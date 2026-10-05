import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { MockXApiClient } from "../src/clients/x-api.js";
import { ActivationWorker } from "../src/services/activation-worker.js";
import { PlatformWebhookWorker } from "../src/services/platform-webhook.js";
import { signPlatformWebhook } from "../src/security.js";

const catalog = "./config/products-x-partner.json";
const production = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production", PRODUCT_CATALOG_PATH: catalog,
  PUBLIC_BASE_URL: "https://partner.example.com", PLATFORM_API_KEY: "a".repeat(40),
  PLATFORM_WEBHOOK_SECRET: "w".repeat(40), PLATFORM_WEBHOOK_URL: "https://shop.example.com/callback",
  ADMIN_TOKEN: "d".repeat(40), SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
  EMAIL_HMAC_KEY: "h".repeat(40), PAYMENT_PROVIDER: "alipay", ALIPAY_APP_ID: "test-app",
  ALIPAY_PRIVATE_KEY: "test-private", ALIPAY_PUBLIC_KEY: "test-public", ALIPAY_SELLER_ID: "test-seller",
  ALIPAY_NOTIFY_URL: "https://partner.example.com/callbacks/alipay", X_API_MODE: "disabled",
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("isolated partner webhook configuration", () => {
  it("retains legacy enabled behavior when the flag is absent", () => {
    const config = loadConfig({ NODE_ENV: "test", PRODUCT_CATALOG_PATH: catalog });
    expect(config.platformWebhookEnabled).toBe(true);
    expect(config.platformWebhookUrl).toBe("https://prodclub.xyz/api/v1/upstream/webhook");
  });

  it.each(["false", "0", "off", "no"])("explicit %s disables delivery without inheriting the GPT callback", (flag) => {
    const env = production();
    delete env.PLATFORM_WEBHOOK_URL;
    delete env.PLATFORM_WEBHOOK_SECRET;
    env.PLATFORM_WEBHOOK_ENABLED = flag;
    const config = loadConfig(env);
    expect(config.platformWebhookEnabled).toBe(false);
    expect(config.platformWebhookUrl).toBe("");
  });

  it("does not silently reinterpret a misspelled delivery flag", () => {
    expect(() => loadConfig({ ...production(), PLATFORM_WEBHOOK_ENABLED: "flase" })).toThrow("PLATFORM_WEBHOOK_ENABLED");
  });

  it.each([
    "http://shop.example.com/callback", "https://user:password@shop.example.com/callback",
    "https://shop.example.com/callback#token", "https://shop.example.com/callback#",
    "https://localhost/callback", "https://localhost./callback", "https://service.local/callback",
    "https://metadata.google.internal/callback", "https://router.home.arpa/callback", "https://singlelabel/callback",
    "https://127.0.0.1/callback", "https://2130706433/callback", "https://10.0.0.1/callback",
    "https://192.168.1.1/callback", "https://172.16.0.1/callback", "https://169.254.169.254/callback",
    "https://100.64.0.1/callback", "https://[::1]/callback", "https://[fd00::1]/callback",
    "https://[fe80::1]/callback", "https://[::ffff:127.0.0.1]/callback", "not-a-url",
  ])("rejects an unsafe enabled production callback: %s", (url) => {
    expect(() => loadConfig({ ...production(), PLATFORM_WEBHOOK_URL: url })).toThrow("公网 HTTPS");
  });

  it.each(["https://shop.example.com/callback?version=1", "https://8.8.8.8/callback", "https://[2606:4700:4700::1111]/callback"])(
    "accepts a public HTTPS callback with an independent secret: %s", (url) => {
      expect(loadConfig({ ...production(), PLATFORM_WEBHOOK_URL: url }).platformWebhookEnabled).toBe(true);
    },
  );

  it("requires a strong independent key only when delivery is enabled", () => {
    expect(() => loadConfig({ ...production(), PLATFORM_WEBHOOK_SECRET: "short" })).toThrow("独立");
    expect(() => loadConfig({ ...production(), PLATFORM_WEBHOOK_SECRET: "a".repeat(40) })).toThrow("独立");
    expect(() => loadConfig({ ...production(), PLATFORM_WEBHOOK_ENABLED: "false", PLATFORM_WEBHOOK_SECRET: "" })).not.toThrow();
  });

  it("loads only the two disabled X products with the agreed supply prices", () => {
    const config = loadConfig({ NODE_ENV: "test", PRODUCT_CATALOG_PATH: catalog });
    expect(config.products.map(({ product, plan, cost_price, max_sell_price, enabled, internal_cost_cny }) =>
      ({ product, plan, cost_price, max_sell_price, enabled, internal_cost_cny }))).toEqual([
      { product: "x_premium_3m", plan: "x_premium_3m", cost_price: "22.00", max_sell_price: "9999.00", enabled: false, internal_cost_cny: "0.00" },
      { product: "x_premium_6m", plan: "x_premium_6m", cost_price: "44.00", max_sell_price: "9999.00", enabled: false, internal_cost_cny: "0.00" },
    ]);
  });
});

describe("disabled delivery preserves payment and automatic gift fulfillment", () => {
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let giftWorker: ActivationWorker | undefined;
  let webhook: PlatformWebhookWorker | undefined;

  afterEach(async () => {
    webhook?.stop();
    await giftWorker?.stop();
    await app?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined; app = undefined; giftWorker = undefined; webhook = undefined;
  });

  async function fulfilledOrder() {
    directory = mkdtempSync(join(tmpdir(), "x-webhook-off-"));
    const config = loadConfig({ NODE_ENV: "test", PRODUCT_CATALOG_PATH: catalog,
      DATABASE_PATH: join(directory, "test.sqlite"), SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
      X_API_MODE: "mock", PLATFORM_WEBHOOK_ENABLED: "false" });
    config.products[0].enabled = true;
    const db = new AppDatabase(config.databasePath);
    const xApi = new MockXApiClient();
    const zovo = new MockZovoClient();
    app = await buildApp(config, { db, xApi, zovo, payment: new MockPaymentClient(config.publicBaseUrl), startWorkers: false });
    const created = await app.inject({ method: "POST", url: "/api/v1/checkout/orders",
      headers: { "x-api-key": config.platformApiKey }, payload: { product: "x_premium_3m", quantity: 1,
        sell_price: "22.00", client_order_id: "JD-WEBHOOK-OFF", recipient: "example_user" } });
    expect(created.statusCode).toBe(200);
    const orderId = String(created.json().order_id);
    const paid = await app.inject({ method: "POST", url: `/dev/pay/${orderId}` });
    expect(paid.statusCode).toBe(200);
    expect(db.listActivations(orderId)).toHaveLength(1);
    giftWorker = new ActivationWorker(config, db, zovo, app.log, xApi);
    await giftWorker.tick();
    xApi.setStatus(`jd:${orderId}`, "succeeded");
    xApi.orders.get(`jd:${orderId}`)!.receipt = "pi_mock_confirmed";
    await giftWorker.tick();
    expect(db.getOrder(orderId)).toMatchObject({ status: "paid", delivery_status: "success" });
    const rows = () => db.db.prepare("SELECT * FROM webhook_outbox ORDER BY id").all();
    expect(rows()).toMatchObject([{ event: "order.paid", delivered_at: null }, { event: "order.activated", delivered_at: null }]);
    webhook = new PlatformWebhookWorker(config, db, app.log);
    return { config, db, rows, orderId };
  }

  it("creates paid/success outbox events while stopped, and resumes them only to the newly configured callback", async () => {
    const fetcher = vi.fn(async () => new Response("success"));
    vi.stubGlobal("fetch", fetcher);
    const { config, rows } = await fulfilledOrder();
    const before = rows();
    const interval = vi.spyOn(globalThis, "setInterval");
    webhook!.start();
    await webhook!.tick();
    await webhook!.tick();
    expect(interval).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows()).toEqual(before);

    config.platformWebhookUrl = "https://confirmed-shop.example.com/x-callback";
    config.platformWebhookSecret = "new-confirmed-webhook-secret-1234567890";
    config.platformWebhookEnabled = true;
    await webhook!.tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls as unknown as Array<[string, RequestInit]>) {
      const [url, init] = call;
      expect(url).toBe(config.platformWebhookUrl);
      expect(init.redirect).toBe("manual");
      const headers = new Headers(init.headers);
      expect(headers.get("X-Webhook-Signature")).toBe(signPlatformWebhook(config.platformWebhookSecret,
        Number(headers.get("X-Webhook-Timestamp")), String(init.body)));
    }
    expect(rows().every((row) => typeof row.delivered_at === "string")).toBe(true);
  });

  it("stops between outbox records when delivery is disabled and preserves the remaining attempt count", async () => {
    const { config, rows } = await fulfilledOrder();
    config.platformWebhookEnabled = true;
    config.platformWebhookUrl = "https://confirmed-shop.example.com/x-callback";
    const fetcher = vi.fn(async () => { config.platformWebhookEnabled = false; return new Response("success"); });
    vi.stubGlobal("fetch", fetcher);
    await webhook!.tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rows()[1]).toMatchObject({ delivered_at: null, attempt_count: 0 });
  });

  it("never follows callback redirects or marks their deliveries successful", async () => {
    const { config, rows } = await fulfilledOrder();
    config.platformWebhookEnabled = true;
    config.platformWebhookUrl = "https://confirmed-shop.example.com/x-callback";
    const fetcher = vi.fn(async () => new Response(null, { status: 307, headers: { Location: "https://other.example/collect" } }));
    vi.stubGlobal("fetch", fetcher);
    await webhook!.tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(rows().every((row) => row.delivered_at === null && row.attempt_count === 1)).toBe(true);
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("manual");
  });

  it("rejects an invalid production destination before touching outbox records or the network", async () => {
    const { config, rows } = await fulfilledOrder();
    config.nodeEnv = "production";
    config.platformWebhookEnabled = true;
    config.platformWebhookUrl = "https://user:secret@127.0.0.1/callback";
    config.platformWebhookSecret = "w".repeat(40);
    const before = rows();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(webhook!.tick()).rejects.toThrow("platform_webhook_configuration_invalid");
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows()).toEqual(before);
  });
});
