import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { AppDatabase } from "../database.js";
import type { OrderRecord, ProductConfig } from "../domain.js";
import { isXGiftPlan, moneyToCents, normalizeXUsername, xGiftProductCode } from "../domain.js";
import type { PaymentClient } from "../clients/payment.js";
import type { ZovoClient } from "../clients/zovo.js";
import { DisabledXApiClient, type XApiClient } from "../clients/x-api.js";
import { encryptValue, hmacHex } from "../security.js";

type OrderInput = {
  product: string;
  quantity: number;
  sellPrice: string;
  clientOrderId: string;
  recipient?: string;
};

export class BusinessError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class OrderService {
  private readonly pending = new Map<string, {input: OrderInput; promise: Promise<{order: OrderRecord; idempotent: boolean}>}>();
  constructor(
    private readonly db: AppDatabase,
    private readonly payment: PaymentClient,
    private readonly zovo: ZovoClient,
    private readonly xApi: XApiClient = new DisabledXApiClient(),
    private readonly recipientSecrets?: { encryptionKey: Buffer; hmacKey: string },
    private readonly salesGateFile?: string,
  ) {
    // Durable reservation precedes the external payment request. Never delete uncertain intents.
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS checkout_intents (
        client_order_id TEXT PRIMARY KEY, order_json TEXT NOT NULL,
        lease_token TEXT, lease_until TEXT, updated_at TEXT NOT NULL
      );
    `);
  }

  async getProducts(): Promise<Array<ProductConfig & { in_stock: boolean }>> {
    return Promise.all(
      this.db.listProducts().map(async (product) => ({
        ...product,
        in_stock: product.enabled && (!isXGiftPlan(product.plan) || this.salesOpen()) && (isXGiftPlan(product.plan)
          ? await this.xApi.isPlanAvailable(product.plan)
          : await this.zovo.isPlanAvailable(product.plan)),
      })),
    );
  }

  async createOrder(input: OrderInput): Promise<{ order: OrderRecord; idempotent: boolean }> {
    const normalizedInput = { ...input, recipient: normalizeOptionalRecipient(input.recipient) };
    const pending = this.pending.get(normalizedInput.clientOrderId);
    if (pending) {
      if (pending.input.product !== normalizedInput.product ||
          pending.input.quantity !== normalizedInput.quantity ||
          pending.input.recipient !== normalizedInput.recipient ||
          moneyToCents(pending.input.sellPrice) !== moneyToCents(normalizedInput.sellPrice)) {
        throw new BusinessError(409, "idempotency_conflict", "相同订单号的商品、数量或售价不一致");
      }
      return {...await pending.promise, idempotent: true};
    }
    const promise = this.createReservedOrder(normalizedInput);
    this.pending.set(normalizedInput.clientOrderId, {input: {...normalizedInput}, promise});
    try { return await promise; }
    finally { this.pending.delete(normalizedInput.clientOrderId); }
  }

  private async createReservedOrder(input: OrderInput): Promise<{ order: OrderRecord; idempotent: boolean }> {
    const recipientHash = input.recipient && this.recipientSecrets
      ? hmacHex(this.recipientSecrets.hmacKey, input.recipient)
      : undefined;
    const existing = this.db.getOrderByClientId(input.clientOrderId);
    if (existing) {
      const replay = sameOrderIntent(existing, { ...input, recipientHash });
      this.db.recordIdempotencyHit(
        input.clientOrderId,
        existing.order_id,
        replay ? "replay" : "conflict",
      );
      if (!replay) {
        throw new BusinessError(
          409,
          "idempotency_conflict",
          "client_order_id 已存在，但商品、数量或售价与原请求不一致",
        );
      }
      return { order: existing, idempotent: true };
    }

    const reserved = this.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?")
      .get(input.clientOrderId) as {order_json:string}|undefined;
    if (reserved) {
      const original = JSON.parse(reserved.order_json) as OrderRecord;
      if (!sameOrderIntent(original, { ...input, recipientHash })) {
        throw new BusinessError(409, "idempotency_conflict", "相同订单号的商品、数量、售价或接收账号不一致");
      }
      return this.completePayment(original, true);
    }
    const product = this.db.listProducts().find((item) => item.product === input.product);
    if (!product) throw new BusinessError(404, "product_not_found", "商品编码不存在");
    // Checkout must not wait for an upstream inventory request before creating
    // the Alipay QR code. Product availability is monitored separately; the
    // local enabled switch remains the immediate sales control.
    if (!product.enabled) {
      throw new BusinessError(409, "product_unavailable", "商品暂时不可售");
    }
    const xGift = isXGiftPlan(product.plan);
    if (xGift && !this.salesOpen()) {
      throw new BusinessError(503, "sales_paused", "蓝V暂未开放接单，已有订单仍可查询");
    }
    if (xGift && !input.recipient) {
      throw new BusinessError(422, "recipient_required", "购买蓝V套餐必须填写 X 用户名");
    }
    if (xGift && !this.recipientSecrets) {
      throw new BusinessError(503, "fulfillment_not_configured", "蓝V收件信息加密配置未就绪");
    }
    if (!xGift && input.recipient) {
      throw new BusinessError(422, "unexpected_recipient", "该商品不使用 X 用户名");
    }
    // 现有 ChatGPT 商品保持原有快速下单行为；蓝V需要在收款前确认
    // 商户余额、接单开关和套餐状态，避免已收款后才发现无法履约。
    if (xGift && !(await this.xApi.isPlanAvailable(product.plan))) {
      throw new BusinessError(409, "product_unavailable", "蓝V商品暂时不可售");
    }
    if (input.quantity !== 1) throw new BusinessError(422, "invalid_quantity", "数量目前只能为 1");
    const price = moneyToCents(input.sellPrice);
    if (price < moneyToCents(product.cost_price)) {
      throw new BusinessError(422, "price_below_floor", "售价低于成本价");
    }
    if (price > moneyToCents(product.max_sell_price)) {
      throw new BusinessError(422, "price_above_max", "售价高于售价上限");
    }
    let xCredential: { username: string; recipient_id: string; product_code: string; expected_points: number } | undefined;
    if (xGift) {
      try {
        const identity = await this.xApi.eligibility(input.recipient!);
        if (!identity.eligible || !identity.recipient_id || identity.username !== input.recipient) {
          throw new BusinessError(422, "recipient_not_eligible", "该 X 账号当前不能接收赠送，请核对用户名");
        }
        const upstreamProduct = await this.xApi.product(xGiftProductCode(product.plan));
        if (!upstreamProduct?.enabled || !Number.isSafeInteger(upstreamProduct.points) || upstreamProduct.points <= 0) {
          throw new BusinessError(409, "product_unavailable", "蓝V商品暂时不可售");
        }
        xCredential = {
          username: input.recipient!,
          recipient_id: identity.recipient_id,
          product_code: upstreamProduct.code,
          expected_points: upstreamProduct.points,
        };
      } catch (error) {
        if (error instanceof BusinessError) throw error;
        throw new BusinessError(503, "recipient_check_unavailable", "接收账号暂时无法核验，请稍后重试");
      }
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 20 * 60_000);
    const orderId = makeOrderId(now);
    const encryptedRecipient = xGift
      ? encryptValue(JSON.stringify(xCredential), this.recipientSecrets!.encryptionKey, "order-recipient")
      : undefined;
    const base: OrderRecord = {
      order_id: orderId,
      client_order_id: input.clientOrderId,
      product: product.product,
      plan: product.plan,
      payment_country: product.payment_country ?? null,
      payment_currency: product.payment_currency ?? null,
      quantity: input.quantity,
      sell_price: input.sellPrice,
      amount: input.sellPrice,
      status: "pending",
      qr: "",
      expires_at: expiresAt.toISOString(),
      alipay_trade_no: null,
      paid_at: null,
      refunded_at: null,
      delivery_status: null,
      platform_supply_price: product.cost_price,
      platform_max_sell_price: product.max_sell_price,
      upstream_estimated_cost_cny: product.internal_cost_cny ?? "0.00",
      upstream_actual_cost_amount: null,
      upstream_actual_cost_currency: null,
      upstream_actual_cost_cny: null,
      alipay_receipt_amount: null,
      customer_price_refund_amount: "0.00",
      customer_price_refund_reference: null,
      customer_price_refund_reason: null,
      customer_price_refunded_at: null,
      fulfillment_recipient_ciphertext: encryptedRecipient?.ciphertext ?? null,
      fulfillment_recipient_iv: encryptedRecipient?.iv ?? null,
      fulfillment_recipient_tag: encryptedRecipient?.tag ?? null,
      fulfillment_recipient_hash: recipientHash ?? null,
      fulfillment_recipient_masked: input.recipient ? `@${input.recipient}` : null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    if (xGift && !this.salesOpen()) {
      throw new BusinessError(503, "sales_paused", "蓝V接单已暂停，请稍后再试");
    }
    return this.completePayment(base, false);
  }

  private salesOpen(): boolean {
    return !this.salesGateFile || existsSync(this.salesGateFile);
  }

  private async completePayment(candidate: OrderRecord, replay: boolean): Promise<{order: OrderRecord; idempotent: boolean}> {
    const token = randomBytes(16).toString("hex");
    const claimed = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.db.prepare("INSERT OR IGNORE INTO checkout_intents (client_order_id,order_json,updated_at) VALUES (?,?,?)")
        .run(candidate.client_order_id, JSON.stringify(candidate), now);
      const intent = this.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?")
        .get(candidate.client_order_id) as {order_json:string};
      const order = JSON.parse(intent.order_json) as OrderRecord;
      if (!sameOrderIntent(order, {
        product: candidate.product,
        quantity: candidate.quantity,
        sellPrice: candidate.sell_price,
        recipientHash: candidate.fulfillment_recipient_hash ?? undefined,
      })) {
        throw new BusinessError(409, "idempotency_conflict", "相同订单号的商品、数量或售价不一致");
      }
      const stored = this.db.getOrderByClientId(candidate.client_order_id);
      if (stored) return {order:stored, owned:false, complete:true};
      const owned = this.db.db.prepare(`UPDATE checkout_intents SET lease_token=?,lease_until=?,updated_at=?
        WHERE client_order_id=? AND (lease_token IS NULL OR lease_until<=?)`)
        .run(token,new Date(Date.now()+60_000).toISOString(),now,candidate.client_order_id,now).changes > 0;
      return {order,owned,complete:false};
    });
    if (claimed.complete) return {order:claimed.order,idempotent:true};
    if (!claimed.owned) {
      // Cross-process contenders wait briefly, then ask for a safe retry of this SAME order.
      for (let attempt=0; attempt<40; attempt++) {
        await new Promise(resolve=>setTimeout(resolve,25));
        const stored = this.db.getOrderByClientId(candidate.client_order_id);
        if (stored) return {order:stored,idempotent:true};
      }
      throw new BusinessError(503, "internal_error", "订单正在生成，请使用同一订单号稍后重试");
    }
    const order = claimed.order;
    const heartbeat = setInterval(() => {
      try {
        this.db.db.prepare("UPDATE checkout_intents SET lease_until=? WHERE client_order_id=? AND lease_token=?")
          .run(new Date(Date.now()+60_000).toISOString(),order.client_order_id,token);
      } catch { /* The final transaction fences ownership before publishing a result. */ }
    },15_000);
    heartbeat.unref();
    try {
      // A timeout or process restart keeps the original out_trade_no and amount.
      order.qr = await this.payment.createPaymentUrl(order);
      return this.db.transaction(() => {
        const owned = this.db.db.prepare("SELECT 1 FROM checkout_intents WHERE client_order_id=? AND lease_token=?")
          .get(order.client_order_id,token);
        if (!owned) throw new BusinessError(503,"internal_error","订单生成状态正在核实，请使用同一订单号重试");
        const existing = this.db.getOrderByClientId(order.client_order_id);
        if (!existing) this.db.createOrder(order);
        const saved = this.db.getOrderByClientId(order.client_order_id)!;
        this.db.db.prepare("UPDATE checkout_intents SET order_json=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE client_order_id=? AND lease_token=?")
          .run(JSON.stringify(saved),new Date().toISOString(),order.client_order_id,token);
        return {order:saved,idempotent:replay || !!existing};
      });
    } finally {
      clearInterval(heartbeat);
      this.db.db.prepare("UPDATE checkout_intents SET lease_token=NULL,lease_until=NULL WHERE client_order_id=? AND lease_token=?")
        .run(order.client_order_id,token);
    }
  }

  async createManualCashOrder(input: {
    product: string;
    sellPrice: string;
    clientOrderId: string;
    customerRef: string;
    note: string;
    paidAt: string;
    paymentReference: string;
  }): Promise<OrderRecord> {
    const product = this.db.listProducts().find((item) => item.product === input.product);
    if (!product) throw new BusinessError(404, "product_not_found", "商品编码不存在");
    if (isXGiftPlan(product.plan)) {
      throw new BusinessError(409, "x_gift_checkout_required", "蓝V请通过平台下单并填写接收账号");
    }
    if (!product.enabled || !(await this.zovo.isPlanAvailable(product.plan))) {
      throw new BusinessError(409, "product_unavailable", "商品暂时不可售");
    }
    const price = moneyToCents(input.sellPrice);
    if (price < moneyToCents(product.cost_price)) {
      throw new BusinessError(422, "price_below_floor", "售价低于平台供货价");
    }
    if (price > moneyToCents(product.max_sell_price)) {
      throw new BusinessError(422, "price_above_max", "售价高于售价上限");
    }
    const now = new Date();
    const paidAt = new Date(input.paidAt);
    if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > now.getTime() + 60_000) {
      throw new BusinessError(422, "invalid_paid_at", "现金收款时间无效，不能晚于当前时间");
    }
    const orderId = makeOrderId(now);
    const order: OrderRecord = {
      order_id: orderId,
      client_order_id: input.clientOrderId,
      product: product.product,
      plan: product.plan,
      payment_country: product.payment_country ?? null,
      payment_currency: product.payment_currency ?? null,
      quantity: 1,
      sell_price: input.sellPrice,
      amount: input.sellPrice,
      status: "paid",
      qr: "",
      expires_at: paidAt.toISOString(),
      alipay_trade_no: null,
      paid_at: paidAt.toISOString(),
      refunded_at: null,
      delivery_status: null,
      platform_supply_price: product.cost_price,
      platform_max_sell_price: product.max_sell_price,
      upstream_estimated_cost_cny: product.internal_cost_cny ?? "0.00",
      upstream_actual_cost_amount: null,
      upstream_actual_cost_currency: null,
      upstream_actual_cost_cny: null,
      alipay_receipt_amount: input.sellPrice,
      customer_price_refund_amount: "0.00",
      customer_price_refund_reference: null,
      customer_price_refund_reason: null,
      customer_price_refunded_at: null,
      order_source: "manual",
      manual_customer_ref: input.customerRef,
      manual_note: input.note,
      payment_channel: "cash",
      manual_payment_reference: input.paymentReference,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    const created = this.db.createOrder(order);
    this.db.recordOrderAudit({
      orderId,
      action: "manual_cash_order_created",
      fromStatus: null,
      toStatus: "payment:paid",
      reason: `现金收款；凭证号：${input.paymentReference}${input.note ? `；${input.note}` : ""}`,
      operator: "admin",
      now: now.toISOString(),
    });
    return created;
  }

  getOrder(orderId: string): OrderRecord {
    this.db.expirePendingOrders(new Date().toISOString());
    const order = this.db.getOrder(orderId);
    if (!order) throw new BusinessError(404, "order_not_found", "订单不存在");
    return order;
  }
}

function sameOrderIntent(
  order: OrderRecord,
  input: { product: string; quantity: number; sellPrice: string; recipientHash?: string },
): boolean {
  return (
    order.product === input.product &&
    order.quantity === input.quantity &&
    moneyToCents(order.sell_price) === moneyToCents(input.sellPrice) &&
    (order.fulfillment_recipient_hash ?? null) === (input.recipientHash ?? null)
  );
}

function normalizeOptionalRecipient(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    return normalizeXUsername(value);
  } catch {
    throw new BusinessError(422, "invalid_recipient", "X 用户名格式无效");
  }
}

function makeOrderId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `UP${stamp}${randomBytes(5).toString("hex").toUpperCase()}`;
}
