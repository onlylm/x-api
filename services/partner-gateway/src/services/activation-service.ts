import { randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import { AppDatabase } from "../database.js";
import type { ActivationRecord, EncryptedValue, FailureCode } from "../domain.js";
import { decryptValue, hmacHex, encryptValue } from "../security.js";
import { isXGiftPlan, maskEmail, normalizeXUsername } from "../domain.js";
import { BusinessError } from "./order-service.js";

export interface ParsedSession {
  raw: Record<string, unknown>;
  email: string;
  accessToken: string;
}

export class ActivationService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
  ) {}

  create(orderId: string, sessionInput: unknown): ActivationRecord {
    const order = this.db.getOrder(orderId);
    if (!order) throw new BusinessError(404, "order_not_found", "订单不存在");
    if (order.status !== "paid") {
      throw new BusinessError(409, "order_not_paid", "订单尚未确认到账");
    }
    const isXGift = isXGiftPlan(order.plan);
    let raw: Record<string, unknown>;
    let accountMasked: string;
    let accountIdentity: string;
    if (isXGift) {
      const recipient = parseXRecipient(sessionInput);
      if (!order.fulfillment_recipient_hash ||
          hmacHex(this.config.emailHmacKey, recipient.username) !== order.fulfillment_recipient_hash) {
        throw new BusinessError(409, "recipient_mismatch", "接收账号必须与付款订单一致");
      }
      const previous = this.db.listActivations(orderId);
      if (previous.length) return previous.at(-1)!;
      if (!order.fulfillment_recipient_ciphertext || !order.fulfillment_recipient_iv ||
          !order.fulfillment_recipient_tag) {
        throw new BusinessError(409, "recipient_missing", "订单收件信息不完整");
      }
      raw = JSON.parse(decryptValue({
        ciphertext: order.fulfillment_recipient_ciphertext,
        iv: order.fulfillment_recipient_iv,
        tag: order.fulfillment_recipient_tag,
      }, this.config.sessionEncryptionKey, "order-recipient")) as Record<string, unknown>;
      if (raw.username !== recipient.username) {
        throw new BusinessError(409, "recipient_mismatch", "订单收件信息不一致");
      }
      accountMasked = `@${recipient.username}`;
      accountIdentity = recipient.username;
    } else {
      const session = parseSession(sessionInput);
      raw = session.raw;
      accountMasked = maskEmail(session.email);
      accountIdentity = session.email.trim().toLowerCase();
    }
    const encrypted = encryptValue(JSON.stringify(raw), this.config.sessionEncryptionKey, "session");
    try {
      return this.db.createActivation({
        orderId,
        taskId: `tsk_${randomBytes(12).toString("hex")}`,
        encryptedSession: encrypted,
        emailMasked: accountMasked,
        emailHash: hmacHex(this.config.emailHmacKey, accountIdentity),
        now: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "activation_in_progress") {
        throw new BusinessError(409, "activation_in_progress", "已有开通任务正在进行");
      }
      if (error instanceof Error && error.message === "manual_takeover_in_progress") {
        throw new BusinessError(409, "manual_takeover_in_progress", "订单已进入人工开通接管，不能再次自动提交");
      }
      if (error instanceof Error && error.message === "activation_quota_used") {
        throw new BusinessError(409, "activation_quota_used", "订单的开通次数已使用完毕");
      }
      if (error instanceof Error && error.message === "refund_pending") {
        throw new BusinessError(409, "refund_pending", "订单已进入退款流程，不能再提交开通");
      }
      if (error instanceof Error && error.message === "order_not_paid") {
        throw new BusinessError(409, "order_not_paid", "订单尚未确认到账");
      }
      throw error;
    }
  }

  createForPaidOrder(orderId: string): ActivationRecord | undefined {
    const order = this.db.getOrder(orderId);
    if (!order || order.status !== "paid" || !isXGiftPlan(order.plan)) return undefined;
    const existing = this.db.listActivations(orderId);
    if (existing.length) return existing.at(-1);
    if (!order.fulfillment_recipient_ciphertext || !order.fulfillment_recipient_iv ||
        !order.fulfillment_recipient_tag) {
      throw new BusinessError(409, "recipient_missing", "蓝V订单缺少已加密的 X 用户名");
    }
    const raw = decryptValue({
      ciphertext: order.fulfillment_recipient_ciphertext,
      iv: order.fulfillment_recipient_iv,
      tag: order.fulfillment_recipient_tag,
    }, this.config.sessionEncryptionKey, "order-recipient");
    try {
      return this.create(orderId, JSON.parse(raw));
    } catch (error) {
      if (error instanceof BusinessError && ["activation_in_progress", "activation_quota_used"].includes(error.code)) {
        return this.db.listActivations(orderId).at(-1);
      }
      throw error;
    }
  }

  reconcilePaidOrders(): void {
    const rows = this.db.db.prepare(`SELECT o.order_id FROM orders o
      WHERE o.status='paid' AND o.plan IN ('x_premium_3m','x_premium_6m')
        AND o.fulfillment_recipient_ciphertext IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM activations a WHERE a.order_id=o.order_id)
        AND NOT EXISTS(SELECT 1 FROM refunds r WHERE r.order_id=o.order_id)
      ORDER BY o.paid_at LIMIT 50`).all() as Array<{order_id: string}>;
    for (const row of rows) {
      try { this.createForPaidOrder(row.order_id); }
      catch {
        if (!this.db.db.prepare(`SELECT 1 FROM order_audit_log
          WHERE order_id=? AND action='x_auto_enqueue_review' LIMIT 1`).get(row.order_id)) {
          this.db.recordOrderAudit({
            orderId: row.order_id, action: "x_auto_enqueue_review", fromStatus: "paid",
            toStatus: "review_required", operator: "system", reason: "已收款订单自动入队异常，请核对收件信息。",
          });
        }
      }
    }
  }

  list(orderId: string): {
    activation_quota: number;
    activation_used: number;
    activation_remaining: number;
    items: Array<Record<string, unknown>>;
  } {
    const order = this.db.getOrder(orderId);
    if (!order) throw new BusinessError(404, "order_not_found", "订单不存在");
    const rows = this.db.listActivations(orderId);
    const used = isXGiftPlan(order.plan) ? rows.length
      : rows.filter((row) => row.status === "success" || !row.finished).length;
    return {
      activation_quota: order.quantity,
      activation_used: used,
      activation_remaining: Math.max(0, order.quantity - used),
      items: rows.map((row) => {
        const item = toPlatformActivation(row, isXGiftPlan(order.plan));
        if (isXGiftPlan(order.plan) && !row.finished && row.message_zh?.includes("核对")) item.requires_review = true;
        return item;
      }),
    };
  }
}

interface ParsedXRecipient {
  raw: { username: string };
  username: string;
}

function parseXRecipient(input: unknown): ParsedXRecipient {
  const value = typeof input === "string" ? input : (
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).username
      : undefined
  );
  try {
    const username = normalizeXUsername(value);
    return { raw: { username }, username };
  } catch {
    throw new BusinessError(422, "invalid_recipient", "X 用户名格式无效");
  }
}

function parseSession(input: unknown): ParsedSession {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new BusinessError(422, "invalid_session_json", "Session 不是合法 JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BusinessError(422, "invalid_session_json", "Session 不是合法对象");
  }
  const raw = value as Record<string, unknown>;
  const user = raw.user;
  const email =
    user && typeof user === "object" && !Array.isArray(user)
      ? String((user as Record<string, unknown>).email ?? "")
      : "";
  const accessToken = String(raw.accessToken ?? "");
  if (!accessToken || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new BusinessError(422, "invalid_session_json", "Session 缺少 accessToken 或用户邮箱");
  }
  return { raw, email: email.trim().toLowerCase(), accessToken };
}

export function inspectSession(input: unknown): { email: string } {
  const session = parseSession(input);
  return { email: session.email };
}

function toPlatformActivation(row: ActivationRecord, xGift: boolean): Record<string, unknown> {
  const output: Record<string, unknown> = {
    activation_id: row.activation_id,
    task_id: row.task_id,
    status: row.status,
    finished: Boolean(row.finished),
    message_zh: row.message_zh ?? statusMessage(row.status),
    updated_at: row.updated_at,
  };
  if (row.failure_code) output.failure_code = row.failure_code satisfies FailureCode;
  if (row.status === "success" && row.account_email_masked) {
    if (xGift) output.recipient = row.account_email_masked;
    else output.account_email = row.account_email_masked;
  }
  return output;
}

function statusMessage(status: ActivationRecord["status"]): string {
  const messages: Record<ActivationRecord["status"], string> = {
    submitting: "已收到，正在核实",
    queued: "已受理，正在排队",
    running: "正在开通",
    success: "开通成功",
    failed: "开通失败",
  };
  return messages[status];
}

export function encryptedFromActivation(row: ActivationRecord): EncryptedValue {
  if (!row.session_ciphertext || !row.session_iv || !row.session_tag) {
    throw new Error("activation_session_missing");
  }
  return { ciphertext: row.session_ciphertext, iv: row.session_iv, tag: row.session_tag };
}
