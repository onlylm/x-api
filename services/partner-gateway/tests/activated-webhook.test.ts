import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AppDatabase } from "../src/database.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { signPlatformWebhook } from "../src/security.js";
import { ActivationService } from "../src/services/activation-service.js";
import { ActivationWorker } from "../src/services/activation-worker.js";
import { OrderService } from "../src/services/order-service.js";
import { PlatformWebhookWorker } from "../src/services/platform-webhook.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";

describe("order.activated platform webhook", () => {
  let directory: string;
  let db: AppDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let config: ReturnType<typeof ledgerTestConfig>;
  let zovo: MockZovoClient;
  let orders: OrderService;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "activated-webhook-"));
    config = ledgerTestConfig(join(directory, "test.sqlite"));
    db = new AppDatabase(config.databasePath);
    zovo = new MockZovoClient();
    const payment = new MockPaymentClient(config.publicBaseUrl);
    app = await buildApp(config, { db, zovo, payment, startWorkers: false });
    orders = new OrderService(db, payment, zovo);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function paidOrder(suffix: string, manual = false) {
    const { order } = await orders.createOrder({
      product: "chatgpt_plus_1m", quantity: 1,
      sellPrice: "135.00", clientOrderId: `po_activated_${suffix}`,
    });
    if (manual) db.markOrderManual({ orderId: order.order_id, customerRef: "internal", note: "内部补录" });
    db.markOrderPaid(order.order_id, new Date().toISOString(), `mock-${suffix}`, "135.00");
    // This test observes only the new event; order.paid has its own coverage.
    db.db.prepare("UPDATE webhook_outbox SET delivered_at = ? WHERE event = 'order.paid'")
      .run(new Date().toISOString());
    return order;
  }

  function activatedEvents(orderId: string) {
    return db.db.prepare("SELECT event, event_key, payload_json, delivered_at FROM webhook_outbox WHERE event_key = ?")
      .all(`${orderId}:order.activated`) as Array<{
        event: string; event_key: string; payload_json: string; delivered_at: string | null;
      }>;
  }

  it("queues automatic success once and sends it only after the success progress is queryable", async () => {
    const order = await paidOrder("auto");
    new ActivationService(config, db).create(order.order_id,
      { user: { email: "buyer@example.com" }, accessToken: "private-session" });
    expect(activatedEvents(order.order_id)).toHaveLength(0);

    await new ActivationWorker(config, db, zovo, app.log).tick();
    const [event] = activatedEvents(order.order_id);
    expect(event).toMatchObject({ event: "order.activated", event_key: `${order.order_id}:order.activated` });
    expect(JSON.parse(event.payload_json)).toEqual({
      event: "order.activated", order_id: order.order_id, client_order_id: order.client_order_id,
    });

    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const progress = await app.inject({
        method: "GET", url: `/api/v1/checkout/orders/${order.order_id}/activation`,
        headers: { "x-api-key": config.platformApiKey },
      });
      expect(progress.statusCode).toBe(200);
      expect(progress.json().items[0]).toMatchObject({
        status: "success", finished: true, account_email: "b***r@example.com",
      });
      const headers = new Headers(init.headers);
      expect(headers.get("X-Webhook-Event")).toBe("order.activated");
      expect(headers.get("X-Webhook-Signature")).toBe(signPlatformWebhook(
        config.platformWebhookSecret, Number(headers.get("X-Webhook-Timestamp")), String(init.body),
      ));
      expect(JSON.parse(String(init.body))).toEqual(JSON.parse(event.payload_json));
      return new Response("success", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const webhookWorker = new PlatformWebhookWorker(config, db, app.log);
    await webhookWorker.tick();
    await webhookWorker.tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(activatedEvents(order.order_id)[0].delivered_at).not.toBeNull();
  });

  it("queues the same signed event for manual success without consuming an upstream CDK", async () => {
    const order = await paidOrder("human");
    const result = db.confirmManualDelivery({
      orderId: order.order_id, taskId: "manual-activated-test", reason: "人工开通已核实",
      accountEmailMasked: "b***r@example.com", emailHash: "email-hash",
    });
    expect(result.activation).toMatchObject({ status: "success", finished: 1, cdk_id: null });
    expect(new ActivationService(config, db).list(order.order_id)).toMatchObject({
      activation_used: 1, activation_remaining: 0,
      items: [expect.objectContaining({ status: "success", finished: true, account_email: "b***r@example.com" })],
    });
    expect(activatedEvents(order.order_id)).toHaveLength(1);
    expect(() => db.confirmManualDelivery({
      orderId: order.order_id, taskId: "manual-activated-repeat", reason: "重复点击",
      accountEmailMasked: "b***r@example.com", emailHash: "email-hash",
    })).toThrow("successful_delivery_is_immutable");
    expect(activatedEvents(order.order_id)).toHaveLength(1);
  });

  it("rolls back the success and event together and never notifies internal manual orders", async () => {
    const platformOrder = await paidOrder("rollback");
    const activation = new ActivationService(config, db).create(platformOrder.order_id,
      { user: { email: "buyer@example.com" }, accessToken: "private-session" });
    expect(() => db.transaction(() => {
      db.markActivationSuccess(activation.id, "b***r@example.com", new Date().toISOString());
      throw new Error("rollback-test");
    })).toThrow("rollback-test");
    expect(db.listActivations(platformOrder.order_id)[0].status).not.toBe("success");
    expect(activatedEvents(platformOrder.order_id)).toHaveLength(0);

    const internalOrder = await paidOrder("internal", true);
    db.confirmManualDelivery({
      orderId: internalOrder.order_id, taskId: "manual-internal", reason: "内部现金单",
      accountEmailMasked: "b***r@example.com", emailHash: "email-hash",
    });
    expect(activatedEvents(internalOrder.order_id)).toHaveLength(0);
  });
});
