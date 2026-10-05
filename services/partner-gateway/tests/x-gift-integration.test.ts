import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { MockXApiClient } from "../src/clients/x-api.js";
import { ActivationWorker } from "../src/services/activation-worker.js";

describe("AI京东蓝V自动履约", () => {
  let directory: string;
  let config: AppConfig;
  let db: AppDatabase;
  let xApi: MockXApiClient;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "jd-x-gift-"));
    config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: join(directory, "gateway.sqlite"),
      SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
      X_API_MODE: "mock",
    });
    config.products = [{
      product: "x_premium_3m",
      name_zh: "X Premium 蓝V 3个月",
      name: "X Premium 3 Months",
      plan: "x_premium_3m",
      internal_cost_cny: "30.00",
      cost_price: "30.00",
      max_sell_price: "30.00",
      currency: "CNY",
      max_qty: 1,
      enabled: true,
    }];
    db = new AppDatabase(config.databasePath);
    xApi = new MockXApiClient();
    app = await buildApp(config, {
      db,
      payment: new MockPaymentClient(config.publicBaseUrl),
      zovo: new MockZovoClient(),
      xApi,
      startWorkers: false,
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("支付前收集用户名，到账后只创建一个任务并查询原单直到成功", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const catalog = await app.inject({ method: "GET", url: "/api/v1/checkout/products", headers });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().items[0]).toMatchObject({
      product: "x_premium_3m",
      fulfillment_type: "x_gift",
      automatic_fulfillment: true,
      required_input: { field: "recipient", type: "x_username", timing: "before_payment" },
    });

    const missingRecipient = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "x_premium_3m",
        quantity: 1,
        sell_price: "30.00",
        client_order_id: "JD-X-MISSING-001",
      },
    });
    expect(missingRecipient.statusCode).toBe(422);
    expect(missingRecipient.json().error).toBe("recipient_required");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "x_premium_3m",
        quantity: 1,
        sell_price: "30.00",
        client_order_id: "JD-X-ORDER-001",
        recipient: "@Example_User",
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ recipient: "@example_user", status: "pending" });
    const orderId = String(created.json().order_id);
    const stored = db.getOrder(orderId)!;
    expect(stored.fulfillment_recipient_ciphertext).toBeTruthy();
    expect(stored.fulfillment_recipient_ciphertext).not.toContain("example_user");

    const paid = await app.inject({ method: "POST", url: `/dev/pay/${orderId}` });
    expect(paid.statusCode).toBe(200);
    expect(db.listActivations(orderId)).toHaveLength(1);
    await app.inject({ method: "POST", url: `/dev/pay/${orderId}` });
    expect(db.listActivations(orderId)).toHaveLength(1);

    const worker = new ActivationWorker(config, db, new MockZovoClient(), app.log, xApi);
    await worker.tick();
    const activation = db.listActivations(orderId)[0];
    const merchantOrderNo = `jd:${orderId}`;
    expect(xApi.orders.get(merchantOrderNo)).toMatchObject({
      recipient: "example_user",
      product_code: "x-premium-3m",
      points: 300,
      status: "queued",
    });

    xApi.setStatus(merchantOrderNo, "succeeded");
    await worker.tick();
    await worker.stop();
    expect(db.getOrder(orderId)).toMatchObject({ status: "paid", delivery_status: "success" });

    const result = await app.inject({
      method: "GET",
      url: `/api/v1/checkout/orders/${orderId}/activation`,
      headers,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().items[0]).toMatchObject({
      status: "success",
      finished: true,
      recipient: "@example_user",
    });
  });
});
