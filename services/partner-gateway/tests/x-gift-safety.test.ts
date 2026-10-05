import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import type { OrderRecord } from "../src/domain.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { MockXApiClient, XApiUpstreamError } from "../src/clients/x-api.js";
import { decryptValue } from "../src/security.js";
import { OrderService } from "../src/services/order-service.js";
import { ActivationService } from "../src/services/activation-service.js";
import { ActivationWorker } from "../src/services/activation-worker.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";

describe("X gift payment and fulfillment safety boundaries", () => {
  let directory: string;
  let config: AppConfig;
  let db: AppDatabase;
  let payment: MockPaymentClient;
  let zovo: MockZovoClient;
  let xApi: MockXApiClient;
  let orders: OrderService;
  let activations: ActivationService;
  let workers: ActivationWorker[];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T10:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("test_external_network_forbidden"); }));
    directory = mkdtempSync(join(tmpdir(), "jd-x-safety-"));
    config = ledgerTestConfig(join(directory, "test.sqlite"));
    config.xApi.mode = "mock";
    config.products = [{
      product: "x_premium_3m", plan: "x_premium_3m", name_zh: "蓝V 3个月", name: "X Premium 3 Months",
      internal_cost_cny: "15.00", cost_price: "30.00", max_sell_price: "50.00", currency: "CNY", max_qty: 1, enabled: true,
    }];
    db = new AppDatabase(config.databasePath);
    db.seedProducts(config.products);
    payment = new MockPaymentClient(config.publicBaseUrl);
    zovo = new MockZovoClient();
    xApi = new MockXApiClient();
    orders = new OrderService(db, payment, zovo, xApi, {
      encryptionKey: config.sessionEncryptionKey, hmacKey: config.emailHmacKey,
    });
    activations = new ActivationService(config, db);
    workers = [];
  });

  afterEach(async () => {
    for (const worker of workers) await worker.stop();
    expect(fetch).not.toHaveBeenCalled();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function input(clientOrderId = "JD-SAFE-001", recipient = "@Example_User") {
    return { product: "x_premium_3m", quantity: 1, sellPrice: "30.00", clientOrderId, recipient };
  }

  async function paidOrder(clientOrderId = "JD-SAFE-001"): Promise<OrderRecord> {
    const { order } = await orders.createOrder(input(clientOrderId));
    return db.markOrderPaid(order.order_id, new Date().toISOString(), `alipay-${clientOrderId}`, "30.00");
  }

  function worker(): ActivationWorker {
    const value = new ActivationWorker(config, db, zovo, logger, xApi);
    workers.push(value);
    return value;
  }

  function nextPoll(): void { vi.setSystemTime(new Date(Date.now() + 31_000)); }

  function submission(orderId: string) {
    return db.db.prepare(`SELECT s.* FROM x_gift_submissions s JOIN activations a ON a.id=s.activation_id
      WHERE a.order_id=?`).get(orderId) as {
        activation_id: number; merchant_order_no: string; request_json: string; submit_started_at: string;
      } | undefined;
  }

  function activatedEvents(orderId: string): number {
    return Number((db.db.prepare("SELECT COUNT(*) AS count FROM webhook_outbox WHERE event_key=?")
      .get(`${orderId}:order.activated`) as { count: number }).count);
  }

  it("freezes normalized username, recipient identity, product and points before payment creation", async () => {
    const createPayment = vi.spyOn(payment, "createPaymentUrl");
    const { order } = await orders.createOrder(input());
    const frozen = JSON.parse(decryptValue({
      ciphertext: order.fulfillment_recipient_ciphertext!, iv: order.fulfillment_recipient_iv!, tag: order.fulfillment_recipient_tag!,
    }, config.sessionEncryptionKey, "order-recipient"));
    expect(frozen).toEqual({ username: "example_user", recipient_id: "123456789", product_code: "x-premium-3m", expected_points: 300 });
    expect(order.fulfillment_recipient_ciphertext).not.toContain("example_user");
    expect(order.fulfillment_recipient_hash).toBeTruthy();
    expect(createPayment).toHaveBeenCalledTimes(1);
    expect(db.listActivations(order.order_id)).toHaveLength(0);
    expect(xApi.orders.size).toBe(0);

    vi.spyOn(xApi, "eligibility").mockRejectedValue(new Error("upstream changed after checkout"));
    vi.spyOn(xApi, "product").mockResolvedValue({ code: "x-premium-3m", points: 600, enabled: true });
    const replay = await orders.createOrder(input("JD-SAFE-001", "example_user"));
    expect(replay).toMatchObject({ idempotent: true, order: { order_id: order.order_id,
      fulfillment_recipient_ciphertext: order.fulfillment_recipient_ciphertext } });
    expect(createPayment).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous checkouts and rejects account changes under the same client order number", async () => {
    const createPayment = vi.spyOn(payment, "createPaymentUrl");
    const [first, duplicate] = await Promise.all([orders.createOrder(input()), orders.createOrder(input())]);
    expect(first.order.order_id).toBe(duplicate.order.order_id);
    expect(duplicate.idempotent).toBe(true);
    expect(createPayment).toHaveBeenCalledTimes(1);
    await expect(orders.createOrder(input("JD-SAFE-001", "other_user"))).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(db.getOrder(first.order.order_id)?.fulfillment_recipient_masked).toBe("@example_user");
    expect(createPayment).toHaveBeenCalledTimes(1);
  });

  it("rejects an ineligible account before generating a payment or reserving checkout", async () => {
    const createPayment = vi.spyOn(payment, "createPaymentUrl");
    vi.spyOn(xApi, "eligibility").mockResolvedValue({ username: "example_user", eligible: false, reason: "not_eligible" });
    await expect(orders.createOrder(input())).rejects.toMatchObject({ code: "recipient_not_eligible", httpStatus: 422 });
    expect(createPayment).not.toHaveBeenCalled();
    expect(db.getOrderByClientId("JD-SAFE-001")).toBeUndefined();
    expect(db.db.prepare("SELECT * FROM checkout_intents").all()).toHaveLength(0);
  });

  it("does not collect payment when recipient verification is unavailable", async () => {
    const createPayment = vi.spyOn(payment, "createPaymentUrl");
    vi.spyOn(xApi, "eligibility").mockRejectedValue(new XApiUpstreamError("x_api_timeout", 504, "x_api_timeout"));
    await expect(orders.createOrder(input())).rejects.toMatchObject({ code: "recipient_check_unavailable", httpStatus: 503 });
    expect(createPayment).not.toHaveBeenCalled();
    expect(db.getOrderByClientId("JD-SAFE-001")).toBeUndefined();
    expect(xApi.orders.size).toBe(0);
  });

  it("recovers a paid order with no task after restart exactly once and ignores an unpaid order", async () => {
    const paid = await paidOrder();
    const pending = (await orders.createOrder(input("JD-SAFE-PENDING", "pending_user"))).order;
    expect(db.listActivations(paid.order_id)).toHaveLength(0);
    new ActivationService(config, db).reconcilePaidOrders();
    new ActivationService(config, db).reconcilePaidOrders();
    const [task] = db.listActivations(paid.order_id);
    expect(task).toMatchObject({ status: "queued", finished: 0, worker_state: "queued" });
    expect(db.listActivations(paid.order_id)).toHaveLength(1);
    expect(db.listActivations(pending.order_id)).toHaveLength(0);
    expect(activations.createForPaidOrder(paid.order_id)?.id).toBe(task.id);
    expect(activations.createForPaidOrder(pending.order_id)).toBeUndefined();
  });

  it("returns the original activation for repeat calls and never allows a different paid recipient", async () => {
    const order = await paidOrder();
    const first = activations.create(order.order_id, { username: "example_user" });
    expect(activations.create(order.order_id, "@Example_User").id).toBe(first.id);
    expect(() => activations.create(order.order_id, { username: "other_user" }))
      .toThrow(expect.objectContaining({ code: "recipient_mismatch" }));
    db.markActivationFailed(first.id, "payment_blocked", "test definitive rejection", new Date().toISOString());
    expect(activations.create(order.order_id, { username: "example_user" }).id).toBe(first.id);
    expect(db.listActivations(order.order_id)).toHaveLength(1);
    expect(xApi.orders.size).toBe(0);
  });

  it("persists the immutable submission and polling state before the charge-creating request", async () => {
    const order = await paidOrder();
    const original = xApi.createOrder.bind(xApi);
    const createGift = vi.spyOn(xApi, "createOrder").mockImplementation(async (request) => {
      const evidence = submission(order.order_id)!;
      expect(evidence).toMatchObject({ merchant_order_no: `jd:${order.order_id}` });
      expect(JSON.parse(evidence.request_json)).toEqual({
        merchantOrderNo: `jd:${order.order_id}`, idempotencyKey: `jd:${order.order_id}`,
        productCode: "x-premium-3m", recipient: "example_user", recipientId: "123456789", expectedPoints: 300,
      });
      expect(db.listActivations(order.order_id)[0]).toMatchObject({ worker_state: "polling", redemption_token: `jd:${order.order_id}` });
      return original(request);
    });
    await worker().tick();
    expect(createGift).toHaveBeenCalledTimes(1);
    expect(db.listActivations(order.order_id)).toHaveLength(1);
    expect(db.db.prepare("SELECT * FROM cdks").all()).toHaveLength(0);
  });

  it("queries the original order after an accepted POST loses its response and succeeds without resubmission", async () => {
    const order = await paidOrder();
    const original = xApi.createOrder.bind(xApi);
    const createGift = vi.spyOn(xApi, "createOrder").mockImplementation(async (request) => {
      await original(request);
      throw new XApiUpstreamError("x_api_timeout", 504, "x_api_timeout");
    });
    const lookup = vi.spyOn(xApi, "findByMerchantOrder");
    await worker().tick();
    expect(db.listActivations(order.order_id)[0]).toMatchObject({ worker_state: "polling", finished: 0, upstream_order_id: null });
    expect(submission(order.order_id)).toBeTruthy();
    xApi.setStatus(`jd:${order.order_id}`, "succeeded");
    nextPoll();
    await worker().tick();
    expect(lookup).toHaveBeenLastCalledWith(`jd:${order.order_id}`);
    expect(createGift).toHaveBeenCalledTimes(1);
    expect(db.getOrder(order.order_id)).toMatchObject({ status: "paid", delivery_status: "success" });
    expect(activatedEvents(order.order_id)).toBe(1);
    nextPoll();
    await worker().tick();
    expect(createGift).toHaveBeenCalledTimes(1);
    expect(activatedEvents(order.order_id)).toBe(1);
  });

  it.each(["not_found", "unauthorized"])("never POSTs again after a timeout followed by %s, including worker restarts", async (lookupResult) => {
    const order = await paidOrder();
    const createGift = vi.spyOn(xApi, "createOrder")
      .mockRejectedValue(new XApiUpstreamError("x_api_timeout", 504, "x_api_timeout"));
    const lookup = vi.spyOn(xApi, "findByMerchantOrder").mockResolvedValueOnce(undefined);
    if (lookupResult === "not_found") lookup.mockResolvedValue(undefined); // Exact 404 is decoded to undefined by the live client.
    else lookup.mockRejectedValue(new XApiUpstreamError("unauthorized", 401, "unauthorized"));
    await worker().tick();
    for (let index = 0; index < 3; index++) {
      nextPoll();
      await worker().tick();
    }
    expect(createGift).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(db.listActivations(order.order_id)[0]).toMatchObject({ worker_state: "polling", finished: 0, status: "running" });
    expect(db.getOrder(order.order_id)?.delivery_status).not.toBe("success");
    expect(activatedEvents(order.order_id)).toBe(0);
    expect(db.db.prepare("SELECT * FROM refunds").all()).toHaveLength(0);
  });

  it("keeps unknown results pollable, blocks refund while uncertain, and later converges to success", async () => {
    const order = await paidOrder();
    const createGift = vi.spyOn(xApi, "createOrder");
    const activeWorker = worker();
    await activeWorker.tick();
    xApi.setStatus(`jd:${order.order_id}`, "unknown", "result_unconfirmed");
    await activeWorker.tick();
    const task = db.listActivations(order.order_id)[0];
    expect(task).toMatchObject({ finished: 0, worker_state: "polling", status: "running" });
    expect(task.message_zh).toContain("核对");
    expect(db.db.prepare("SELECT needs_review FROM activation_worker_control WHERE activation_id=?").get(task.id))
      .toMatchObject({ needs_review: 0 });
    expect(() => db.createRefund({ refundId: "ref_test", orderId: order.order_id, clientRefundId: "test_refund",
      amount: "30.00", reason: "uncertain result", requestedBy: "platform", now: new Date().toISOString() }))
      .toThrow("activation_in_progress");
    xApi.setStatus(`jd:${order.order_id}`, "succeeded");
    nextPoll();
    await worker().tick();
    expect(db.listActivations(order.order_id)[0]).toMatchObject({ status: "success", finished: 1, worker_state: "terminal" });
    expect(createGift).toHaveBeenCalledTimes(1);
    expect(activatedEvents(order.order_id)).toBe(1);
  });

  it.each([
    { recipient: "different_user" },
    { product_code: "x-premium-6m" },
    { points: 600 },
  ])("rejects a claimed success whose frozen recipient/product/points do not match: %j", async (corruption) => {
    const order = await paidOrder();
    const createGift = vi.spyOn(xApi, "createOrder");
    await worker().tick();
    const upstream = xApi.orders.get(`jd:${order.order_id}`)!;
    vi.spyOn(xApi, "getOrder").mockResolvedValue({ ...upstream, status: "succeeded", receipt: "pi_claimed_success", ...corruption });
    await worker().tick();
    expect(db.listActivations(order.order_id)[0]).toMatchObject({ finished: 0, worker_state: "polling" });
    expect(db.getOrder(order.order_id)?.delivery_status).not.toBe("success");
    expect(activatedEvents(order.order_id)).toBe(0);
    expect(createGift).toHaveBeenCalledTimes(1);
  });

  it("refuses fulfillment when the username now resolves to a different numeric recipient identity", async () => {
    const order = await paidOrder();
    const createGift = vi.spyOn(xApi, "createOrder");
    vi.spyOn(xApi, "eligibility").mockResolvedValue({ username: "example_user", eligible: true, recipient_id: "987654321" });
    await worker().tick();
    expect(createGift).not.toHaveBeenCalled();
    expect(submission(order.order_id)).toBeUndefined();
    expect(db.listActivations(order.order_id)[0]).toMatchObject({ status: "failed", finished: 1, failure_code: "account_not_eligible" });
    expect(db.getOrder(order.order_id)?.status).toBe("paid");
    expect(activatedEvents(order.order_id)).toBe(0);
    expect(db.db.prepare("SELECT * FROM refunds").all()).toHaveLength(0);
  });

  it.each(["existing_lookup", "create_response", "poll_response"])(
    "does not bind a wrong-recipient order ID from %s and later recovers the legitimate original", async (phase) => {
      const order = await paidOrder();
      const merchantOrderNo = `jd:${order.order_id}`;
      const originalCreate = xApi.createOrder.bind(xApi);
      const originalLookup = xApi.findByMerchantOrder.bind(xApi);
      const wrong = {
        id: `ord_${"f".repeat(32)}`, merchant_order_no: merchantOrderNo, product_code: "x-premium-3m",
        recipient: "wrong_recipient", points: 300, status: "succeeded" as const, receipt: "pi_wrong_paid", failure_code: null,
      };
      const lookup = vi.spyOn(xApi, "findByMerchantOrder").mockImplementation(originalLookup);
      const getById = vi.spyOn(xApi, "getOrder");
      const createGift = vi.spyOn(xApi, "createOrder").mockImplementation(originalCreate);
      if (phase === "existing_lookup") {
        await originalCreate({ merchantOrderNo, productCode: "x-premium-3m", recipient: "example_user", expectedPoints: 300 });
        lookup.mockResolvedValueOnce(wrong);
      } else if (phase === "create_response") {
        createGift.mockImplementationOnce(async (request) => {
          await originalCreate(request);
          return wrong;
        });
      } else {
        createGift.mockImplementationOnce(async (request) => {
          await originalCreate(request);
          throw new XApiUpstreamError("x_api_timeout", 504, "x_api_timeout");
        });
      }
      await worker().tick();
      if (phase === "poll_response") {
        lookup.mockResolvedValueOnce(wrong);
        nextPoll();
        await worker().tick();
      }
      expect(db.listActivations(order.order_id)[0]).toMatchObject({ upstream_order_id: null, finished: 0, worker_state: "polling" });
      expect(activatedEvents(order.order_id)).toBe(0);
      expect(getById).not.toHaveBeenCalled();

      const legitimate = xApi.orders.get(merchantOrderNo)!;
      expect(legitimate.id).not.toBe(wrong.id);
      xApi.setStatus(merchantOrderNo, "succeeded");
      legitimate.receipt = "pi_correct_paid";
      nextPoll();
      await worker().tick();
      expect(lookup).toHaveBeenLastCalledWith(merchantOrderNo);
      expect(createGift).toHaveBeenCalledTimes(phase === "existing_lookup" ? 0 : 1);
      expect(db.listActivations(order.order_id)[0]).toMatchObject({
        upstream_order_id: legitimate.id, status: "success", finished: 1, worker_state: "terminal",
      });
      expect(activatedEvents(order.order_id)).toBe(1);
      expect(db.getOrder(order.order_id)?.delivery_status).toBe("success");
    },
  );
});
