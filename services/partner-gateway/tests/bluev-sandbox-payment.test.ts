import { generateKeyPairSync, sign } from "node:crypto";
import { AlipaySdk } from "alipay-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { OrderRecord } from "../src/domain.js";
import { BluevPaymentError, BluevSandboxPaymentClient, describeBluevPaymentError } from "../src/bluev-sandbox-payment.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const config: AppConfig["alipay"] = { appId: "2021000000000000", sellerId: "2088000000000000",
  privateKey: keys.privateKey, publicKey: keys.publicKey, gateway: "https://openapi.alipay.com/gateway.do",
  notifyUrl: "https://merchant.invalid/bluev-sandbox/callbacks/alipay", returnUrl: "https://merchant.invalid" };
const now = new Date("2026-10-06T00:00:00.000Z");
const order: OrderRecord = { order_id: "UP-ORIGINAL-ONLY", client_order_id: "ADMINTEST-BLUEV-original",
  product: "x_premium_3m", plan: "x_premium_3m", quantity: 1, sell_price: "22.00", amount: "22.00",
  status: "pending", qr: "", expires_at: "2026-10-06T00:20:00.000Z", alipay_trade_no: null, paid_at: null,
  refunded_at: null, delivery_status: null, platform_supply_price: null, platform_max_sell_price: null,
  upstream_estimated_cost_cny: null, upstream_actual_cost_amount: null, upstream_actual_cost_currency: null,
  upstream_actual_cost_cny: null, alipay_receipt_amount: null, customer_price_refund_amount: "0.00",
  customer_price_refund_reference: null, customer_price_refund_reason: null, customer_price_refunded_at: null,
  created_at: now.toISOString(), updated_at: now.toISOString() };
const success = () => ({ code: "10000", msg: "Success", out_trade_no: order.order_id, qr_code: "https://qr.alipay.com/safe-test-only" });
const query = (trade_status = "WAIT_BUYER_PAY") => ({ code: "10000", out_trade_no: order.order_id,
  trade_no: "verified-trade", total_amount: order.amount, trade_status });

describe("isolated blueV signed payment adapter", () => {
  let client: BluevSandboxPaymentClient;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden"); }));
    client = new BluevSandboxPaymentClient(config);
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  // A real SDK instance and its unmocked RSA2 checkResponseSign verify every fixture.
  // Only exec's network transport is replaced: malformed or unsigned fixtures still fail real crypto.
  function respond(body: Record<string, unknown>, options: { unsigned?: boolean; badSign?: boolean; errorResponse?: boolean } = {}) {
    return vi.spyOn(AlipaySdk.prototype, "exec").mockImplementation(async function (this: AlipaySdk, method, _params, requestOptions) {
      expect(requestOptions?.validateSign).toBe(true);
      const key = `${method.replaceAll(".", "_")}_response`;
      const encoded = JSON.stringify(body);
      const signature = options.unsigned ? undefined : options.badSign ? "invalid-signature" : sign("RSA-SHA256", Buffer.from(encoded), keys.privateKey).toString("base64");
      const raw = JSON.stringify({ [options.errorResponse ? "error_response" : key]: body, sign: signature });
      this.checkResponseSign(raw, key, signature!, "test-trace");
      return { ...body, code: String(body.code ?? ""), msg: "fixture" };
    });
  }

  it("uses the original number, amount and absolute Beijing expiry, never a new relative payment window", async () => {
    const exec = respond(success());
    expect(await client.createPaymentUrl(order)).toBe(success().qr_code);
    expect(exec).toHaveBeenCalledExactlyOnceWith("alipay.trade.precreate", {
      notify_url: config.notifyUrl, bizContent: { out_trade_no: order.order_id, product_code: "FACE_TO_FACE_PAYMENT",
        total_amount: "22.00", subject: "会员服务订单-GINAL-ONLY", time_expire: "2026-10-06 08:20:00" },
    }, { validateSign: true });
    expect(JSON.stringify(exec.mock.calls)).not.toContain("timeout_express");
  });
  it("absolute expiry is independent of local process time zone and preserves offset input", async () => {
    const exec = respond(success());
    await client.createPaymentUrl({ ...order, expires_at: "2026-10-06T08:18:03+08:00" });
    expect(exec.mock.calls[0][1]).toMatchObject({ bizContent: { time_expire: "2026-10-06 08:18:03" } });
  });
  it.each(["2026-10-05T23:59:59Z", now.toISOString(), "2026-10-06T00:00:00.999Z"])("refuses expired/truncated expiry %s before external I/O", async (expires_at) => {
    const exec = vi.spyOn(AlipaySdk.prototype, "exec");
    await expect(client.createPaymentUrl({ ...order, expires_at })).rejects.toMatchObject({ code: "bluev_payment_expired" });
    expect(exec).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "not-a-date", "2026-10-06 10:20:00", "2026-10-06T10:20:00"])("refuses missing or invalid expiry %s without external I/O", async (expires_at) => {
    const exec = vi.spyOn(AlipaySdk.prototype, "exec");
    await expect(client.createPaymentUrl({ ...order, expires_at })).rejects.toMatchObject({ code: "bluev_payment_invalid_expiry" });
    expect(exec).not.toHaveBeenCalled();
  });
  it.each(["", "https://evil.invalid/pay", "http://qr.alipay.com/pay", "https://qr.alipay.com.evil.invalid/pay",
    "https://user:password@qr.alipay.com/pay", "https://qr.alipay.com:8443/pay", "https://qr.alipay.com:443/pay",
    "https://qr.alipay.com/pay#secret", " https://qr.alipay.com/pay", "https://qr.alipay.com/pay\nmore", "https://qr.alipay.com\\@evil.invalid/pay"])("refuses missing/unsafe QR %s", async (qr_code) => {
    respond({ ...success(), qr_code });
    await expect(client.createPaymentUrl(order)).rejects.toMatchObject({ code: qr_code ? "bluev_payment_invalid_qr" : "bluev_payment_missing_qr" });
  });
  it("rejects a verified response for a different order", async () => {
    respond({ ...success(), out_trade_no: "another-order" });
    await expect(client.createPaymentUrl(order)).rejects.toMatchObject({ code: "bluev_payment_order_mismatch" });
  });
  it("rejects missing response order number", async () => {
    respond({ code: "10000", qr_code: success().qr_code });
    await expect(client.createPaymentUrl(order)).rejects.toMatchObject({ code: "bluev_payment_order_mismatch" });
  });
  it.each(["ACQ.ACCESS_FORBIDDEN", "isv.insufficient-isv-permissions"])("describes verified permission code %s with fixed safe copy", async (sub_code) => {
    respond({ code: "40004", sub_code, sub_msg: "secret-signed-response-content" });
    await expect(client.createPaymentUrl(order)).rejects.toMatchObject({ code: "bluev_payment_provider_permission" });
  });
  it("describes other verified business failures without exposing provider text", async () => {
    respond({ code: "40004", sub_code: "ACQ.OTHER", sub_msg: keys.privateKey });
    const error = await client.createPaymentUrl(order).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BluevPaymentError);
    expect(describeBluevPaymentError(error).code).toBe("bluev_payment_provider_rejected");
    expect(JSON.stringify(error)).not.toContain("PRIVATE KEY");
    expect(String(error)).not.toContain("PRIVATE KEY");
  });
  it.each([{ unsigned: true }, { badSign: true }, { unsigned: true, errorResponse: true }])("never trusts unverified business permission or missing-trade responses %j", async (options) => {
    respond({ code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST", sub_msg: "sensitive-raw-provider-message" }, options);
    for (const action of [() => client.createPaymentUrl(order), () => client.queryForRecovery(order)]) {
      const error = await action().catch((error: unknown) => error);
      expect(describeBluevPaymentError(error).code).toBe("bluev_payment_signature_unverified");
      expect(String(error)).not.toContain("sensitive-raw");
      expect(JSON.stringify(error)).not.toContain("responseDataRaw");
    }
  });
  it("does not accept an exec result that bypassed the verifier", async () => {
    vi.spyOn(AlipaySdk.prototype, "exec").mockResolvedValue({ code: "40004", msg: "Business Failed", sub_code: "ACQ.TRADE_NOT_EXIST" });
    await expect(client.queryForRecovery(order)).rejects.toMatchObject({ code: "bluev_payment_signature_unverified" });
  });
  it("allows recovery classification only for signed 40004 plus ACQ.TRADE_NOT_EXIST", async () => {
    const exec = respond({ code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST" });
    expect(await client.queryForRecovery(order)).toEqual({ state: "not_found", confirmation: {
      paid: false, tradeNo: null, paidAt: now.toISOString(), receiptAmount: null, tradeStatus: null } });
    expect(exec).toHaveBeenCalledExactlyOnceWith("alipay.trade.query", { bizContent: { out_trade_no: order.order_id } }, { validateSign: true });
  });
  it.each([{ code: "40004", sub_code: "ACQ.ACCESS_FORBIDDEN" }, { code: "20000", sub_code: "ACQ.TRADE_NOT_EXIST" },
    { code: "40004", sub_code: "unknown" }])("never authorizes retry for any other signed error %j", async (body) => {
    respond(body);
    expect(await client.queryForRecovery(order)).toMatchObject({ state: "unknown", confirmation: { paid: false } });
  });
  it.each(["WAIT_BUYER_PAY", "TRADE_CLOSED", "UNKNOWN_FUTURE_STATUS"])("preserves an existing trade with status %s, never permitting another precreate", async (status) => {
    respond(query(status));
    expect(await client.queryForRecovery(order)).toMatchObject({ state: "trade_exists", confirmation: { paid: false, tradeStatus: status } });
  });
  it.each(["TRADE_SUCCESS", "TRADE_FINISHED"])("confirms paid only from a verified matching order/amount for %s", async (status) => {
    respond({ ...query(status), receipt_amount: "21.50", send_pay_date: "2026-10-06 07:59:00" });
    expect(await client.queryForRecovery(order)).toMatchObject({ state: "trade_exists", confirmation: {
      paid: true, tradeNo: "verified-trade", receiptAmount: "21.50", paidAt: "2026-10-05T23:59:00.000Z", tradeStatus: status } });
    expect(await client.queryPayment(order)).toMatchObject({ paid: true, tradeNo: "verified-trade" });
  });
  it("preserves signed notification verification and requires a fresh matching signed active query", async () => {
    const exec = respond(query("TRADE_SUCCESS"));
    const payload: Record<string, string> = { app_id: config.appId, seller_id: config.sellerId,
      out_trade_no: order.order_id, total_amount: order.amount, trade_status: "TRADE_SUCCESS", trade_no: "verified-trade", sign_type: "RSA2" };
    const canonical = Object.keys(payload).filter((key) => key !== "sign_type").sort().map((key) => `${key}=${payload[key]}`).join("&");
    payload.sign = sign("RSA-SHA256", Buffer.from(canonical), keys.privateKey).toString("base64");
    expect(await client.verifyNotification(payload, order)).toMatchObject({ paid: true, tradeNo: "verified-trade" });
    expect(exec).toHaveBeenCalledTimes(1);
    await expect(client.verifyNotification({ ...payload, total_amount: "0.01" }, order)).rejects.toThrow();
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("does not mark paid when a signed successful query omits the transaction number", async () => {
    respond({ ...query("TRADE_SUCCESS"), trade_no: "" });
    await expect(client.queryForRecovery(order)).rejects.toMatchObject({ code: "bluev_payment_unknown" });
  });
  it.each(["wrong-order", ""])("rejects query order mismatch %s before recovery classification", async (out_trade_no) => {
    respond({ ...query("TRADE_SUCCESS"), out_trade_no });
    await expect(client.queryForRecovery(order)).rejects.toMatchObject({ code: "bluev_payment_order_mismatch" });
  });
  it.each(["21.99", "", "not-money"])("rejects query amount mismatch %s before recovery classification", async (total_amount) => {
    respond({ ...query("TRADE_SUCCESS"), total_amount });
    await expect(client.queryForRecovery(order)).rejects.toMatchObject({ code: "bluev_payment_amount_mismatch" });
  });
  it.each([["ETIMEDOUT", "bluev_payment_timeout"], ["UND_ERR_HEADERS_TIMEOUT", "bluev_payment_timeout"],
    ["ECONNRESET", "bluev_payment_network"], ["ENOTFOUND", "bluev_payment_network"], ["ERR_OSSL_BAD_KEY", "bluev_payment_local_config"],
    ["UNRECOGNIZED", "bluev_payment_unknown"]])("sanitizes transport/crypto error %s to %s", async (code, expected) => {
    vi.spyOn(AlipaySdk.prototype, "exec").mockRejectedValue(Object.assign(new Error("password-and-private-key-secret"), { code, responseDataRaw: "raw-secret" }));
    const error = await client.queryForRecovery(order).catch((error: unknown) => error);
    expect(describeBluevPaymentError(error).code).toBe(expected);
    expect(JSON.stringify(error)).not.toMatch(/password|private-key|raw-secret/);
    expect(String(error)).not.toMatch(/password|private-key|raw-secret/);
  });
  it("maps arbitrary caller errors to fixed unknown copy, never echoing their messages or fake codes", () => {
    expect(describeBluevPaymentError({ code: "bluev_payment_provider_permission", message: keys.privateKey }).code).toBe("bluev_payment_unknown");
    expect(JSON.stringify(describeBluevPaymentError(new Error(keys.privateKey)))).not.toContain("PRIVATE KEY");
  });
  it.each([["ETIMEDOUT", "bluev_payment_timeout"], ["ECONNRESET", "bluev_payment_network"]])("classifies SDK-wrapped transport cause %s without retaining raw diagnostics", async (code, expected) => {
    const cause = Object.assign(new Error("secret inner exception"), { code });
    vi.spyOn(AlipaySdk.prototype, "exec").mockRejectedValue(new Error("secret SDK error", { cause }));
    const error = await client.queryForRecovery(order).catch((error: unknown) => error);
    expect(describeBluevPaymentError(error).code).toBe(expected);
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(error).not.toHaveProperty("cause");
  });
  it("bounds traversal even for cyclic error causes", async () => {
    const original = new Error("secret cyclic exception"); original.cause = original;
    vi.spyOn(AlipaySdk.prototype, "exec").mockRejectedValue(original);
    await expect(client.queryForRecovery(order)).rejects.toMatchObject({ code: "bluev_payment_unknown" });
  });
  it.each([{ publicKey: "" }, { privateKey: "invalid-secret" }, { appId: "" }, { sellerId: "" },
    { notifyUrl: "http://merchant.invalid/notify" }, { gateway: "https://user:secret@openapi.alipay.com" }])("refuses invalid local config without SDK I/O %j", (override) => {
    const exec = vi.spyOn(AlipaySdk.prototype, "exec");
    expect(() => new BluevSandboxPaymentClient({ ...config, ...override })).toThrow(BluevPaymentError);
    expect(exec).not.toHaveBeenCalled();
  });
  it("isolates signature state across concurrent requests so an unsigned response cannot borrow another signature", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(AlipaySdk.prototype, "exec").mockImplementation(async function (this: AlipaySdk, method) {
      if (method === "alipay.trade.query") { await blocked; return { code: "40004", msg: "Business Failed", sub_code: "ACQ.TRADE_NOT_EXIST" }; }
      const key = "alipay_trade_precreate_response";
      const body = success();
      const signature = sign("RSA-SHA256", Buffer.from(JSON.stringify(body)), keys.privateKey).toString("base64");
      this.checkResponseSign(JSON.stringify({ [key]: body, sign: signature }), key, signature, "test");
      return body;
    });
    const recovering = client.queryForRecovery(order);
    await expect(client.createPaymentUrl(order)).resolves.toBe(success().qr_code);
    release();
    await expect(recovering).rejects.toMatchObject({ code: "bluev_payment_signature_unverified" });
  });
});
