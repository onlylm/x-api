import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { LiveXApiClient, XApiUpstreamError, type XApiOrder } from "../src/clients/x-api.js";

const config: AppConfig["xApi"] = {
  mode: "live", baseUrl: "https://bluev.example.test", partnerId: "usr_test",
  keyId: "key_test", secret: "test-only-signing-secret", timeoutMs: 1_000,
};
const order: XApiOrder = {
  id: `ord_${"1".repeat(32)}`, merchant_order_no: "jd.order:123", product_code: "x-premium-3m",
  recipient: "sample_user", points: 300, status: "queued", failure_code: null, receipt: null,
};
const createInput = {
  merchantOrderNo: order.merchant_order_no, idempotencyKey: "x-order:jd.order:123",
  productCode: order.product_code, recipient: order.recipient, recipientId: "123456789", expectedPoints: 300,
};
const products = [
  { code: "x-premium-3m", name: "X Premium 3 months", months: 3, currency: "BDT", amount_minor: 30000, points: 300, enabled: 1 },
  { code: "x-premium-6m", name: "X Premium 6 months", months: 6, currency: "BDT", amount_minor: 60000, points: 600, enabled: 0 },
];
const envelope = (data: unknown, status = 200) => Response.json({ data }, { status });
const protocolError = (code: unknown, status = 404, message = "provider-private-message") =>
  Response.json({ error: { code, message } }, { status });

function stubCatalog(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    "/v1/products": products,
    "/v1/balance": { available: 1000, frozen: 0 },
    "/v1/capabilities": { execution_ready: true, accepts_orders: true, reason: null, modes: ["direct", "voucher"] },
    ...overrides,
  };
  const fetcher = vi.fn(async (input: URL | string) => envelope(data[new URL(input).pathname]));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

// This canonical message is the public xgift-signature.ts protocol: eight lines,
// RFC 3986 query encoding, SHA-256 body hash, and a hex HMAC-SHA-256 signature.
function expectedSignature(url: URL, init: RequestInit): string {
  const headers = new Headers(init.headers);
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = [...url.searchParams.entries()].map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("&");
  const message = [init.method, url.pathname, query, headers.get("X-Timestamp"), headers.get("X-Nonce"),
    config.keyId, headers.get("Idempotency-Key") ?? "", createHash("sha256").update(String(init.body ?? "")).digest("hex")].join("\n");
  return createHmac("sha256", config.secret).update(message).digest("hex");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("live X API protocol", () => {
  it("unwraps a real create envelope, sends exact identity/point fields, and signs the raw request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T09:00:00.000Z"));
    const fetcher = vi.fn(async () => envelope({ ...order, mode: "direct", currency: "BDT", amount_minor: 30000,
      created_at: Date.now(), updated_at: Date.now() }, 201));
    vi.stubGlobal("fetch", fetcher);
    expect(await new LiveXApiClient(config).createOrder(createInput)).toEqual(order);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://bluev.example.test/v1/orders");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(JSON.parse(String(init.body))).toEqual({
      merchant_order_no: order.merchant_order_no, product_code: order.product_code,
      recipient: order.recipient, recipient_id: createInput.recipientId, expected_points: 300,
    });
    const headers = new Headers(init.headers);
    expect(headers.get("X-Partner-Id")).toBe(config.partnerId);
    expect(headers.get("X-Key-Id")).toBe(config.keyId);
    expect(headers.get("X-Timestamp")).toBe("1791190800");
    expect(headers.get("X-Nonce")).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(headers.get("Idempotency-Key")).toBe(createInput.idempotencyKey);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Signature")).toBe(expectedSignature(url, init));
  });

  it("signs an encoded GET query with an empty body and a fresh nonce each time", async () => {
    const fetcher = vi.fn(async () => envelope(order));
    vi.stubGlobal("fetch", fetcher);
    const client = new LiveXApiClient(config);
    expect(await client.findByMerchantOrder(order.merchant_order_no)).toEqual(order);
    expect(await client.getOrder(order.id)).toEqual(order);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.search).toBe("?merchant_order_no=jd.order%3A123");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeNull();
    expect(new Headers(init.headers).get("X-Signature")).toBe(expectedSignature(url, init));
    const [, secondInit] = fetcher.mock.calls[1] as unknown as [URL, RequestInit];
    expect(new Headers(secondInit.headers).get("X-Nonce")).not.toBe(new Headers(init.headers).get("X-Nonce"));
  });

  it("unwraps real products, wallet and capabilities without turning enabled=0 into available", async () => {
    const fetcher = stubCatalog();
    const client = new LiveXApiClient(config);
    expect(await client.isPlanAvailable("x_premium_3m")).toBe(true);
    expect(await client.isPlanAvailable("x_premium_6m")).toBe(false);
    expect(await client.isPlanAvailable("plus")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await client.product("x-premium-3m")).toEqual({ code: "x-premium-3m", points: 300, enabled: 1 });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it.each([
    { "/v1/balance": { available: 299, frozen: 0 } },
    { "/v1/capabilities": { execution_ready: true, accepts_orders: false } },
  ])("does not advertise a plan without funds or admission", async (overrides) => {
    stubCatalog(overrides);
    expect(await new LiveXApiClient(config).isPlanAvailable("x_premium_3m")).toBe(false);
  });

  it.each([
    { username: "sample_user", eligible: true, recipient_id: "123", reason: null, checked_at: 1 },
    { username: "sample_user", eligible: false, recipient_id: "123", reason: "not_eligible", checked_at: 1 },
    { username: "sample_user", eligible: false, reason: "user_not_found", checked_at: 1 },
  ])("unwraps real eligibility results: $reason", async (data) => {
    const fetcher = vi.fn(async () => envelope(data));
    vi.stubGlobal("fetch", fetcher);
    expect(await new LiveXApiClient(config).eligibility("sample_user")).toEqual({
      username: data.username, eligible: data.eligible, recipient_id: data.recipient_id, reason: data.reason,
    });
  });

  it("only treats the exact HTTP 404 not_found envelope as a missing order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => protocolError("not_found")));
    expect(await new LiveXApiClient(config).findByMerchantOrder(order.merchant_order_no)).toBeUndefined();
  });

  it.each([
    () => protocolError("unauthorized"),
    () => protocolError("not_found", 503),
    () => new Response("proxy route not found", { status: 404 }),
    () => Response.json({ error: "not_found" }, { status: 404 }),
    () => Response.json({ error: { code: "not_found" }, data: null }, { status: 404 }),
    () => envelope(null, 404),
    () => protocolError("not_found", 200),
  ])("does not mistake another error or malformed reply for a missing order", async (response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await expect(new LiveXApiClient(config).findByMerchantOrder(order.merchant_order_no)).rejects.toBeInstanceOf(XApiUpstreamError);
  });

  it("preserves a known code and Retry-After without exposing provider text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: { code: "rate_limited", message: "password=secret-cookie" }, detail_zh: "private key text",
    }, { status: 429, headers: { "Retry-After": "2" } })));
    await expect(new LiveXApiClient(config).getOrder(order.id)).rejects.toMatchObject({
      message: "rate_limited", errorCode: "rate_limited", httpStatus: 429, retryAfterMs: 2_000,
    });
  });

  it.each(["token_privatevalue", "private provider prose", "<html>secret</html>", { token: "secret" }])(
    "does not expose arbitrary upstream error codes or messages", async (code) => {
      vi.stubGlobal("fetch", vi.fn(async () => protocolError(code, 500, "secret-cookie")));
      await expect(new LiveXApiClient(config).getOrder(order.id)).rejects.toMatchObject({
        message: "x_api_http_error", errorCode: "x_api_http_error", httpStatus: 500,
      });
    },
  );

  it.each([
    () => new Response("<html>login</html>", { status: 200 }),
    () => new Response("broken JSON with secrets", { status: 200, headers: { "Content-Type": "application/json" } }),
    () => Response.json(order),
    () => Response.json({}),
    () => Response.json([]),
    () => envelope(null),
    () => envelope([]),
    () => Response.json({ data: order, error: { code: "not_found" } }),
    () => new Response(null, { status: 204 }),
  ])("rejects malformed successful envelopes rather than returning an empty order", async (response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await expect(new LiveXApiClient(config).getOrder(order.id)).rejects.toMatchObject({
      message: "invalid_x_api_response", errorCode: "invalid_x_api_response", httpStatus: 502,
    });
  });

  it.each([301, 302, 303, 307, 308])("refuses HTTP %i redirects without following them", async (status) => {
    const fetcher = vi.fn(async () => new Response(null, { status, headers: { Location: "https://untrusted.example/login" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new LiveXApiClient(config).createOrder(createInput)).rejects.toMatchObject({ errorCode: "x_api_redirect_rejected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  it.each([
    { id: "invalid" }, { merchant_order_no: "other-order" }, { product_code: "bad code" },
    { recipient: "@unsafe" }, { points: "300" }, { points: 0 }, { points: 1.5 },
    { status: "success" }, { status: ["queued"] }, { failure_code: "private text" }, { failure_code: undefined },
    { receipt: "<html>secret</html>" }, { receipt: undefined },
    { status: "succeeded", receipt: null }, { status: "succeeded", receipt: "pi_test", failure_code: "failed" },
    { status: "failed", receipt: "pi_paid", failure_code: "card_declined" },
    { status: "failed", receipt: "pi_paid", failure_code: null },
    { status: "failed", receipt: null, failure_code: null },
    { status: "failed", receipt: null, failure_code: "" },
  ])("rejects invalid order fields and mismatched merchant identity", async (fields) => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ ...order, ...fields })));
    await expect(new LiveXApiClient(config).findByMerchantOrder(order.merchant_order_no))
      .rejects.toMatchObject({ errorCode: "invalid_x_api_response" });
  });

  it.each([
    { id: `ord_${"2".repeat(32)}` },
  ])("binds get-order results to the requested order ID", async (fields) => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ ...order, ...fields })));
    await expect(new LiveXApiClient(config).getOrder(order.id)).rejects.toMatchObject({ errorCode: "invalid_x_api_response" });
  });

  it.each([{ recipient: "other_user" }, { product_code: "x-premium-6m" }, { points: 600 }])(
    "binds create-order results to the requested recipient, product and points", async (fields) => {
      vi.stubGlobal("fetch", vi.fn(async () => envelope({ ...order, ...fields })));
      await expect(new LiveXApiClient(config).createOrder(createInput)).rejects.toMatchObject({ errorCode: "invalid_x_api_response" });
    },
  );

  it.each([
    { username: "different" }, { eligible: "true" }, { recipient_id: undefined },
    { recipient_id: "not-numeric" }, { reason: "secret-token" }, { reason: "not_eligible" },
  ])("rejects invalid eligibility or a different recipient", async (fields) => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ username: "sample_user", recipient_id: "123", eligible: true, reason: null, ...fields })));
    await expect(new LiveXApiClient(config).eligibility("sample_user")).rejects.toMatchObject({ errorCode: "invalid_x_api_response" });
  });

  it.each([
    { "/v1/products": [{ ...products[0], points: "300" }] },
    { "/v1/products": [{ ...products[0], enabled: "false" }] },
    { "/v1/products": [{ ...products[0], points: -1 }] },
    { "/v1/products": [{ ...products[0], code: "" }] },
    { "/v1/products": [products[0], products[0]] },
    { "/v1/balance": { available: "1000", frozen: 0 } },
    { "/v1/balance": { available: -1, frozen: 0 } },
    { "/v1/balance": { available: 1000 } },
    { "/v1/capabilities": { accepts_orders: "true", execution_ready: true } },
    { "/v1/capabilities": { accepts_orders: true, execution_ready: false } },
  ])("rejects malformed product/balance/admission responses and fails closed", async (overrides) => {
    stubCatalog(overrides);
    const client = new LiveXApiClient(config);
    expect(await client.isPlanAvailable("x_premium_3m")).toBe(false);
    await expect(client.product("x-premium-3m")).rejects.toMatchObject({ errorCode: "invalid_x_api_response" });
  });

  it("returns verified successful terminal evidence", async () => {
    const completed = { ...order, status: "succeeded", receipt: "pi_success_test" };
    vi.stubGlobal("fetch", vi.fn(async () => envelope(completed)));
    expect(await new LiveXApiClient(config).getOrder(order.id)).toEqual(completed);
  });

  it("accepts a definitive failure only when it has a failure code and no payment receipt", async () => {
    const failed = { ...order, status: "failed", failure_code: "card_declined", receipt: null };
    vi.stubGlobal("fetch", vi.fn(async () => envelope(failed)));
    expect(await new LiveXApiClient(config).getOrder(order.id)).toEqual(failed);
  });

  it("sanitizes transport failure messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret authorization header"); }));
    await expect(new LiveXApiClient(config).getOrder(order.id)).rejects.toMatchObject({
      errorCode: "x_api_unavailable", message: "x_api_unavailable", httpStatus: 503,
    });
  });

  it("aborts a timed-out request and reports a machine code", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("private message", "AbortError")));
    })));
    const result = new LiveXApiClient(config).getOrder(order.id);
    const assertion = expect(result).rejects.toMatchObject({ errorCode: "x_api_timeout", message: "x_api_timeout", httpStatus: 504 });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
