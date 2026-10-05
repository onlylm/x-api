import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import { z, ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { validateXApiConfiguration } from "./config.js";
import { AppDatabase } from "./database.js";
import type { ActivationRecord, OrderRecord, ProductConfig } from "./domain.js";
import { normalizeXUsername } from "./domain.js";
import type { PaymentClient, PaymentConfirmation } from "./clients/payment.js";
import { createXApiClient, type XApiClient } from "./clients/x-api.js";
import { MockZovoClient } from "./clients/zovo.js";
import { RuntimePaymentClient } from "./runtime-clients.js";
import { RuntimeSettings } from "./runtime-settings.js";
import { secureEqual } from "./security.js";
import { renderQrPng } from "./qr-image.js";
import { OrderService, BusinessError } from "./services/order-service.js";
import { ActivationService } from "./services/activation-service.js";
import { ActivationWorker } from "./services/activation-worker.js";
import { XPaymentReconciler } from "./services/x-payment-reconciler.js";

const PUBLIC_BASE = "https://x.aifu.me/bluev-sandbox";
const UUID = z.string().uuid().transform(value => value.toLowerCase());
const productCode = z.enum(["x_premium_3m", "x_premium_6m"]);
const recipient = z.string().min(1).max(16).transform((value, context) => {
  try { return normalizeXUsername(value); }
  catch { context.addIssue({ code: "custom", message: "invalid_recipient" }); return z.NEVER; }
});
const eligibilityInput = z.object({ product: productCode, recipient }).strict();
const orderInput = eligibilityInput.extend({ request_id: UUID, confirm_real_payment: z.literal(true) }).strict();
const listInput = z.object({ request_id: UUID.optional() }).strict();
const pathInput = z.object({ id: UUID }).strict();

export interface BluevSandboxConfig extends AppConfig {
  bluevSandbox: true;
  bluevTestKey: string;
  partnerSalesGateFile: string;
}

export function bluevSandboxProducts(): ProductConfig[] {
  return ([3, 6] as const).map(months => ({
    product: `x_premium_${months}m`, plan: `x_premium_${months}m`,
    name_zh: `X Premium · ${months} 个月`, name: `X Premium ${months} Months`,
    cost_price: months === 3 ? "22.00" : "44.00", max_sell_price: months === 3 ? "22.00" : "44.00",
    currency: "CNY", max_qty: 1, enabled: true,
  }));
}

/** No default catalog, formal database, webhook destination or GPT credentials are inherited. */
export function loadBluevSandboxConfig(env: NodeJS.ProcessEnv = process.env): BluevSandboxConfig {
  if (env.BLUEV_SANDBOX_ENABLED !== "true" || (env.NODE_ENV && env.NODE_ENV !== "production") ||
      (env.HOST && env.HOST !== "127.0.0.1") || (env.PORT && env.PORT !== "3112") ||
      env.PUBLIC_BASE_URL !== PUBLIC_BASE || env.X_API_MODE !== "live" ||
      env.X_API_BASE_URL !== "https://x.aifu.me" ||
      (env.ALIPAY_GATEWAY && env.ALIPAY_GATEWAY !== "https://openapi.alipay.com/gateway.do") ||
      (env.ALIPAY_NOTIFY_URL && env.ALIPAY_NOTIFY_URL !== `${PUBLIC_BASE}/callbacks/alipay`)) {
    throw new Error("bluev_sandbox_configuration_invalid");
  }
  const encryptionKey = Buffer.from(env.SESSION_ENCRYPTION_KEY ?? "", "base64");
  const key = env.BLUEV_TEST_KEY ?? "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(key) || encryptionKey.length !== 32 || encryptionKey.equals(Buffer.alloc(32)) ||
      !env.EMAIL_HMAC_KEY || env.EMAIL_HMAC_KEY.length < 32 || env.EMAIL_HMAC_KEY === key ||
      !/^\d{16}$/.test(env.ALIPAY_APP_ID ?? "") || !/^\d{16}$/.test(env.ALIPAY_SELLER_ID ?? "") ||
      !env.ALIPAY_PRIVATE_KEY || !env.ALIPAY_PUBLIC_KEY) throw new Error("bluev_sandbox_credentials_invalid");
  const config: BluevSandboxConfig = {
    bluevSandbox: true, bluevTestKey: key, nodeEnv: "production", host: "127.0.0.1", port: 3112,
    publicBaseUrl: PUBLIC_BASE, databasePath: env.BLUEV_SANDBOX_DB_PATH ?? "",
    partnerSalesGateFile: env.BLUEV_SANDBOX_SALES_GATE_FILE ?? "", trustProxy: false,
    platformApiKey: "", platformAllowedIps: new Set(), platformWebhookEnabled: false,
    platformWebhookUrl: "", platformWebhookSecret: "", adminToken: "",
    sessionEncryptionKey: encryptionKey, emailHmacKey: env.EMAIL_HMAC_KEY, products: bluevSandboxProducts(),
    paymentProvider: "alipay", alipay: {
      appId: env.ALIPAY_APP_ID!, sellerId: env.ALIPAY_SELLER_ID!,
      privateKey: env.ALIPAY_PRIVATE_KEY.replace(/\\n/g, "\n"), publicKey: env.ALIPAY_PUBLIC_KEY.replace(/\\n/g, "\n"),
      gateway: "https://openapi.alipay.com/gateway.do", notifyUrl: `${PUBLIC_BASE}/callbacks/alipay`, returnUrl: "",
    },
    zovo: { mode: "mock", baseUrl: "https://invalid.example", appId: "", apiKey: "", timeoutMs: 1000 },
    xApi: { mode: "live", baseUrl: "https://x.aifu.me", partnerId: env.X_API_PARTNER_ID ?? "",
      keyId: env.X_API_KEY_ID ?? "", secret: env.X_API_SECRET ?? "", timeoutMs: 15_000 },
    activationPollIntervalMs: 3000, webhookPollIntervalMs: 5000,
  };
  validateXApiConfiguration(config);
  validateSandboxPaths(config);
  return config;
}

function validateSandboxPaths(config: BluevSandboxConfig): void {
  const path = config.databasePath, gate = config.partnerSalesGateFile;
  if (config.bluevSandbox !== true || !isAbsolute(path) || basename(path) !== "bluev-sandbox.sqlite" ||
      !isAbsolute(gate) || basename(gate) !== "sales.enabled" || resolve(dirname(path)) !== resolve(dirname(gate)) ||
      (config.nodeEnv !== "test" && (path !== "/srv/x-bluev-sandbox/bluev-sandbox.sqlite" || gate !== "/srv/x-bluev-sandbox/sales.enabled"))) {
    throw new Error("bluev_sandbox_database_isolation_required");
  }
}

/** Verify an existing file BEFORE AppDatabase can migrate or modify it. */
export function openBluevSandboxDatabase(config: BluevSandboxConfig): AppDatabase {
  validateSandboxPaths(config);
  const path = config.databasePath;
  for (let parent = dirname(path);; parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error("bluev_sandbox_symlink_forbidden");
    if (dirname(parent) === parent) break;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Windows may normalize drive letter case; POSIX path must remain exactly the requested directory.
  if (process.platform !== "win32" && realpathSync(dirname(path)) !== dirname(path)) throw new Error("bluev_sandbox_path_invalid");
  const fingerprint = createHash("sha256").update(config.sessionEncryptionKey).update(config.emailHmacKey).digest("hex");
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("bluev_sandbox_database_invalid");
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      const row = reader.prepare("SELECT purpose,key_fingerprint FROM bluev_sandbox_metadata WHERE id=1").get();
      if (row?.purpose !== "bluev-sandbox-v1" || row.key_fingerprint !== fingerprint) throw new Error("invalid_marker");
      if (reader.prepare("SELECT 1 FROM sqlite_master WHERE name='orders'").get() &&
          reader.prepare("SELECT 1 FROM orders WHERE product NOT IN ('x_premium_3m','x_premium_6m') OR client_order_id NOT LIKE 'ADMINTEST-BLUEV-%' LIMIT 1").get()) throw new Error("invalid_orders");
    } catch { throw new Error("bluev_sandbox_database_marker_required"); }
    finally { reader.close(); }
  } else {
    const fresh = new DatabaseSync(path);
    try {
      fresh.exec("CREATE TABLE bluev_sandbox_metadata(id INTEGER PRIMARY KEY CHECK(id=1),purpose TEXT NOT NULL,key_fingerprint TEXT NOT NULL)");
      fresh.prepare("INSERT INTO bluev_sandbox_metadata VALUES(1,?,?)").run("bluev-sandbox-v1", fingerprint);
    } finally { fresh.close(); }
  }
  return new AppDatabase(path);
}

type RequestRow = { request_id: string; client_order_id: string; product: string; recipient: string;
  state: "creating" | "created" | "rejected" | "review"; created_at: string; updated_at: string };
export interface BluevTestOrder {
  test_id: string; request_id: string; order_id: string | null; client_order_id: string; product: string;
  recipient: string; amount: string; currency: "CNY";
  payment_status: "not_created" | "unknown" | "pending" | "paid" | "expired" | "closed" | "refunded";
  fulfillment_status: "not_started" | "queued" | "running" | "success" | "failed" | "review";
  requires_review: boolean; qr_available: boolean; terminal: boolean; expires_at: string | null;
  paid_at: string | null; created_at: string; updated_at: string; upstream_order_id: string | null; detail_zh: string;
}

function fulfillment(activation: ActivationRecord | undefined, needsReview: boolean): BluevTestOrder["fulfillment_status"] {
  if (!activation) return "not_started";
  if (needsReview || /核对|核查|未知|未确认/.test(activation.message_zh ?? "")) return "review";
  if (activation.finished === 1 && activation.worker_state === "terminal") {
    if (activation.status === "success") return "success";
    if (activation.status === "failed" && activation.failure_code) return "failed";
    return "review";
  }
  if (activation.finished !== 0 || !["queued", "provisioning", "polling"].includes(activation.worker_state)) return "review";
  return activation.status === "running" ? "running" : ["submitting", "queued"].includes(activation.status) ? "queued" : "review";
}

export class BluevSandboxOrders {
  private recovering: Promise<void> | undefined;
  constructor(readonly db: AppDatabase, private readonly orders: OrderService,
    private readonly payment: PaymentClient, private readonly activations: ActivationService) {
    db.db.exec(`CREATE TABLE IF NOT EXISTS bluev_test_requests (
      request_id TEXT PRIMARY KEY, client_order_id TEXT NOT NULL UNIQUE, product TEXT NOT NULL, recipient TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      next_check TEXT NOT NULL, query_lease TEXT, query_lease_until TEXT
    )`);
  }

  private row(id: string): RequestRow | undefined {
    return this.db.db.prepare("SELECT request_id,client_order_id,product,recipient,state,created_at,updated_at FROM bluev_test_requests WHERE request_id=?")
      .get(id) as RequestRow | undefined;
  }
  private intent(row: RequestRow): OrderRecord | undefined {
    const found = this.db.db.prepare("SELECT order_json FROM checkout_intents WHERE client_order_id=?").get(row.client_order_id) as { order_json: string } | undefined;
    if (!found) return undefined;
    const order = JSON.parse(found.order_json) as OrderRecord;
    if (order.client_order_id !== row.client_order_id || order.product !== row.product || order.plan !== row.product ||
        order.amount !== price(row.product) || order.quantity !== 1 || order.fulfillment_recipient_masked !== `@${row.recipient}` ||
        !/^UP[A-Z0-9]+$/.test(order.order_id)) throw new Error("sandbox_intent_mismatch");
    return order;
  }
  private order(row: RequestRow): OrderRecord | undefined { return this.db.getOrderByClientId(row.client_order_id); }

  item(id: string): BluevTestOrder {
    const row = this.row(id);
    if (!row) throw new BusinessError(404, "test_not_found", "测试记录不存在");
    const order = this.order(row), intent = order ? undefined : this.intent(row);
    const activation = order ? this.db.listActivations(order.order_id).at(-1) : undefined;
    const control = activation ? this.db.db.prepare("SELECT needs_review FROM activation_worker_control WHERE activation_id=?").get(activation.id) : undefined;
    const status = fulfillment(activation, Boolean(control?.needs_review));
    const paymentStatus: BluevTestOrder["payment_status"] = order
      ? (order.status === "pending" && order.expires_at <= new Date().toISOString() ? "expired" : order.status)
      : row.state === "rejected" && !intent ? "not_created" : "unknown";
    const terminal = paymentStatus === "not_created" || ["closed", "refunded"].includes(paymentStatus) || ["success", "failed"].includes(status);
    const review = status === "review" || ["unknown", "expired"].includes(paymentStatus);
    return {
      test_id: id, request_id: id, order_id: order?.order_id ?? intent?.order_id ?? null, client_order_id: row.client_order_id,
      product: row.product, recipient: `@${row.recipient}`, amount: price(row.product), currency: "CNY",
      payment_status: paymentStatus, fulfillment_status: status, requires_review: review,
      qr_available: paymentStatus === "pending" && Boolean(order?.qr), terminal,
      expires_at: order?.expires_at ?? intent?.expires_at ?? null, paid_at: order?.paid_at ?? null,
      created_at: row.created_at, updated_at: [row.updated_at, order?.updated_at ?? "", activation?.updated_at ?? ""].sort().at(-1)!,
      upstream_order_id: activation?.upstream_order_id ?? null,
      detail_zh: review ? "结果尚未确认，只核对原单，请勿重复付款或赠送。" :
        status === "success" ? "赠送已确认成功。" : status === "failed" ? "赠送已明确失败，请人工处理已收款项。" :
        paymentStatus === "paid" ? "已确认收款，等待自动赠送。" : paymentStatus === "pending" ? "请扫描原订单二维码付款。" :
        paymentStatus === "not_created" ? "资格或接单检查未通过，未发起付款。" : "测试记录已结束。",
    };
  }
  list(requestId?: string): BluevTestOrder[] {
    const rows = requestId ? this.db.db.prepare("SELECT request_id FROM bluev_test_requests WHERE request_id=?").all(requestId) :
      this.db.db.prepare("SELECT request_id FROM bluev_test_requests ORDER BY created_at DESC,rowid DESC LIMIT 30").all();
    return rows.map(row => this.item(String(row.request_id)));
  }
  active(): string | null {
    for (const row of this.db.db.prepare("SELECT request_id FROM bluev_test_requests ORDER BY created_at DESC").all()) {
      if (!this.item(String(row.request_id)).terminal) return String(row.request_id);
    }
    return null;
  }
  async create(input: z.infer<typeof orderInput>): Promise<{ item: BluevTestOrder; idempotent: boolean }> {
    const replay = this.db.transaction(() => {
      const existing = this.row(input.request_id);
      if (existing) {
        if (existing.product !== input.product || existing.recipient !== input.recipient) throw new BusinessError(409, "idempotency_conflict", "请求号与原测试内容不一致");
        return true;
      }
      if (this.active()) throw new BusinessError(409, "test_in_progress", "已有未结束测试，请先核对原单");
      const now = new Date().toISOString();
      this.db.db.prepare("INSERT INTO bluev_test_requests(request_id,client_order_id,product,recipient,state,created_at,updated_at,next_check) VALUES(?,?,?,?,'creating',?,?,?)")
        .run(input.request_id, `ADMINTEST-BLUEV-${input.request_id}`, input.product, input.recipient, now, now, now);
      return false;
    });
    if (!replay) {
      try {
        await this.orders.createOrder({ product: input.product, quantity: 1, sellPrice: price(input.product),
          clientOrderId: `ADMINTEST-BLUEV-${input.request_id}`, recipient: input.recipient });
        this.setState(input.request_id, "created");
      } catch {
        const row = this.row(input.request_id)!;
        this.setState(input.request_id, this.order(row) ? "created" : this.intent(row) ? "review" : "rejected");
      }
    }
    return { item: this.item(input.request_id), idempotent: replay };
  }
  private setState(id: string, state: RequestRow["state"]): void {
    this.db.db.prepare("UPDATE bluev_test_requests SET state=?,updated_at=? WHERE request_id=?").run(state, new Date().toISOString(), id);
  }
  qr(id: string): string {
    const item = this.item(id);
    if (!item.qr_available) throw new BusinessError(409, "qr_unavailable", "当前无可支付二维码，请查询原单");
    return this.order(this.row(id)!)!.qr;
  }
  private acceptPaid(row: RequestRow, candidate: OrderRecord, result: PaymentConfirmation): void {
    if (!result.paid || typeof result.tradeNo !== "string" || !result.tradeNo.trim() || result.tradeNo.length > 128 ||
        !["TRADE_SUCCESS", "TRADE_FINISHED"].includes(result.tradeStatus ?? "") ||
        !Number.isFinite(Date.parse(result.paidAt))) throw new Error("payment_confirmation_invalid");
    this.db.transaction(() => { if (!this.order(row)) this.db.createOrder(candidate); });
    const existing = this.order(row)!;
    if (existing.status === "paid" && existing.alipay_trade_no !== result.tradeNo) throw new Error("payment_trade_conflict");
    this.db.markOrderPaid(candidate.order_id, result.paidAt, result.tradeNo, result.receiptAmount);
    this.activations.createForPaidOrder(candidate.order_id);
    this.setState(row.request_id, "created");
  }
  async notification(payload: Record<string, string>): Promise<void> {
    const id = payload.out_trade_no;
    if (typeof id !== "string" || !/^UP[A-Z0-9]+$/.test(id)) throw new Error("unknown_payment");
    // Bounded by the one-unfinished-test invariant. Match a stored intent, never trust callback product/recipient.
    const rows = this.db.db.prepare("SELECT request_id,client_order_id,product,recipient,state,created_at,updated_at FROM bluev_test_requests").all() as unknown as RequestRow[];
    const pair = rows.map(row => ({ row, order: this.order(row) ?? this.intent(row) })).find(item => item.order?.order_id === id);
    if (!pair?.order) throw new Error("unknown_payment");
    const result = await this.payment.verifyNotification(payload, pair.order);
    this.acceptPaid(pair.row, pair.order, result);
  }
  /** Supplement the existing order reconciler with query-only recovery of precreate-unknown intents. */
  recoverIntents(): Promise<void> {
    if (this.recovering) return this.recovering;
    this.recovering = this.recoverIntentBatch().finally(() => { this.recovering = undefined; });
    return this.recovering;
  }
  async drain(): Promise<void> { await this.recovering; }
  private async recoverIntentBatch(): Promise<void> {
    const now = new Date().toISOString();
    const rows = this.db.db.prepare(`SELECT t.request_id,t.client_order_id,t.product,t.recipient,t.state,t.created_at,t.updated_at
      FROM bluev_test_requests t JOIN checkout_intents i ON i.client_order_id=t.client_order_id
      LEFT JOIN orders o ON o.client_order_id=t.client_order_id
      WHERE o.order_id IS NULL AND t.next_check<=? AND (t.query_lease_until IS NULL OR t.query_lease_until<=?)
      AND (i.lease_until IS NULL OR i.lease_until<=?) ORDER BY t.next_check LIMIT 1`).all(now, now, now) as unknown as RequestRow[];
    for (const row of rows) {
      const token = randomUUID();
      const claimed = this.db.db.prepare(`UPDATE bluev_test_requests SET query_lease=?,query_lease_until=?
        WHERE request_id=? AND (query_lease_until IS NULL OR query_lease_until<=?)`)
        .run(token, new Date(Date.now() + 60_000).toISOString(), row.request_id, now).changes;
      if (!claimed) continue;
      let candidate: OrderRecord | undefined;
      const heartbeat = setInterval(() => {
        try { this.db.db.prepare("UPDATE bluev_test_requests SET query_lease_until=? WHERE request_id=? AND query_lease=?")
          .run(new Date(Date.now() + 60_000).toISOString(), row.request_id, token); } catch { /* Ownership is fenced below. */ }
      }, 15_000);
      heartbeat.unref();
      try {
        candidate = this.intent(row);
        if (!candidate || this.order(row)) continue;
        const result = await this.payment.queryPayment(candidate);
        if (!this.db.db.prepare("SELECT 1 FROM bluev_test_requests WHERE request_id=? AND query_lease=? AND query_lease_until>?")
          .get(row.request_id, token, new Date().toISOString())) continue;
        if (result.paid) this.acceptPaid(row, candidate, result);
        else this.setState(row.request_id, "review");
      } catch { this.setState(row.request_id, "review"); }
      finally {
        clearInterval(heartbeat);
        const expiredFor = candidate ? Date.now() - Date.parse(candidate.expires_at) : 0;
        const delay = expiredFor >= 86_400_000 ? 86_400_000 : expiredFor >= 0 ? 300_000 : 15_000;
        this.db.db.prepare("UPDATE bluev_test_requests SET query_lease=NULL,query_lease_until=NULL,next_check=? WHERE request_id=? AND query_lease=?")
          .run(new Date(Date.now() + delay).toISOString(), row.request_id, token);
      }
    }
  }
}

function price(product: string): string { return product === "x_premium_3m" ? "22.00" : "44.00"; }

export interface BluevSandboxOptions { payment?: PaymentClient; xApi?: XApiClient; startWorkers?: boolean }
export async function buildBluevSandbox(config: BluevSandboxConfig, options: BluevSandboxOptions = {}): Promise<{
  app: FastifyInstance; db: AppDatabase; tests: BluevSandboxOrders; paymentReconciler: XPaymentReconciler; activationWorker: ActivationWorker;
}> {
  validateSandboxPaths(config);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(config.bluevTestKey) || config.platformWebhookEnabled !== false ||
      JSON.stringify(config.products) !== JSON.stringify(bluevSandboxProducts()) ||
      (config.nodeEnv !== "test" && (options.payment || options.xApi || options.startWorkers === false))) throw new Error("bluev_sandbox_configuration_invalid");
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 16 * 1024, requestTimeout: 35_000 });
  await app.register(formbody);
  const db = openBluevSandboxDatabase(config);
  db.seedProducts(bluevSandboxProducts());
  const payment = options.payment ?? new RuntimePaymentClient(config, new RuntimeSettings(config, db));
  const xApi = options.xApi ?? createXApiClient(config);
  const zovo = new MockZovoClient(); // No GPT route, SKU, upstream key or worker task can enter this isolated DB.
  const orders = new OrderService(db, payment, zovo, xApi, { encryptionKey: config.sessionEncryptionKey, hmacKey: config.emailHmacKey }, config.partnerSalesGateFile);
  const activations = new ActivationService(config, db);
  const paymentReconciler = new XPaymentReconciler(db, payment, activations, app.log);
  const activationWorker = new ActivationWorker(config, db, zovo, app.log, xApi);
  const tests = new BluevSandboxOrders(db, orders, payment, activations);
  const salesOpen = () => existsSync(config.partnerSalesGateFile) && !lstatSync(config.partnerSalesGateFile).isSymbolicLink() && lstatSync(config.partnerSalesGateFile).isFile();
  let windowStart = Date.now(), count = 0, inFlight = 0;
  const admitted = new WeakSet<object>();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    if (!request.url.startsWith("/internal/")) return;
    const key = request.headers["x-bluev-test-key"];
    if (typeof key !== "string" || !secureEqual(key, config.bluevTestKey)) return reply.code(401).send({ success: false, error: { code: "unauthorized", message: "无权访问测试入口" } });
    if (Date.now() - windowStart >= 10_000) { windowStart = Date.now(); count = 0; }
    if (++count > 60 || inFlight >= 4) return reply.code(429).send({ success: false, error: { code: "rate_limited", message: "请求过于频繁，请稍后查询原单" } });
    if (request.method === "POST" && !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) return reply.code(415).send({ success: false, error: { code: "json_required", message: "请使用 JSON 请求" } });
    inFlight += 1; admitted.add(request);
  });
  app.addHook("onResponse", async request => { if (admitted.delete(request)) inFlight -= 1; });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ success: false, error: { code: "invalid_request", message: "测试请求格式不正确" } });
    const safe = error instanceof BusinessError && ["test_not_found", "idempotency_conflict", "test_in_progress", "qr_unavailable", "sales_paused"].includes(error.code);
    return reply.code(safe ? error.httpStatus : 503).send({ success: false, error: {
      code: safe ? error.code : "test_unavailable", message: safe ? error.message : "测试暂时不可用，请查询原请求号，勿重复付款" } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ success: false, error: { code: "not_found", message: "接口不存在" } }));
  app.get("/health", async () => ({ success: true, service: "bluev-sandbox", isolated: true }));
  app.get("/internal/bluev-test/status", async () => {
    const sales = salesOpen();
    const products = await Promise.all(bluevSandboxProducts().map(async product => ({
      product: product.product, name: product.name_zh, amount: product.cost_price, currency: "CNY",
      available: sales && await xApi.isPlanAvailable(product.plan).catch(() => false),
    })));
    return { success: true, isolated: true, sales_open: sales, ready: sales && products.some(item => item.available),
      products, active_test_id: tests.active(), checked_at: new Date().toISOString() };
  });
  app.post("/internal/bluev-test/eligibility", async request => {
    const input = eligibilityInput.parse(request.body);
    const eligible = await xApi.eligibility(input.recipient);
    const matches = eligible.eligible && Boolean(eligible.recipient_id) && eligible.username === input.recipient;
    return { success: true, product: input.product, recipient: `@${input.recipient}`, eligible: matches,
      available: salesOpen() && await xApi.isPlanAvailable(input.product), amount: price(input.product), currency: "CNY",
      detail_zh: matches ? "账号可接收；创建付款前会再次核验。" : "该账号当前不能接收赠送，请核对用户名。", checked_at: new Date().toISOString() };
  });
  app.post("/internal/bluev-test/orders", async (request, reply) => {
    const input = orderInput.parse(request.body);
    if (!tests.list(input.request_id).length && !salesOpen()) throw new BusinessError(503, "sales_paused", "测试新增接单已暂停，仍可查询原单");
    const result = await tests.create(input);
    return reply.code(result.item.payment_status === "unknown" ? 202 : result.idempotent ? 200 : 201).send({ success: true, ...result });
  });
  app.get("/internal/bluev-test/orders", async request => ({ success: true, items: tests.list(listInput.parse(request.query).request_id) }));
  app.get("/internal/bluev-test/orders/:id", async request => ({ success: true, item: tests.item(pathInput.parse(request.params).id) }));
  app.get("/internal/bluev-test/orders/:id/qr", async (request, reply) => reply.type("image/png").send(await renderQrPng(tests.qr(pathInput.parse(request.params).id))));
  app.post("/callbacks/alipay", async (request, reply) => {
    try {
      const payload = z.record(z.string().max(100), z.string().max(8192)).parse(request.body);
      await tests.notification(payload);
      return reply.type("text/plain").send("success");
    } catch { return reply.code(400).type("text/plain").send("failure"); }
  });
  let paymentTimer: NodeJS.Timeout | undefined, paymentFlight: Promise<void> | undefined, stopping = false;
  const paymentTick = () => {
    if (stopping || paymentFlight) return;
    paymentFlight = (async () => { await tests.recoverIntents(); await paymentReconciler.tick(); })()
      .catch(() => { /* Safe original-order retry next cycle; never log provider content. */ })
      .finally(() => { paymentFlight = undefined; });
  };
  if (options.startWorkers !== false) {
    paymentTimer = setInterval(paymentTick, 15_000); paymentTimer.unref(); paymentTick(); activationWorker.start();
  }
  app.addHook("onClose", async () => {
    stopping = true;
    if (paymentTimer) clearInterval(paymentTimer);
    await paymentFlight; await tests.drain();
    await paymentReconciler.stop(); await activationWorker.stop(); db.close();
  });
  return { app, db, tests, paymentReconciler, activationWorker };
}
