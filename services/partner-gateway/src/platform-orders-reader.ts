import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

const SESSION_URL = "http://127.0.0.1:8791/api/session";
const ADMIN_HOST = "x.aifu.me";
const PAGE_SIZE = 30;
const PAYMENT_STATES = ["pending", "paid", "expired", "closed", "refunded"] as const;
const FULFILLMENT_STATES = ["not_started", "queued", "running", "success", "failed", "review"] as const;

export interface PlatformOrdersReaderConfig {
  databasePath: string;
  sessionUrl: string;
  adminHost: string;
}

export interface PlatformOrderItem {
  order_id: string;
  client_order_id: string;
  recipient: string | null;
  product: "x_premium_3m" | "x_premium_6m";
  amount: string;
  supply_price: string | null;
  payment_status: typeof PAYMENT_STATES[number];
  fulfillment_status: typeof FULFILLMENT_STATES[number];
  upstream_order_id: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
}

interface ListOptions {
  page: number;
  q: string;
  payment: "all" | typeof PAYMENT_STATES[number];
  fulfillment: "all" | typeof FULFILLMENT_STATES[number];
}

class ReaderError extends Error {
  constructor(readonly status: number, readonly code: string, readonly publicMessage: string) { super(code); }
}

export function loadPlatformOrdersReaderConfig(env: NodeJS.ProcessEnv = process.env): PlatformOrdersReaderConfig {
  if ((env.HOST !== undefined && env.HOST !== "127.0.0.1") || (env.PORT !== undefined && env.PORT !== "3111")) {
    throw new Error("platform_orders_reader_configuration_invalid");
  }
  const config = { databasePath: env.PLATFORM_ORDERS_DB_PATH ?? "",
    sessionUrl: env.X_ADMIN_SESSION_URL ?? SESSION_URL, adminHost: env.X_ADMIN_HOST ?? ADMIN_HOST };
  assertConfig(config);
  return config;
}

function assertConfig(config: PlatformOrdersReaderConfig): void {
  if (!config.databasePath || !isAbsolute(config.databasePath) || config.databasePath.includes("\0") ||
      config.sessionUrl !== SESSION_URL || config.adminHost !== ADMIN_HOST) {
    throw new Error("platform_orders_reader_configuration_invalid");
  }
}

/** No migrations, application initialization, journal changes or writable connections. */
export function openPlatformOrdersReadOnlyDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
    return db;
  } catch (error) { db.close(); throw error; }
}

function parseListOptions(params: URLSearchParams): ListOptions {
  for (const key of params.keys()) {
    if (!["page", "q", "payment", "fulfillment"].includes(key) || params.getAll(key).length !== 1) {
      throw new ReaderError(400, "invalid_argument", "查询参数不合法。");
    }
  }
  const rawPage = params.get("page") ?? "1";
  const q = params.get("q") ?? "";
  const payment = params.get("payment") ?? "all";
  const fulfillment = params.get("fulfillment") ?? "all";
  if (!/^[1-9]\d{0,5}$/.test(rawPage) || Number(rawPage) > 100000 || q.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(q) || !["all", ...PAYMENT_STATES].includes(payment) ||
      !["all", ...FULFILLMENT_STATES].includes(fulfillment)) {
    throw new ReaderError(400, "invalid_argument", "查询参数不合法。");
  }
  return { page: Number(rawPage), q: q.trim(), payment, fulfillment } as ListOptions;
}

export function listPlatformOrders(db: DatabaseSync, params = new URLSearchParams()): {
  items: PlatformOrderItem[]; page: number; has_next: boolean; updated_at: string;
} {
  const input = parseListOptions(params);
  const hasControl = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get("activation_worker_control"));
  const review = hasControl ? "COALESCE(c.needs_review,0)<>0 OR" : "";
  const values: SQLInputValue[] = ["x_premium_3m", "x_premium_6m", "platform"];
  const filters: string[] = [];
  if (input.payment !== "all") { filters.push("payment_status=?"); values.push(input.payment); }
  if (input.fulfillment !== "all") { filters.push("fulfillment_status=?"); values.push(input.fulfillment); }
  if (input.q) {
    const search = `%${input.q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    filters.push(`(order_id LIKE ? ESCAPE '\\' OR client_order_id LIKE ? ESCAPE '\\'
      OR COALESCE(recipient,'') LIKE ? ESCAPE '\\' OR COALESCE(upstream_order_id,'') LIKE ? ESCAPE '\\')`);
    values.push(search, search, search, search);
  }
  values.push(PAGE_SIZE + 1, (input.page - 1) * PAGE_SIZE);
  // Only inspect saved state. In particular, reading this endpoint never calls
  // /v1 upstream APIs, advances workers, expires orders, or writes nonce records.
  const rows = db.prepare(`WITH visible_orders AS (
    SELECT o.order_id,o.client_order_id,o.fulfillment_recipient_masked AS recipient,
      o.product,o.amount,o.platform_supply_price AS supply_price,o.status AS payment_status,
      a.upstream_order_id,o.created_at,
      CASE WHEN a.updated_at>o.updated_at THEN a.updated_at ELSE o.updated_at END AS updated_at,o.paid_at,
      CASE
        WHEN a.id IS NULL THEN CASE WHEN o.delivery_status IS NULL OR o.delivery_status IN ('','closed')
          THEN 'not_started' ELSE 'review' END
        WHEN ${review} instr(COALESCE(a.message_zh,''),'核对')>0
          OR instr(COALESCE(a.message_zh,''),'核查')>0
          OR instr(COALESCE(a.message_zh,''),'未知')>0
          OR instr(COALESCE(a.message_zh,''),'未确认')>0 THEN 'review'
        WHEN a.status='success' AND a.finished=1 AND a.worker_state='terminal' THEN 'success'
        WHEN a.status='failed' AND a.finished=1 AND a.worker_state='terminal'
          AND length(trim(COALESCE(a.failure_code,'')))>0 THEN 'failed'
        WHEN COALESCE(a.finished,-1)<>0 OR COALESCE(a.worker_state,'') NOT IN ('queued','provisioning','polling') THEN 'review'
        WHEN a.status IN ('queued','submitting') THEN 'queued'
        WHEN a.status='running' THEN 'running'
        ELSE 'review'
      END AS fulfillment_status
    FROM orders o
    LEFT JOIN activations a ON a.id=(SELECT latest.id FROM activations latest
      WHERE latest.order_id=o.order_id ORDER BY latest.id DESC LIMIT 1)
    ${hasControl ? "LEFT JOIN activation_worker_control c ON c.activation_id=a.id" : ""}
    WHERE o.product IN (?,?) AND o.plan=o.product AND o.order_source=?
  ) SELECT order_id,client_order_id,recipient,product,amount,supply_price,payment_status,
      fulfillment_status,upstream_order_id,created_at,updated_at,paid_at FROM visible_orders
    ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY created_at DESC,order_id DESC LIMIT ? OFFSET ?`).all(...values);
  const items = rows.slice(0, PAGE_SIZE).map((row) => safeItem(row));
  return { items, page: input.page, has_next: rows.length > PAGE_SIZE, updated_at: new Date().toISOString() };
}

function safeItem(row: Record<string, unknown>): PlatformOrderItem {
  const shortText = (value: unknown, maximum: number): string => {
    if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new ReaderError(503, "orders_unavailable", "平台订单暂时无法查询。");
    }
    return value;
  };
  const money = (value: unknown): string => {
    if (typeof value !== "string" || !/^\d{1,15}\.\d{2}$/.test(value)) {
      throw new ReaderError(503, "orders_unavailable", "平台订单暂时无法查询。");
    }
    return value;
  };
  if (!PAYMENT_STATES.includes(row.payment_status as typeof PAYMENT_STATES[number]) ||
      !FULFILLMENT_STATES.includes(row.fulfillment_status as typeof FULFILLMENT_STATES[number])) {
    throw new ReaderError(503, "orders_unavailable", "平台订单暂时无法查询。");
  }
  return {
    order_id: shortText(row.order_id, 128), client_order_id: shortText(row.client_order_id, 128),
    recipient: typeof row.recipient === "string" && /^@[A-Za-z0-9_*]{1,32}$/.test(row.recipient) ? row.recipient : null,
    product: row.product as PlatformOrderItem["product"], amount: money(row.amount),
    supply_price: row.supply_price === null ? null : money(row.supply_price),
    payment_status: row.payment_status as PlatformOrderItem["payment_status"],
    fulfillment_status: row.fulfillment_status as PlatformOrderItem["fulfillment_status"],
    upstream_order_id: row.upstream_order_id === null ? null : shortText(row.upstream_order_id, 128),
    created_at: shortText(row.created_at, 40), updated_at: shortText(row.updated_at, 40),
    paid_at: row.paid_at === null ? null : shortText(row.paid_at, 40),
  };
}

function sessionCookie(value: string | undefined): string {
  const cookies = (value ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith("__Host-xgift="));
  if (cookies.length !== 1 || !/^__Host-xgift=[a-f0-9]{64}$/.test(cookies[0])) {
    throw new ReaderError(401, "unauthorized", "请先登录管理员账号。");
  }
  return cookies[0];
}

async function smallJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > 4096) throw new Error("invalid_session");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (signal.aborted) throw new Error("invalid_session");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4096) throw new Error("invalid_session");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
}

async function assertAdmin(cookieHeader: string | undefined, config: PlatformOrdersReaderConfig,
  request: typeof fetch): Promise<void> {
  const cookie = sessionCookie(cookieHeader);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const unavailable = () => new ReaderError(503, "session_unavailable", "登录验证暂时不可用，请稍后重试。");
  const check = async () => {
    let response: Response;
    try {
      response = await request(config.sessionUrl, { method: "GET", redirect: "error", signal: controller.signal,
        headers: { Host: config.adminHost, Cookie: cookie, Accept: "application/json" } });
    } catch { throw unavailable(); }
    if (response.status === 401) throw new ReaderError(401, "unauthorized", "登录已过期，请重新登录。");
    if (response.status === 403) throw new ReaderError(403, "forbidden", "需要管理员权限。");
    if (response.status !== 200 || response.redirected) throw unavailable();
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new ReaderError(401, "unauthorized", "登录状态无效，请重新登录。");
    }
    let payload: unknown;
    try { payload = await smallJson(response, controller.signal); }
    catch { throw new ReaderError(401, "unauthorized", "登录状态无效，请重新登录。"); }
    if (!record(payload) || Object.keys(payload).length !== 1 || !record(payload.data)) {
      throw new ReaderError(401, "unauthorized", "登录状态无效，请重新登录。");
    }
    const data = payload.data;
    if (data.authenticated !== true) throw new ReaderError(401, "unauthorized", "登录已过期，请重新登录。");
    if (data.role !== "admin") throw new ReaderError(403, "forbidden", "需要管理员权限。");
    if (data.userId !== null || Object.keys(data).sort().join(",") !== "authenticated,role,userId") {
      throw new ReaderError(401, "unauthorized", "登录状态无效，请重新登录。");
    }
  };
  try {
    await Promise.race([check(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(unavailable()); controller.abort(); }, 2000);
    })]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function send(response: ServerResponse, request: IncomingMessage, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", ...(status === 405 ? { Allow: "GET, HEAD" } : {}) });
  response.end(request.method === "HEAD" ? undefined : data);
}

export function createPlatformOrdersServer(config: PlatformOrdersReaderConfig,
  options: { fetch?: typeof fetch } = {}): Server {
  assertConfig(config);
  const db = openPlatformOrdersReadOnlyDatabase(config.databasePath);
  const sessionFetch = options.fetch ?? globalThis.fetch;
  let authInFlight = 0;
  let authWindowStart = Date.now();
  let authWindowUsed = 0;
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    try {
      if (!["GET", "HEAD"].includes(req.method ?? "")) throw new ReaderError(405, "method_not_allowed", "仅支持只读查询。");
      if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.includes("#")) {
        throw new ReaderError(400, "invalid_argument", "请求地址不合法。");
      }
      const url = new URL(req.url, "http://127.0.0.1:3111");
      if (url.pathname === "/health") {
        send(res, req, 200, { ok: true, service: "x-platform-orders", read_only: true }); return;
      }
      if (url.pathname !== "/api/admin/platform-orders") throw new ReaderError(404, "not_found", "接口不存在。");
      sessionCookie(req.headers.cookie);
      // One administrator's list UI needs very few requests. Bound aggregate
      // verification load even behind a proxy where every socket is loopback.
      if (Date.now() - authWindowStart >= 10_000) { authWindowStart = Date.now(); authWindowUsed = 0; }
      if (authInFlight >= 4 || authWindowUsed >= 30) {
        throw new ReaderError(429, "rate_limited", "查询过于频繁，请稍后重试。");
      }
      authWindowUsed += 1;
      authInFlight += 1;
      try { await assertAdmin(req.headers.cookie, config, sessionFetch); }
      finally { authInFlight -= 1; }
      send(res, req, 200, { data: listPlatformOrders(db, url.searchParams) });
    } catch (error) {
      const failure = error instanceof ReaderError ? error : new ReaderError(503, "orders_unavailable", "平台订单暂时无法查询。");
      send(res, req, failure.status, { error: { code: failure.code, message: failure.publicMessage } });
    }
  });
  server.once("close", () => { db.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = createPlatformOrdersServer(loadPlatformOrdersReaderConfig());
    server.on("error", () => { process.stderr.write("platform_orders_reader_start_failed\n"); process.exit(1); });
    server.listen(3111, "127.0.0.1");
    const stop = () => { server.close(() => { process.exit(0); }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch { process.stderr.write("platform_orders_reader_start_failed\n"); process.exit(1); }
}
