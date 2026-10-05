import { randomBytes } from "node:crypto";
import type { PaymentClient, RefundConfirmation } from "../clients/payment.js";
import { PaymentProviderError } from "../clients/payment.js";
import { AppDatabase } from "../database.js";
import type { RefundRecord } from "../domain.js";
import { FinancialAmountError } from "../domain.js";
import { BusinessError } from "./order-service.js";

export class RefundService {
  constructor(
    private readonly db: AppDatabase,
    private readonly payment: PaymentClient,
  ) {}

  async request(input: {
    orderId: string;
    clientRefundId: string;
    reason: string;
    requestedBy: "platform" | "admin";
  }): Promise<{ refund: RefundRecord; idempotent: boolean }> {
    const existingByClient = this.db.getRefundByClientId(input.clientRefundId);
    if (existingByClient && existingByClient.order_id !== input.orderId) {
      throw new BusinessError(409, "refund_idempotency_conflict", "退款请求号已被其他订单使用");
    }
    const existing = this.db.getRefundByOrderId(input.orderId);
    if (existing && existing.client_refund_id !== input.clientRefundId) {
      throw new BusinessError(409, "refund_already_exists", "该订单已有退款请求，请沿用原退款请求号查询或重试");
    }
    if (existing) return { refund: existing, idempotent: true };

    const order = this.db.getOrder(input.orderId);
    if (!order) throw new BusinessError(404, "order_not_found", "订单不存在");
    const amount = order.alipay_receipt_amount ?? order.amount;
    try {
      const refund = this.db.createRefund({
        refundId: makeRefundId(),
        orderId: input.orderId,
        clientRefundId: input.clientRefundId,
        amount,
        reason: input.reason,
        requestedBy: input.requestedBy,
        now: new Date().toISOString(),
      });
      return { refund, idempotent: false };
    } catch (error) {
      throw mapRefundStateError(error);
    }
  }

  async execute(input: {
    orderId: string;
    clientRefundId: string;
    reason: string;
  }): Promise<{ refund: RefundRecord; idempotent: boolean }> {
    let existing = this.db.getRefundByOrderId(input.orderId);
    const hadExisting = Boolean(existing);
    if (!existing) {
      existing = (await this.request({
        orderId: input.orderId,
        clientRefundId: input.clientRefundId,
        reason: input.reason,
        requestedBy: "admin",
      })).refund;
    }
    if (existing.status === "succeeded") return { refund: existing, idempotent: true };
    if (existing.status === "processing" && existing.failure_code?.startsWith("financial_")) {
      return {refund:await this.get(input.orderId,true),idempotent:true};
    }
    if (existing.status === "rejected") {
      throw new BusinessError(409, "refund_rejected", "该退款申请已被驳回，不能直接执行");
    }
    if (existing.status === "processing" && Date.now() - new Date(existing.updated_at).getTime() < 15_000) {
      return { refund: existing, idempotent: true };
    }

    const order = this.db.assertFullRefundAmount(input.orderId, existing.amount);
    if (order.status !== "paid") throw new BusinessError(409,"order_not_paid","订单已不处于已付款状态，不能再次发起退款");
    let refund = existing;
    if (refund.status === "requested" || refund.status === "failed") {
      try {
        refund = this.db.approveRefund({
          refundId: refund.refund_id,
          reason: input.reason,
          now: new Date().toISOString(),
        });
      } catch (error) {
        throw mapRefundStateError(error);
      }
    }

    try {
      const confirmation = await this.payment.refundPayment(order, refund.client_refund_id, refund.reason);
      refund = this.applyConfirmation(refund, confirmation);
      return { refund, idempotent: hadExisting };
    } catch (error) {
      if (error instanceof PaymentProviderError && error.definitive) {
        const reconciled = await this.tryReconcileClosedTrade(order, refund);
        if (reconciled) return { refund: reconciled, idempotent: hadExisting };
        this.db.recordRefundProviderResult({
          refundId: refund.refund_id,
          status: "failed",
          failureCode: error.code,
          failureMessage: error.message,
          now: new Date().toISOString(),
        });
        throw new BusinessError(502, "refund_rejected", `支付宝退款未受理：${safeProviderMessage(error.message)}`);
      }
      refund = this.db.recordRefundProviderResult({
        refundId: refund.refund_id,
        status: "processing",
        failureCode: error instanceof PaymentProviderError || error instanceof FinancialAmountError ? error.code : "refund_status_unknown",
        failureMessage: error instanceof Error ? error.message : "退款结果暂时未知",
        now: new Date().toISOString(),
      });
      return { refund, idempotent: hadExisting };
    }
  }

  async reconcileExternal(input: {
    orderId: string;
    clientRefundId: string;
    reason: string;
  }): Promise<{ refund: RefundRecord; idempotent: boolean }> {
    const order = this.db.getOrder(input.orderId);
    if (!order) throw new BusinessError(404, "order_not_found", "订单不存在");
    const existing = this.db.getRefundByOrderId(input.orderId);
    if (order.status === "refunded" && existing?.status === "succeeded") {
      return { refund: existing, idempotent: true };
    }
    if (order.status !== "paid" || !order.paid_at) {
      throw new BusinessError(409, "order_not_paid", "只有已确认付款的订单才能核验线下退款");
    }

    const paymentState = await this.payment.queryPayment(order);
    if (paymentState.tradeStatus !== "TRADE_CLOSED") {
      throw new BusinessError(
        409,
        "external_refund_not_confirmed",
        "支付宝主动查单尚未确认全额退款，订单状态不会变更",
      );
    }

    // The takeover lock blocks initiating a refund, but it must not conceal an
    // external refund that Alipay has already confirmed as a financial fact.
    if (this.db.hasActiveManualActivationTakeover(input.orderId)) {
      const refundedAt = new Date().toISOString();
      const amount = order.alipay_receipt_amount ?? order.amount;
      if (existing) {
        return {
          refund: this.db.completeRefund({
            refundId: existing.refund_id,
            tradeNo: paymentState.tradeNo ?? order.alipay_trade_no,
            refundFee: amount,
            refundedAt,
          }),
          idempotent: true,
        };
      }
      return {
        refund: this.db.recordVerifiedExternalRefundDuringTakeover({
          refundId: makeRefundId(),
          orderId: input.orderId,
          clientRefundId: input.clientRefundId,
          amount,
          reason: input.reason,
          tradeNo: paymentState.tradeNo ?? order.alipay_trade_no,
          refundedAt,
        }),
        idempotent: false,
      };
    }

    let refund = existing;
    const idempotent = Boolean(existing);
    if (!refund) {
      refund = (await this.request({
        orderId: input.orderId,
        clientRefundId: input.clientRefundId,
        reason: input.reason,
        requestedBy: "admin",
      })).refund;
    }
    if (refund.status === "rejected") {
      throw new BusinessError(409, "refund_rejected", "该退款申请已被驳回，需先人工复核");
    }
    if (refund.status === "requested" || refund.status === "failed") {
      try {
        refund = this.db.approveRefund({
          refundId: refund.refund_id,
          reason: input.reason,
          now: new Date().toISOString(),
        });
      } catch (error) {
        throw mapRefundStateError(error);
      }
    }
    return {
      refund: this.db.completeRefund({
        refundId: refund.refund_id,
        tradeNo: paymentState.tradeNo ?? order.alipay_trade_no,
        refundFee: order.alipay_receipt_amount ?? order.amount,
        refundedAt: new Date().toISOString(),
      }),
      idempotent,
    };
  }

  reject(orderId: string, reason: string): RefundRecord {
    const refund = this.db.getRefundByOrderId(orderId);
    if (!refund) throw new BusinessError(404, "refund_not_found", "该订单没有待审核退款申请");
    try {
      return this.db.rejectRefund({ refundId: refund.refund_id, reason, now: new Date().toISOString() });
    } catch (error) {
      throw mapRefundStateError(error);
    }
  }

  async get(orderId: string, refresh = false): Promise<RefundRecord> {
    let refund = this.db.getRefundByOrderId(orderId);
    if (!refund) throw new BusinessError(404, "refund_not_found", "该订单尚未发起退款");
    if (!refresh || refund.status !== "processing") return refund;
    if (Date.now() - new Date(refund.created_at).getTime() < 10_000) return refund;
    const order = this.db.getOrder(orderId);
    if (!order) throw new BusinessError(404, "order_not_found", "订单不存在");
    try {
      const confirmation = await this.payment.queryRefund(order, refund.client_refund_id);
      refund = this.applyConfirmation(refund, confirmation);
    } catch (error) {
      refund = this.db.recordRefundProviderResult({
        refundId: refund.refund_id,
        status: "processing",
        failureCode: error instanceof PaymentProviderError || error instanceof FinancialAmountError ? error.code : "refund_query_unknown",
        failureMessage: error instanceof Error ? error.message : "退款查询结果未知",
        now: new Date().toISOString(),
      });
    }
    return refund;
  }

  private applyConfirmation(refund: RefundRecord, confirmation: RefundConfirmation): RefundRecord {
    if (confirmation.status === "succeeded") {
      return this.db.completeRefund({
        refundId: refund.refund_id,
        tradeNo: confirmation.tradeNo,
        refundFee: confirmation.refundFee,
        refundedAt: confirmation.refundedAt ?? new Date().toISOString(),
      });
    }
    return this.db.recordRefundProviderResult({
      refundId: refund.refund_id,
      status: "processing",
      now: new Date().toISOString(),
    });
  }

  private async tryReconcileClosedTrade(order: import("../domain.js").OrderRecord, refund: RefundRecord): Promise<RefundRecord | null> {
    try {
      const paymentState = await this.payment.queryPayment(order);
      if (paymentState.tradeStatus !== "TRADE_CLOSED" || !order.paid_at) return null;
      return this.db.completeRefund({
        refundId: refund.refund_id,
        tradeNo: paymentState.tradeNo ?? order.alipay_trade_no,
        refundFee: order.alipay_receipt_amount ?? order.amount,
        refundedAt: new Date().toISOString(),
      });
    } catch {
      return null;
    }
  }
}

function mapRefundStateError(error: unknown): BusinessError {
  const code = error instanceof Error ? error.message : "";
  const known: Record<string, [number, string, string]> = {
    order_not_found: [404, "order_not_found", "订单不存在"],
    only_paid_order_can_be_refunded: [409, "order_not_paid", "只有已付款订单可以退款"],
    already_activated: [409, "already_activated", "该订单已经开通成功，不能退款"],
    activation_in_progress: [409, "activation_in_progress", "该订单正在开通中，暂时不能退款"],
    manual_takeover_blocks_refund: [409, "manual_takeover_blocks_refund", "订单已进入人工开通接管，暂不能发起退款"],
    fulfilled_order_refund_requires_review: [409, "fulfilled_order_refund_requires_review", "订单已经履约成功，禁止直接退款"],
    activation_blocks_refund: [409, "activation_blocks_refund", "上游订单正在处理、结果未知或已经履约成功，禁止退款"],
    rejected_refund_cannot_be_approved: [409, "refund_rejected", "该退款申请已被驳回"],
    only_requested_refund_can_be_rejected: [409, "refund_not_reviewable", "只有待审核的退款申请可以驳回"],
  };
  const mapped = known[code];
  if (mapped) return new BusinessError(...mapped);
  throw error;
}

function makeRefundId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `RF${stamp}${randomBytes(4).toString("hex").toUpperCase()}`;
}

function safeProviderMessage(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 160) || "请稍后重试";
}
