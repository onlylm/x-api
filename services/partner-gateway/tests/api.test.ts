import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { alipayPaymentSubject, MockPaymentClient, PaymentProviderError } from "../src/clients/payment.js";
import { buildUpstreamCredential, MockZovoClient, ZovoUpstreamError, type ZovoClient } from "../src/clients/zovo.js";
import { ActivationWorker } from "../src/services/activation-worker.js";
import { DailySettlementWorker, dailySettlementWindow } from "../src/services/daily-settlement-worker.js";

describe("daily platform settlement window", () => {
  it("uses the previous cutoff before 22:00 Beijing time", () => {
    expect(dailySettlementWindow(new Date("2026-09-26T13:59:59.000Z"))).toEqual({
      businessDate: "2026-09-25",
      from: "2026-09-24T14:00:00.000Z",
      to: "2026-09-25T14:00:00.000Z",
      settlementId: "STD20260925",
    });
  });

  it("opens the current business-date statement at 22:00 Beijing time", () => {
    expect(dailySettlementWindow(new Date("2026-09-26T14:00:00.000Z"))).toEqual({
      businessDate: "2026-09-26",
      from: "2026-09-25T14:00:00.000Z",
      to: "2026-09-26T14:00:00.000Z",
      settlementId: "STD20260926",
    });
  });
});

describe("upstream credential mapping", () => {
  it("uses a real session token in session mode", () => {
    expect(buildUpstreamCredential({ accessToken: "jwt", sessionToken: "session-cookie" })).toEqual({
      mode: "session",
      session: "session-cookie",
    });
  });

  it("uses access_token mode for the platform session accessToken", () => {
    expect(buildUpstreamCredential({ accessToken: "jwt" })).toEqual({
      mode: "access_token",
      accessToken: "jwt",
    });
  });
});

describe("payment descriptor", () => {
  it("uses a stable neutral membership order label without internal product names", () => {
    const subject = alipayPaymentSubject("UP20260924171527477F36E50D");
    expect(subject).toBe("会员服务订单-477F36E50D");
    expect(subject.toLowerCase()).not.toContain("chatgpt");
    expect(subject).not.toContain("chatgpt_plus_1m");
  });
});

describe("platform API", () => {
  let directory: string;
  let db: AppDatabase;
  let app: FastifyInstance;
  let config: AppConfig;
  let zovo: MockZovoClient;
  let payment: MockPaymentClient;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "merchant-gateway-"));
    config = testConfig(join(directory, "test.sqlite"));
    db = new AppDatabase(config.databasePath);
    zovo = new MockZovoClient();
    payment = new MockPaymentClient(config.publicBaseUrl);
    app = await buildApp(config, {
      db,
      zovo,
      payment,
      startWorkers: false,
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires the platform key", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/checkout/products" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("invalid_api_key");

    const buyerPage = await app.inject({ method: "GET", url: "/activate" });
    expect(buyerPage.statusCode).toBe(404);
  });

  it("exposes the platform price range and enforces both boundaries", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const products = await app.inject({ method: "GET", url: "/api/v1/checkout/products", headers });
    expect(products.statusCode).toBe(200);
    expect(products.json().items[0].cost_price).toBe("99.00");
    expect(products.json().items[0].max_sell_price).toBe("159.00");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "159.00",
        client_order_id: "po_price_at_cap",
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().amount).toBe("159.00");

    const above = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "159.01",
        client_order_id: "po_price_above_cap",
      },
    });
    expect(above.statusCode).toBe(422);
    expect(above.json().error).toBe("price_above_max");
  });

  it("creates the payment order without waiting for an upstream availability check", async () => {
    const availability = vi.spyOn(zovo, "isPlanAvailable").mockRejectedValue(new Error("upstream timeout"));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers: { "x-api-key": config.platformApiKey },
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_checkout_without_inventory_wait",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().qr).toContain("/dev/pay/");
    expect(availability).not.toHaveBeenCalled();
  });

  it("creates an idempotent order and exposes no upstream details", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const payload = {
      product: "chatgpt_plus_1m",
      quantity: 1,
      sell_price: "139.00",
      client_order_id: "po_test_001",
    };
    const first = await app.inject({ method: "POST", url: "/api/v1/checkout/orders", headers, payload });
    const second = await app.inject({ method: "POST", url: "/api/v1/checkout/orders", headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json().idempotent).toBe(false);
    expect(second.json().idempotent).toBe(true);
    expect(second.json().order_id).toBe(first.json().order_id);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: { ...payload, sell_price: "140.00" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("idempotency_conflict");
    expect(first.json().activation_url).toBeUndefined();
    expect(JSON.stringify(first.json())).not.toContain("zovocard");
    expect(JSON.stringify(first.json())).not.toContain("ZC-");

    const imageUrl = new URL(first.json().qr_image_url);
    const image = await app.inject({ method: "GET", url: `${imageUrl.pathname}${imageUrl.search}` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.rawPayload.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const forged = await app.inject({
      method: "GET",
      url: `${imageUrl.pathname}?token=invalid`,
    });
    expect(forged.statusCode).toBe(404);
  });

  it("records a platform refund request and only refunds after admin approval", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const adminHeaders = { "x-admin-token": config.adminToken };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_refund_001",
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-REFUND-TRADE", "139.00");
    const payload = { refund_id: "po_refund_001", reason: "" };
    const requested = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers,
      payload,
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toEqual({ success: true, order_id: orderId, refund_status: "pending" });
    expect(db.getOrder(orderId)?.status).toBe("paid");
    expect(db.db.prepare("SELECT id FROM webhook_outbox WHERE event_key = ?").get(`${orderId}:order.refunded`)).toBeUndefined();

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(requested.json());

    const lockedActivation = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/activate`,
      headers,
      payload: { session_data: { user: { email: "refund@example.com" }, accessToken: "secret" } },
    });
    expect(lockedActivation.statusCode).toBe(409);
    expect(lockedActivation.json().error).toBe("refund_pending");

    const approved = await app.inject({
      method: "POST",
      url: `/admin/api/orders/${orderId}/actions`,
      headers: adminHeaders,
      payload: { action: "refund_via_alipay", reason: "已核查无上游履约，批准原路退款" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().refund.status).toBe("succeeded");
    expect(db.getOrder(orderId)?.status).toBe("refunded");
    const event = db.db.prepare("SELECT event, payload_json FROM webhook_outbox WHERE event_key = ?")
      .get(`${orderId}:order.refunded`) as { event: string; payload_json: string };
    expect(event.event).toBe("order.refunded");
    expect(JSON.parse(event.payload_json)).toEqual({
      event: "order.refunded",
      order_id: orderId,
      client_order_id: "po_refund_001",
    });

    const completedReplay = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers,
      payload,
    });
    expect(completedReplay.statusCode).toBe(200);
    expect(completedReplay.json()).toEqual({ success: true, order_id: orderId, refund_status: "refunded" });

    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers,
      payload: { ...payload, refund_id: "po_refund_002" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("refund_already_exists");
  });

  it("reconciles a full refund already completed in the Alipay backend", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const adminHeaders = { "x-admin-token": config.adminToken };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_external_refund",
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-EXTERNAL-REFUND", "139.00");
    await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers,
      payload: { refund_id: "po_external_refund", reason: "买家申请退款" },
    });

    const unconfirmed = await app.inject({
      method: "POST",
      url: `/admin/api/orders/${orderId}/actions`,
      headers: adminHeaders,
      payload: { action: "confirm_external_refund", reason: "核验支付宝后台手动退款结果" },
    });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json().error).toBe("external_refund_not_confirmed");
    expect(db.getOrder(orderId)?.status).toBe("paid");

    payment.markExternallyRefunded(orderId);
    const confirmed = await app.inject({
      method: "POST",
      url: `/admin/api/orders/${orderId}/actions`,
      headers: adminHeaders,
      payload: { action: "confirm_external_refund", reason: "支付宝主动查单确认全额退款" },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().refund.status).toBe("succeeded");
    expect(db.getOrder(orderId)?.status).toBe("refunded");

    const query = await app.inject({ method: "GET", url: `/api/v1/checkout/orders/${orderId}`, headers });
    expect(query.json().status).toBe("refunded");
    const event = db.db.prepare("SELECT event FROM webhook_outbox WHERE event_key = ?")
      .get(`${orderId}:order.refunded`) as { event: string };
    expect(event.event).toBe("order.refunded");
  });

  it("treats a closed trade as refunded when a repeated refund call is rejected", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const adminHeaders = { "x-admin-token": config.adminToken };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_closed_trade_refund",
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-CLOSED-TRADE", "139.00");
    await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers,
      payload: { refund_id: "po_closed_trade_refund", reason: "买家申请退款" },
    });
    payment.markExternallyRefunded(orderId);
    payment.refundPayment = async () => {
      throw new PaymentProviderError("ACQ.TRADE_HAS_CLOSE", "交易已经关闭", true);
    };

    const result = await app.inject({
      method: "POST",
      url: `/admin/api/orders/${orderId}/actions`,
      headers: adminHeaders,
      payload: { action: "refund_via_alipay", reason: "复核订单并执行原路退款" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().refund.status).toBe("succeeded");
    expect(db.getOrder(orderId)?.status).toBe("refunded");
  });

  it("rejects refund requests for missing, unpaid, activating, or activated orders", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders/UP-NOT-FOUND/refund",
      headers,
      payload: { refund_id: "po_missing", reason: "" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ success: false, error: "order_not_found" });
    expect(missing.json().detail_zh).toBeTruthy();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_refund_guards",
      },
    });
    const orderId = created.json().order_id as string;
    const unpaid = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers,
      payload: { refund_id: "po_unpaid", reason: "" },
    });
    expect(unpaid.statusCode).toBe(409);
    expect(unpaid.json()).toMatchObject({ success: false, error: "order_not_paid" });

    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-REFUND-GUARDS");
    const activation = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/activate`,
      headers,
      payload: { session_data: { user: { email: "guard@example.com" }, accessToken: "secret" } },
    });
    expect(activation.statusCode).toBe(200);

    const activating = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers,
      payload: { refund_id: "po_activating", reason: "正在开通时申请" },
    });
    expect(activating.statusCode).toBe(409);
    expect(activating.json()).toMatchObject({ success: false, error: "activation_in_progress" });
    expect(activating.json().detail_zh).toContain("正在开通中");
  });

  it("runs paid order through hidden CDK activation", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_test_002",
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-TRADE");

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/activate`,
      headers,
      payload: {
        session_data: {
          user: { email: "buyer@example.com" },
          expires: "2026-10-24T08:30:00.000Z",
          accessToken: "mock-access-token",
        },
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe("queued");

    const worker = new ActivationWorker(config, db, zovo, app.log);
    await worker.tick();
    const status = await app.inject({
      method: "GET",
      url: `/api/v1/checkout/orders/${orderId}/activation`,
      headers,
    });
    const body = status.json();
    expect(body.items[0].status).toBe("success");
    expect(body.items[0].account_email).toBe("b***r@example.com");
    expect(JSON.stringify(body)).not.toContain("mock-access-token");
    expect(JSON.stringify(body)).not.toContain("ZC-MOCK");

    const adminHeaders = { "x-admin-token": config.adminToken };
    const customers = await app.inject({ method: "GET", url: "/admin/api/customers", headers: adminHeaders });
    expect(customers.statusCode).toBe(200);
    expect(customers.json().items[0].email_masked).toBe("b***r@example.com");
    expect(customers.body).not.toContain("mock-access-token");
    const customerDetail = await app.inject({
      method: "GET",
      url: `/admin/api/customers/${customers.json().items[0].customer_id}`,
      headers: adminHeaders,
    });
    expect(customerDetail.statusCode).toBe(200);
    expect(customerDetail.json().customer.email_masked).toBe("b***r@example.com");
    expect(customerDetail.json().orders[0].order_id).toBe(orderId);
    expect(customerDetail.body).not.toContain("mock-access-token");

    const detail = await app.inject({
      method: "GET",
      url: `/admin/api/orders/${orderId}`,
      headers: adminHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().activations[0].upstream_order_id).toBeTruthy();
    expect(detail.body).not.toContain("mock-access-token");
    expect(detail.body).not.toContain("ZC-MOCK");

    const requestedRefund = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers,
      payload: { refund_id: "po_platform_blocked_refund", reason: "尝试退款已履约订单" },
    });
    expect(requestedRefund.statusCode).toBe(409);
    expect(requestedRefund.json().error).toBe("already_activated");
    expect(requestedRefund.json().detail_zh).toContain("已经开通成功");
    expect(db.getRefundByOrderId(orderId)).toBeUndefined();
  });

  it("preserves an upstream eligibility failure code in fulfillment progress", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_account_not_eligible",
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-NOT-ELIGIBLE");
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/activate`,
      headers,
      payload: { session_data: { user: { email: "eligible@example.com" }, accessToken: "secret-token" } },
    });
    expect(accepted.statusCode).toBe(200);

    const eligibilityZovo: ZovoClient = {
      async isPlanAvailable() { return true; },
      async getCdkStatus() { return "unused"; },
      async issueCdk() { return { id: "eligibility-cdk", code: "ZC-ELIGIBILITY", plan: "plus" }; },
      async preview() { return { redemptionToken: "rt-eligibility", plan: "plus" }; },
      async preflight() {
        throw new ZovoUpstreamError("账号不满足商品开通条件", 422, "ACCOUNT_NOT_ELIGIBLE");
      },
      async redeem() { return { orderId: "should-not-redeem", status: "queued" }; },
      async getResult() { return { status: "queued" }; },
    };
    const worker = new ActivationWorker(config, db, eligibilityZovo, app.log);
    await worker.tick();

    const progress = await app.inject({
      method: "GET",
      url: `/api/v1/checkout/orders/${orderId}/activation`,
      headers,
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json().items[0]).toMatchObject({
      status: "failed",
      finished: true,
      failure_code: "account_not_eligible",
    });
    expect(progress.json().items[0].message_zh).toContain("不满足该商品");
  });

  it("issues a dedicated CDK and device for each new task while keeping each task's device consistent", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_stable_cdk_device",
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-STABLE-DEVICE");

    const previewDevices: string[] = [];
    const previewCodes: string[] = [];
    const preflightDevices: string[] = [];
    const redemptionRequests: Array<{ deviceId: string; clientRequestId: string }> = [];
    const resultDevices: string[] = [];
    const issueKeys: string[] = [];
    let preflightCount = 0;
    const stableZovo: ZovoClient = {
      async isPlanAvailable() {
        return true;
      },
      async getCdkStatus() {
        return "unused";
      },
      async issueCdk(plan, idempotencyKey) {
        issueKeys.push(idempotencyKey);
        return { id: `dedicated-${idempotencyKey}`, code: `ZC-DEDICATED-${issueKeys.length}`, plan };
      },
      async preview(code, deviceId) {
        previewCodes.push(code);
        previewDevices.push(deviceId);
        return { redemptionToken: `rt-${previewDevices.length}`, plan: "plus" };
      },
      async preflight(_redemptionToken, sessionData, deviceId) {
        preflightDevices.push(deviceId);
        preflightCount += 1;
        const email = String((sessionData.user as Record<string, unknown>).email);
        return {
          email: preflightCount === 1 ? "different@example.com" : email,
          preflightToken: `pt-${preflightCount}`,
        };
      },
      async redeem(_redemptionToken, _preflightToken, clientRequestId, deviceId) {
        redemptionRequests.push({ deviceId, clientRequestId });
        return { orderId: "upstream-order", status: "queued" };
      },
      async getResult(_redemptionToken, deviceId) {
        resultDevices.push(deviceId);
        return { status: "completed", accountEmail: "second@example.com" };
      },
    };
    const worker = new ActivationWorker(config, db, stableZovo, app.log);

    const submit = (email: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/checkout/orders/${orderId}/activate`,
        headers,
        payload: { session_data: { user: { email }, accessToken: "secret-token" } },
      });

    expect((await submit("first@example.com")).statusCode).toBe(200);
    await worker.tick();
    const firstTask = db.listActivations(orderId)[0];
    expect(firstTask).toMatchObject({ status: "failed", finished: 1, failure_code: "session_invalid" });
    expect(db.getCdk(firstTask.cdk_id!)).toMatchObject({ status: "unused", assigned_activation_id: null });
    expect(redemptionRequests).toHaveLength(0);
    expect((await submit("second@example.com")).statusCode).toBe(200);
    await worker.tick();

    const secondTask = db.listActivations(orderId).at(-1)!;
    expect(secondTask.task_id).not.toBe(firstTask.task_id);
    expect(secondTask.cdk_id).not.toBe(firstTask.cdk_id);
    expect(issueKeys).toEqual([`cdk-${firstTask.task_id}`, `cdk-${secondTask.task_id}`]);
    expect(previewCodes).toEqual(["ZC-DEDICATED-1", "ZC-DEDICATED-2"]);
    expect(previewDevices).toEqual([`merchant-${firstTask.task_id}`, `merchant-${secondTask.task_id}`]);
    expect(preflightDevices).toEqual(previewDevices);
    expect(redemptionRequests).toEqual([{ deviceId: previewDevices[1], clientRequestId: secondTask.task_id }]);
    expect(resultDevices).toEqual([previewDevices[1]]);
    expect(db.getCdk(firstTask.cdk_id!)).toMatchObject({ status: "unused", assigned_activation_id: null });
    expect(db.getCdk(secondTask.cdk_id!)?.status).toBe("consumed");
    const status = await app.inject({
      method: "GET",
      url: `/api/v1/checkout/orders/${orderId}/activation`,
      headers,
    });
    expect(status.json().items.at(-1).status).toBe("success");
  });

  it("retries a preview 400 while upstream still reports the CDK as unused", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_preview_token_overlap",
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-PREVIEW-OVERLAP");
    await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/activate`,
      headers,
      payload: {
        session_data: { user: { email: "retry@example.com" }, accessToken: "secret-token" },
      },
    });

    let previewCount = 0;
    let issueCount = 0;
    const retryingZovo: ZovoClient = {
      async isPlanAvailable() {
        return true;
      },
      async getCdkStatus() {
        return "unused";
      },
      async issueCdk() {
        issueCount += 1;
        return { id: "overlap-cdk", code: "ZC-OVERLAP", plan: "plus" };
      },
      async preview() {
        previewCount += 1;
        if (previewCount === 1) throw new ZovoUpstreamError("not ready", 400);
        return { redemptionToken: "rt-overlap", plan: "plus" };
      },
      async preflight() {
        return { email: "retry@example.com", preflightToken: "pt-overlap" };
      },
      async redeem() {
        return { orderId: "order-overlap", status: "queued" };
      },
      async getResult() {
        return { status: "completed", accountEmail: "retry@example.com" };
      },
    };
    const worker = new ActivationWorker(config, db, retryingZovo, app.log);

    await worker.tick();
    let activation = db.listActivations(orderId)[0];
    expect(activation.finished).toBe(0);
    db.clearProvisioningLock(activation.id, new Date().toISOString());
    db.db.prepare("UPDATE activation_worker_control SET next_retry_at = NULL WHERE activation_id = ?").run(activation.id);
    await worker.tick();

    activation = db.listActivations(orderId)[0];
    expect(activation.status).toBe("success");
    expect(issueCount).toBe(1);
    expect(previewCount).toBe(2);
  });

  it("requires human review when the result is 404 even though the CDK is consumed", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_consumed_result_missing",
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-CONSUMED-MISSING");
    await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/activate`,
      headers,
      payload: {
        session_data: { user: { email: "reconcile@example.com" }, accessToken: "secret-token" },
      },
    });

    const resultMissingZovo: ZovoClient = {
      async isPlanAvailable() { return true; },
      async getCdkStatus() { return "consumed"; },
      async issueCdk() { return { id: "consumed-cdk", code: "ZC-CONSUMED", plan: "plus" }; },
      async preview() { return { redemptionToken: "rt-consumed", plan: "plus" }; },
      async preflight() { return { email: "reconcile@example.com", preflightToken: "pt-consumed" }; },
      async redeem() { return { orderId: "286432", status: "queued" }; },
      async getResult() { throw new ZovoUpstreamError("兑换结果不存在", 404); },
    };
    const worker = new ActivationWorker(config, db, resultMissingZovo, app.log);
    await worker.tick();
    let activation = db.listActivations(orderId)[0];
    expect(activation.status).toBe("running");

    db.db.prepare("UPDATE activations SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 61_000).toISOString(), activation.id);
    db.db.prepare("UPDATE activation_worker_control SET next_retry_at = NULL WHERE activation_id = ?").run(activation.id);
    await worker.tick();
    activation = db.listActivations(orderId)[0];
    expect(activation.status).toBe("running");
    expect(activation.finished).toBe(0);
    expect(db.getOrder(orderId)?.delivery_status).not.toBe("success");
    expect(db.getCdk(activation.cdk_id!)?.status).toBe("reserved");
    const review = db.db.prepare("SELECT needs_review,last_error_code FROM activation_worker_control WHERE activation_id=?")
      .get(activation.id) as { needs_review: number; last_error_code: string };
    expect(review).toMatchObject({ needs_review: 1, last_error_code: "cdk_consumed_activation_not_confirmed" });
    expect(db.db.prepare("SELECT 1 FROM webhook_outbox WHERE event_key=?").get(`${orderId}:order.activated`))
      .toBeUndefined();
  });

  it("rejects activation before payment and malformed sessions", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: "po_test_003",
      },
    });
    const orderId = created.json().order_id as string;
    const unpaid = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/activate`,
      headers,
      payload: { session_data: { accessToken: "token" } },
    });
    expect(unpaid.statusCode).toBe(409);
    expect(unpaid.json().error).toBe("order_not_paid");

    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-TRADE");
    const malformed = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/activate`,
      headers,
      payload: { session_data: { accessToken: "token" } },
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json().error).toBe("invalid_session_json");
  });

  it("provides a cookie-protected visual operations API without echoing secrets", async () => {
    const page = await app.inject({ method: "GET", url: "/admin" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("商户 ERP 控制台");
    expect(page.body).toContain('data-days="1">今天');
    expect(page.body).toContain('data-days="7">近 7 天');
    expect(page.body).toContain('data-days="30">近 30 天');
    expect(page.body).toContain('id="requestProgress"');
    expect(page.body).toContain("下单时间");
    expect(page.body).toContain("status === 'success' || status === '履约成功'");
    expect(page.body).toContain("status === 'failed' || status === '履约失败'");

    const anonymous = await app.inject({ method: "GET", url: "/admin/api/config" });
    expect(anonymous.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { password: config.adminToken },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const operations = await app.inject({ method: "GET", url: "/admin/api/operations", headers: { cookie } });
    expect(operations.statusCode).toBe(200);
    expect(operations.json().controls.some((item: { key: string }) => item.key === "idempotency")).toBe(true);

    const saved = await app.inject({
      method: "PUT",
      url: "/admin/api/config",
      headers: { cookie },
      payload: {
        zovo_app_id: "ak_test_app_123456",
        zovo_api_key: "sk_test_secret_123456789",
        zovo_mode: "live",
      },
    });
    expect(saved.statusCode).toBe(200);
    const read = await app.inject({ method: "GET", url: "/admin/api/config", headers: { cookie } });
    expect(read.body).not.toContain("sk_test_secret_123456789");
    expect(read.json().zovo_app_id_masked).toBe("••••123456");
    expect(read.json().zovo_api_key_masked).toBe("••••456789");

    const normalized = await app.inject({
      method: "PUT",
      url: "/admin/api/products/chatgpt_plus_1m",
      headers: { cookie },
      payload: { internal_cost_cny: "80", cost_price: "99.9", enabled: false },
    });
    expect(normalized.statusCode).toBe(200);
    expect(normalized.json().product.internal_cost_cny).toBe("80.00");
    expect(normalized.json().product.cost_price).toBe("99.90");

    const enable = await app.inject({
      method: "PUT",
      url: "/admin/api/products/chatgpt_plus_1m",
      headers: { cookie },
      payload: { internal_cost_cny: "80.00", cost_price: "99.00", enabled: true },
    });
    expect(enable.statusCode).toBe(409);
  });

  it("supports the admin visual end-to-end test flow without exposing credentials or CDKs", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { password: config.adminToken },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const created = await app.inject({
      method: "POST",
      url: "/admin/api/test/orders",
      headers: { cookie },
      payload: { product: "chatgpt_plus_1m", sell_price: "99.00" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().qr).toContain("/dev/pay/");
    const orderId = created.json().order_id as string;
    expect(created.json().activation_url).toBeUndefined();

    const unpaid = await app.inject({
      method: "POST",
      url: `/admin/api/test/orders/${orderId}/refresh-payment`,
      headers: { cookie },
    });
    expect(unpaid.json().status).toBe("pending");
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-ADMIN-TRADE");

    const sessionData = JSON.stringify({
      user: { email: "visual-test@example.com" },
      accessToken: "visual-test-secret-token",
    });
    const inspected = await app.inject({
      method: "POST",
      url: `/admin/api/test/orders/${orderId}/inspect-session`,
      headers: { cookie },
      payload: { session_data: sessionData },
    });
    expect(inspected.json().email).toBe("visual-test@example.com");
    expect(inspected.body).not.toContain("visual-test-secret-token");

    const activated = await app.inject({
      method: "POST",
      url: `/admin/api/test/orders/${orderId}/activate`,
      headers: { cookie },
      payload: { session_data: sessionData },
    });
    expect(activated.statusCode).toBe(200);
    const worker = new ActivationWorker(config, db, zovo, app.log);
    await worker.tick();
    const status = await app.inject({
      method: "GET",
      url: `/admin/api/test/orders/${orderId}`,
      headers: { cookie },
    });
    expect(status.json().activation.items[0].status).toBe("success");
    expect(status.body).not.toContain("visual-test-secret-token");
    expect(status.body).not.toContain("ZC-MOCK");
  });

  it("closes an internal paid test order without issuing a refund", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const adminHeaders = { "x-admin-token": config.adminToken };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: `ADMINTEST-${Date.now()}-close`,
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-CLOSE-TRADE");
    db.setDeliveryStatusByAdmin(orderId, "failed", "内部测试履约失败");

    const closed = await app.inject({
      method: "POST",
      url: `/admin/api/orders/${orderId}/actions`,
      headers: adminHeaders,
      payload: { action: "close_test_order", reason: "内部联调完成无需退款" },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().order.status).toBe("closed");
    expect(closed.json().order.delivery_status).toBe("closed");
    expect(db.getRefundByOrderId(orderId)).toBeUndefined();
    expect(db.db.prepare("SELECT event FROM webhook_outbox WHERE event_key = ?").get(`${orderId}:order.refunded`)).toBeUndefined();
    expect(db.getAdminOrderDetail(orderId)?.audit[0].action).toBe("close_test_order");
  });

  it("records a completed manual recharge as fulfilled without refunding or calling the upstream", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const adminHeaders = { "x-admin-token": config.adminToken };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "130.00",
        client_order_id: `po_manual_delivery_${Date.now()}`,
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-MANUAL-DELIVERY-TRADE");
    db.setDeliveryStatusByAdmin(orderId, "failed", "上游未完成开通，客服已人工处理");

    const confirmed = await app.inject({
      method: "POST",
      url: `/admin/api/orders/${orderId}/actions`,
      headers: adminHeaders,
      payload: {
        action: "confirm_manual_delivery",
        reason: "客服已人工完成充值，凭证：MANUAL-RECHARGE-001",
        account_email: "customer@example.com", verified: true,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().order.delivery_status).toBe("success");
    expect(confirmed.json().activation).toMatchObject({
      status: "success",
      finished: 1,
      message_zh: "开通成功",
    });
    expect(db.getRefundByOrderId(orderId)).toBeUndefined();
    expect(db.db.prepare("SELECT event FROM webhook_outbox WHERE event_key = ?").get(`${orderId}:order.refunded`)).toBeUndefined();
    expect(db.getAdminOrderDetail(orderId)?.audit[0]).toMatchObject({
      action: "manual_delivery_confirmed",
      reason: "客服已人工完成充值，凭证：MANUAL-RECHARGE-001",
    });

    const progress = await app.inject({
      method: "GET",
      url: `/api/v1/checkout/orders/${orderId}/activation`,
      headers,
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json().items[0]).toMatchObject({
      status: "success",
      finished: true,
      message_zh: "开通成功", account_email: "c***r@example.com",
    });

    const repeated = await app.inject({
      method: "POST",
      url: `/admin/api/orders/${orderId}/actions`,
      headers: adminHeaders,
      payload: { action: "confirm_manual_delivery", reason: "重复确认人工充值不应重复写入",account_email:"customer@example.com",verified:true },
    });
    expect(repeated.statusCode).toBe(409);
  });

  it("records a customer price refund separately and reduces only the platform profit", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const adminHeaders = { "x-admin-token": config.adminToken };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "120.00",
        client_order_id: `po_price_refund_${Date.now()}`,
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-PRICE-REFUND-TRADE", "120.00");
    db.db.prepare("UPDATE orders SET delivery_status = 'success' WHERE order_id = ?").run(orderId);

    const excessive = await app.inject({
      method: "PUT",
      url: `/admin/api/orders/${orderId}/customer-price-refund`,
      headers: adminHeaders,
      payload: {
        amount: "21.01",
        reference: "PRICE-REFUND-TOO-HIGH",
        reason: "超过原始平台利润",
        refunded_at: new Date().toISOString(),
      },
    });
    expect(excessive.statusCode).toBe(422);

    const recorded = await app.inject({
      method: "PUT",
      url: `/admin/api/orders/${orderId}/customer-price-refund`,
      headers: adminHeaders,
      payload: {
        amount: "10.00",
        reference: "PRICE-REFUND-001",
        reason: "按实际供货差价退给用户",
        refunded_at: new Date().toISOString(),
      },
    });
    expect(recorded.statusCode).toBe(200);
    expect(db.getOrder(orderId)).toMatchObject({
      alipay_receipt_amount: "120.00",
      platform_supply_price: "99.00",
      customer_price_refund_amount: "10.00",
      customer_price_refund_reference: "PRICE-REFUND-001",
    });
    expect(db.getAdminOrderDetail(orderId)?.audit[0].action).toBe("customer_price_refund_recorded");

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const query = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const finance = await app.inject({ method: "GET", url: `/admin/api/finance${query}`, headers: adminHeaders });
    const row = finance.json().items.find((item: { order_id: string }) => item.order_id === orderId);
    expect(row).toMatchObject({
      customer_payment_amount: "120.00",
      receipt_amount: "120.00",
      supply_price: "99.00",
      customer_price_refund_amount: "10.00",
      platform_margin: "11.00",
    });
    expect(finance.json().summary.receipts).toBe("120.00");
    expect(finance.json().summary.platform_payable).toBe("11.00");

    const invoiceLookup = await app.inject({
      method: "GET",
      url: `/admin/api/invoices/order-lookup?order_number=${orderId}`,
      headers: adminHeaders,
    });
    expect(invoiceLookup.json().order.receipt_amount).toBe("110.00");

    const csv = await app.inject({ method: "GET", url: `/admin/api/finance.csv${query}`, headers: adminHeaders });
    expect(csv.body).toContain('"订单号","用户付款","服务商收款","供货成本","补差退款","平台利润","下单时间","付款时间","履约提交时间","履约完成时间","补差退款时间","全额退款时间","平台结算时间"');
    expect(csv.body).toContain('"120.00","120.00","99.00","10.00","11.00"');

    const daily = await app.inject({ method: "GET", url: "/admin/api/analytics/daily", headers: adminHeaders });
    expect(daily.statusCode).toBe(200);
    expect(daily.json().items[0]).toMatchObject({ success_count: 1, failed_count: 0, success_rate: "100.0", failure_rate: "0.0" });

    const generated = await app.inject({
      method: "POST",
      url: "/admin/api/platform-settlements",
      headers: adminHeaders,
      payload: { from, to },
    });
    expect(generated.statusCode).toBe(201);
    expect(generated.json().settlement.amount).toBe("11.00");

    const locked = await app.inject({
      method: "PUT",
      url: `/admin/api/orders/${orderId}/customer-price-refund`,
      headers: adminHeaders,
      payload: {
        amount: "9.00",
        reference: "PRICE-REFUND-EDIT",
        reason: "结算后尝试修改",
        refunded_at: new Date().toISOString(),
      },
    });
    expect(locked.statusCode).toBe(409);
  });

  it("supports server-side date filters, search, status filters, and pagination for growing order lists", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const adminHeaders = { "x-admin-token": config.adminToken };
    const orderIds: string[] = [];
    const stamp = Date.now();
    for (let index = 0; index < 12; index += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/checkout/orders",
        headers,
        payload: {
          product: "chatgpt_plus_1m",
          quantity: 1,
          sell_price: "120.00",
          client_order_id: `po_page_${stamp}_${String(index).padStart(2, "0")}`,
        },
      });
      const orderId = created.json().order_id as string;
      orderIds.push(orderId);
      db.markOrderPaid(orderId, new Date().toISOString(), `PAGE-TRADE-${index}`, "120.00");
      db.db.prepare("UPDATE orders SET delivery_status = ? WHERE order_id = ?")
        .run(index % 2 === 0 ? "success" : "failed", orderId);
    }
    const from = encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString());
    const to = encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString());
    const range = `from=${from}&to=${to}`;

    const firstPage = await app.inject({
      method: "GET", url: `/admin/api/orders?${range}&page=1&page_size=10`, headers: adminHeaders,
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items).toHaveLength(10);
    expect(firstPage.json().pagination).toMatchObject({ total: 12, page: 1, page_size: 10, pages: 2 });

    const secondPage = await app.inject({
      method: "GET", url: `/admin/api/orders?${range}&page=2&page_size=10`, headers: adminHeaders,
    });
    expect(secondPage.json().items).toHaveLength(2);

    const searched = await app.inject({
      method: "GET",
      url: `/admin/api/orders?${range}&q=${encodeURIComponent(`po_page_${stamp}_07`)}&page=1&page_size=10`,
      headers: adminHeaders,
    });
    expect(searched.json().pagination.total).toBe(1);
    expect(searched.json().items[0].client_order_id).toBe(`po_page_${stamp}_07`);

    const fulfillment = await app.inject({
      method: "GET",
      url: `/admin/api/fulfillment?${range}&delivery_status=failed&page=1&page_size=10`,
      headers: adminHeaders,
    });
    expect(fulfillment.statusCode).toBe(200);
    expect(fulfillment.json().pagination.total).toBe(6);
    expect(fulfillment.json().summary).toEqual({ waiting: 0, failed: 6, success: 6 });
    expect(fulfillment.json().items.every((item: { delivery_status: string }) => item.delivery_status === "failed")).toBe(true);

    const finance = await app.inject({
      method: "GET", url: `/admin/api/finance?${range}&page=2&page_size=10`, headers: adminHeaders,
    });
    expect(finance.json().items).toHaveLength(2);
    expect(finance.json().pagination).toMatchObject({ total: 12, page: 2, pages: 2 });
    expect(orderIds).toHaveLength(12);
  });

  it("creates a platform settlement statement and clears payable only after payment is recorded", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const adminHeaders = { "x-admin-token": config.adminToken };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: `po_settlement_${Date.now()}`,
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-SETTLEMENT-TRADE");
    db.db.prepare("UPDATE orders SET delivery_status = 'success' WHERE order_id = ?").run(orderId);
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const query = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    const before = await app.inject({ method: "GET", url: `/admin/api/finance${query}`, headers: adminHeaders });
    expect(before.json().summary.platform_payable).toBe("40.00");
    expect(before.json().items[0].platform_settlement_zh).toBe("未生成");

    const generated = await app.inject({
      method: "POST",
      url: "/admin/api/platform-settlements",
      headers: adminHeaders,
      payload: { from, to },
    });
    expect(generated.statusCode).toBe(201);
    expect(generated.json().settlement.amount).toBe("40.00");
    expect(generated.json().lines).toHaveLength(1);
    const settlementId = generated.json().settlement.settlement_id as string;

    const duplicate = await app.inject({
      method: "POST",
      url: "/admin/api/platform-settlements",
      headers: adminHeaders,
      payload: { from, to },
    });
    expect(duplicate.statusCode).toBe(409);

    const pending = await app.inject({ method: "GET", url: `/admin/api/finance${query}`, headers: adminHeaders });
    expect(pending.json().summary.platform_payable).toBe("40.00");
    expect(pending.json().items[0].platform_settlement_status).toBe("pending");

    const paidAt = new Date().toISOString();
    const paid = await app.inject({
      method: "POST",
      url: `/admin/api/platform-settlements/${settlementId}/payment`,
      headers: adminHeaders,
      payload: {
        method: "bank_transfer",
        reference: "BANK-TEST-0001",
        note: "测试打款记录",
        paid_at: paidAt,
      },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().settlement.status).toBe("paid");

    const after = await app.inject({ method: "GET", url: `/admin/api/finance${query}`, headers: adminHeaders });
    expect(after.json().summary.platform_payable).toBe("0.00");
    expect(after.json().summary.platform_settled).toBe("40.00");
    expect(after.json().items[0].platform_payment_reference).toBe("BANK-TEST-0001");
  });

  it("records a USD platform rebate and includes it once in the 22:00 daily settlement", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const adminHeaders = { "x-admin-token": config.adminToken };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: `po_daily_rebate_${Date.now()}`,
      },
    });
    const orderId = created.json().order_id as string;
    const createdAt = "2026-09-26T13:00:00.000Z";
    db.markOrderPaid(orderId, "2026-09-26T13:01:00.000Z", "MOCK-REBATE-TRADE", "139.00");
    db.db.prepare("UPDATE orders SET delivery_status = 'success', created_at = ?, updated_at = ? WHERE order_id = ?")
      .run(createdAt, createdAt, orderId);
    db.db.prepare(`
      INSERT INTO activations (
        order_id, activation_id, task_id, status, finished, upstream_order_id,
        worker_state, created_at, updated_at
      ) VALUES (?, 1, ?, 'success', 1, ?, 'terminal', ?, ?)
    `).run(orderId, `tsk_rebate_${Date.now()}`, "291502", createdAt, createdAt);

    const costDraft = await app.inject({
      method: "PUT",
      url: `/admin/api/cost-reviews/${orderId}`,
      headers: adminHeaders,
      payload: {
        standard_usd: "15.76",
        actual_usd: "14.00",
        retained_usd: "0.15", revision:0, plan:"plus", source:"manual",
        transaction_ids:["trans-daily-rebate-001"], fees_checked:true,
        standard_reference:"Plus 2026-09-26 标准价",
        evidence:"人工核实卡台交易与本单对应",
      },
    });
    expect(costDraft.statusCode).toBe(200);
    const recorded = await app.inject({method:"POST",url:`/admin/api/cost-reviews/${orderId}/confirm`,
      headers:adminHeaders,payload:{revision:1,verified:true}});
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().rebate).toMatchObject({
      upstream_order_id: "291502",
      standard_usd: "15.76",
      actual_usd: "14.00",
      fee_usd: "0.15",
      rebate_usd: "1.61",
      status: "pending",
    });
    db.db.prepare("UPDATE platform_rebates SET created_at = ?, updated_at = ? WHERE order_id = ?")
      .run(createdAt, createdAt, orderId);
    db.db.prepare("UPDATE orders SET updated_at=? WHERE order_id=?").run(createdAt,orderId);

    const replay = await app.inject({
      method: "PUT",
      url: `/admin/api/orders/${orderId}/platform-rebate`,
      headers: adminHeaders,
      payload: {
        standard_usd: "15.76",
        actual_usd: "14.00",
        fee_usd: "0.15",
        card_transaction_id: "trans-daily-rebate-001",
        reason: "重复请求不应生成第二条记录",
      },
    });
    expect(replay.statusCode).toBe(200);
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM platform_rebates WHERE order_id = ?")
      .get(orderId) as { count: number }).count).toBe(1);

    const worker = new DailySettlementWorker(db, app.log);
    await worker.tick(new Date("2026-09-26T14:01:00.000Z"));
    await worker.tick(new Date("2026-09-26T14:02:00.000Z"));
    const settlement = db.getPlatformSettlementByBusinessDate("2026-09-26")!;
    expect(settlement).toMatchObject({
      settlement_id: "STD20260926",
      generation_mode: "scheduled",
      amount: "40.00",
      rebate_usd: "1.61",
      order_count: 1,
      status: "pending",
    });
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM platform_settlements WHERE business_date = ?")
      .get("2026-09-26") as { count: number }).count).toBe(1);
    expect(db.getPlatformRebate(orderId)).toMatchObject({
      status: "included",
      settlement_id: "STD20260926",
    });

    const finance = await app.inject({
      method: "GET",
      url: "/admin/api/finance?from=2026-09-25T14%3A00%3A00.000Z&to=2026-09-26T14%3A00%3A00.000Z",
      headers: adminHeaders,
    });
    expect(finance.json().summary).toMatchObject({
      platform_rebate_payable_usd: "1.61",
      platform_rebate_settled_usd: "0.00",
    });
    expect(finance.json().items[0]).toMatchObject({
      platform_rebate_usd: "1.61",
      platform_rebate_status: "included",
      platform_rebate_settlement_id: "STD20260926",
    });

    const paidAt = "2026-09-26T14:10:00.000Z";
    const paid = await app.inject({
      method: "POST",
      url: "/admin/api/platform-settlements/STD20260926/payment",
      headers: adminHeaders,
      payload: {
        method: "other",
        reference: "PLATFORM-USD-SETTLEMENT-001",
        currency:"USD",amount:"1.61",payment_id:"usd-test-001",
        note: "人民币利润和美元差价均已线下处理",
        paid_at: paidAt,
      },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().settlement.status).toBe("partial");
    expect(paid.json().settlement.cny_paid).toBe("0.00");
    expect(db.getPlatformRebate(orderId)).toMatchObject({ status: "paid", settled_at: paidAt });
    expect(db.getPlatformRebateSummary()).toMatchObject({ payable: "0.00", paid: "1.61" });

    await worker.tick(new Date("2026-09-28T14:01:00.000Z"));
    expect(db.getPlatformSettlementByBusinessDate("2026-09-27")).toMatchObject({
      settlement_id: "STD20260927",
      amount: "0.00",
      rebate_usd: "0.00",
    });
    expect(db.getPlatformSettlementByBusinessDate("2026-09-28")).toMatchObject({
      settlement_id: "STD20260928",
      amount: "0.00",
      rebate_usd: "0.00",
    });
  });

  it("generates an invoice work order from the paid amount and records the issued invoice", async () => {
    const headers = { "x-api-key": config.platformApiKey };
    const adminHeaders = { "x-admin-token": config.adminToken };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/checkout/orders",
      headers,
      payload: {
        product: "chatgpt_plus_1m",
        quantity: 1,
        sell_price: "139.00",
        client_order_id: `po_invoice_${Date.now()}`,
      },
    });
    const orderId = created.json().order_id as string;
    db.markOrderPaid(orderId, new Date().toISOString(), "MOCK-INVOICE-TRADE");

    const lookup = await app.inject({
      method: "GET",
      url: `/admin/api/invoices/order-lookup?order_number=${orderId}`,
      headers: adminHeaders,
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ eligible: true, order: { receipt_amount: "139.00" } });

    const requested = await app.inject({
      method: "POST",
      url: "/admin/api/invoices",
      headers: adminHeaders,
      payload: {
        order_number: orderId,
        title_type: "company",
        title: "测试科技有限公司",
        tax_id: "91310000TEST000001",
        unit_address: "上海市测试路 100 号",
        phone: "021-12345678",
        bank_name: "测试银行",
        bank_account: "6222000000000000",
        recipient_email: "finance@example.com",
        request_note: "测试开票单",
      },
    });
    expect(requested.statusCode).toBe(201);
    expect(requested.json().invoice).toMatchObject({
      order_id: orderId,
      amount: "139.00",
      status: "requested",
      unit_address: "上海市测试路 100 号",
      phone: "021-12345678",
      bank_name: "测试银行",
      bank_account: "6222000000000000",
    });
    const invoiceId = requested.json().invoice.invoice_id as string;

    const duplicate = await app.inject({
      method: "POST",
      url: "/admin/api/invoices",
      headers: adminHeaders,
      payload: {
        order_number: orderId,
        title_type: "personal",
        title: "重复申请",
        tax_id: "",
        recipient_email: "again@example.com",
        request_note: "",
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const issued = await app.inject({
      method: "POST",
      url: `/admin/api/invoices/${invoiceId}/issue`,
      headers: adminHeaders,
      payload: {
        invoice_number: "FP-2026-0001",
        invoice_date: "2026-09-25",
        invoice_url: "https://invoice.example.com/FP-2026-0001.pdf",
        issue_note: "已发送给客户",
      },
    });
    expect(issued.statusCode).toBe(200);
    expect(issued.json().invoice).toMatchObject({ status: "issued", invoice_number: "FP-2026-0001" });

    const list = await app.inject({ method: "GET", url: "/admin/api/invoices", headers: adminHeaders });
    expect(list.json().items[0]).toMatchObject({
      invoice_id: invoiceId,
      client_order_id: created.json().client_order_id,
      title: "测试科技有限公司",
      tax_id: "91310000TEST000001",
      unit_address: "上海市测试路 100 号",
      phone: "021-12345678",
    });
  });

  it("records a manual cash order with receipt time and never sends a platform payment webhook", async () => {
    const adminHeaders = { "x-admin-token": config.adminToken };
    const receivedAt = new Date(Date.now() - 60_000).toISOString();
    const created = await app.inject({
      method: "POST",
      url: "/admin/api/manual-orders",
      headers: adminHeaders,
      payload: {
        product: "chatgpt_plus_1m",
        sell_price: "139.00",
        collection_method: "cash",
        received_at: receivedAt,
        payment_reference: "CASH-RECEIPT-0001",
        customer_ref: "客服工单-1001",
        note: "用户无法使用支付宝，线下现金收款",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      status: "paid",
      amount: "139.00",
      payment_channel: "cash",
      payment_reference: "CASH-RECEIPT-0001",
    });
    const orderId = created.json().order_id as string;
    const order = db.getOrder(orderId)!;
    expect(order).toMatchObject({
      order_source: "manual",
      payment_channel: "cash",
      paid_at: receivedAt,
      manual_customer_ref: "客服工单-1001",
    });
    expect(db.db.prepare("SELECT event FROM webhook_outbox WHERE event_key = ?").get(`${orderId}:order.paid`)).toBeUndefined();
    expect(db.getAdminOrderDetail(orderId)?.audit[0].action).toBe("manual_cash_order_created");

    const sessionData = { user: { email: "cash-customer@example.com" }, accessToken: "manual-cash-token" };
    const inspected = await app.inject({
      method: "POST",
      url: `/admin/api/manual-orders/${orderId}/inspect-session`,
      headers: adminHeaders,
      payload: { session_data: sessionData },
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().email).toBe("cash-customer@example.com");

    const activated = await app.inject({
      method: "POST",
      url: `/admin/api/manual-orders/${orderId}/activate`,
      headers: adminHeaders,
      payload: { session_data: sessionData },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({ order_id: orderId, status: "queued", finished: false });
    const worker = new ActivationWorker(config, db, zovo, app.log);
    await worker.tick();
    expect(db.getOrder(orderId)?.delivery_status).toBe("success");
    expect(db.listActivations(orderId)[0]).toMatchObject({ status: "success", finished: 1 });

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const finance = await app.inject({
      method: "GET",
      url: `/admin/api/finance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: adminHeaders,
    });
    const row = finance.json().items.find((item: { order_id: string }) => item.order_id === orderId);
    expect(row).toMatchObject({ receipt_amount: "139.00", platform_margin: "0.00", platform_settlement_zh: "无需核销" });
  });
});

function testConfig(databasePath: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3100,
    publicBaseUrl: "http://127.0.0.1:3100",
    databasePath,
    trustProxy: false,
    platformApiKey: "test-platform-api-key",
    platformAllowedIps: new Set(["127.0.0.1"]),
    platformWebhookUrl: "http://127.0.0.1:3999/webhook",
    platformWebhookSecret: "test-webhook-secret",
    adminToken: "test-admin-token",
    sessionEncryptionKey: Buffer.alloc(32, 7),
    emailHmacKey: "test-email-hmac-key",
    products: [
      {
        product: "chatgpt_plus_1m",
        name_zh: "ChatGPT Plus 月卡",
        name: "ChatGPT Plus 1 Month",
        plan: "plus",
        cost_price: "99.00",
        max_sell_price: "159.00",
        currency: "CNY",
        max_qty: 1,
        enabled: true,
      },
    ],
    paymentProvider: "mock",
    alipay: {
      appId: "",
      privateKey: "",
      publicKey: "",
      sellerId: "",
      gateway: "https://openapi.alipay.com/gateway.do",
      notifyUrl: "",
      returnUrl: "",
    },
    zovo: { mode: "mock", baseUrl: "https://zovocard.com", appId: "", apiKey: "", timeoutMs: 15_000 },
    xApi: {
      mode: "disabled",
      baseUrl: "https://x.aifu.me",
      partnerId: "",
      keyId: "",
      secret: "",
      timeoutMs: 15_000,
    },
    activationPollIntervalMs: 3_000,
    webhookPollIntervalMs: 5_000,
  };
}
