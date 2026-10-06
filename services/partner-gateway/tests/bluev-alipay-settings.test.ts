import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlipaySdk } from "alipay-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/database.js";
import type { AppConfig } from "../src/config.js";
import type { OrderRecord } from "../src/domain.js";
import { MockPaymentClient, type PaymentConfirmation } from "../src/clients/payment.js";
import type { BluevRecoveryPayment } from "../src/bluev-sandbox-payment.js";
import { BLUEV_ALIPAY_NOTIFY_URL, BluevAlipaySettingsError } from "../src/bluev-alipay-contract.js";
import { BluevAlipaySettings, BluevAlipayPaymentRouter, type BluevAlipayClientFactory } from "../src/bluev-alipay-settings.js";

const keyPair = (modulusLength = 2048) => generateKeyPairSync("rsa", { modulusLength,
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const [applicationKeys, alipayKeys, rotatedKeys] = [keyPair(), keyPair(), keyPair()];
const seed: AppConfig["alipay"] = { appId: "2021000000000001", sellerId: "2088000000000001",
  privateKey: applicationKeys.privateKey, publicKey: alipayKeys.publicKey,
  gateway: "https://openapi.alipay.com/gateway.do", notifyUrl: BLUEV_ALIPAY_NOTIFY_URL, returnUrl: "" };
const nextIdentity: AppConfig["alipay"] = { ...seed, appId: "2021000000000002", sellerId: "2088000000000002",
  privateKey: alipayKeys.privateKey, publicKey: applicationKeys.publicKey };
const encryptionKey = Buffer.alloc(32, 0x53);
const paid = (): PaymentConfirmation => ({ paid: true, tradeNo: "verified-trade", paidAt: new Date().toISOString(),
  receiptAmount: "22.00", tradeStatus: "TRADE_SUCCESS" });
function record(id: string): OrderRecord {
  const now = new Date().toISOString();
  return { order_id: id, client_order_id: `ADMINTEST-BLUEV-${id}`, product: "x_premium_3m", plan: "x_premium_3m",
    quantity: 1, sell_price: "22.00", amount: "22.00", status: "pending", qr: "", expires_at: new Date(Date.now() + 1200000).toISOString(),
    alipay_trade_no: null, paid_at: null, refunded_at: null, delivery_status: null, platform_supply_price: "22.00", platform_max_sell_price: "22.00",
    upstream_estimated_cost_cny: null, upstream_actual_cost_amount: null, upstream_actual_cost_currency: null, upstream_actual_cost_cny: null,
    alipay_receipt_amount: null, customer_price_refund_amount: "0.00", customer_price_refund_reference: null,
    customer_price_refund_reason: null, customer_price_refunded_at: null, created_at: now, updated_at: now };
}
function saveInput(revision = 1, config = seed, keys = false) {
  return { app_id: config.appId, seller_id: config.sellerId, private_key: keys ? config.privateKey : "",
    public_key: keys ? config.publicKey : "", expected_revision: revision, confirm_apply: true };
}
function notification(order: OrderRecord, config = seed, signer = alipayKeys.privateKey) {
  const payload: Record<string, string> = { app_id: config.appId, seller_id: config.sellerId,
    out_trade_no: order.order_id, total_amount: order.amount, trade_no: "verified-trade", trade_status: "TRADE_SUCCESS", sign_type: "RSA2" };
  const canonical = Object.keys(payload).filter(key => key !== "sign_type").sort().map(key => `${key}=${payload[key]}`).join("&");
  return { ...payload, sign: sign("RSA-SHA256", Buffer.from(canonical), signer).toString("base64") };
}

describe("isolated encrypted blueV Alipay settings and order identity routing", () => {
  let directory: string, db: AppDatabase;
  let calls: Array<{ operation: string; config: AppConfig["alipay"]; orderId: string }>;
  let factory: ReturnType<typeof vi.fn<BluevAlipayClientFactory>>;
  let store: BluevAlipaySettings, router: BluevAlipayPaymentRouter;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "bluev-alipay-settings-"));
    db = new AppDatabase(join(directory, "bluev-sandbox.sqlite"));
    db.db.exec(`CREATE TABLE checkout_intents(client_order_id TEXT PRIMARY KEY,order_json TEXT NOT NULL,
      lease_token TEXT,lease_until TEXT,updated_at TEXT NOT NULL)`);
    calls = [];
    factory = vi.fn((config: AppConfig["alipay"]) => {
      class Client extends MockPaymentClient implements BluevRecoveryPayment {
        override async createPaymentUrl(order: Pick<OrderRecord, "order_id">) {
          expect(db.db.prepare("SELECT order_id FROM bluev_alipay_order_identities WHERE order_id=?").get(order.order_id)).toBeTruthy();
          calls.push({ operation: "create", config, orderId: order.order_id }); return "https://qr.alipay.com/test-only";
        }
        override async queryPayment(order: OrderRecord) {
          calls.push({ operation: "query", config, orderId: order.order_id }); return paid();
        }
        async queryForRecovery(order: OrderRecord) {
          calls.push({ operation: "recovery", config, orderId: order.order_id });
          return { state: "not_found" as const, confirmation: { ...paid(), paid: false, tradeNo: null, tradeStatus: null, receiptAmount: null } };
        }
        override async verifyNotification(): Promise<PaymentConfirmation> { throw new Error("historical_client_must_not_verify_and_query"); }
      }
      return new Client("https://invalid.test");
    });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden"); }));
    vi.spyOn(AlipaySdk.prototype, "exec").mockImplementation(async () => { throw new Error("real_payment_forbidden"); });
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled(); expect(AlipaySdk.prototype.exec).not.toHaveBeenCalled();
    db.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  function setup() {
    store = new BluevAlipaySettings(db, seed, encryptionKey, factory);
    router = new BluevAlipayPaymentRouter(store);
  }
  function intent(id = "UPTEST001") {
    const order = record(id);
    db.db.prepare("INSERT INTO checkout_intents(client_order_id,order_json,updated_at) VALUES(?,?,?)")
      .run(order.client_order_id, JSON.stringify(order), order.updated_at);
    return order;
  }
  function binding(id: string) { return db.db.prepare("SELECT * FROM bluev_alipay_order_identities WHERE order_id=?").get(id); }

  it("seeds one encrypted revision without any payment/client calls or key values in the DTO", () => {
    setup(); const dto = store.read();
    expect(dto).toEqual({ revision: 1, app_id: seed.appId, seller_id: seed.sellerId, has_private_key: true,
      has_public_key: true, notify_url: BLUEV_ALIPAY_NOTIFY_URL, updated_at: expect.any(String) });
    expect(factory).not.toHaveBeenCalled(); expect(calls).toEqual([]);
    const rows = JSON.stringify(db.db.prepare("SELECT * FROM bluev_alipay_versions").all());
    expect(rows).not.toContain("PRIVATE KEY"); expect(rows).not.toContain("PUBLIC KEY");
    expect(rows).not.toContain(seed.privateKey); expect(rows).not.toContain(seed.publicKey);
    expect(JSON.stringify(dto)).not.toMatch(/ciphertext|secret_|fingerprint|private_key.*BEGIN|public_key.*BEGIN/);
    const bytes = Buffer.concat(["bluev-sandbox.sqlite", "bluev-sandbox.sqlite-wal"].map(file => join(directory, file))
      .filter(path => existsSync(path)).map(path => readFileSync(path)));
    expect(bytes.includes(Buffer.from(seed.privateKey))).toBe(false); expect(bytes.includes(Buffer.from(seed.publicKey))).toBe(false);
  });
  it("backfills legacy orders and intent-only records to env identity without changing original JSON", async () => {
    const complete = record("UPLEGACY001"); complete.qr = "https://qr.alipay.com/original";
    db.createOrder(complete); const pending = intent("UPLEGACY002");
    const beforeOrders = db.db.prepare("SELECT * FROM orders").all();
    const beforeIntents = db.db.prepare("SELECT * FROM checkout_intents").all();
    setup();
    expect(binding(complete.order_id)?.bound_revision).toBe(1); expect(binding(pending.order_id)?.bound_revision).toBe(1);
    expect(db.db.prepare("SELECT * FROM orders").all()).toEqual(beforeOrders);
    expect(db.db.prepare("SELECT * FROM checkout_intents").all()).toEqual(beforeIntents);
    store.save(saveInput(1, nextIdentity, true));
    await router.queryPayment(complete); await router.queryForRecovery(pending);
    expect(calls.map(item => item.config.appId)).toEqual([seed.appId, seed.appId]);
  });
  it("supports initialization before checkout_intents exists", () => {
    db.db.exec("DROP TABLE checkout_intents"); setup();
    expect(store.read().revision).toBe(1); expect(factory).not.toHaveBeenCalled();
  });
  it("does not reseed or silently change keys from environment on restart", () => {
    setup(); store.save(saveInput(1, nextIdentity, true));
    const before = db.db.prepare("SELECT * FROM bluev_alipay_versions").all();
    const restarted = new BluevAlipaySettings(db, { ...seed, privateKey: "invalid ignored environment secret" }, encryptionKey, factory);
    expect(restarted.read()).toMatchObject({ revision: 2, app_id: nextIdentity.appId });
    expect(db.db.prepare("SELECT * FROM bluev_alipay_versions").all()).toEqual(before);
  });
  it("binds a new order durably before the first payment call and never switches it with active settings", async () => {
    setup(); const original = intent();
    await router.createPaymentUrl(original);
    const originalBinding = binding(original.order_id);
    store.save(saveInput(1, nextIdentity, true));
    await router.queryPayment(original); await router.queryForRecovery(original); await router.createPaymentUrl(original);
    expect(binding(original.order_id)).toEqual(originalBinding);
    expect(calls.map(item => item.config.appId)).toEqual([seed.appId, seed.appId, seed.appId, seed.appId]);
    const next = intent("UPTEST002"); await router.createPaymentUrl(next);
    expect(calls.at(-1)?.config.appId).toBe(nextIdentity.appId); expect(binding(next.order_id)?.bound_revision).toBe(2);
  });
  it("can bind a newly reserved intent during query-only crash recovery without precreating", async () => {
    setup(); store.save(saveInput(1, nextIdentity, true)); const order = intent();
    await router.queryForRecovery(order);
    expect(binding(order.order_id)?.bound_revision).toBe(2); expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ operation: "recovery", config: { appId: nextIdentity.appId } });
  });
  it("same-identity empty keys retain secrets while all bound orders use the latest rotated keys", async () => {
    setup(); const original = intent(); await router.createPaymentUrl(original);
    store.save(saveInput());
    await router.queryPayment(original);
    expect(calls.at(-1)?.config.privateKey).toBe(seed.privateKey); expect(calls.at(-1)?.config.publicKey).toBe(seed.publicKey);
    const rotated = { ...seed, privateKey: rotatedKeys.privateKey, publicKey: rotatedKeys.publicKey };
    store.save(saveInput(2, rotated, true)); await router.queryForRecovery(original);
    expect(calls.at(-1)?.config).toMatchObject({ privateKey: rotated.privateKey, publicKey: rotated.publicKey, appId: seed.appId });
    expect(binding(original.order_id)?.bound_revision).toBe(1); expect(store.read().revision).toBe(3);
  });
  it("one replacement key on the same identity retains the other and does not call payment", () => {
    setup();
    store.save({ ...saveInput(), private_key: rotatedKeys.privateKey });
    expect(store.read().revision).toBe(2); expect(factory).not.toHaveBeenCalled();
  });
  it.each(["private_key", "public_key"])("identity change requires both keys, rejecting omitted %s atomically", field => {
    setup(); const before = db.db.prepare("SELECT * FROM bluev_alipay_versions").all();
    expect(() => store.save({ ...saveInput(1, nextIdentity, true), [field]: "" })).toThrowError(expect.objectContaining({ code: "bluev_alipay_keys_required" }));
    expect(store.read().revision).toBe(1); expect(db.db.prepare("SELECT * FROM bluev_alipay_versions").all()).toEqual(before); expect(factory).not.toHaveBeenCalled();
  });
  it("seller-only identity changes also require both new keys", () => {
    setup(); expect(() => store.save({ ...saveInput(), seller_id: nextIdentity.sellerId })).toThrowError(expect.objectContaining({ code: "bluev_alipay_keys_required" }));
  });
  it("optimistic revisions prevent a stale administrator from replacing another save", () => {
    setup(); const secondDb = new AppDatabase(join(directory, "bluev-sandbox.sqlite"));
    try {
      const other = new BluevAlipaySettings(secondDb, seed, encryptionKey, factory);
      store.save(saveInput());
      expect(() => other.save(saveInput(1, nextIdentity, true))).toThrowError(expect.objectContaining({ code: "bluev_alipay_revision_conflict", httpStatus: 409 }));
      expect(other.read()).toMatchObject({ revision: 2, app_id: seed.appId });
      expect(db.db.prepare("SELECT COUNT(*) n FROM bluev_alipay_versions").get()?.n).toBe(2); expect(factory).not.toHaveBeenCalled();
    } finally { secondDb.close(); }
  });
  it.each([{ expected_revision: 0 }, { expected_revision: 1.5 }, { confirm_apply: false }, { confirm_apply: undefined },
    { app_id: "123" }, { seller_id: "not-a-pid" }, { gateway: "https://evil.invalid" }, { notify_url: "https://evil.invalid" },
    { private_key: "x".repeat(8193) }, { public_key: null }])("strictly rejects invalid or unrecognized save input %j", patch => {
    setup(); expect(() => store.save({ ...saveInput(), ...patch })).toThrowError(expect.objectContaining({ code: "bluev_alipay_invalid_request" }));
    expect(store.read().revision).toBe(1); expect(factory).not.toHaveBeenCalled();
  });
  it.each(["private", "public"])("invalid %s key produces fixed safe errors, not raw key material", kind => {
    setup(); const raw = "secret-user-input-never-echo";
    try { store.save({ ...saveInput(), [`${kind}_key`]: raw }); throw new Error("expected_failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(BluevAlipaySettingsError);
      expect(error).toMatchObject({ code: `bluev_alipay_invalid_${kind}_key` });
      expect(String(error)).not.toContain(raw); expect(JSON.stringify(error)).not.toContain(raw);
    }
    expect(store.read().revision).toBe(1);
  });
  it("never accepts a private key pasted into the public-key field", () => {
    setup(); expect(() => store.save({ ...saveInput(), public_key: alipayKeys.privateKey })).toThrowError(expect.objectContaining({ code: "bluev_alipay_invalid_public_key" }));
  });
  it("accepts bare base64 RSA keys, normalizing them only inside encrypted storage", async () => {
    setup(); const bare = (key: string) => key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    store.save({ ...saveInput(), private_key: bare(rotatedKeys.privateKey), public_key: bare(rotatedKeys.publicKey) });
    const order = intent(); await router.createPaymentUrl(order);
    expect(calls.at(-1)?.config).toMatchObject({ privateKey: rotatedKeys.privateKey, publicKey: rotatedKeys.publicKey });
    expect(JSON.stringify(store.read())).not.toContain(bare(rotatedKeys.publicKey));
  });
  it("rejects weak RSA keys", () => {
    setup(); const weak = keyPair(1024);
    expect(() => store.save({ ...saveInput(), private_key: weak.privateKey })).toThrowError(expect.objectContaining({ code: "bluev_alipay_invalid_private_key" }));
    expect(() => store.save({ ...saveInput(), public_key: weak.publicKey })).toThrowError(expect.objectContaining({ code: "bluev_alipay_invalid_public_key" }));
  });
  it("authenticates AES-GCM version/purpose so ciphertext cannot be moved between revisions", () => {
    setup(); store.save(saveInput());
    db.db.exec(`UPDATE bluev_alipay_versions SET secret_ciphertext=(SELECT secret_ciphertext FROM bluev_alipay_versions WHERE revision=1),
      secret_iv=(SELECT secret_iv FROM bluev_alipay_versions WHERE revision=1),secret_tag=(SELECT secret_tag FROM bluev_alipay_versions WHERE revision=1) WHERE revision=2`);
    expect(() => store.read()).toThrowError(expect.objectContaining({ code: "bluev_alipay_storage_unavailable" }));
  });
  it("rejects another encryption key without modifying saved profiles", () => {
    setup(); const before = db.db.prepare("SELECT * FROM bluev_alipay_versions").all();
    expect(() => new BluevAlipaySettings(db, seed, Buffer.alloc(32, 8), factory)).toThrowError(expect.objectContaining({ code: "bluev_alipay_storage_unavailable" }));
    expect(db.db.prepare("SELECT * FROM bluev_alipay_versions").all()).toEqual(before);
  });
  it("never invents bindings for absent records or completed orders created outside the router", async () => {
    setup(); const missing = record("UPMISSING001");
    await expect(router.queryPayment(missing)).rejects.toMatchObject({ code: "bluev_alipay_binding_missing" });
    db.createOrder(missing);
    await expect(router.queryForRecovery(missing)).rejects.toMatchObject({ code: "bluev_alipay_binding_missing" });
    expect(factory).not.toHaveBeenCalled(); expect(binding(missing.order_id)).toBeUndefined();
  });
  it("rejects order-field mismatches before binding or making a client", async () => {
    setup(); const order = intent();
    for (const patch of [{ amount: "0.01" }, { product: "x_premium_6m" }, { client_order_id: "different-client" }]) {
      await expect(router.createPaymentUrl({ ...order, ...patch })).rejects.toMatchObject({ code: "bluev_alipay_binding_mismatch" });
    }
    expect(factory).not.toHaveBeenCalled(); expect(binding(order.order_id)).toBeUndefined();
  });
  it.each([{ status: "paid" }, { qr: "https://qr.alipay.com/already-created" }, { paid_at: "2026-10-06T00:00:00.000Z" },
    { alipay_trade_no: "existing-trade" }])("never infers the active identity for an unbound intent with payment evidence %j", async patch => {
    setup(); const order = intent();
    db.db.prepare("UPDATE checkout_intents SET order_json=? WHERE client_order_id=?")
      .run(JSON.stringify({ ...order, ...patch }), order.client_order_id);
    await expect(router.queryForRecovery(order)).rejects.toMatchObject({ code: "bluev_alipay_binding_missing" });
    expect(factory).not.toHaveBeenCalled(); expect(binding(order.order_id)).toBeUndefined();
  });
  it("a payment already in flight keeps its bound identity when settings are saved concurrently", async () => {
    setup(); const order = intent();
    let release!: (url: string) => void;
    factory.mockImplementationOnce(config => {
      const client = new MockPaymentClient("https://invalid.test") as MockPaymentClient & BluevRecoveryPayment;
      client.queryForRecovery = async () => ({ state: "unknown", confirmation: { ...paid(), paid: false } });
      client.createPaymentUrl = async () => {
        expect(binding(order.order_id)?.bound_revision).toBe(1);
        calls.push({ operation: "create", config, orderId: order.order_id });
        return new Promise<string>(resolve => { release = resolve; });
      };
      return client;
    });
    const inFlight = router.createPaymentUrl(order);
    expect(release).toBeTypeOf("function");
    store.save(saveInput(1, nextIdentity, true));
    release("https://qr.alipay.com/test-only"); await inFlight;
    await router.queryPayment(order);
    expect(calls.map(call => call.config.appId)).toEqual([seed.appId, seed.appId]);
    expect(store.read().app_id).toBe(nextIdentity.appId); expect(binding(order.order_id)?.bound_revision).toBe(1);
  });
  it("old-identity callbacks remain valid after switching the global active app", async () => {
    setup(); const order = intent(); await router.createPaymentUrl(order); calls.length = 0;
    store.save(saveInput(1, nextIdentity, true));
    expect(await router.verifyNotification(notification(order), order)).toMatchObject({ paid: true });
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ operation: "query", config: { appId: seed.appId, privateKey: seed.privateKey } });
  });
  it("old-public-key signatures are accepted locally but actively queried with latest same-identity keys", async () => {
    setup(); const order = intent(); await router.createPaymentUrl(order); calls.length = 0;
    const rotated = { ...seed, privateKey: rotatedKeys.privateKey, publicKey: rotatedKeys.publicKey };
    store.save(saveInput(1, rotated, true));
    expect(await router.verifyNotification(notification(order), order)).toMatchObject({ paid: true });
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ operation: "query", config: { privateKey: rotatedKeys.privateKey, publicKey: rotatedKeys.publicKey } });
    expect(await router.verifyNotification(notification(order, rotated, rotatedKeys.privateKey), order)).toMatchObject({ paid: true });
  });
  it("cannot use another identity's valid historical signing key for the original order", async () => {
    setup(); const order = intent(); await router.createPaymentUrl(order); calls.length = 0;
    store.save(saveInput(1, nextIdentity, true));
    await expect(router.verifyNotification(notification(order, seed, applicationKeys.privateKey), order)).rejects.toMatchObject({ code: "bluev_alipay_notification_invalid" });
    expect(calls).toEqual([]);
  });
  it.each(["app_id", "seller_id", "out_trade_no", "total_amount", "trade_no"])("refuses callback mismatch %s without active querying", async field => {
    setup(); const order = intent(); await router.createPaymentUrl(order); calls.length = 0;
    const payload = { ...notification(order), [field]: field === "total_amount" ? "0.01" : field === "trade_no" ? "" : "wrong" };
    await expect(router.verifyNotification(payload, order)).rejects.toMatchObject({ code: "bluev_alipay_notification_invalid" });
    expect(calls).toEqual([]);
  });
  it("a valid signature still cannot confirm payment when the latest active query is not paid", async () => {
    setup(); const order = intent(); await router.createPaymentUrl(order);
    const mock = new MockPaymentClient("https://invalid.test") as MockPaymentClient & BluevRecoveryPayment;
    mock.queryForRecovery = async () => ({ state: "unknown", confirmation: { ...paid(), paid: false } });
    factory.mockReturnValueOnce(mock);
    await expect(router.verifyNotification(notification(order), order)).rejects.toMatchObject({ code: "bluev_alipay_notification_invalid" });
  });
  it("unbound incoming notifications cannot choose an identity or create a binding", async () => {
    setup(); const order = intent();
    await expect(router.verifyNotification(notification(order), order)).rejects.toMatchObject({ code: "bluev_alipay_binding_missing" });
    expect(binding(order.order_id)).toBeUndefined(); expect(factory).not.toHaveBeenCalled();
  });
  it("unsigned callback cannot cause a query even after key rotation", async () => {
    setup(); const order = intent(); await router.createPaymentUrl(order); calls.length = 0;
    store.save(saveInput(1, { ...seed, publicKey: rotatedKeys.publicKey }, true));
    await expect(router.verifyNotification({ ...notification(order), sign: "" }, order)).rejects.toMatchObject({ code: "bluev_alipay_notification_invalid" });
    expect(calls).toEqual([]);
  });
  it("explicitly disables refunds without contacting any payment provider", async () => {
    setup(); const order = intent();
    await expect(router.refundPayment(order, "request", "reason")).rejects.toMatchObject({ code: "bluev_alipay_refund_disabled" });
    await expect(router.queryRefund(order, "request")).rejects.toMatchObject({ code: "bluev_alipay_refund_disabled" });
    expect(factory).not.toHaveBeenCalled();
  });
});
