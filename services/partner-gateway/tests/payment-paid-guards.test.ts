import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AppDatabase } from "../src/database.js";
import { MockPaymentClient, type PaymentConfirmation } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { MockXApiClient } from "../src/clients/x-api.js";
import { OrderService } from "../src/services/order-service.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";

describe("transactional paid-order guards", () => {
  let directory: string;
  let db: AppDatabase;
  let config: ReturnType<typeof ledgerTestConfig>;
  let payment: MockPaymentClient;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orders: OrderService;
  let serial: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "jd-paid-guard-"));
    config = ledgerTestConfig(join(directory, "gateway.sqlite"));
    config.xApi.mode = "mock";
    config.products = [{ product: "x_premium_3m", plan: "x_premium_3m", name_zh: "蓝V 3个月",
      name: "X Premium 3 Months", cost_price: "22.00", internal_cost_cny: "15.00",
      max_sell_price: "99.00", currency: "CNY", max_qty: 1, enabled: true }];
    db = new AppDatabase(config.databasePath);
    payment = new MockPaymentClient(config.publicBaseUrl);
    const zovo = new MockZovoClient();
    const xApi = new MockXApiClient();
    app = await buildApp(config, { db, payment, zovo, xApi, startWorkers: false });
    orders = new OrderService(db, payment, zovo, xApi, {
      encryptionKey: config.sessionEncryptionKey, hmacKey: config.emailHmacKey,
    });
    serial = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("test_external_network_forbidden"); }));
    vi.spyOn(payment, "refundPayment");
  });

  afterEach(async () => {
    expect(fetch).not.toHaveBeenCalled();
    expect(payment.refundPayment).not.toHaveBeenCalled();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function pending() {
    return (await orders.createOrder({ product: "x_premium_3m", quantity: 1, sellPrice: "30.00",
      clientOrderId: `ADMINTEST-GUARD-${++serial}`, recipient: "guard_user" })).order;
  }
  async function paid() {
    const order = await pending();
    return db.markOrderPaid(order.order_id, "2026-10-05T10:00:00.000Z", "original-trade", "30.00");
  }
  function refund(orderId: string) {
    return db.createRefund({ refundId: `refund-${orderId}`, orderId, clientRefundId: `client-refund-${orderId}`,
      amount: "30.00", reason: "offline test", requestedBy: "admin", now: new Date().toISOString() });
  }
  function lateConfirmation(orderId: string) {
    return db.markOrderPaid(orderId, "2026-10-05T11:00:00.000Z", "late-other-trade", "29.00");
  }
  function paidEventCount(orderId: string) {
    return Number((db.db.prepare("SELECT COUNT(*) AS n FROM webhook_outbox WHERE event_key=?")
      .get(`${orderId}:order.paid`) as { n: number }).n);
  }

  it("rejects closed orders without overwriting original receipts or reconciliation evidence", async () => {
    const order = await paid();
    const closed = db.closeTestOrderWithoutRefund(order.order_id, "管理员已核对关闭");
    db.db.prepare(`INSERT INTO x_payment_reconciliation(order_id,next_check,last_checked_at,last_error_code,updated_at)
      VALUES (?,?,?,?,?)`).run(order.order_id, "2026-10-06T10:00:00.000Z", "2026-10-05T10:01:00.000Z",
      "payment_record_unavailable", "2026-10-05T10:01:00.000Z");
    const evidence = db.db.prepare("SELECT * FROM x_payment_reconciliation WHERE order_id=?").get(order.order_id);
    const audits = db.db.prepare("SELECT * FROM order_audit_log WHERE order_id=?").all(order.order_id);
    expect(() => lateConfirmation(order.order_id)).toThrow("closed_order_cannot_be_paid");
    expect(db.getOrder(order.order_id)).toEqual(closed);
    expect(db.db.prepare("SELECT * FROM x_payment_reconciliation WHERE order_id=?").get(order.order_id)).toEqual(evidence);
    expect(db.db.prepare("SELECT * FROM order_audit_log WHERE order_id=?").all(order.order_id)).toEqual(audits);
    expect(paidEventCount(order.order_id)).toBe(1);
    expect(db.listActivations(order.order_id)).toHaveLength(0);
  });

  it.each(["pending", "expired"])("rejects a %s order with retained refunded_at evidence", async (status) => {
    const order = await paid();
    db.db.prepare("UPDATE orders SET status=?,refunded_at=? WHERE order_id=?")
      .run(status, "2026-10-05T10:30:00.000Z", order.order_id);
    const before = db.getOrder(order.order_id);
    expect(() => lateConfirmation(order.order_id)).toThrow("refunded_order_cannot_be_paid");
    expect(db.getOrder(order.order_id)).toEqual(before);
    expect(db.listActivations(order.order_id)).toHaveLength(0);
    expect(paidEventCount(order.order_id)).toBe(1);
  });

  it("continues refusing refunded orders with or without a populated refund timestamp", async () => {
    const order = await paid();
    db.db.prepare("UPDATE orders SET status='refunded' WHERE order_id=?").run(order.order_id);
    const before = db.getOrder(order.order_id);
    expect(() => lateConfirmation(order.order_id)).toThrow("refunded_order_cannot_be_paid");
    expect(db.getOrder(order.order_id)).toEqual(before);
    expect(paidEventCount(order.order_id)).toBe(1);
  });

  it.each(["requested", "processing", "succeeded", "failed", "rejected"])(
    "blocks an abnormal unpaid order retaining a %s refund record", async (status) => {
      const order = await paid();
      const created = refund(order.order_id);
      db.db.prepare("UPDATE refunds SET status=? WHERE refund_id=?").run(status, created.refund_id);
      db.db.prepare("UPDATE orders SET status='expired' WHERE order_id=?").run(order.order_id);
      const before = db.getOrder(order.order_id);
      const refundBefore = db.getRefundByOrderId(order.order_id);
      expect(() => lateConfirmation(order.order_id)).toThrow("refund_exists_order_cannot_be_paid");
      expect(db.getOrder(order.order_id)).toEqual(before);
      expect(db.getRefundByOrderId(order.order_id)).toEqual(refundBefore);
      expect(db.listActivations(order.order_id)).toHaveLength(0);
      expect(paidEventCount(order.order_id)).toBe(1);
    });

  it("retains existing paid-order idempotence even if a refund is already requested", async () => {
    const order = await paid();
    const created = refund(order.order_id);
    const before = db.getOrder(order.order_id);
    expect(lateConfirmation(order.order_id)).toEqual(before);
    expect(db.getRefundByOrderId(order.order_id)).toEqual(created);
    expect(paidEventCount(order.order_id)).toBe(1);
    expect(db.listActivations(order.order_id)).toHaveLength(0);
  });

  it.each(["pending", "expired"])("still accepts a genuine %s payment exactly once", async (status) => {
    const order = await pending();
    db.db.prepare("UPDATE orders SET status=? WHERE order_id=?").run(status, order.order_id);
    const first = lateConfirmation(order.order_id);
    const second = lateConfirmation(order.order_id);
    expect(first).toMatchObject({ status: "paid", alipay_trade_no: "late-other-trade", alipay_receipt_amount: "29.00" });
    expect(second).toEqual(first);
    expect(paidEventCount(order.order_id)).toBe(1);
  });

  it("reads the latest committed close inside the transaction after another process changed the order", async () => {
    const order = await paid();
    const other = new AppDatabase(config.databasePath);
    try {
      expect(db.getOrder(order.order_id)?.status).toBe("paid");
      other.closeTestOrderWithoutRefund(order.order_id, "另一进程关闭");
      expect(() => lateConfirmation(order.order_id)).toThrow("closed_order_cannot_be_paid");
      expect(other.getOrder(order.order_id)?.status).toBe("closed");
      expect(db.listActivations(order.order_id)).toHaveLength(0);
    } finally { other.close(); }
  });

  it("late callback cannot restart X fulfillment after the order closed while verification was running", async () => {
    const order = await paid();
    let resolve!: (value: PaymentConfirmation) => void;
    let started!: () => void;
    const verificationStarted = new Promise<void>((done) => { started = done; });
    const confirmation = new Promise<PaymentConfirmation>((done) => { resolve = done; });
    vi.spyOn(payment, "verifyNotification").mockImplementation(() => { started(); return confirmation; });
    const callback = app.inject({ method: "POST", url: "/callbacks/alipay", payload: { out_trade_no: order.order_id } });
    await verificationStarted;
    const other = new AppDatabase(config.databasePath);
    try { other.closeTestOrderWithoutRefund(order.order_id, "验证期间管理员关闭"); }
    finally { other.close(); }
    resolve({ paid: true, tradeNo: "original-trade", paidAt: "2026-10-05T10:00:00.000Z",
      receiptAmount: "30.00", tradeStatus: "TRADE_SUCCESS" });
    const response = await callback;
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe("failure");
    expect(db.getOrder(order.order_id)?.status).toBe("closed");
    expect(db.listActivations(order.order_id)).toHaveLength(0);
    expect(paidEventCount(order.order_id)).toBe(1);
  });

  it("still rejects nonexistent orders without adding payment events", () => {
    expect(() => lateConfirmation("missing-order")).toThrow("order_not_found");
    expect(db.db.prepare("SELECT * FROM webhook_outbox").all()).toHaveLength(0);
  });
});
