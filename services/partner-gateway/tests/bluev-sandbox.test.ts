import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bluevSandboxProducts, buildBluevSandbox, loadBluevSandboxConfig, openBluevSandboxDatabase,
  type BluevSandboxConfig, type BluevTestOrder } from "../src/bluev-sandbox.js";
import { MockPaymentClient, type PaymentConfirmation } from "../src/clients/payment.js";
import { MockXApiClient } from "../src/clients/x-api.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";

describe("isolated administrator blueV real-payment sandbox", () => {
  let directory: string;
  let config: BluevSandboxConfig;
  let payment: MockPaymentClient;
  let xApi: MockXApiClient;
  let service: Awaited<ReturnType<typeof buildBluevSandbox>>;
  let closed: boolean;
  const prefix = "/internal/bluev-test";
  const headers = () => ({ "x-bluev-test-key": config.bluevTestKey });
  const input = (id = randomUUID(), product = "x_premium_3m", recipient = "test_user") =>
    ({ request_id: id, product, recipient, confirm_real_payment: true });
  const confirmation = (amount = "22.00"): PaymentConfirmation => ({ paid: true, tradeNo: "verified-alipay-trade",
    paidAt: new Date().toISOString(), receiptAmount: amount, tradeStatus: "TRADE_SUCCESS" });

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("external_network_forbidden"); }));
    directory = mkdtempSync(join(tmpdir(), "bluev-sandbox-test-"));
    config = { ...ledgerTestConfig(join(directory, "bluev-sandbox.sqlite")), bluevSandbox: true,
      bluevTestKey: "test-key-".padEnd(40, "z"), partnerSalesGateFile: join(directory, "sales.enabled"),
      products: bluevSandboxProducts(), platformWebhookEnabled: false };
    config.xApi.mode = "mock";
    writeFileSync(config.partnerSalesGateFile, "test-only\n");
    payment = new MockPaymentClient("https://payment.invalid");
    vi.spyOn(payment, "createPaymentUrl"); vi.spyOn(payment, "refundPayment"); vi.spyOn(payment, "queryPayment");
    vi.spyOn(payment, "verifyNotification");
    xApi = new MockXApiClient();
    vi.spyOn(xApi, "createOrder");
    service = await buildBluevSandbox(config, { payment, xApi, startWorkers: false });
    closed = false;
  });
  afterEach(async () => {
    if (!closed) await service.app.close();
    expect(payment.refundPayment).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });
  async function create(body = input()) {
    return service.app.inject({ method: "POST", url: `${prefix}/orders`, headers: headers(), payload: body });
  }
  async function item(id: string): Promise<BluevTestOrder> {
    return (await service.app.inject({ method: "GET", url: `${prefix}/orders/${id}`, headers: headers() })).json().item;
  }
  async function paidCallback(orderId: string) {
    vi.mocked(payment.verifyNotification).mockResolvedValue(confirmation());
    return service.app.inject({ method: "POST", url: "/callbacks/alipay", payload: { out_trade_no: orderId, sign: "mock-signed" } });
  }

  it("does not register public partner, old admin, development or refund routes", async () => {
    for (const url of ["/v1/orders", "/api/v1/orders", "/admin/api/test/orders", "/dev/pay/anything", "/api/refunds"]) {
      expect((await service.app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(404);
    }
    const health = await service.app.inject("/health");
    expect(health.json()).toEqual({ success: true, service: "bluev-sandbox", isolated: true });
    expect(health.headers["cache-control"]).toBe("no-store");
  });
  it("requires the dedicated server key for every internal endpoint including QR", async () => {
    for (const url of [`${prefix}/status`, `${prefix}/orders`, `${prefix}/orders/${randomUUID()}/qr`]) {
      expect((await service.app.inject({ url, headers: { "x-admin-token": config.bluevTestKey } })).statusCode).toBe(401);
      expect((await service.app.inject({ url, headers: { "x-bluev-test-key": `${config.bluevTestKey},${config.bluevTestKey}` } })).statusCode).toBe(401);
    }
    expect((await service.app.inject({ method: "POST", url: `${prefix}/eligibility`, payload: { product: "x_premium_3m", recipient: "test" } })).statusCode).toBe(401);
    expect(payment.createPaymentUrl).not.toHaveBeenCalled();
  });
  it("shows only the two fixed 22/44 products and no configuration secrets", async () => {
    const response = await service.app.inject({ url: `${prefix}/status`, headers: headers() });
    expect(response.json()).toMatchObject({ success: true, isolated: true, ready: true, sales_open: true, active_test_id: null });
    expect(response.json().products.map((p: {amount: string}) => p.amount)).toEqual(["22.00", "44.00"]);
    expect(response.body).not.toContain(config.bluevTestKey);
    expect(response.body).not.toContain(config.emailHmacKey);
    expect(response.body).not.toContain(config.databasePath);
  });
  it("eligibility is read-only with no intent, payment or gift", async () => {
    const response = await service.app.inject({ method: "POST", url: `${prefix}/eligibility`, headers: headers(), payload: { product: "x_premium_3m", recipient: "@TEST_User" } });
    expect(response.json()).toMatchObject({ eligible: true, recipient: "@test_user", amount: "22.00", available: true });
    expect(service.tests.list()).toEqual([]);
    expect(service.db.db.prepare("SELECT COUNT(*) n FROM checkout_intents").get()?.n).toBe(0);
    expect(payment.createPaymentUrl).not.toHaveBeenCalled(); expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it("creation rechecks eligibility and rejection never calls payment", async () => {
    await service.app.inject({ method: "POST", url: `${prefix}/eligibility`, headers: headers(), payload: { product: "x_premium_3m", recipient: "test_user" } });
    vi.spyOn(xApi, "eligibility").mockResolvedValue({ eligible: false, username: "test_user" });
    const response = await create();
    expect(response.json().item).toMatchObject({ payment_status: "not_created", terminal: true, qr_available: false });
    expect(payment.createPaymentUrl).not.toHaveBeenCalled();
  });
  it("refuses missing confirmation, arbitrary products, prices and non-UUID ids", async () => {
    const cases = [{ ...input(), confirm_real_payment: false }, { ...input(), product: "chatgpt_plus_1m" },
      { ...input(), sell_price: "0.01" }, { ...input(), request_id: "same-unsafe-id" }, { ...input(), recipient: "url/path" }];
    for (const payload of cases) expect((await service.app.inject({ method: "POST", url: `${prefix}/orders`, headers: headers(), payload })).statusCode).toBe(400);
    expect(service.tests.list()).toEqual([]); expect(payment.createPaymentUrl).not.toHaveBeenCalled();
  });
  it("creates one frozen order at fixed price and serves PNG only behind the key", async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);
    const created: BluevTestOrder = response.json().item;
    expect(created).toMatchObject({ amount: "22.00", payment_status: "pending", fulfillment_status: "not_started", qr_available: true, terminal: false });
    expect(response.body).not.toMatch(/ciphertext|session_|redemption_token|payment.invalid/);
    expect(service.db.getOrder(created.order_id!)?.client_order_id).toBe(`ADMINTEST-BLUEV-${created.request_id}`);
    const qr = await service.app.inject({ url: `${prefix}/orders/${created.test_id}/qr`, headers: headers() });
    expect(qr.headers["content-type"]).toContain("image/png");
    expect(qr.rawPayload.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1); expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it("idempotent replays never precreate again and cannot change recipient", async () => {
    const body = input(); await create(body);
    expect((await create(body)).json().idempotent).toBe(true);
    expect((await create({ ...body, recipient: "someone_else" })).statusCode).toBe(409);
    expect((await create({ ...body, product: "x_premium_6m" })).statusCode).toBe(409);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
    const filtered = await service.app.inject({ url: `${prefix}/orders?request_id=${body.request_id}`, headers: headers() });
    expect(filtered.json().items).toHaveLength(1);
  });
  it("holds the single slot before asynchronous eligibility so simultaneous clicks cannot create two payments", async () => {
    let release!: (result: {username:string;recipient_id:string;eligible:boolean}) => void;
    vi.spyOn(xApi, "eligibility").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = create(input());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect((await create(input())).statusCode).toBe(409);
    release({ username: "test_user", recipient_id: "123456789", eligible: true });
    expect((await first).statusCode).toBe(201); expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
  });
  it("unknown precreate persists the request and intent, blocks another test and never retries precreate", async () => {
    vi.mocked(payment.createPaymentUrl).mockRejectedValue(new Error("SECRET upstream timeout"));
    const body = input(); const response = await create(body);
    expect(response.statusCode).toBe(202);
    expect(response.json().item).toMatchObject({ payment_status: "unknown", requires_review: true, terminal: false, qr_available: false });
    expect(response.body).not.toContain("SECRET");
    expect((await create(body)).statusCode).toBe(202);
    expect((await create(input())).statusCode).toBe(409);
    await service.tests.recoverIntents();
    expect(payment.queryPayment).toHaveBeenCalledTimes(1); expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
    expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it("recovers unknown precreate after restart solely by original signed payment query", async () => {
    vi.mocked(payment.createPaymentUrl).mockRejectedValue(new Error("timeout"));
    const body = input(); await create(body);
    await service.app.close();
    service = await buildBluevSandbox(config, { payment, xApi, startWorkers: false });
    expect((await create(body)).statusCode).toBe(202);
    vi.mocked(payment.queryPayment).mockResolvedValue(confirmation());
    await service.tests.recoverIntents();
    const recovered = await item(body.request_id);
    expect(recovered).toMatchObject({ payment_status: "paid", fulfillment_status: "queued", qr_available: false });
    expect(service.db.listActivations(recovered.order_id!)).toHaveLength(1);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
  });
  it("a verified callback can recover an intent-only payment exactly once", async () => {
    vi.mocked(payment.createPaymentUrl).mockRejectedValue(new Error("timeout"));
    const created: BluevTestOrder = (await create()).json().item;
    expect((await paidCallback(created.order_id!)).body).toBe("success");
    expect((await paidCallback(created.order_id!)).body).toBe("success");
    expect(service.db.listActivations(created.order_id!)).toHaveLength(1);
    expect(service.db.db.prepare("SELECT COUNT(*) n FROM webhook_outbox WHERE event_key=?").get(`${created.order_id}:order.paid`)?.n).toBe(1);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid or missing trade confirmation without creating a fulfillment task", async () => {
    const created: BluevTestOrder = (await create()).json().item;
    vi.mocked(payment.verifyNotification).mockResolvedValue({ ...confirmation(), tradeNo: null });
    expect((await service.app.inject({ method: "POST", url: "/callbacks/alipay", payload: { out_trade_no: created.order_id } })).statusCode).toBe(400);
    expect(service.db.getOrder(created.order_id!)?.status).toBe("pending");
    expect(service.db.listActivations(created.order_id!)).toHaveLength(0);
  });
  it("query and callback racing create a single task and only one upstream gift", async () => {
    const created: BluevTestOrder = (await create()).json().item;
    vi.mocked(payment.queryPayment).mockResolvedValue(confirmation());
    await Promise.all([service.paymentReconciler.tick(), paidCallback(created.order_id!)]);
    expect(service.db.listActivations(created.order_id!)).toHaveLength(1);
    await service.activationWorker.tick(); await service.activationWorker.tick();
    expect(xApi.createOrder).toHaveBeenCalledTimes(1);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
  });
  it("gift timeout remains review and subsequent ticks never submit another gift", async () => {
    const created: BluevTestOrder = (await create()).json().item;
    await paidCallback(created.order_id!);
    vi.mocked(xApi.createOrder).mockRejectedValue(new Error("unknown gift response"));
    await service.activationWorker.tick(); await service.activationWorker.tick();
    expect(xApi.createOrder).toHaveBeenCalledTimes(1);
    expect(await item(created.test_id)).toMatchObject({ payment_status: "paid", fulfillment_status: "review", terminal: false });
    expect((await create()).statusCode).toBe(409);
  });
  it("an unknown gift may converge to original success without any second POST", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const created: BluevTestOrder = (await create()).json().item;
    await paidCallback(created.order_id!);
    const original = MockXApiClient.prototype.createOrder;
    vi.mocked(xApi.createOrder).mockImplementation(async request => {
      await original.call(xApi, request);
      throw new Error("lost response after accepted gift");
    });
    await service.activationWorker.tick();
    expect((await item(created.test_id)).fulfillment_status).toBe("review");
    const upstream = await xApi.findByMerchantOrder(`jd:${created.order_id}`);
    upstream!.status = "succeeded"; upstream!.receipt = "original-success-receipt";
    vi.setSystemTime(Date.now() + 31_000);
    await service.activationWorker.tick();
    expect((await item(created.test_id)).fulfillment_status).toBe("success");
    expect(xApi.createOrder).toHaveBeenCalledTimes(1);
  });
  it("confirmed gift completion releases the next test slot", async () => {
    const created: BluevTestOrder = (await create()).json().item;
    await paidCallback(created.order_id!); await service.activationWorker.tick();
    const upstream = await xApi.findByMerchantOrder(`jd:${created.order_id}`);
    upstream!.status = "succeeded"; upstream!.receipt = "confirmed-receipt";
    await service.activationWorker.tick();
    expect(await item(created.test_id)).toMatchObject({ fulfillment_status: "success", terminal: true });
    expect((await create(input(randomUUID(), "x_premium_6m", "other_user"))).json().item.amount).toBe("44.00");
  });
  it("closing the sandbox sales gate blocks new checkout but does not stop paid fulfillment", async () => {
    const created: BluevTestOrder = (await create()).json().item;
    unlinkSync(config.partnerSalesGateFile);
    expect((await create()).statusCode).toBe(503);
    await paidCallback(created.order_id!); await service.activationWorker.tick();
    expect(xApi.createOrder).toHaveBeenCalledTimes(1);
    expect((await service.app.inject({ url: `${prefix}/status`, headers: headers() })).json().sales_open).toBe(false);
  });
  it("read-only status may display expiry but cannot expire other database rows", async () => {
    const created: BluevTestOrder = (await create()).json().item;
    service.db.db.prepare("UPDATE orders SET expires_at=? WHERE order_id=?").run("2020-01-01T00:00:00.000Z", created.order_id!);
    expect(await item(created.test_id)).toMatchObject({ payment_status: "expired", terminal: false, requires_review: true });
    expect(service.db.getOrder(created.order_id!)?.status).toBe("pending");
    expect(payment.queryPayment).not.toHaveBeenCalled();
    expect((await create()).statusCode).toBe(409);
    await paidCallback(created.order_id!);
    expect((await item(created.test_id)).payment_status).toBe("paid");
  });
  it("late callbacks never revive a locally closed order", async () => {
    const created: BluevTestOrder = (await create()).json().item;
    service.db.db.prepare("UPDATE orders SET status='closed' WHERE order_id=?").run(created.order_id!);
    expect((await paidCallback(created.order_id!)).statusCode).toBe(400);
    expect(service.db.getOrder(created.order_id!)?.status).toBe("closed");
    expect(service.db.listActivations(created.order_id!)).toHaveLength(0);
  });
  it("a callback cannot invent a test, and raw verification errors never leak", async () => {
    expect((await service.app.inject({ method: "POST", url: "/callbacks/alipay", payload: { out_trade_no: "UP20260101ABCDEF" } })).body).toBe("failure");
    expect(service.tests.list()).toEqual([]);
    const created: BluevTestOrder = (await create()).json().item;
    vi.mocked(payment.verifyNotification).mockRejectedValue(new Error("private-key-confidential upstream raw"));
    const response = await service.app.inject({ method: "POST", url: "/callbacks/alipay", payload: { out_trade_no: created.order_id } });
    expect(response.statusCode).toBe(400); expect(response.body).toBe("failure");
    expect(service.db.listActivations(created.order_id!)).toHaveLength(0);
  });
  it("intent query timeout is only retryable review, never a failed or refunded order", async () => {
    vi.mocked(payment.createPaymentUrl).mockRejectedValue(new Error("precreate uncertain"));
    const created: BluevTestOrder = (await create()).json().item;
    vi.mocked(payment.queryPayment).mockRejectedValue(new Error("query uncertain"));
    await service.tests.recoverIntents();
    expect(await item(created.test_id)).toMatchObject({ payment_status: "unknown", fulfillment_status: "not_started", terminal: false, requires_review: true });
    expect(service.db.getOrder(created.order_id!)).toBeUndefined();
    expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it("pure list and status do not secretly recover, precreate or start fulfillment", async () => {
    vi.mocked(payment.createPaymentUrl).mockRejectedValue(new Error("uncertain"));
    const created: BluevTestOrder = (await create()).json().item;
    await item(created.test_id);
    await service.app.inject({ url: `${prefix}/orders`, headers: headers() });
    await service.app.inject({ url: `${prefix}/status`, headers: headers() });
    expect(payment.queryPayment).not.toHaveBeenCalled(); expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
    expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it("drains on close without starting a new payment query", async () => {
    vi.mocked(payment.createPaymentUrl).mockRejectedValue(new Error("timeout")); await create();
    await service.app.close(); closed = true;
    expect(payment.queryPayment).not.toHaveBeenCalled();
  });
  it("does not migrate an existing unmarked database or accept different keys", async () => {
    const foreignPath = join(directory, "foreign", "bluev-sandbox.sqlite");
    const { mkdirSync } = await import("node:fs"); mkdirSync(join(directory, "foreign"));
    const foreign = new DatabaseSync(foreignPath); foreign.exec("CREATE TABLE valuable(data TEXT)"); foreign.close();
    const before = readFileSync(foreignPath);
    expect(() => openBluevSandboxDatabase({ ...config, databasePath: foreignPath, partnerSalesGateFile: join(directory, "foreign", "sales.enabled") })).toThrow("marker_required");
    expect(readFileSync(foreignPath)).toEqual(before);
    expect(() => openBluevSandboxDatabase({ ...config, emailHmacKey: "another-key" })).toThrow("marker_required");
    expect(() => openBluevSandboxDatabase({ ...config, databasePath: join(directory, "production.sqlite") })).toThrow("isolation_required");
  });
});

describe("sandbox production configuration fail-closed contract", () => {
  const environment = (): NodeJS.ProcessEnv => ({ NODE_ENV: "production", BLUEV_SANDBOX_ENABLED: "true",
    HOST: "127.0.0.1", PORT: "3112", PUBLIC_BASE_URL: "https://x.aifu.me/bluev-sandbox",
    BLUEV_SANDBOX_DB_PATH: "/srv/x-bluev-sandbox/bluev-sandbox.sqlite", BLUEV_SANDBOX_SALES_GATE_FILE: "/srv/x-bluev-sandbox/sales.enabled",
    BLUEV_TEST_KEY: "k".repeat(40), SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"), EMAIL_HMAC_KEY: "h".repeat(40),
    ALIPAY_APP_ID: "2020000000000000", ALIPAY_SELLER_ID: "2088000000000000", ALIPAY_PRIVATE_KEY: "test-private", ALIPAY_PUBLIC_KEY: "test-public",
    X_API_MODE: "live", X_API_BASE_URL: "https://x.aifu.me", X_API_PARTNER_ID: `usr_${"a".repeat(32)}`, X_API_KEY_ID: `key_${"b".repeat(32)}`, X_API_SECRET: "x".repeat(40) });
  it.each([
    ["BLUEV_SANDBOX_ENABLED", "false"], ["NODE_ENV", "development"], ["HOST", "0.0.0.0"], ["PORT", "3100"],
    ["PUBLIC_BASE_URL", "https://x.aifu.me"], ["X_API_MODE", "mock"], ["X_API_BASE_URL", "https://user@x.aifu.me"],
    ["BLUEV_TEST_KEY", "short"], ["BLUEV_SANDBOX_DB_PATH", "/srv/x-partner-gateway/merchant-gateway.sqlite"],
    ["ALIPAY_NOTIFY_URL", "https://x.aifu.me/api/alipay/notify"], ["ALIPAY_GATEWAY", "https://openapi-sandbox.dl.alipaydev.com/gateway.do"],
  ])("rejects unsafe %s", (name, value) => expect(() => loadBluevSandboxConfig({ ...environment(), [name]: value })).toThrow());
  it("does not inherit formal DB, worker gate, webhook or GPT credentials", () => {
    // Production Linux paths are deliberately validated even when building on Windows.
    if (process.platform === "win32") return;
    const config = loadBluevSandboxConfig({ ...environment(), DATABASE_PATH: "/production.sqlite", PARTNER_SALES_GATE_FILE: "/old/sales",
      ZOVO_API_KEY: "do-not-use", PLATFORM_WEBHOOK_URL: "https://callback.invalid", QUEFA_WORKER_GATE_FILE: "/old/workers" });
    expect(config.databasePath).toBe("/srv/x-bluev-sandbox/bluev-sandbox.sqlite");
    expect(config.platformWebhookEnabled).toBe(false); expect(config.zovo.apiKey).toBe("");
  });
});
