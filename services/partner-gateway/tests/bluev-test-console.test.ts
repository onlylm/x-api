import { type Server } from "node:http";
import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBluevConsoleServer, loadBluevConsoleConfig, injectBluevLink, SANDBOX_MARKER, BLUEV_LINK_CARD } from "../src/bluev-test-console.js";
import { bluevTestPage, bluevTestScript } from "../src/bluev-test-page.js";

const KEY = "independent-test-key-" + "k".repeat(40);
const COOKIE = "merchant_admin=" + "a".repeat(40) + "." + "b".repeat(43);
const ID = "23ff9a67-f3d0-4350-ae58-6f2c2cfa7304";
const ORIGIN = "https://api.quefa.cn";
const API = "/admin/api/bluev-test";
const item = () => ({ test_id: ID, request_id: ID, order_id: "po_test", client_order_id: "BLUEVTEST-" + ID,
  product: "x_premium_3m", recipient: "@tester", amount: "22.00", currency: "CNY", payment_status: "pending",
  fulfillment_status: "not_started", requires_review: false, qr_available: true, terminal: false,
  expires_at: null, paid_at: null, created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z",
  upstream_order_id: null, detail_zh: "等待付款", qr_error_code: null, qr_error_zh: null,
  qr_retry_allowed: false, qr_retry_requires_renewal: false, qr_retry_version: 0 });
let server: Server;
let base: string;
let sessionStatus: number;
let sessionPayload: unknown;
let upstreamStatus: number;
let upstreamBody: unknown;
let upstreamHeaders: Record<string, string>;
let financeHtml: string;
let fakeFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  sessionStatus = 200; sessionPayload = { success: true };
  upstreamStatus = 200; upstreamBody = { success: true, items: [item()] };
  upstreamHeaders = { "Content-Type": "application/json" };
  financeHtml = "<!doctype html><html>before" + SANDBOX_MARKER + "after</html>";
  fakeFetch = vi.fn(async (url: string) => {
    if (url === "http://app_finance:3100/admin/api/session") return Response.json(sessionPayload, { status: sessionStatus });
    if (url === "http://app_finance:3100/admin") return new Response(financeHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    return new Response(upstreamBody instanceof Uint8Array ? Uint8Array.from(upstreamBody).buffer : JSON.stringify(upstreamBody), { status: upstreamStatus, headers: upstreamHeaders });
  });
  server = createBluevConsoleServer(loadBluevConsoleConfig({ BLUEV_TEST_KEY: KEY }), { fetch: fakeFetch as typeof fetch });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers: { Cookie: COOKIE, ...headers } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method: "POST", headers: { Cookie: COOKIE, Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
const upstreamCalls = () => fakeFetch.mock.calls.filter(call => String(call[0]).startsWith("https://x.aifu.me"));

describe("isolated bluev admin console", () => {
  it("has no old secret or database configuration dependency and pins upstream hosts", () => {
    expect(loadBluevConsoleConfig({ BLUEV_TEST_KEY: KEY, ADMIN_TOKEN: "old-secret", DATABASE_PATH: "/old.sqlite" })).toEqual({
      host: "0.0.0.0", port: 3114, financeOrigin: "http://app_finance:3100", upstreamOrigin: "https://x.aifu.me/bluev-sandbox", testKey: KEY,
    });
    for (const bad of [{ BLUEV_TEST_KEY: "short" }, { BLUEV_TEST_KEY: KEY, QUEFA_FINANCE_ORIGIN: "https://evil.test" },
      { BLUEV_TEST_KEY: KEY, BLUEV_TEST_BASE_URL: "https://evil.test" }]) expect(() => loadBluevConsoleConfig(bad)).toThrow("configuration_invalid");
  });
  it("health makes no old-session or upstream request", async () => {
    expect(await (await get("/health")).json()).toEqual({ ok: true, service: "bluev-test-console" });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
  it("rejects missing, duplicate and forged cookie without reaching X", async () => {
    for (const cookie of ["", "merchant_admin=bad", COOKIE + "; " + COOKIE]) {
      const result = await get(API + "/orders", { Cookie: cookie, "X-Admin-Token": "forged", "X-Role": "admin" });
      expect(result.status).toBe(401);
    }
    expect(fakeFetch).not.toHaveBeenCalled();
  });
  it("revalidates GET every time and forwards only the one admin cookie to finance", async () => {
    expect((await get(API + "/orders", { Cookie: "other=private; " + COOKIE, Authorization: "Bearer secret", "X-Admin-Token": "secret" })).status).toBe(200);
    sessionPayload = { success: false };
    expect((await get(API + "/orders")).status).toBe(401);
    const sessions = fakeFetch.mock.calls.filter(call => String(call[0]).endsWith("/admin/api/session"));
    expect(sessions).toHaveLength(2);
    const sent = sessions[0][1] as RequestInit;
    expect(sent.redirect).toBe("manual");
    expect(new Headers(sent.headers).get("cookie")).toBe(COOKIE);
    expect(new Headers(sent.headers).get("authorization")).toBeNull();
    expect(new Headers(sent.headers).get("x-admin-token")).toBeNull();
    expect(upstreamCalls()).toHaveLength(1);
  });
  it("requires both HTTP 200 and success true, never follows authentication redirects", async () => {
    for (const [code, payload] of [[401, { success: true }], [200, {}], [302, { success: true }]] as const) {
      sessionStatus = code; sessionPayload = payload;
      expect((await get(API + "/orders")).status).toBe(401);
    }
    expect(upstreamCalls()).toHaveLength(0);
  });
  it("rejects a non-JSON finance session reply even if its text looks like success", async () => {
    fakeFetch.mockResolvedValueOnce(new Response('{"success":true}', { headers: { "Content-Type": "text/plain" } }));
    expect((await get(API + "/orders")).status).toBe(401); expect(upstreamCalls()).toHaveLength(0);
  });
  it("caps in-flight finance checks before a fifth request and limits the public shell too", async () => {
    const release: Array<(value: Response) => void> = [];
    fakeFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/admin/api/session")) return new Promise<Response>(resolve => release.push(resolve));
      return Response.json({ success: true, items: [] });
    });
    const pending = Array.from({ length: 4 }, () => get(API + "/orders"));
    try {
      await vi.waitFor(() => expect(release).toHaveLength(4));
      expect((await get(API + "/orders", { "X-Forwarded-For": "203.0.113.5" })).status).toBe(429);
      expect((await fetch(base + "/admin")).status).toBe(503);
      expect(fakeFetch).toHaveBeenCalledTimes(4);
    } finally { release.forEach(resolve => resolve(Response.json({ success: true }))); await Promise.all(pending); }
  });
  it("has one bounded rate bucket which forged cookies and forwarded addresses cannot bypass", async () => {
    sessionStatus = 401; sessionPayload = { success: false };
    for (let index = 0; index < 60; index++) expect((await get(API + "/orders", { "X-Forwarded-For": "203.0.113." + index })).status).toBe(401);
    expect((await get(API + "/orders")).status).toBe(429);
    expect((await fetch(base + "/admin")).status).toBe(503);
    expect(fakeFetch).toHaveBeenCalledTimes(60); expect(upstreamCalls()).toHaveLength(0);
    expect((await get("/health")).status).toBe(200);
  });
  it("serves an authenticated page with hash CSP and no credential", async () => {
    const result = await get("/admin/bluev-test");
    expect(result.status).toBe(200);
    expect(result.headers.get("content-security-policy")).toContain("script-src 'sha256-");
    const html = await result.text();
    expect(html).toContain("¥22.00"); expect(html).not.toContain(KEY);
    expect(html).not.toContain("X-Bluev-Test-Key"); expect(upstreamCalls()).toHaveLength(0);
  });
  it("keeps the existing public login HTML and injects only its verified sandbox marker", async () => {
    const result = await fetch(base + "/admin");
    expect(result.status).toBe(200);
    expect((await result.text()).replace(BLUEV_LINK_CARD, "")).toBe(financeHtml);
    expect(fakeFetch.mock.calls[0][0]).toBe("http://app_finance:3100/admin");
    expect(new Headers((fakeFetch.mock.calls[0][1] as RequestInit).headers).get("cookie")).toBeNull();
  });
  it("passes through unchanged when the marker is missing, ambiguous or already injected", async () => {
    for (const html of ["old login html", SANDBOX_MARKER + SANDBOX_MARKER, injectBluevLink(financeHtml)]) expect(injectBluevLink(html)).toBe(html);
    financeHtml = "<!doctype html><p>unchanged 登录</p>";
    expect(await (await fetch(base + "/admin/")).text()).toBe(financeHtml);
  });
  it("blocks cross-origin, non-JSON and extra price/configuration fields before any X request", async () => {
    const value = { product: "x_premium_3m", recipient: "tester" };
    expect((await post(API + "/eligibility", value, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await post(API + "/eligibility", value, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post(API + "/orders", { ...value, request_id: ID, confirm_real_payment: true, sell_price: "0.01" })).status).toBe(422);
    expect((await post(API + "/orders", { ...value, request_id: ID, confirm_real_payment: false })).status).toBe(422);
    expect(upstreamCalls()).toHaveLength(0);
  });
  it("forwards only approved input and one dedicated server-side key to the pinned isolated service", async () => {
    upstreamStatus = 201; upstreamBody = { success: true, item: item(), idempotent: false, secret: KEY };
    const input = { product: "x_premium_3m", recipient: "tester", request_id: ID, confirm_real_payment: true };
    const result = await post(API + "/orders", input);
    expect(result.status).toBe(201);
    const call = upstreamCalls()[0];
    expect(call[0]).toBe("https://x.aifu.me/bluev-sandbox/internal/bluev-test/orders");
    expect(new Headers((call[1] as RequestInit).headers).get("x-bluev-test-key")).toBe(KEY);
    expect(new Headers((call[1] as RequestInit).headers).get("cookie")).toBeNull();
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual(input);
    expect(await result.text()).not.toContain(KEY);
  });
  it("forwards an explicit version-bound QR retry as JSON with its original UUID", async () => {
    upstreamBody = { success: true, item: { ...item(), qr_retry_version: 1 }, idempotent: false };
    const input = { expected_version: 0, confirm_retry: true, confirm_renewal: false };
    const result = await post(API + "/orders/" + ID + "/retry-qr", input);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ success: true, idempotent: false, item: { qr_retry_version: 1 } });
    expect(upstreamCalls()).toHaveLength(1);
    const call = upstreamCalls()[0];
    expect(call[0]).toBe("https://x.aifu.me/bluev-sandbox/internal/bluev-test/orders/" + ID + "/retry-qr");
    const sent = call[1] as RequestInit;
    expect(sent.method).toBe("POST"); expect(new Headers(sent.headers).get("accept")).toBe("application/json");
    expect(new Headers(sent.headers).get("cookie")).toBeNull();
    expect(JSON.parse(sent.body as string)).toEqual(input);
  });
  it("rejects QR recovery without login, same-origin JSON and the exact three consent fields", async () => {
    const path = API + "/orders/" + ID + "/retry-qr";
    const body = { expected_version: 0, confirm_retry: true, confirm_renewal: false };
    expect((await post(path, body, { Cookie: "" })).status).toBe(401);
    expect((await post(path, body, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await post(path, body, { "Content-Type": "text/plain" })).status).toBe(415);
    for (const input of [{ ...body, expected_version: "0" }, { ...body, expected_version: -1 },
      { ...body, expected_version: 0.5 }, { ...body, expected_version: Number.MAX_SAFE_INTEGER + 1 },
      { ...body, confirm_retry: false }, { ...body, confirm_renewal: "true" },
      { expected_version: 0, confirm_retry: true }, { ...body, amount: "0.01" }, { ...body, recipient: "other" }]) {
      expect((await post(path, input)).status).toBe(422);
    }
    expect(upstreamCalls()).toHaveLength(0);
  });
  it("never exposes recovery as a GET side effect or treats its JSON response as a PNG", async () => {
    expect((await get(API + "/orders/" + ID + "/retry-qr")).status).toBe(405);
    expect((await post(API + "/orders/" + ID + "/qr", {})).status).toBe(405);
    expect((await post(API + "/orders/invalid/retry-qr", {})).status).toBe(405);
    expect(upstreamCalls()).toHaveLength(0);
  });
  it("rejects a recovery response for a different original order", async () => {
    const different = "5dd52d41-d3ac-4d4f-b50e-37e38d626734";
    upstreamBody = { success: true, item: { ...item(), test_id: different, request_id: different }, idempotent: false };
    const response = await post(API + "/orders/" + ID + "/retry-qr", { expected_version: 0, confirm_retry: true, confirm_renewal: false });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(different);
  });
  it("replaces raw QR diagnostic text with local fixed messages and rejects unknown error contracts", async () => {
    upstreamBody = { success: true, item: { ...item(), qr_error_code: "payment_result_unknown", qr_error_zh: "private raw " + KEY } };
    const body = await (await get(API + "/orders/" + ID)).json();
    expect(body.item.qr_error_code).toBe("payment_result_unknown");
    expect(typeof body.item.qr_error_zh).toBe("string");
    expect(JSON.stringify(body)).not.toMatch(/private raw|independent-test-key/);
    for (const change of [{ qr_error_code: "unexpected_private_error" }, { qr_retry_version: "1" },
      { qr_retry_version: -1 }, { qr_retry_version: 1.2 }, { qr_retry_allowed: "true" }, { qr_retry_requires_renewal: null }]) {
      upstreamBody = { success: true, item: { ...item(), ...change } };
      expect((await get(API + "/orders/" + ID)).status).toBe(503);
    }
  });
  it("returns safe recovery conflicts and does not repeat an uncertain upstream POST", async () => {
    const path = API + "/orders/" + ID + "/retry-qr";
    const input = { expected_version: 0, confirm_retry: true, confirm_renewal: true };
    for (const code of ["retry_not_allowed", "retry_busy", "renewal_required", "retry_conflict", "retry_recipient_changed", "retry_fulfillment_unavailable"]) {
      upstreamStatus = 409; upstreamBody = { error: { code, message: "private raw " + KEY } };
      const response = await post(path, input);
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe(code); expect(body.detail_zh).not.toContain("private raw");
    }
    const before = upstreamCalls().length;
    fakeFetch.mockImplementation(async (url: string) => { if (url.includes("/admin/api/session")) return Response.json({ success: true }); throw new Error("timeout " + KEY); });
    const failed = await post(path, input);
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain(KEY);
    expect(upstreamCalls()).toHaveLength(before + 1);
  });
  it("retains request UUID lookup and whitelists all public order fields", async () => {
    upstreamBody = { success: true, items: [{ ...item(), secret: KEY, recipient_ciphertext: "private", qr: "private-qr", detail_zh: KEY }] };
    const result = await get(API + "/orders?request_id=" + ID);
    const body = await result.json();
    expect(body.items[0].request_id).toBe(ID);
    expect(body.items[0].detail_zh).toBe("[已隐藏]");
    expect(JSON.stringify(body)).not.toMatch(/private|ciphertext|secret/);
    expect(upstreamCalls()[0][0]).toContain("?request_id=" + ID);
  });
  it("fails closed on mismatched UUIDs, unexpected prices or invalid status contracts", async () => {
    for (const change of [{ request_id: "different" }, { amount: "0.01" }, { payment_status: "other" }, { terminal: "true" }]) {
      upstreamBody = { success: true, item: { ...item(), ...change } };
      expect((await get(API + "/orders/" + ID)).status).toBe(503);
    }
  });
  it("rejects arbitrary paths and queries instead of exposing a generic proxy", async () => {
    for (const path of [API + "/orders?url=https://evil.test", API + "/orders?request_id=" + ID + "&request_id=" + ID]) expect((await get(path)).status).toBe(422);
    expect((await get(API + "/config")).status).toBe(405);
    expect((await post(API + "/orders/" + ID + "/refund", {})).status).toBe(405);
    expect((await get("/api/v1/checkout/orders")).status).toBe(404);
    expect(upstreamCalls()).toHaveLength(0);
  });
  it("serves only an authenticated PNG response for a known test UUID", async () => {
    upstreamHeaders = { "Content-Type": "image/png" };
    upstreamBody = new Uint8Array([137,80,78,71,13,10,26,10,0]);
    const result = await get(API + "/orders/" + ID + "/qr");
    expect(result.status).toBe(200); expect(result.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(upstreamBody);
    upstreamBody = new Uint8Array([1,2,3]);
    expect((await get(API + "/orders/" + ID + "/qr")).status).toBe(503);
  });
  it("maps allowlisted upstream business errors without relaying raw messages or keys", async () => {
    upstreamStatus = 409; upstreamBody = { error: { code: "idempotency_conflict", message: "private-raw" + KEY }, stack: "private-stack" };
    const text = await (await post(API + "/eligibility", { product: "x_premium_3m", recipient: "tester" })).text();
    expect(text).toContain("请求号与原测试内容不一致"); expect(text).not.toContain(KEY); expect(text).not.toContain("private-");
    upstreamBody = { error: { code: "unknown", message: "private-message" }, detail_zh: "private-detail" };
    expect(await (await get(API + "/orders")).text()).not.toContain("private-");
  });
  it("returns safe failure when authentication or upstream times out", async () => {
    fakeFetch.mockRejectedValueOnce(new Error("SECRET " + KEY));
    expect((await get(API + "/orders")).status).toBe(401);
    fakeFetch.mockImplementation(async (url: string) => { if (url.includes("/admin/api/session")) return Response.json({ success: true }); throw new Error(KEY); });
    const result = await get(API + "/orders"); expect(result.status).toBe(503); expect(await result.text()).not.toContain(KEY);
  });
});

describe("bluev page static contract", () => {
  it("has valid JavaScript, unique IDs, clear risk and independent dual states", () => {
    expect(() => new Script(bluevTestScript)).not.toThrow();
    const ids = [...bluevTestPage.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [...bluevTestScript.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1])) expect(ids).toContain(id);
    expect(bluevTestPage).toContain("真实交易测试");
    expect(bluevTestPage).toContain("支付宝收款"); expect(bluevTestPage).toContain("会员赠送");
    expect(bluevTestPage).not.toMatch(/on(?:click|submit)="/);
  });
  it("uses only IDs for refresh recovery and never automatically posts or retries payment", () => {
    expect(bluevTestScript).toContain("JSON.stringify({request_id:state.requestId,draft:state.draft})");
    expect(bluevTestScript).not.toContain("localStorage");
    expect(bluevTestScript).not.toContain("/activate");
    expect(bluevTestScript).not.toContain("/refund");
    expect(bluevTestScript).toContain("/orders?request_id=");
    expect(bluevTestScript).toContain("!document.hidden");
  });
});
