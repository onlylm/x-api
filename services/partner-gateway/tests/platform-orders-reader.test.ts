import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformOrdersServer, listPlatformOrders, loadPlatformOrdersReaderConfig,
  openPlatformOrdersReadOnlyDatabase, type PlatformOrdersReaderConfig } from "../src/platform-orders-reader.js";

const COOKIE = `__Host-xgift=${"a".repeat(64)}`;
const ADMIN = { data: { authenticated: true, role: "admin", userId: null } };
const API = "/api/admin/platform-orders";
const NOW = "2026-10-05T10:00:00.000Z";
let directory: string;
let path: string;
let writer: DatabaseSync;
let server: Server | undefined;
let port: number;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "x-platform-reader-"));
  path = join(directory, "partner.sqlite");
  writer = new DatabaseSync(path);
  writer.exec(`CREATE TABLE orders (
    order_id TEXT PRIMARY KEY,client_order_id TEXT NOT NULL,product TEXT NOT NULL,plan TEXT NOT NULL,
    order_source TEXT,fulfillment_recipient_masked TEXT,amount TEXT,platform_supply_price TEXT,status TEXT,
    delivery_status TEXT,created_at TEXT,updated_at TEXT,paid_at TEXT,
    qr TEXT,fulfillment_recipient_ciphertext TEXT,alipay_trade_no TEXT
  );
  CREATE TABLE activations (id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT,status TEXT,finished INTEGER,
    worker_state TEXT,failure_code TEXT,message_zh TEXT,upstream_order_id TEXT,updated_at TEXT,
    session_ciphertext TEXT,cdk_id INTEGER);
  CREATE TABLE activation_worker_control (activation_id INTEGER PRIMARY KEY,needs_review INTEGER,last_error_code TEXT);`);
});

afterEach(async () => {
  if (server) {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => { server!.close((error) => error ? reject(error) : resolve()); });
  }
  server = undefined;
  writer.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function config(): PlatformOrdersReaderConfig {
  return loadPlatformOrdersReaderConfig({ PLATFORM_ORDERS_DB_PATH: path });
}

function seed(id: string, values: Record<string, SQLInputValue> = {}) {
  const row: Record<string, SQLInputValue> = { order_id: id,client_order_id: `JD-${id}`,product: "x_premium_3m",
    plan: "x_premium_3m",order_source: "platform",fulfillment_recipient_masked: "@customer",amount: "30.00",
    platform_supply_price: "22.00",status: "pending",delivery_status: null,created_at: NOW,updated_at: NOW,paid_at: null,
    qr: "SECRET_PAYMENT_QR",fulfillment_recipient_ciphertext: "SECRET_RECIPIENT_CIPHERTEXT",alipay_trade_no: "SECRET_PAYMENT_TRADE",
    ...values };
  writer.prepare(`INSERT INTO orders(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

function task(orderId: string, values: Record<string, SQLInputValue> = {}, needsReview = 0) {
  const row: Record<string, SQLInputValue> = { order_id: orderId,status: "queued",finished: 0,worker_state: "queued",
    failure_code: null,message_zh: null,upstream_order_id: null,updated_at: "2026-10-05T10:01:00.000Z",
    session_ciphertext: "SECRET_SESSION",cdk_id: 123456789,...values };
  const result = writer.prepare(`INSERT INTO activations(${Object.keys(row).join(",")})
    VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  writer.prepare("INSERT INTO activation_worker_control VALUES(?,?,?)")
    .run(result.lastInsertRowid, needsReview, "SECRET_UPSTREAM_ERROR");
  return Number(result.lastInsertRowid);
}

function list(query = "") {
  const db = openPlatformOrdersReadOnlyDatabase(path);
  try { return listPlatformOrders(db, new URLSearchParams(query)); } finally { db.close(); }
}

async function start(fetcher: typeof fetch = vi.fn(async () => Response.json(ADMIN))) {
  server = createPlatformOrdersServer(config(), { fetch: fetcher });
  await new Promise<void>((resolve) => { server!.listen(0, "127.0.0.1", resolve); });
  port = (server.address() as { port: number }).port;
  return fetcher;
}

function call(url = API, headers: Record<string, string> = { Cookie: COOKIE }, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string; body: any }>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path: url, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode!, headers: res.headers, text, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("read-only platform order storage", () => {
  it("opens a real SQLite file read-only, does not migrate, and cannot write even with query_only reset", () => {
    seed("ord-1");
    const before = readFileSync(path);
    const db = openPlatformOrdersReadOnlyDatabase(path);
    expect(db.prepare("PRAGMA query_only").get()).toMatchObject({ query_only: 1 });
    expect(() => db.prepare("DELETE FROM orders").run()).toThrow();
    db.exec("PRAGMA query_only=OFF");
    expect(() => db.prepare("UPDATE orders SET status='paid'").run()).toThrow();
    expect(() => db.exec("CREATE TABLE should_never_exist (secret TEXT)")).toThrow();
    expect(listPlatformOrders(db).items).toHaveLength(1);
    db.close();
    expect(readFileSync(path)).toEqual(before);
    expect(writer.prepare("SELECT status FROM orders").get()).toMatchObject({ status: "pending" });
    expect(writer.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(4);
  });

  it("fails rather than creating a missing database", () => {
    const missing = join(directory, "missing.sqlite");
    expect(() => openPlatformOrdersReadOnlyDatabase(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  it("allows only the two matching X products from platform orders and exposes an explicit field allowlist", () => {
    seed("three");
    seed("six", { product: "x_premium_6m",plan: "x_premium_6m",amount: "60.00",platform_supply_price: "44.00" });
    seed("gpt", { product: "chatgpt_plus_1m",plan: "plus" });
    seed("manual", { order_source: "manual" });
    seed("other", { order_source: null });
    seed("mismatch", { plan: "plus" });
    task("three", { status: "running",worker_state: "polling",upstream_order_id: "ord_upstream" });
    const output = list();
    expect(output.items.map((item) => item.order_id)).toEqual(["three", "six"]);
    expect(Object.keys(output.items[0]).sort()).toEqual(["order_id","client_order_id","recipient","product","amount",
      "supply_price","payment_status","fulfillment_status","upstream_order_id","created_at","updated_at","paid_at"].sort());
    expect(output.items[0]).toMatchObject({ recipient: "@customer",amount: "30.00",supply_price: "22.00",
      payment_status: "pending",fulfillment_status: "running",upstream_order_id: "ord_upstream",
      updated_at: "2026-10-05T10:01:00.000Z" });
    expect(JSON.stringify(output)).not.toMatch(/SECRET_|ciphertext|qr|cdk|last_error|session/);
  });

  it.each([
    [{}, 0, "queued"],
    [{ status: "submitting",worker_state: "provisioning" }, 0, "queued"],
    [{ status: "queued",worker_state: "polling" }, 0, "queued"],
    [{ status: "running",worker_state: "polling" }, 0, "running"],
    [{ status: "success",worker_state: "terminal",finished: 1 }, 0, "success"],
    [{ status: "failed",worker_state: "terminal",finished: 1,failure_code: "payment_blocked" }, 0, "failed"],
    [{ status: "failed",worker_state: "terminal",finished: 0,failure_code: "payment_blocked" }, 0, "review"],
    [{ status: "failed",worker_state: "terminal",finished: 1,failure_code: null }, 0, "review"],
    [{ status: "success",worker_state: "polling",finished: 0 }, 0, "review"],
    [{ status: "unknown",worker_state: "polling" }, 0, "review"],
    [{ status: "running",worker_state: "polling",message_zh: "赠送结果待核对，查询原订单" }, 0, "review"],
    [{ status: "running",worker_state: "polling",message_zh: "请人工核查" }, 0, "review"],
    [{ status: "running",worker_state: "polling",message_zh: "结果未知" }, 0, "review"],
    [{ status: "running",worker_state: null }, 0, "review"],
    [{ status: "running",worker_state: "polling",finished: null }, 0, "review"],
    [{ status: "queued" }, 1, "review"],
    [{ status: "failed",worker_state: "terminal",finished: 1,failure_code: "other" }, 1, "review"],
    [{ status: "unexpected",worker_state: "unrecognized" }, 0, "review"],
  ] as Array<[Record<string, SQLInputValue>, number, string]>)(
    "maps saved activation %j with review=%d to %s without changing it", (values, review, expected) => {
      seed("mapped");
      task("mapped", values, review);
      const before = writer.prepare("SELECT * FROM activations").all();
      expect(list().items[0].fulfillment_status).toBe(expected);
      expect(list(`fulfillment=${expected}`).items).toHaveLength(1);
      expect(writer.prepare("SELECT * FROM activations").all()).toEqual(before);
    });

  it("uses only the latest activation and never carries an older success or upstream ID forward", () => {
    seed("latest", { status: "paid",paid_at: NOW });
    task("latest", { status: "success",finished: 1,worker_state: "terminal",upstream_order_id: "old-id" });
    task("latest", { status: "running",worker_state: "polling",message_zh: "待核对",upstream_order_id: null });
    expect(list().items[0]).toMatchObject({ fulfillment_status: "review",upstream_order_id: null,paid_at: NOW });
    expect(list("fulfillment=success").items).toHaveLength(0);
  });

  it("keeps absent task and recipient nullable, and handles a database without the optional control table", () => {
    seed("not-started", { fulfillment_recipient_masked: null,platform_supply_price: null });
    seed("malformed-mask", { fulfillment_recipient_masked: "SECRET_RAW_ACCOUNT@example.com" });
    writer.exec("DROP TABLE activation_worker_control");
    const output = list();
    expect(output.items).toEqual(expect.arrayContaining([expect.objectContaining({ order_id: "not-started",
      recipient: null,supply_price: null,fulfillment_status: "not_started",upstream_order_id: null })]));
    expect(output.items.find((row) => row.order_id === "malformed-mask")?.recipient).toBeNull();
    expect(writer.prepare("SELECT 1 FROM sqlite_master WHERE name='activation_worker_control'").get()).toBeUndefined();
  });

  it.each(["pending", "paid", "expired", "closed", "refunded"])("filters saved payment state %s", (status) => {
    for (const value of ["pending", "paid", "expired", "closed", "refunded"]) seed(value, { status: value });
    expect(list(`payment=${status}`).items.map((row) => row.order_id)).toEqual([status]);
  });

  it("uses fixed 30-row pagination plus one lookahead without a full count", () => {
    for (let index = 1; index <= 31; index += 1) seed(`order-${String(index).padStart(2, "0")}`);
    expect(list()).toMatchObject({ page: 1,has_next: true });
    expect(list().items).toHaveLength(30);
    expect(list().items[0].order_id).toBe("order-31");
    expect(list("page=2")).toMatchObject({ page: 2,has_next: false,items: [expect.objectContaining({ order_id: "order-01" })] });
    expect(list("page=100000")).toMatchObject({ page: 100000,has_next: false,items: [] });
  });

  it("parameterizes text searches and treats percent, underscore and backslash literally", () => {
    seed("literal", { client_order_id: "JD-%_\\-client" });
    seed("wildcard-lookalike", { client_order_id: "JD-abcZ\\-client" });
    seed("quote", { client_order_id: "JD-' OR 1=1 --" });
    const query = (q: string) => list(new URLSearchParams({ q }).toString()).items.map((row) => row.order_id);
    expect(query("%_\\")).toEqual(["literal"]);
    expect(query("' OR 1=1 --")).toEqual(["quote"]);
    expect(query("@customer")).toHaveLength(3);
    expect(query("NO_MATCH' UNION SELECT * FROM orders--")).toEqual([]);
    expect(writer.prepare("SELECT count(*) n FROM orders").get()).toMatchObject({ n: 3 });
  });

  it.each(["page=0", "page=-1", "page=1.5", "page=1e2", "page=100001", "page=01", "page=",
    "page=1&page=2", "payment=unknown", "fulfillment=unknown", "page_size=999", "q=%00", `q=${"a".repeat(101)}`])(
    "rejects invalid or ambiguous pagination/filter parameters %s", (query) => {
      expect(() => list(query)).toThrow("invalid_argument");
    });
});

describe("independent platform order HTTP service", () => {
  it("forwards only the strict session cookie to the fixed local old session endpoint", async () => {
    seed("visible");
    const fetcher = vi.fn(async () => Response.json(ADMIN));
    await start(fetcher);
    const result = await call(API, { Cookie: `other=SECRET_COOKIE; ${COOKIE}; third=value`,
      "X-Role": "user", "X-User-Id": "forged", Authorization: "do-not-forward" });
    expect(result.status).toBe(200);
    expect(result.body.data.items[0].order_id).toBe("visible");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8791/api/session", expect.objectContaining({
      method: "GET",redirect: "error",signal: expect.any(AbortSignal),
      headers: { Host: "x.aifu.me",Cookie: COOKIE,Accept: "application/json" },
    }));
    expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/SECRET_COOKIE|do-not-forward|forged/);
  });

  it.each(["", `xgift_dev=${"a".repeat(64)}`, `__Host-xgift=${"A".repeat(64)}`, "__Host-xgift=short",
    `__Host-xgift=${"a".repeat(65)}`, `${COOKIE}; ${COOKIE}`, `${COOKIE}=suffix`, `__Host-xgift=%61${"a".repeat(63)}`])(
    "rejects absent, malformed and duplicate cookies before contacting old service: %s", async (cookie) => {
      const fetcher = vi.fn(async () => Response.json(ADMIN));
      await start(fetcher);
      const response = await call(API, { Cookie: cookie,"X-Role": "admin","X-Authenticated": "true" });
      expect(response.status).toBe(401);
      expect(fetcher).not.toHaveBeenCalled();
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.text).not.toContain("__Host-xgift");
    });

  it.each([
    [{ data: { authenticated: false } }, 401],
    [{ data: { authenticated: true,role: "user",userId: "usr_1" } }, 403],
    [{ data: { authenticated: "true",role: "admin",userId: null } }, 401],
    [{ data: { authenticated: true,role: "admin",userId: "usr_1" } }, 401],
    [{ data: { authenticated: true,role: "admin" } }, 401],
    [{ authenticated: true,role: "admin",userId: null }, 401],
    [{ data: { authenticated: true,role: "admin",userId: null,token: "SECRET" } }, 401],
    [{ ...ADMIN,debug: "SECRET" }, 401],
  ])("strictly validates session envelope %j", async (payload, status) => {
    await start(vi.fn(async () => Response.json(payload)));
    const response = await call();
    expect(response.status).toBe(status);
    expect(response.text).not.toContain("SECRET");
  });

  it("does not cache successful authorization between requests", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(ADMIN))
      .mockResolvedValueOnce(Response.json({ data: { authenticated: false } }));
    await start(fetcher);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reflects saved gateway changes through the same read-only connection without performing any writes", async () => {
    seed("live");
    const fetcher = vi.fn(async () => Response.json(ADMIN));
    await start(fetcher);
    expect((await call()).body.data.items[0].payment_status).toBe("pending");
    writer.prepare("UPDATE orders SET status='paid',paid_at=? WHERE order_id=?").run(NOW, "live");
    task("live", { status: "success",finished: 1,worker_state: "terminal" });
    expect((await call()).body.data.items[0]).toMatchObject({ payment_status: "paid",fulfillment_status: "success",paid_at: NOW });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 302, 500])("handles session HTTP %d without following a redirect or leaking its response", async (status) => {
    await start(vi.fn(async () => new Response("SECRET_PROVIDER_BODY", { status,
      headers: { Location: "https://untrusted.example/steal" } })));
    const response = await call();
    expect(response.status).toBe(status === 401 || status === 403 ? status : 503);
    expect(response.text).not.toMatch(/SECRET|untrusted/);
  });

  it.each(["content-type", "invalid-json", "too-large", "false-content-length"])(
    "rejects malformed/bounded session response: %s", async (mode) => {
      const body = mode === "invalid-json" ? "{SECRET" : mode === "too-large" ? JSON.stringify({ data: "a".repeat(5000) })
        : JSON.stringify(ADMIN);
      await start(vi.fn(async () => new Response(body, { headers: {
        "Content-Type": mode === "content-type" ? "text/html" : "application/json",
        ...(mode === "false-content-length" ? { "Content-Length": "5000" } : {}),
      } })));
      const response = await call();
      expect(response.status).toBe(401);
      expect(response.text).not.toContain("SECRET");
    });

  it("times out authorization after two seconds and aborts only that request", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("PRIVATE_NETWORK_ERROR")), { once: true });
      });
    });
    await start(fetcher);
    const before = Date.now();
    const response = await call();
    expect(response.status).toBe(503);
    expect(Date.now() - before).toBeGreaterThanOrEqual(1800);
    expect(Date.now() - before).toBeLessThan(3500);
    expect(signal?.aborted).toBe(true);
    expect(response.text).not.toContain("PRIVATE_NETWORK_ERROR");
  });

  it("bounds simultaneous verification to four requests", async () => {
    const releases: Array<() => void> = [];
    let ready!: () => void;
    const allStarted = new Promise<void>((resolve) => { ready = resolve; });
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
      releases.push(() => resolve(Response.json(ADMIN)));
      if (releases.length === 4) ready();
    }));
    await start(fetcher);
    const active = Array.from({ length: 4 }, () => call());
    await allStarted;
    expect((await call()).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(4);
    releases.forEach((release) => release());
    expect((await Promise.all(active)).map((result) => result.status)).toEqual([200, 200, 200, 200]);
  });

  it("also times out and cancels a session response whose headers arrive but body stalls", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    await start(vi.fn(async () => new Response(body, { headers: { "Content-Type": "application/json" } })));
    expect((await call()).status).toBe(503);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("bounds aggregate verification rate without caching or trusting identity headers", async () => {
    const fetcher = vi.fn(async () => Response.json(ADMIN));
    await start(fetcher);
    for (let index = 0; index < 30; index += 1) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(30);
  });

  it("serves path-free health and supports HEAD with the same authorization", async () => {
    const fetcher = vi.fn(async () => Response.json(ADMIN));
    await start(fetcher);
    expect((await call("/health", {})).body).toEqual({ ok: true,service: "x-platform-orders",read_only: true });
    expect(fetcher).not.toHaveBeenCalled();
    const response = await call(API, { Cookie: COOKIE }, "HEAD");
    expect(response.status).toBe(200);
    expect(response.text).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await call(API, {}, "HEAD")).status).toBe(401);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("rejects %s without contacting old service or changing rows", async (method) => {
    seed("untouched");
    const fetcher = vi.fn(async () => Response.json(ADMIN));
    await start(fetcher);
    const response = await call(API, { Cookie: COOKIE }, method);
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, HEAD");
    expect(fetcher).not.toHaveBeenCalled();
    expect(writer.prepare("SELECT status FROM orders").get()).toMatchObject({ status: "pending" });
  });

  it("does not expose database paths, schema errors, or old service failure details", async () => {
    await start(vi.fn(async () => Response.json(ADMIN)));
    writer.exec("DROP TABLE orders");
    const response = await call();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: { code: "orders_unavailable",message: "平台订单暂时无法查询。" } });
    expect(response.text).not.toMatch(/sqlite|SELECT|no such table|partner.sqlite|SECRET/);
    expect((await call(API, {})).status).toBe(401);
    expect((await call("/does-not-exist", {})).status).toBe(404);
  });
});

describe("reader fixed configuration", () => {
  it("defaults to only the fixed loopback session endpoint and public Host", () => {
    expect(config()).toEqual({ databasePath: path,sessionUrl: "http://127.0.0.1:8791/api/session",adminHost: "x.aifu.me" });
    expect(() => loadPlatformOrdersReaderConfig({ PLATFORM_ORDERS_DB_PATH: path,HOST: "127.0.0.1",PORT: "3111" })).not.toThrow();
  });
  it.each([
    { PLATFORM_ORDERS_DB_PATH: "relative.sqlite" }, { PLATFORM_ORDERS_DB_PATH: "" },
    { X_ADMIN_SESSION_URL: "https://x.aifu.me/api/session" },
    { X_ADMIN_SESSION_URL: "http://127.0.0.1:8791/api/session#fragment" },
    { X_ADMIN_SESSION_URL: "http://127.0.0.1:8791/v1/balance" },
    { X_ADMIN_SESSION_URL: "http://user:password@127.0.0.1:8791/api/session" },
    { X_ADMIN_HOST: "evil.example" }, { X_ADMIN_HOST: "x.aifu.me\r\nCookie: stolen" },
    { HOST: "0.0.0.0" }, { PORT: "3110" },
  ])("fails closed for unsafe configuration %j", (values) => {
    expect(() => loadPlatformOrdersReaderConfig({ PLATFORM_ORDERS_DB_PATH: path,...values }))
      .toThrow("platform_orders_reader_configuration_invalid");
  });
});
