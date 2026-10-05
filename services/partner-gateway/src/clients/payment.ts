import { AlipaySdk } from "alipay-sdk";
import type { AppConfig } from "../config.js";
import type { OrderRecord } from "../domain.js";
import { moneyToCents } from "../domain.js";

export function alipayPaymentSubject(orderId: string): string {
  return `会员服务订单-${orderId.slice(-10)}`;
}

export interface PaymentConfirmation {
  paid: boolean;
  tradeNo: string | null;
  paidAt: string;
  receiptAmount: string | null;
  tradeStatus: string | null;
}

export interface RefundConfirmation {
  status: "processing" | "succeeded";
  tradeNo: string | null;
  refundFee: string | null;
  refundedAt: string | null;
}

export class PaymentProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly definitive: boolean,
  ) {
    super(message);
  }
}

export interface PaymentClient {
  createPaymentUrl(
    order: Pick<OrderRecord, "order_id" | "amount" | "product">,
    returnUrl?: string,
  ): Promise<string>;
  verifyNotification(payload: Record<string, string>, order: OrderRecord): Promise<PaymentConfirmation>;
  queryPayment(order: OrderRecord): Promise<PaymentConfirmation>;
  refundPayment(order: OrderRecord, outRequestNo: string, reason: string): Promise<RefundConfirmation>;
  queryRefund(order: OrderRecord, outRequestNo: string): Promise<RefundConfirmation>;
}

export class MockPaymentClient implements PaymentClient {
  private readonly externallyRefundedOrders = new Set<string>();

  constructor(private readonly publicBaseUrl: string) {}

  markExternallyRefunded(orderId: string): void {
    this.externallyRefundedOrders.add(orderId);
  }

  async createPaymentUrl(order: Pick<OrderRecord, "order_id">): Promise<string> {
    return `${this.publicBaseUrl}/dev/pay/${encodeURIComponent(order.order_id)}`;
  }

  async verifyNotification(): Promise<PaymentConfirmation> {
    throw new Error("mock_payment_does_not_accept_alipay_notifications");
  }

  async queryPayment(order: OrderRecord): Promise<PaymentConfirmation> {
    return {
      paid: false,
      tradeNo: order.alipay_trade_no,
      paidAt: order.paid_at ?? new Date().toISOString(),
      receiptAmount: order.alipay_receipt_amount,
      tradeStatus: this.externallyRefundedOrders.has(order.order_id) ? "TRADE_CLOSED" : null,
    };
  }

  async refundPayment(order: OrderRecord): Promise<RefundConfirmation> {
    return {
      status: "succeeded",
      tradeNo: order.alipay_trade_no,
      refundFee: order.alipay_receipt_amount ?? order.amount,
      refundedAt: new Date().toISOString(),
    };
  }

  async queryRefund(order: OrderRecord): Promise<RefundConfirmation> {
    return this.refundPayment(order);
  }
}

export class AlipayPaymentClient implements PaymentClient {
  private readonly sdk: AlipaySdk;

  constructor(private readonly config: AppConfig["alipay"]) {
    this.sdk = new AlipaySdk({
      appId: config.appId,
      privateKey: config.privateKey,
      alipayPublicKey: config.publicKey,
      gateway: config.gateway,
      signType: "RSA2",
      charset: "utf-8",
      version: "1.0",
      keyType: config.privateKey.includes("BEGIN PRIVATE KEY") ? "PKCS8" : "PKCS1",
      camelcase: true,
      timeout: 10_000,
    });
  }

  async createPaymentUrl(
    order: Pick<OrderRecord, "order_id" | "amount" | "product">,
    _returnUrl?: string,
  ): Promise<string> {
    // 生产支付统一使用当面付预创建。平台需要的是 qr_code，不能返回
    // alipay.trade.page.pay 生成的电脑网站支付链接。
    const response = await this.sdk.exec(
      "alipay.trade.precreate",
      {
        // notify_url 是支付宝公共请求参数，必须与 bizContent 同级传入。
        // 若遗漏，扫码支付可以成功，但支付宝不会发送异步付款通知。
        notify_url: this.config.notifyUrl,
        bizContent: {
          out_trade_no: order.order_id,
          product_code: "FACE_TO_FACE_PAYMENT",
          total_amount: order.amount,
          // 支付宝账单只展示稳定的中性订单标识，不暴露品牌、套餐或内部商品名称。
          subject: alipayPaymentSubject(order.order_id),
          timeout_express: "20m",
        },
      },
      { validateSign: true },
    );
    if (String(response.code ?? "") !== "10000") {
      throw new Error(`alipay_precreate_failed:${String(response.subCode ?? response.sub_code ?? response.msg ?? "unknown")}`);
    }
    const qrCode = String(response.qrCode ?? response.qr_code ?? "").trim();
    if (!qrCode) throw new Error("alipay_precreate_missing_qr_code");
    return qrCode;
  }

  async verifyNotification(
    payload: Record<string, string>,
    order: OrderRecord,
  ): Promise<PaymentConfirmation> {
    if (!this.sdk.checkNotifySignV2(payload)) throw new Error("invalid_alipay_signature");
    if (payload.app_id !== this.config.appId) throw new Error("alipay_app_id_mismatch");
    if (payload.seller_id !== this.config.sellerId) throw new Error("alipay_seller_id_mismatch");
    if (payload.out_trade_no !== order.order_id) throw new Error("alipay_order_id_mismatch");
    if (moneyToCents(payload.total_amount) !== moneyToCents(order.amount)) {
      throw new Error("alipay_amount_mismatch");
    }
    if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(payload.trade_status)) {
      return {
        paid: false,
        tradeNo: payload.trade_no || null,
        paidAt: new Date().toISOString(),
        receiptAmount: null,
        tradeStatus: payload.trade_status || null,
      };
    }

    // 异步通知验签后再主动查单，避免只凭浏览器跳转或伪造通知入账。
    const confirmation = await this.queryPayment(order);
    if (!confirmation.paid) throw new Error("alipay_active_query_not_paid");
    return confirmation;
  }

  async queryPayment(order: OrderRecord): Promise<PaymentConfirmation> {
    const query = await this.sdk.exec(
      "alipay.trade.query",
      { bizContent: { out_trade_no: order.order_id } },
      { validateSign: true },
    );
    const queryStatus = String(query.tradeStatus ?? query.trade_status ?? "");
    const queryAmount = String(query.totalAmount ?? query.total_amount ?? "");
    if (String(query.code ?? "") !== "10000") {
      return {
        paid: false,
        tradeNo: null,
        paidAt: new Date().toISOString(),
        receiptAmount: null,
        tradeStatus: null,
      };
    }
    if (!queryAmount || moneyToCents(queryAmount) !== moneyToCents(order.amount)) {
      throw new Error("alipay_query_amount_mismatch");
    }
    const paid = ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(queryStatus);
    return {
      paid,
      tradeNo: String(query.tradeNo ?? query.trade_no ?? "") || null,
      paidAt: alipayDateToIso(String(query.sendPayDate ?? query.send_pay_date ?? "")) || new Date().toISOString(),
      receiptAmount: String(query.receiptAmount ?? query.receipt_amount ?? order.amount),
      tradeStatus: queryStatus || null,
    };
  }

  async refundPayment(
    order: OrderRecord,
    outRequestNo: string,
    reason: string,
  ): Promise<RefundConfirmation> {
    let response: Record<string, unknown>;
    try {
      response = await this.sdk.exec(
        "alipay.trade.refund",
        {
          bizContent: {
            out_trade_no: order.order_id,
            refund_amount: order.alipay_receipt_amount ?? order.amount,
            refund_reason: reason,
            out_request_no: outRequestNo,
          },
        },
        { validateSign: true },
      ) as Record<string, unknown>;
    } catch (error) {
      throw new PaymentProviderError(
        "alipay_refund_network_error",
        error instanceof Error ? error.message : "支付宝退款请求状态未知",
        false,
      );
    }
    if (String(response.code ?? "") !== "10000") {
      const providerCode = String(response.subCode ?? response.sub_code ?? response.code ?? "unknown");
      throw new PaymentProviderError(
        providerCode,
        String(response.subMsg ?? response.sub_msg ?? response.msg ?? "支付宝拒绝退款"),
        true,
      );
    }
    const succeeded = String(response.fundChange ?? response.fund_change ?? "") === "Y";
    return {
      status: succeeded ? "succeeded" : "processing",
      tradeNo: String(response.tradeNo ?? response.trade_no ?? order.alipay_trade_no ?? "") || null,
      refundFee: String(response.refundFee ?? response.refund_fee ?? "") || null,
      refundedAt: succeeded ? new Date().toISOString() : null,
    };
  }

  async queryRefund(order: OrderRecord, outRequestNo: string): Promise<RefundConfirmation> {
    let response: Record<string, unknown>;
    try {
      response = await this.sdk.exec(
        "alipay.trade.fastpay.refund.query",
        {
          bizContent: {
            out_trade_no: order.order_id,
            out_request_no: outRequestNo,
          },
        },
        { validateSign: true },
      ) as Record<string, unknown>;
    } catch (error) {
      throw new PaymentProviderError(
        "alipay_refund_query_network_error",
        error instanceof Error ? error.message : "支付宝退款查询状态未知",
        false,
      );
    }
    if (String(response.code ?? "") !== "10000") {
      const providerCode = String(response.subCode ?? response.sub_code ?? response.code ?? "unknown");
      throw new PaymentProviderError(
        providerCode,
        String(response.subMsg ?? response.sub_msg ?? response.msg ?? "支付宝退款查询失败"),
        true,
      );
    }
    const succeeded = String(response.refundStatus ?? response.refund_status ?? "") === "REFUND_SUCCESS";
    return {
      status: succeeded ? "succeeded" : "processing",
      tradeNo: String(response.tradeNo ?? response.trade_no ?? order.alipay_trade_no ?? "") || null,
      refundFee: String(response.refundAmount ?? response.refund_amount ?? response.refundFee ?? response.refund_fee ?? "") || null,
      refundedAt: succeeded
        ? alipayDateToIso(String(response.gmtRefundPay ?? response.gmt_refund_pay ?? "")) || new Date().toISOString()
        : null,
    };
  }
}

function alipayDateToIso(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value.replace(" ", "T") + "+08:00");
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function createPaymentClient(config: AppConfig): PaymentClient {
  return config.paymentProvider === "alipay"
    ? new AlipayPaymentClient(config.alipay)
    : new MockPaymentClient(config.publicBaseUrl);
}
