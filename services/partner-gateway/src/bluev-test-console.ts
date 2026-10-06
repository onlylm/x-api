import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { bluevTestPage, bluevTestScript, bluevTestStyles } from "./bluev-test-page.js";
import { bluevPaymentErrorMessages } from "./bluev-payment-errors.js";

const ORIGIN = "https://api.quefa.cn";
const FINANCE = "http://app_finance:3100";
const UPSTREAM = "https://x.aifu.me/bluev-sandbox";
const BASE = "/admin/api/bluev-test";
const INTERNAL = "/internal/bluev-test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCTS = new Set(["x_premium_3m", "x_premium_6m"]);
const SAFE_ERRORS: Record<string, string> = {
  unauthorized: "测试服务身份校验失败，请联系管理员检查独立连接配置。",
  rate_limited: "请求过于频繁，请稍后查询原单。",
  json_required: "测试请求格式不正确，请刷新本页面。",
  invalid_request: "测试请求格式不正确，请核对账号与套餐。",
  test_not_found: "测试记录不存在，请保留原请求号继续核对。",
  idempotency_conflict: "请求号与原测试内容不一致，请勿修改原账号与套餐后重发。",
  test_in_progress: "已有未结束测试，请先核对原单。",
  qr_unavailable: "当前无可支付二维码，请查询原单。",
  retry_not_allowed: "当前仅能核对原单，不能重取付款码。",
  retry_busy: "原单正在处理中，请稍后查询原单。",
  renewal_required: "原付款窗口已到期，需要明确确认续开 20 分钟后才能重取付款码。",
  retry_conflict: "原单状态已变化，请查询原单后重新核对。",
  retry_recipient_changed: "原接收账号资格已变化，请仅核对原单，不要重新付款。",
  retry_fulfillment_unavailable: "原套餐或赠送服务状态已变化，请仅核对原单。",
  sales_paused: "测试新增接单已暂停，仍可查询原单。",
  test_unavailable: "测试暂时不可用，请查询原请求号，勿重复付款。",
  not_found: "测试接口不存在，请联系管理员检查独立连接配置。",
};
export const SANDBOX_MARKER = '<section id="sandbox" class="view"><div class="notice" style="margin-bottom:16px"><strong>真实链路沙箱：</strong>';
export const BLUEV_LINK_CARD = '<section class="panel" data-bluev-test-entry="true"><div class="panel-head"><div><h2>蓝 V 测试（3/6个月）</h2><p>使用 X 用户名测试支付宝收款与会员赠送；与下方 ChatGPT 测试独立。</p></div><a class="btn primary" href="/admin/bluev-test">打开蓝 V 测试</a></div></section>';

export interface BluevConsoleConfig { host: string; port: number; financeOrigin: string; upstreamOrigin: string; testKey: string }
export function loadBluevConsoleConfig(env: NodeJS.ProcessEnv = process.env): BluevConsoleConfig {
  const host = env.HOST || "0.0.0.0";
  const port = Number(env.PORT || 3114);
  const financeOrigin = env.QUEFA_FINANCE_ORIGIN || FINANCE;
  const upstreamOrigin = env.BLUEV_TEST_BASE_URL || UPSTREAM;
  const testKey = env.BLUEV_TEST_KEY || "";
  if (!["0.0.0.0", "127.0.0.1"].includes(host) || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      financeOrigin !== FINANCE || upstreamOrigin !== UPSTREAM || !/^[\x21-\x7e]{32,256}$/.test(testKey)) {
    throw new Error("bluev_console_configuration_invalid");
  }
  return { host, port, financeOrigin, upstreamOrigin, testKey };
}

/** The existing login document stays public; only this exact known panel gets a link. */
export function injectBluevLink(html: string): string {
  if (html.includes("data-bluev-test-entry") || html.split(SANDBOX_MARKER).length !== 2) return html;
  return html.replace(SANDBOX_MARKER,
    '<section id="sandbox" class="view">' + BLUEV_LINK_CARD +
    '<div class="notice" style="margin-bottom:16px"><strong>真实链路沙箱：</strong>');
}

class ConsoleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function cookieOnly(value: string | undefined): string {
  if (!value || value.length > 8192) throw new ConsoleError(401, "login_required", "请先登录 Quefa 后台。");
  const matches = value.split(";").map(v => v.trim()).filter(v => v.startsWith("merchant_admin="));
  if (matches.length !== 1 || !/^merchant_admin=[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{20,128}$/.test(matches[0])) {
    throw new ConsoleError(401, "login_required", "登录状态无效，请重新登录后台。");
  }
  return matches[0];
}
async function responseBytes(response: Response, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (Number(response.headers.get("content-length")) > limit) throw new Error("response_too_large");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new Error("response_too_large");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
function headers(response: ServerResponse): void {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
}
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  headers(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers.origin !== ORIGIN) throw new ConsoleError(403, "origin_rejected", "请从 Quefa 后台发起此操作。");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] || "")) {
    throw new ConsoleError(415, "json_required", "请求必须使用 JSON 格式。");
  }
  if (request.headers["content-encoding"]) throw new ConsoleError(415, "encoding_rejected", "不支持压缩请求。");
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 4096) throw new ConsoleError(413, "body_too_large", "提交内容过长。");
    chunks.push(bytes);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new ConsoleError(400, "invalid_json", "请求格式无效，请刷新后重试。"); }
}
function orderInput(body: Record<string, unknown>, create: boolean): Record<string, unknown> {
  const allowed = create ? ["product", "recipient", "request_id", "confirm_real_payment"] : ["product", "recipient"];
  if (Object.keys(body).some(key => !allowed.includes(key)) || !PRODUCTS.has(String(body.product)) ||
      typeof body.recipient !== "string" || !/^@?[A-Za-z0-9_]{1,15}$/.test(body.recipient) ||
      (create && (typeof body.request_id !== "string" || !UUID.test(body.request_id) || body.confirm_real_payment !== true))) {
    throw new ConsoleError(422, "invalid_argument", "请选择套餐、填写有效 X 用户名，并明确确认真实交易。");
  }
  return body;
}
function qrRetryInput(body: Record<string, unknown>): Record<string, unknown> {
  const allowed = ["expected_version", "confirm_retry", "confirm_renewal"];
  if (Object.keys(body).length !== allowed.length || Object.keys(body).some(key => !allowed.includes(key)) ||
      !Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 0 ||
      body.confirm_retry !== true || typeof body.confirm_renewal !== "boolean") {
    throw new ConsoleError(422, "invalid_argument", "请查询原单状态，并明确确认是否重取原单付款码及续开付款窗口。");
  }
  return { expected_version: body.expected_version, confirm_retry: true, confirm_renewal: body.confirm_renewal };
}
const ORDER_FIELDS = ["test_id", "request_id", "order_id", "client_order_id", "product", "recipient", "amount", "currency",
  "payment_status", "fulfillment_status", "requires_review", "qr_available", "terminal", "expires_at", "paid_at",
  "created_at", "updated_at", "upstream_order_id", "detail_zh", "qr_retry_allowed", "qr_retry_requires_renewal", "qr_retry_version"];
const STATUS_FIELDS = ["success", "isolated", "ready", "sales_open", "active_test_id", "checked_at"];
function pick(source: Record<string, unknown>, fields: string[], secret: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of fields) {
    const value = source[key];
    if (typeof value === "string") output[key] = value.slice(0, 1000).split(secret).join("[已隐藏]");
    else if (value === null || typeof value === "boolean" || typeof value === "number") output[key] = value;
  }
  return output;
}
function safeItem(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("invalid_upstream_item");
  const item = value as Record<string, unknown>;
  if (!UUID.test(String(item.test_id)) || item.request_id !== item.test_id || !PRODUCTS.has(String(item.product)) ||
      item.currency !== "CNY" || item.amount !== (item.product === "x_premium_6m" ? "44.00" : "22.00") ||
      !["not_created", "unknown", "pending", "paid", "expired", "closed", "refunded"].includes(String(item.payment_status)) ||
      !["not_started", "queued", "running", "success", "failed", "review"].includes(String(item.fulfillment_status)) ||
      [item.terminal, item.requires_review, item.qr_available, item.qr_retry_allowed, item.qr_retry_requires_renewal].some(flag => typeof flag !== "boolean") ||
      !Number.isSafeInteger(item.qr_retry_version) || Number(item.qr_retry_version) < 0 ||
      (item.qr_error_code !== null && (typeof item.qr_error_code !== "string" || !Object.hasOwn(bluevPaymentErrorMessages, item.qr_error_code)))) throw new Error("invalid_upstream_item");
  const code = item.qr_error_code as keyof typeof bluevPaymentErrorMessages | null;
  return { ...pick(item, ORDER_FIELDS, key), qr_error_code: code, qr_error_zh: code === null ? null : bluevPaymentErrorMessages[code] };
}
function safePayload(route: string, value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).success !== true) throw new Error("invalid_upstream_response");
  const object = value as Record<string, unknown>;
  if (route === "/status") return { ...pick(object, STATUS_FIELDS, key), success: true,
    products: Array.isArray(object.products) ? object.products.slice(0, 2).map(product =>
      pick(product as Record<string, unknown>, ["product", "name", "amount", "currency", "available"], key)) : [] };
  if (route === "/eligibility") return { ...pick(object, ["product", "recipient", "eligible", "available", "amount", "currency", "detail_zh", "checked_at"], key), success: true };
  if (Array.isArray(object.items)) return { success: true, items: object.items.slice(0, 30).map(item => safeItem(item, key)) };
  const item = safeItem(object.item, key);
  const requested = /^\/orders\/([0-9a-f-]+)(?:\/retry-qr)?$/i.exec(route)?.[1];
  if (requested && String(item.test_id).toLowerCase() !== requested.toLowerCase()) throw new Error("upstream_order_mismatch");
  return { success: true, item, ...(typeof object.idempotent === "boolean" ? { idempotent: object.idempotent } : {}) };
}

export function createBluevConsoleServer(config: BluevConsoleConfig, options: { fetch?: typeof fetch } = {}) {
  const fetcher = options.fetch ?? fetch;
  let inFlight = 0;
  let windowStarted = Date.now();
  let windowRequests = 0;
  const finance = async (path: string, cookie?: string) => fetcher(config.financeOrigin + path, {
    redirect: "manual", signal: AbortSignal.timeout(2500), headers: {
      Accept: path === "/admin" ? "text/html" : "application/json", "Accept-Encoding": "identity",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const authorize = async (request: IncomingMessage) => {
    const cookie = cookieOnly(request.headers.cookie);
    try {
      const result = await finance("/admin/api/session", cookie);
      if (result.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        await result.body?.cancel();
        throw new Error("invalid_session_response");
      }
      const body = JSON.parse((await responseBytes(result, 4096)).toString("utf8"));
      if (result.status === 200 && body.success === true) return;
    } catch { /* Fail closed; never cache a previous successful authorization. */ }
    throw new ConsoleError(401, "login_required", "登录已失效或暂时无法核验，请返回后台登录后重试。");
  };
  const server = createServer(async (request, response) => {
    let admitted = false;
    try {
      const url = new URL(request.url || "/", ORIGIN);
      const path = url.pathname;
      if (path === "/health" && request.method === "GET") return sendJson(response, 200, { ok: true, service: "bluev-test-console" });
      const shell = (path === "/admin" || path === "/admin/") && (request.method === "GET" || request.method === "HEAD");
      if (!shell && path !== "/admin/bluev-test" && !path.startsWith(BASE + "/")) throw new ConsoleError(404, "not_found", "页面不存在。");
      const now = Date.now();
      if (now - windowStarted >= 10000) { windowStarted = now; windowRequests = 0; }
      // One bounded global bucket: forwarded IP/cookie values cannot bypass it.
      if (inFlight >= 4 || windowRequests >= 60) {
        response.setHeader("Retry-After", "10");
        throw new ConsoleError(shell ? 503 : 429, "console_busy", "测试入口请求较多，请稍后查询原单。");
      }
      inFlight++; windowRequests++; admitted = true;
      if (shell) {
        const result = await finance("/admin");
        const bytes = await responseBytes(result, 2 * 1024 * 1024);
        const original = bytes.toString("utf8");
        const html = result.status === 200 && result.headers.get("content-type")?.includes("text/html")
          ? injectBluevLink(original) : original;
        const output = html === original ? bytes : Buffer.from(html);
        headers(response);
        for (const name of ["Content-Type", "Content-Security-Policy", "Strict-Transport-Security", "Pragma", "Expires", "Surrogate-Control"]) {
          const value = result.headers.get(name); if (value) response.setHeader(name, value);
        }
        response.writeHead(result.status, { "Content-Length": output.length });
        response.end(request.method === "HEAD" ? undefined : output);
        return;
      }
      await authorize(request);
      if (path === "/admin/bluev-test") {
        if (request.method !== "GET") throw new ConsoleError(405, "method_not_allowed", "不支持此操作。");
        headers(response);
        const hash = (value: string) => createHash("sha256").update(value).digest("base64");
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'sha256-" + hash(bluevTestScript) + "'; style-src 'sha256-" + hash(bluevTestStyles) + "'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(bluevTestPage); return;
      }
      const route = path.slice(BASE.length);
      const orderMatch = /^\/orders\/([0-9a-f-]+)(\/qr|\/retry-qr)?$/i.exec(route);
      const knownOrder = !!orderMatch && UUID.test(orderMatch[1]);
      const isQrImage = knownOrder && orderMatch?.[2] === "/qr";
      const isQrRetry = knownOrder && orderMatch?.[2] === "/retry-qr";
      const validGet = route === "/status" || route === "/orders" || (knownOrder && !isQrRetry);
      const validPost = route === "/orders" || route === "/eligibility" || isQrRetry;
      if ((request.method !== "GET" || !validGet) && (request.method !== "POST" || !validPost)) {
        throw new ConsoleError(405, "method_not_allowed", "此测试入口不支持该操作。");
      }
      let suffix = route;
      if (url.search) {
        const keys = [...url.searchParams.keys()];
        if (request.method !== "GET" || route !== "/orders" || keys.length !== 1 || keys[0] !== "request_id" || !UUID.test(url.searchParams.get("request_id") || "")) throw new ConsoleError(422, "invalid_query", "查询条件无效。");
        suffix += "?request_id=" + url.searchParams.get("request_id");
      }
      const body = request.method === "POST" ? (isQrRetry ? qrRetryInput(await readJson(request)) : orderInput(await readJson(request), route === "/orders")) : undefined;
      const result = await fetcher(config.upstreamOrigin + INTERNAL + suffix, {
        method: request.method, redirect: "manual", signal: AbortSignal.timeout(body ? 25000 : 10000),
        headers: { "X-Bluev-Test-Key": config.testKey, Accept: isQrImage ? "image/png" : "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const bytes = await responseBytes(result, isQrImage ? 512 * 1024 : 128 * 1024);
      if (!result.ok) {
        const status = [400, 404, 409, 422, 429, 503].includes(result.status) ? result.status : 502;
        let code = "test_request_rejected";
        let detail = "";
        try {
          const errorBody = JSON.parse(bytes.toString("utf8"));
          const knownCode = errorBody?.error?.code;
          if (typeof knownCode === "string" && Object.hasOwn(SAFE_ERRORS, knownCode)) { code = knownCode; detail = SAFE_ERRORS[knownCode]; }
        } catch { /* Never relay unstructured upstream errors. */ }
        throw new ConsoleError(status, code, detail || (route === "/orders" && body
          ? "未确认生成结果。请保留本次请求号并查询原单，不要重复创建。" : "暂时无法完成操作，请检查测试状态或查询原单。"));
      }
      if (isQrImage) {
        if (result.headers.get("content-type")?.split(";")[0] !== "image/png" || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("invalid_qr_response");
        headers(response); response.writeHead(200, { "Content-Type": "image/png" }); response.end(bytes); return;
      }
      sendJson(response, result.status, safePayload(route, JSON.parse(bytes.toString("utf8")), config.testKey));
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const known = error instanceof ConsoleError;
      if (known && error.status === 401 && request.url === "/admin/bluev-test") {
        headers(response);
        response.writeHead(401, { "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>请先登录 Quefa 后台</title><h1>请先登录 Quefa 后台</h1><p>登录有效后，返回沙箱打开蓝 V 测试。</p><a href="/admin#sandbox">返回后台登录</a></html>');
        return;
      }
      sendJson(response, known ? error.status : 503, { success: false,
        error: known ? error.code : "temporarily_unavailable",
        detail_zh: known ? error.message : "连接暂时中断。若已提交，请保留请求号并查询原单，不要重新下单。" });
    } finally { if (admitted) inFlight--; }
  });
  server.requestTimeout = 35000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}
