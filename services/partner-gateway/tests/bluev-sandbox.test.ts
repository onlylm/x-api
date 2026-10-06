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
import { BluevPaymentError, type BluevRecoveryPayment } from "../src/bluev-sandbox-payment.js";

describe("isolated administrator blueV real-payment sandbox", () => {
  let directory: string;
  let config: BluevSandboxConfig;
  let payment: MockPaymentClient;
  let xApi: MockXApiClient;
  let service: Awaited<ReturnType<typeof buildBluevSandbox>>;
  let closed: boolean;
  const prefix = "/internal/bluev-test";
  const headers = () => ({ "x-bluev-test-key": config.bluevTestKey });
  const input = (id: string = randomUUID(), product = "x_premium_3m", recipient = "test_user") =>
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
  function enableRecovery() {
    const query = vi.fn<BluevRecoveryPayment["queryForRecovery"]>().mockResolvedValue({ state: "not_found",
      confirmation: { paid: false, tradeNo: null, paidAt: new Date().toISOString(), receiptAmount: null, tradeStatus: null } });
    Object.assign(payment, { queryForRecovery: query });
    return query;
  }
  async function missingQr(expired = false) {
    vi.mocked(payment.createPaymentUrl).mockRejectedValueOnce(new BluevPaymentError("bluev_payment_timeout"));
    const created: BluevTestOrder = (await create()).json().item;
    if (expired) {
      const found = service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!;
      const intent = JSON.parse(String(found.order_json)); intent.expires_at = "2020-01-01T00:00:00.000Z";
      service.db.db.prepare("UPDATE checkout_intents SET order_json=? WHERE client_order_id=?").run(JSON.stringify(intent), created.client_order_id);
    }
    return created;
  }
  async function retry(id: string, version = 0, renewal = false) {
    return service.app.inject({ method: "POST", url: `${prefix}/orders/${id}/retry-qr`, headers: headers(),
      payload: { expected_version: version, confirm_retry: true, confirm_renewal: renewal } });
  }
  async function closeTest(id: string, payload: Record<string, unknown> = { confirm_close: true }) {
    return service.app.inject({ method: "POST", url: `${prefix}/orders/${id}/close`, headers: headers(), payload });
  }
  it("closes a verified absent expired test without changing its intent, and admits a new test", async () => {
    const query = enableRecovery(); const created = await missingQr(true);
    const before = service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id);
    const result = await closeTest(created.test_id);
    expect(result.statusCode).toBe(200);
    expect(result.json().item).toMatchObject({ payment_status: "closed", terminal: true, qr_retry_allowed: false, qr_available: false });
    expect(service.tests.active()).toBeNull();
    expect(service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)).toEqual(before);
    expect((await closeTest(created.test_id)).json().idempotent).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect((await retry(created.test_id)).json().error.code).toBe("retry_not_allowed");
    expect((await create(input(created.test_id))).json().item.payment_status).toBe("closed");
    await service.tests.recoverIntents(); expect(payment.queryPayment).not.toHaveBeenCalled();
    expect((await create(input(randomUUID(), "x_premium_3m", "next_user"))).statusCode).toBe(201);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(2);
  });
  it("requires an ended payment window even after a later permission rejection", async () => {
    const query = enableRecovery(); const created = await missingQr();
    expect((await closeTest(created.test_id)).json().error.code).toBe("close_window_open");
    expect(query).not.toHaveBeenCalled();
    service.db.db.prepare("UPDATE bluev_test_payment_state SET error_code='bluev_payment_provider_permission' WHERE request_id=?").run(created.test_id);
    expect((await closeTest(created.test_id)).json().error.code).toBe("close_window_open");
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["unknown", "trade_exists", "paid", "error"])("does not close when the signed query result is %s", async kind => {
    const query = enableRecovery(); const created = await missingQr(true);
    if (kind === "error") query.mockRejectedValue(new Error("provider-secret-do-not-leak"));
    else query.mockResolvedValue({ state: kind === "unknown" ? "unknown" : "trade_exists", confirmation: kind === "paid" ? confirmation() : {
      paid: false, tradeNo: kind === "trade_exists" ? "existing-trade" : null, paidAt: new Date().toISOString(), receiptAmount: null, tradeStatus: null } });
    const result = await closeTest(created.test_id);
    expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe("close_payment_unknown");
    expect(result.body).not.toContain("provider-secret");
    expect(service.tests.active()).toBe(created.test_id);
    expect(service.db.db.prepare("SELECT count(*) n FROM bluev_test_closures").get()?.n).toBe(0);
  });
  it("does not close or overwrite a concurrent payment callback", async () => {
    const query = enableRecovery(); const created = await missingQr(true);
    query.mockImplementation(async () => { await paidCallback(created.order_id!); return { state: "not_found", confirmation: {
      paid: false, tradeNo: null, paidAt: new Date().toISOString(), receiptAmount: null, tradeStatus: null } }; });
    expect((await closeTest(created.test_id)).json().error.code).toBe("close_busy");
    expect((await item(created.test_id)).payment_status).toBe("paid");
    expect(service.db.listActivations(created.order_id!)).toHaveLength(1);
  });
  it("stores unexpected late payment after close for review without gifting", async () => {
    enableRecovery(); const created = await missingQr(true);
    await closeTest(created.test_id); await paidCallback(created.order_id!);
    expect(await item(created.test_id)).toMatchObject({ payment_status: "paid", fulfillment_status: "review", terminal: false, requires_review: true });
    expect(service.db.getOrder(created.order_id!)).toBeUndefined();
    expect(service.db.listActivations(created.order_id!)).toHaveLength(0);
    expect(service.tests.active()).toBe(created.test_id);
    await service.paymentReconciler.tick();
    expect(service.db.listActivations(created.order_id!)).toHaveLength(0);
    expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it("fences close against retry and a lost query lease", async () => {
    const query = enableRecovery(); const created = await missingQr(true);
    query.mockImplementation(async () => {
      expect((await retry(created.test_id, 0, true)).statusCode).toBe(409);
      service.db.db.prepare("UPDATE bluev_test_requests SET query_lease='another-owner' WHERE request_id=?").run(created.test_id);
      return { state: "not_found", confirmation: { paid: false, tradeNo: null, paidAt: new Date().toISOString(), receiptAmount: null, tradeStatus: null } };
    });
    expect((await closeTest(created.test_id)).json().error.code).toBe("close_busy");
    expect((await item(created.test_id)).payment_status).toBe("unknown");
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
  });
  it("checks retirement inside the same transaction that would materialize a paid order", async () => {
    enableRecovery(); const created = await missingQr(true);
    const transaction = service.db.transaction.bind(service.db);
    vi.spyOn(service.db, "transaction").mockImplementationOnce(work => {
      service.db.db.prepare("INSERT INTO bluev_test_closures(request_id,closed_at,reason) VALUES(?,?,'verified_trade_not_found')")
        .run(created.test_id, new Date().toISOString());
      return transaction(work);
    });
    await paidCallback(created.order_id!);
    expect(await item(created.test_id)).toMatchObject({ payment_status: "paid", fulfillment_status: "review", requires_review: true });
    expect(service.db.getOrder(created.order_id!)).toBeUndefined();
    expect(service.db.listActivations(created.order_id!)).toHaveLength(0);
  });
  it("does not overwrite closure after a stale recovery query loses its lease", async () => {
    const created = await missingQr(true);
    vi.mocked(payment.queryPayment).mockImplementationOnce(async () => {
      service.db.db.prepare("INSERT INTO bluev_test_closures(request_id,closed_at,reason) VALUES(?,?,'verified_trade_not_found')")
        .run(created.test_id, new Date().toISOString());
      service.db.db.prepare("UPDATE bluev_test_requests SET state='closed',query_lease='new-owner' WHERE request_id=?").run(created.test_id);
      throw new Error("late query unavailable");
    });
    await service.tests.recoverIntents();
    expect(service.db.db.prepare("SELECT state FROM bluev_test_requests WHERE request_id=?").get(created.test_id)?.state).toBe("closed");
    expect((await item(created.test_id)).payment_status).toBe("closed");
  });
  it("requires explicit close confirmation and does not close a materialized payment", async () => {
    enableRecovery(); const created = (await create()).json().item;
    expect((await closeTest(created.test_id, {})).statusCode).toBe(400);
    expect((await closeTest(created.test_id, { confirm_close: true, force: true })).statusCode).toBe(400);
    expect((await closeTest(created.test_id)).json().error.code).toBe("close_not_allowed");
    expect((await item(created.test_id)).payment_status).toBe("pending");
  });
  it("shows sanitized payment errors without falsely ending unknown payments", async () => {
    enableRecovery(); const created = await missingQr();
    expect(await item(created.test_id)).toMatchObject({ qr_error_code: "bluev_payment_timeout", qr_retry_allowed: true,
      qr_retry_requires_renewal: false, qr_retry_version: 0, terminal: false });
  });
  it("manual recovery reuses the same order, amount and recipient; replay cannot resend", async () => {
    const query = enableRecovery(); const created = await missingQr();
    const response = await retry(created.test_id);
    expect(response.statusCode).toBe(200);
    expect(response.json().item).toMatchObject({ order_id: created.order_id, client_order_id: created.client_order_id,
      recipient: created.recipient, amount: "22.00", product: "x_premium_3m", qr_available: true, payment_status: "pending", qr_retry_version: 1 });
    expect(query).toHaveBeenCalledTimes(1); expect(payment.createPaymentUrl).toHaveBeenCalledTimes(2);
    expect(xApi.createOrder).not.toHaveBeenCalled();
    expect((await retry(created.test_id)).json().idempotent).toBe(true);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(2);
  });
  it("requires renewal confirmation and persists the new absolute 20m deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const query = enableRecovery(); const created = await missingQr(true);
    expect((await retry(created.test_id)).statusCode).toBe(409);
    expect(query).not.toHaveBeenCalled(); expect((await item(created.test_id)).qr_retry_version).toBe(0);
    const response = await retry(created.test_id, 0, true);
    expect(response.json().item).toMatchObject({ order_id: created.order_id, qr_available: true, qr_retry_version: 1 });
    expect(Date.parse(response.json().item.expires_at) - Date.now()).toBeGreaterThan(1199000);
    expect(Date.parse(response.json().item.expires_at) - Date.now()).toBeLessThanOrEqual(1200000);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(2);
  });
  it.each(["unknown", "trade_exists"] as const)("never precreates when original query is %s", async state => {
    const query = enableRecovery(); const created = await missingQr();
    query.mockResolvedValue({ state, confirmation: { paid: false, tradeNo: "maybe-original-trade", paidAt: new Date().toISOString(), receiptAmount: null,
      tradeStatus: state === "trade_exists" ? "TRADE_CLOSED" : null } });
    expect((await retry(created.test_id)).json().item).toMatchObject({ payment_status: "unknown", qr_retry_version: 1, qr_error_code: "retry_not_allowed" });
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1); expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it("query failure consumes a version durably, even after restart", async () => {
    const query = enableRecovery(); const created = await missingQr();
    query.mockRejectedValue(new BluevPaymentError("bluev_payment_signature_unverified"));
    await retry(created.test_id);
    await service.app.close(); service = await buildBluevSandbox(config, { payment, xApi, startWorkers: false });
    expect((await retry(created.test_id)).json().idempotent).toBe(true);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
    expect((await retry(created.test_id, 1)).statusCode).toBe(409);
  });
  it("concurrent clicks, future versions, create replays and background queries cannot resend", async () => {
    const query = enableRecovery(); const created = await missingQr();
    const answer = { state: "not_found" as const, confirmation: { paid: false, tradeNo: null, paidAt: new Date().toISOString(), receiptAmount: null, tradeStatus: null } };
    let release!: () => void;
    query.mockImplementation(() => new Promise(resolve => { release = () => resolve(answer); }));
    const first = retry(created.test_id); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect((await retry(created.test_id)).json().idempotent).toBe(true);
    expect((await retry(created.test_id, 2)).statusCode).toBe(409);
    expect((await create(input(created.test_id))).json().idempotent).toBe(true);
    await service.tests.recoverIntents(); expect(payment.queryPayment).not.toHaveBeenCalled();
    release(); await first;
    expect(query).toHaveBeenCalledTimes(1); expect(payment.createPaymentUrl).toHaveBeenCalledTimes(2);
  });
  it("an already paid original is reconciled without creating another payment", async () => {
    const query = enableRecovery(); const created = await missingQr();
    query.mockResolvedValue({ state: "trade_exists", confirmation: confirmation() });
    expect((await retry(created.test_id)).json().item).toMatchObject({ payment_status: "paid", fulfillment_status: "queued" });
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1); expect(service.db.listActivations(created.order_id!)).toHaveLength(1);
  });
  it("callback during recovery preserves payment and prevents precreate", async () => {
    const query = enableRecovery(); const created = await missingQr();
    query.mockImplementation(async () => { await paidCallback(created.order_id!); return { state: "not_found", confirmation: {
      paid: false, tradeNo: null, paidAt: new Date().toISOString(), receiptAmount: null, tradeStatus: null } }; });
    expect((await retry(created.test_id)).json().item.payment_status).toBe("paid");
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1); expect(service.db.listActivations(created.order_id!)).toHaveLength(1);
  });
  it("callback during precreate cannot be overwritten back to pending", async () => {
    enableRecovery(); const created = await missingQr();
    vi.mocked(payment.createPaymentUrl).mockImplementationOnce(async () => { await paidCallback(created.order_id!); return "https://qr.alipay.com/test"; });
    expect((await retry(created.test_id)).json().item.payment_status).toBe("paid");
    expect(service.db.listActivations(created.order_id!)).toHaveLength(1);
  });
  it.each(["sales", "recipient", "product"])("rechecks %s before original recovery", async kind => {
    enableRecovery(); const created = await missingQr(true);
    if (kind === "sales") unlinkSync(config.partnerSalesGateFile);
    if (kind === "recipient") vi.spyOn(xApi, "eligibility").mockResolvedValue({ eligible: true, username: "test_user", recipient_id: "changed-owner" });
    if (kind === "product") vi.spyOn(xApi, "isPlanAvailable").mockResolvedValue(false);
    expect((await retry(created.test_id, 0, true)).json().item).toMatchObject({ payment_status: "unknown", qr_available: false, expires_at: "2020-01-01T00:00:00.000Z" });
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1); expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it.each(["eligibility", "product", "availability"])("classifies %s exceptions as fulfillment checks, not an Alipay result", async kind => {
    enableRecovery(); const created = await missingQr(true);
    const before = service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!.order_json;
    const sensitive = new Error("raw-upstream-credentials-must-not-escape");
    if (kind === "eligibility") vi.spyOn(xApi, "eligibility").mockRejectedValue(sensitive);
    if (kind === "product") vi.spyOn(xApi, "product").mockRejectedValue(sensitive);
    if (kind === "availability") vi.spyOn(xApi, "isPlanAvailable").mockRejectedValue(sensitive);
    const response = await retry(created.test_id, 0, true);
    expect(response.json().item).toMatchObject({ qr_error_code: "retry_fulfillment_unavailable", qr_retry_version: 1, qr_available: false });
    expect(response.body).not.toContain("raw-upstream");
    expect(service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!.order_json).toBe(before);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1); expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it("classifies unreadable frozen recipient evidence without leaking decryption errors or renewing", async () => {
    enableRecovery(); const created = await missingQr(true);
    const saved = service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!;
    const intent = JSON.parse(String(saved.order_json)); intent.fulfillment_recipient_ciphertext = "invalid-ciphertext";
    const before = JSON.stringify(intent);
    service.db.db.prepare("UPDATE checkout_intents SET order_json=? WHERE client_order_id=?").run(before, created.client_order_id);
    const eligibility = vi.spyOn(xApi, "eligibility");
    expect((await retry(created.test_id, 0, true)).json().item).toMatchObject({ qr_error_code: "retry_recipient_changed", qr_retry_version: 1 });
    expect(eligibility).not.toHaveBeenCalled(); expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
    expect(service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!.order_json).toBe(before);
  });
  it.each([{ sell_price: "21.00" }, { status: "paid" }, { paid_at: "2026-10-06T00:00:00.000Z" },
    { alipay_trade_no: "retained-payment-evidence" }, { qr: "https://qr.alipay.com/retained-code" }])("refuses recovery of changed price or retained payment evidence %j before consuming a version", async patch => {
    const query = enableRecovery(); const created = await missingQr();
    const saved = service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!;
    const before = JSON.stringify({ ...JSON.parse(String(saved.order_json)), ...patch });
    service.db.db.prepare("UPDATE checkout_intents SET order_json=? WHERE client_order_id=?").run(before, created.client_order_id);
    const response = await retry(created.test_id);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe("retry_not_allowed");
    expect((await item(created.test_id)).qr_retry_version).toBe(0);
    expect(query).not.toHaveBeenCalled(); expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
    expect(service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!.order_json).toBe(before);
  });
  it.each(["eligibility", "product"])("does not renew or precreate after losing the lease during %s", async stage => {
    enableRecovery(); const created = await missingQr(true);
    const before = service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!.order_json;
    const loseLease = () => service.db.db.prepare("UPDATE bluev_test_requests SET query_lease=?,query_lease_until=? WHERE request_id=?")
      .run("another-owner", new Date(Date.now() + 120_000).toISOString(), created.test_id);
    if (stage === "eligibility") {
      const original = xApi.eligibility.bind(xApi);
      vi.spyOn(xApi, "eligibility").mockImplementation(async username => { const result = await original(username); loseLease(); return result; });
    } else {
      const original = xApi.product.bind(xApi);
      vi.spyOn(xApi, "product").mockImplementation(async code => { const result = await original(code); loseLease(); return result; });
    }
    expect((await retry(created.test_id, 0, true)).json().item).toMatchObject({ payment_status: "unknown", qr_available: false, qr_retry_version: 1 });
    expect(service.db.db.prepare("SELECT query_lease FROM bluev_test_requests WHERE request_id=?").get(created.test_id)?.query_lease).toBe("another-owner");
    expect(service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!.order_json).toBe(before);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1); expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it.each(["eligibility", "product"])("preserves a callback received during %s without renewing or precreating", async stage => {
    enableRecovery(); const created = await missingQr(true);
    const before = service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!.order_json;
    if (stage === "eligibility") {
      const original = xApi.eligibility.bind(xApi);
      vi.spyOn(xApi, "eligibility").mockImplementation(async username => { await paidCallback(created.order_id!); return original(username); });
    } else {
      const original = xApi.product.bind(xApi);
      vi.spyOn(xApi, "product").mockImplementation(async code => { await paidCallback(created.order_id!); return original(code); });
    }
    expect((await retry(created.test_id, 0, true)).json().item).toMatchObject({ order_id: created.order_id, payment_status: "paid", expires_at: "2020-01-01T00:00:00.000Z" });
    expect(service.db.listActivations(created.order_id!)).toHaveLength(1);
    expect(service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!.order_json).toBe(before);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1); expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it("does not implicitly renew when eligibility checks cross the original expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    enableRecovery(); const created = await missingQr();
    const saved = service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!;
    const intent = JSON.parse(String(saved.order_json)); intent.expires_at = new Date(Date.now() + 1_000).toISOString();
    const before = JSON.stringify(intent);
    service.db.db.prepare("UPDATE checkout_intents SET order_json=? WHERE client_order_id=?").run(before, created.client_order_id);
    const original = xApi.eligibility.bind(xApi);
    vi.spyOn(xApi, "eligibility").mockImplementation(async username => { const result = await original(username); vi.setSystemTime(Date.now() + 2_000); return result; });
    const response = await retry(created.test_id, 0, false);
    expect(response.json().item).toMatchObject({ qr_error_code: "renewal_required", qr_retry_requires_renewal: true, qr_available: false,
      qr_retry_version: 1, expires_at: intent.expires_at });
    expect(service.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(created.client_order_id)!.order_json).toBe(before);
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1); expect(xApi.createOrder).not.toHaveBeenCalled();
  });
  it("recovery requires auth and exact confirmation payload; original fields cannot be replaced", async () => {
    enableRecovery(); const created = await missingQr(); const url = `${prefix}/orders/${created.test_id}/retry-qr`;
    expect((await service.app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(401);
    for (const payload of [{ expected_version: 0, confirm_retry: false, confirm_renewal: false },
      { expected_version: 0, confirm_retry: true, confirm_renewal: false, recipient: "other" },
      { expected_version: -1, confirm_retry: true, confirm_renewal: false }]) {
      expect((await service.app.inject({ method: "POST", url, headers: headers(), payload })).statusCode).toBe(400);
    }
    expect(payment.createPaymentUrl).toHaveBeenCalledTimes(1);
  });

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
