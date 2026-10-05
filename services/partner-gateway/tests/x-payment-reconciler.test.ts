import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { AlipaySdk } from "alipay-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import type { OrderRecord } from "../src/domain.js";
import { AlipayPaymentClient, MockPaymentClient, type PaymentConfirmation } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { MockXApiClient } from "../src/clients/x-api.js";
import { ActivationService } from "../src/services/activation-service.js";
import { OrderService } from "../src/services/order-service.js";
import { XPaymentReconciler } from "../src/services/x-payment-reconciler.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";

describe("X payment background reconciliation", () => {
  let directory: string;
  let config: AppConfig;
  let db: AppDatabase;
  let payment: MockPaymentClient;
  let orders: OrderService;
  let activations: ActivationService;
  let workers: XPaymentReconciler[];
  let connections: AppDatabase[];
  let orderCount: number;
  let logger: FastifyBaseLogger;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T10:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("test_external_network_forbidden"); }));
    directory = mkdtempSync(join(tmpdir(), "jd-payment-reconcile-"));
    config = ledgerTestConfig(join(directory, "test.sqlite"));
    config.xApi.mode = "mock";
    config.products = [{
      product: "x_premium_3m", plan: "x_premium_3m", name_zh: "蓝V 3个月", name: "X Premium 3 Months",
      internal_cost_cny: "15.00", cost_price: "22.00", max_sell_price: "99.00", currency: "CNY", max_qty: 1, enabled: true,
    }];
    db = new AppDatabase(config.databasePath);
    db.seedProducts(config.products);
    payment = new MockPaymentClient(config.publicBaseUrl);
    vi.spyOn(payment, "createPaymentUrl");
    vi.spyOn(payment, "refundPayment");
    vi.spyOn(payment, "queryRefund");
    vi.spyOn(payment, "verifyNotification");
    orders = new OrderService(db, payment, new MockZovoClient(), new MockXApiClient(), {
      encryptionKey: config.sessionEncryptionKey, hmacKey: config.emailHmacKey,
    });
    activations = new ActivationService(config, db);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
    workers = [];
    connections = [];
    orderCount = 0;
  });

  afterEach(async () => {
    for (const worker of workers) await worker.stop();
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(orderCount);
    expect(payment.refundPayment).not.toHaveBeenCalled();
    expect(payment.queryRefund).not.toHaveBeenCalled();
    expect(payment.verifyNotification).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    for (const connection of connections) connection.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function pending(): Promise<OrderRecord> {
    orderCount += 1;
    const result = await orders.createOrder({ product: "x_premium_3m", quantity: 1, sellPrice: "30.00",
      clientOrderId: `JD-RECONCILE-${orderCount}`, recipient: `user_${orderCount}` });
    advance(1);
    return result.order;
  }

  function worker(connection = db, service = activations): XPaymentReconciler {
    const value = new XPaymentReconciler(connection, payment, service, logger);
    workers.push(value);
    return value;
  }

  function advance(ms: number): void { vi.setSystemTime(new Date(Date.now() + ms)); }
  function paid(tradeNo = "alipay-confirmed"): PaymentConfirmation {
    return { paid: true, tradeNo, paidAt: new Date().toISOString(), receiptAmount: "30.00", tradeStatus: "TRADE_SUCCESS" };
  }
  function state(order: OrderRecord) {
    return db.db.prepare("SELECT * FROM x_payment_reconciliation WHERE order_id=?").get(order.order_id) as {
      next_check: string; lease_token: string | null; lease_until: string | null;
      last_error_code: string | null; check_count: number;
    } | undefined;
  }
  function paidEvents(order: OrderRecord): number {
    return Number((db.db.prepare("SELECT COUNT(*) AS n FROM webhook_outbox WHERE event_key=?")
      .get(`${order.order_id}:order.paid`) as { n: number }).n);
  }
  function expire(order: OrderRecord, agoMs: number): void {
    db.db.prepare("UPDATE orders SET status='expired',expires_at=? WHERE order_id=?")
      .run(new Date(Date.now() - agoMs).toISOString(), order.order_id);
  }
  function deferred<T>() {
    let resolve!: (result: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
  }

  it("recovers a missing callback using only the read-only query and enqueues once", async () => {
    const order = await pending();
    const query = vi.spyOn(payment, "queryPayment").mockResolvedValue(paid());
    const reconcile = worker();
    await reconcile.tick();
    await reconcile.tick();
    expect(query).toHaveBeenCalledTimes(1);
    expect(db.getOrder(order.order_id)).toMatchObject({ status: "paid", alipay_trade_no: "alipay-confirmed" });
    expect(db.listActivations(order.order_id)).toHaveLength(1);
    expect(db.listActivations(order.order_id)[0]).toMatchObject({ status: "queued", finished: 0 });
    expect(paidEvents(order)).toBe(1);
    expect(state(order)).toMatchObject({ lease_token: null, last_error_code: null, check_count: 1 });
  });

  it("still records a confirmed payment after the client payment window expired", async () => {
    const order = await pending();
    expire(order, 25 * 60 * 60_000);
    vi.spyOn(payment, "queryPayment").mockResolvedValue({ ...paid(), tradeStatus: "TRADE_FINISHED" });
    await worker().tick();
    expect(db.getOrder(order.order_id)?.status).toBe("paid");
    expect(db.listActivations(order.order_id)).toHaveLength(1);
    expect(paidEvents(order)).toBe(1);
  });

  it.each(["signed_success", "amount_mismatch", "signature_rejected"])(
    "requires signed amount-checked Alipay query evidence: %s", async (scenario) => {
      const order = await pending();
      const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
      const exec = vi.spyOn(AlipaySdk.prototype, "exec");
      if (scenario === "signature_rejected") exec.mockRejectedValue(new Error("SDK signature failed private-response"));
      else exec.mockResolvedValue({ code: "10000", msg: "Success", tradeStatus: "TRADE_SUCCESS", tradeNo: "verified-alipay-trade",
        totalAmount: scenario === "amount_mismatch" ? "0.01" : "30.00", receiptAmount: "30.00" });
      const client = new AlipayPaymentClient({ ...config.alipay, appId: "2021000000000000",
        sellerId: "2088000000000000", gateway: "https://openapi.alipay.com/gateway.do",
        privateKey: keyPair.privateKey, publicKey: keyPair.publicKey });
      const reconcile = new XPaymentReconciler(db, client, activations, logger);
      workers.push(reconcile);
      await reconcile.tick();
      expect(exec).toHaveBeenCalledExactlyOnceWith("alipay.trade.query",
        { bizContent: { out_trade_no: order.order_id } }, { validateSign: true });
      expect(db.getOrder(order.order_id)?.status).toBe(scenario === "signed_success" ? "paid" : "pending");
      expect(db.listActivations(order.order_id)).toHaveLength(scenario === "signed_success" ? 1 : 0);
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("private-response");
    });

  it.each([
    { tradeNo: null }, { tradeNo: " " }, { tradeStatus: "TRADE_CLOSED" }, { paidAt: "not-a-time" },
  ])("rejects incomplete or contradictory paid evidence %j", async (override) => {
    const order = await pending();
    vi.spyOn(payment, "queryPayment").mockResolvedValue({ ...paid(), ...override });
    await worker().tick();
    expect(db.getOrder(order.order_id)?.status).toBe("pending");
    expect(db.listActivations(order.order_id)).toHaveLength(0);
    expect(state(order)?.last_error_code).toBe("payment_confirmation_invalid");
    expect(paidEvents(order)).toBe(0);
  });

  it("backs off failed queries without changing payment status or leaking upstream text", async () => {
    const order = await pending();
    const query = vi.spyOn(payment, "queryPayment").mockRejectedValue(new Error("TIMEOUT secret-key response-body"));
    const reconcile = worker();
    await reconcile.tick();
    expect(state(order)?.next_check).toBe(new Date(Date.now() + 15_000).toISOString());
    await reconcile.tick();
    advance(14_999);
    await reconcile.tick();
    expect(query).toHaveBeenCalledTimes(1);
    advance(1);
    await reconcile.tick();
    expect(query).toHaveBeenCalledTimes(2);
    expect(db.getOrder(order.order_id)?.status).toBe("pending");
    expect(state(order)).toMatchObject({ lease_token: null, last_error_code: "payment_query_unavailable" });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toMatch(/secret-key|response-body|TIMEOUT/);
    expect(db.listActivations(order.order_id)).toHaveLength(0);
  });

  it("is idempotent when the signed payment callback and query complete together", async () => {
    const order = await pending();
    const response = deferred<PaymentConfirmation>();
    const query = vi.spyOn(payment, "queryPayment").mockReturnValue(response.promise);
    const reconcile = worker();
    const checking = reconcile.tick();
    const sameTick = reconcile.tick();
    expect(checking).toBe(sameTick);
    db.markOrderPaid(order.order_id, new Date().toISOString(), "alipay-confirmed", "30.00");
    activations.createForPaidOrder(order.order_id);
    response.resolve(paid());
    await checking;
    expect(query).toHaveBeenCalledTimes(1);
    expect(db.listActivations(order.order_id)).toHaveLength(1);
    expect(paidEvents(order)).toBe(1);
  });

  it("holds a persistent lease across two database connections", async () => {
    const order = await pending();
    const response = deferred<PaymentConfirmation>();
    const query = vi.spyOn(payment, "queryPayment").mockReturnValue(response.promise);
    const first = worker();
    const otherDb = new AppDatabase(config.databasePath);
    connections.push(otherDb);
    const second = worker(otherDb, new ActivationService(config, otherDb));
    const checking = first.tick();
    await second.tick();
    expect(query).toHaveBeenCalledTimes(1);
    expect(state(order)?.lease_token).toBeTruthy();
    response.resolve(paid());
    await checking;
    expect(db.listActivations(order.order_id)).toHaveLength(1);
    expect(state(order)?.lease_token).toBeNull();
  });

  it("takes at most five due orders and does not starve newer orders behind unpaid ones", async () => {
    const created: OrderRecord[] = [];
    for (let index = 0; index < 7; index += 1) created.push(await pending());
    const query = vi.spyOn(payment, "queryPayment");
    const reconcile = worker();
    await reconcile.tick();
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls.map(([order]) => order.order_id)).toEqual(created.slice(0, 5).map((o) => o.order_id));
    await reconcile.tick();
    expect(query).toHaveBeenCalledTimes(7);
    expect(query.mock.calls.slice(5).map(([order]) => order.order_id)).toEqual(created.slice(5).map((o) => o.order_id));
    await reconcile.tick();
    expect(query).toHaveBeenCalledTimes(7);
  });

  it("uses persisted five-minute and daily backoff after expiry", async () => {
    const recent = await pending();
    const old = await pending();
    expire(recent, 60_000);
    expire(old, 24 * 60 * 60_000);
    const query = vi.spyOn(payment, "queryPayment");
    const first = worker();
    await first.tick();
    expect(state(recent)?.next_check).toBe(new Date(Date.now() + 5 * 60_000).toISOString());
    expect(state(old)?.next_check).toBe(new Date(Date.now() + 24 * 60 * 60_000).toISOString());
    await first.stop();
    const restarted = worker();
    await restarted.tick();
    expect(query).toHaveBeenCalledTimes(2);
    advance(5 * 60_000);
    await restarted.tick();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0].order_id).toBe(recent.order_id);
  });

  it("reclaims a crashed lease and discards the stale owner's eventual response", async () => {
    const order = await pending();
    const response = deferred<PaymentConfirmation>();
    const query = vi.spyOn(payment, "queryPayment")
      .mockReturnValueOnce(response.promise).mockResolvedValue(paid("recovered-trade"));
    const first = worker();
    const checking = first.tick();
    const oldToken = state(order)?.lease_token;
    advance(60_001);
    await worker().tick();
    expect(query).toHaveBeenCalledTimes(2);
    expect(oldToken).toBeTruthy();
    response.resolve(paid("stale-owner-trade"));
    await checking;
    expect(db.getOrder(order.order_id)?.alipay_trade_no).toBe("recovered-trade");
    expect(db.listActivations(order.order_id)).toHaveLength(1);
    expect(paidEvents(order)).toBe(1);
  });

  it("recovers a paid order without a task after restart without requerying payment", async () => {
    const order = await pending();
    db.markOrderPaid(order.order_id, new Date().toISOString(), "callback-before-crash", "30.00");
    const query = vi.spyOn(payment, "queryPayment");
    const first = worker();
    await first.tick();
    await first.stop();
    await worker().tick();
    expect(query).not.toHaveBeenCalled();
    expect(db.listActivations(order.order_id)).toHaveLength(1);
    expect(paidEvents(order)).toBe(1);
  });

  it("keeps confirmed payment and retries local task creation if enqueue briefly fails", async () => {
    const order = await pending();
    const query = vi.spyOn(payment, "queryPayment").mockResolvedValue(paid());
    const create = vi.spyOn(activations, "createForPaidOrder").mockImplementationOnce(() => { throw new Error("private data"); });
    const reconcile = worker();
    await reconcile.tick();
    expect(db.getOrder(order.order_id)?.status).toBe("paid");
    expect(db.listActivations(order.order_id)).toHaveLength(0);
    expect(state(order)?.last_error_code).toBe("payment_activation_enqueue_failed");
    advance(15_000);
    await reconcile.tick();
    expect(create).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(db.listActivations(order.order_id)).toHaveLength(1);
    expect(paidEvents(order)).toBe(1);
  });

  it("ignores non-X, manual, cash, closed and refunded orders", async () => {
    const gpt = await pending();
    const manual = await pending();
    const cash = await pending();
    const closed = await pending();
    const refunded = await pending();
    const paidManual = await pending();
    db.db.prepare("UPDATE orders SET plan='plus' WHERE order_id=?").run(gpt.order_id);
    db.db.prepare("UPDATE orders SET order_source='manual' WHERE order_id=?").run(manual.order_id);
    db.db.prepare("UPDATE orders SET payment_channel='cash' WHERE order_id=?").run(cash.order_id);
    db.db.prepare("UPDATE orders SET status='closed' WHERE order_id=?").run(closed.order_id);
    db.db.prepare("UPDATE orders SET status='refunded',refunded_at=? WHERE order_id=?")
      .run(new Date().toISOString(), refunded.order_id);
    db.db.prepare("UPDATE orders SET status='paid',order_source='manual' WHERE order_id=?").run(paidManual.order_id);
    const query = vi.spyOn(payment, "queryPayment").mockResolvedValue(paid());
    await worker().tick();
    expect(query).not.toHaveBeenCalled();
    expect(db.db.prepare("SELECT * FROM activations").all()).toHaveLength(0);
    expect(db.getOrder(closed.order_id)?.status).toBe("closed");
    expect(db.getOrder(refunded.order_id)?.status).toBe("refunded");
  });

  it("never reopens an order with an existing refund, including an abnormal pending state", async () => {
    const order = await pending();
    db.markOrderPaid(order.order_id, new Date().toISOString(), "callback-refund", "30.00");
    db.createRefund({ refundId: "refund-existing", orderId: order.order_id, clientRefundId: "refund-client",
      amount: "30.00", reason: "test", requestedBy: "admin", now: new Date().toISOString() });
    const query = vi.spyOn(payment, "queryPayment").mockResolvedValue(paid());
    const reconcile = worker();
    await reconcile.tick();
    db.db.prepare("UPDATE orders SET status='pending' WHERE order_id=?").run(order.order_id);
    await reconcile.tick();
    expect(query).not.toHaveBeenCalled();
    expect(db.listActivations(order.order_id)).toHaveLength(0);
    expect(db.getOrder(order.order_id)?.status).toBe("pending");
  });

  it.each(["refunded", "closed", "refund_requested"])("does not reopen %s during a slow query", async (status) => {
    const order = await pending();
    const response = deferred<PaymentConfirmation>();
    vi.spyOn(payment, "queryPayment").mockReturnValue(response.promise);
    const checking = worker().tick();
    db.markOrderPaid(order.order_id, new Date().toISOString(), "callback-refund", "30.00");
    if (status === "refund_requested") {
      db.createRefund({ refundId: "refund-race", orderId: order.order_id, clientRefundId: "refund-race-client",
        amount: "30.00", reason: "test", requestedBy: "admin", now: new Date().toISOString() });
    } else db.db.prepare("UPDATE orders SET status=? WHERE order_id=?").run(status, order.order_id);
    response.resolve(paid());
    await checking;
    expect(db.getOrder(order.order_id)?.status).toBe(status === "refund_requested" ? "paid" : status);
    expect(db.listActivations(order.order_id)).toHaveLength(0);
  });

  it("drains the active read on stop, records its result and does not claim the next order", async () => {
    const first = await pending();
    const second = await pending();
    const response = deferred<PaymentConfirmation>();
    const query = vi.spyOn(payment, "queryPayment").mockReturnValue(response.promise);
    const reconcile = worker();
    const checking = reconcile.tick();
    let stopped = false;
    const stopping = reconcile.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    response.resolve(paid());
    await Promise.all([checking, stopping]);
    expect(stopped).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(db.getOrder(first.order_id)?.status).toBe("paid");
    expect(db.getOrder(second.order_id)?.status).toBe("pending");
    expect(state(first)?.lease_token).toBeNull();
    await reconcile.tick();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("starts immediately and polls every fifteen seconds, and stops the interval", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T10:00:00.000Z"));
    await pending();
    const query = vi.spyOn(payment, "queryPayment");
    const reconcile = worker();
    reconcile.start();
    await reconcile.tick();
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    await reconcile.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
