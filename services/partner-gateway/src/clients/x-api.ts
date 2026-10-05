import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import { isXGiftPlan, type ProductPlan } from "../domain.js";

export type XApiOrderStatus = "queued" | "running" | "unknown" | "succeeded" | "failed";

export interface XApiOrder {
  id: string;
  merchant_order_no: string;
  product_code: string;
  recipient: string;
  points: number;
  status: XApiOrderStatus;
  failure_code: string | null;
  receipt: string | null;
}

export interface XApiEligibility {
  username: string;
  recipient_id?: string;
  eligible: boolean;
  reason?: string | null;
}

export interface XApiProduct {
  code: string;
  points: number;
  enabled: number | boolean;
}

export interface XApiClient {
  isPlanAvailable(plan: ProductPlan): Promise<boolean>;
  eligibility(username: string): Promise<XApiEligibility>;
  product(code: string): Promise<XApiProduct | undefined>;
  findByMerchantOrder(merchantOrderNo: string): Promise<XApiOrder | undefined>;
  getOrder(orderId: string): Promise<XApiOrder>;
  createOrder(input: {
    merchantOrderNo: string;
    idempotencyKey: string;
    productCode: string;
    recipient: string;
    recipientId: string;
    expectedPoints: number;
  }): Promise<XApiOrder>;
}

export class XApiUpstreamError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly errorCode?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class DisabledXApiClient implements XApiClient {
  async isPlanAvailable(): Promise<boolean> { return false; }
  private unavailable(): never {
    throw new XApiUpstreamError("蓝V履约接口未配置", 503, "x_api_disabled");
  }
  async eligibility(): Promise<XApiEligibility> { return this.unavailable(); }
  async product(): Promise<XApiProduct | undefined> { return this.unavailable(); }
  async findByMerchantOrder(): Promise<XApiOrder | undefined> { return this.unavailable(); }
  async getOrder(): Promise<XApiOrder> { return this.unavailable(); }
  async createOrder(): Promise<XApiOrder> { return this.unavailable(); }
}

export class LiveXApiClient implements XApiClient {
  private snapshot:
    | { expiresAt: number; products: XApiProduct[]; available: number; acceptsOrders: boolean }
    | undefined;
  private snapshotRequest: Promise<NonNullable<LiveXApiClient["snapshot"]>> | undefined;

  constructor(private readonly config: AppConfig["xApi"]) {}

  async isPlanAvailable(plan: ProductPlan): Promise<boolean> {
    if (!isXGiftPlan(plan)) return false;
    try {
      const code = plan === "x_premium_3m" ? "x-premium-3m" : "x-premium-6m";
      const snapshot = await this.getSnapshot();
      const product = snapshot.products.find((item) => item.code === code);
      return Boolean(product && Boolean(product.enabled) && snapshot.acceptsOrders && snapshot.available >= product.points);
    } catch {
      return false;
    }
  }

  eligibility(username: string): Promise<XApiEligibility> {
    return this.request("/v1/eligibility", { method: "POST", idempotencyKey: `eligibility:${username}`, body: { username } },
      (data) => parseEligibility(data, username));
  }

  async product(code: string): Promise<XApiProduct | undefined> {
    return (await this.getSnapshot(true)).products.find((item) => item.code === code);
  }

  async findByMerchantOrder(merchantOrderNo: string): Promise<XApiOrder | undefined> {
    try {
      return await this.request(`/v1/orders?merchant_order_no=${encodeURIComponent(merchantOrderNo)}`, { method: "GET" },
        (data) => parseOrder(data, { merchant_order_no: merchantOrderNo }));
    } catch (error) {
      if (error instanceof XApiUpstreamError && error.httpStatus === 404 && error.errorCode === "not_found") return undefined;
      throw error;
    }
  }

  getOrder(orderId: string): Promise<XApiOrder> {
    return this.request(`/v1/orders/${encodeURIComponent(orderId)}`, { method: "GET" },
      (data) => parseOrder(data, { id: orderId }));
  }

  createOrder(input: {
    merchantOrderNo: string;
    idempotencyKey: string;
    productCode: string;
    recipient: string;
    recipientId: string;
    expectedPoints: number;
  }): Promise<XApiOrder> {
    return this.request("/v1/orders", {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        merchant_order_no: input.merchantOrderNo,
        product_code: input.productCode,
        recipient: input.recipient,
        recipient_id: input.recipientId,
        expected_points: input.expectedPoints,
      },
    }, (data) => parseOrder(data, {
      merchant_order_no: input.merchantOrderNo,
      product_code: input.productCode,
      recipient: input.recipient.replace(/^@/, "").toLowerCase(),
      points: input.expectedPoints,
    }));
  }

  private async getSnapshot(force = false): Promise<NonNullable<LiveXApiClient["snapshot"]>> {
    if (!force && this.snapshot && this.snapshot.expiresAt > Date.now()) return this.snapshot;
    if (!force && this.snapshotRequest) return this.snapshotRequest;
    const load = async () => {
      const [products, balance, capabilities] = await Promise.all([
        this.request("/v1/products", { method: "GET" }, parseProducts),
        this.request("/v1/balance", { method: "GET" }, parseBalance),
        this.request("/v1/capabilities", { method: "GET" }, parseCapabilities),
      ]);
      const snapshot = {
        expiresAt: Date.now() + 5_000,
        products,
        available: balance.available,
        acceptsOrders: capabilities.accepts_orders,
      };
      this.snapshot = snapshot;
      return snapshot;
    };
    if (force) return load();
    this.snapshotRequest = load().finally(() => { this.snapshotRequest = undefined; });
    return this.snapshotRequest;
  }

  private async request<T>(
    path: string,
    options: { method: "GET" | "POST"; idempotencyKey?: string; body?: unknown },
    parse: (value: unknown) => T,
  ): Promise<T> {
    const url = new URL(path, this.config.baseUrl + "/");
    const rawBody = options.body === undefined ? "" : JSON.stringify(options.body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(18).toString("base64url");
    const idempotency = options.idempotencyKey ?? "";
    const canonical = [
      options.method,
      url.pathname,
      canonicalQuery(url.searchParams),
      timestamp,
      nonce,
      this.config.keyId,
      idempotency,
      createHash("sha256").update(rawBody).digest("hex"),
    ].join("\n");
    const signature = createHmac("sha256", this.config.secret).update(canonical).digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-Partner-Id": this.config.partnerId,
        "X-Key-Id": this.config.keyId,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": signature,
      };
      if (idempotency) headers["Idempotency-Key"] = idempotency;
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : rawBody,
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new XApiUpstreamError("x_api_redirect_rejected", 502, "x_api_redirect_rejected");
      }
      const isJson = /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "");
      const payload: unknown = isJson ? await response.json().catch(() => undefined) : undefined;
      if (!response.ok) {
        const error = isRecord(payload) && isRecord(payload.error) && !Object.hasOwn(payload, "data")
          ? payload.error : undefined;
        // Only known protocol codes may reach logs or callers. Provider messages can contain secrets.
        const errorCode = typeof error?.code === "string" && upstreamErrorCodes.has(error.code)
          ? error.code : "x_api_http_error";
        throw new XApiUpstreamError(
          errorCode,
          response.status,
          errorCode,
          retryAfterMilliseconds(response.headers.get("retry-after")),
        );
      }
      if (!isRecord(payload) || !Object.hasOwn(payload, "data") || Object.hasOwn(payload, "error")) invalidResponse();
      return parse(payload.data);
    } catch (error) {
      if (error instanceof XApiUpstreamError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new XApiUpstreamError("x_api_timeout", 504, "x_api_timeout");
      }
      throw new XApiUpstreamError("x_api_unavailable", 503, "x_api_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}

const upstreamErrorCodes = new Set([
  "not_found", "unauthorized", "forbidden", "invalid_signature", "invalid_idempotency",
  "invalid_input", "invalid_mode", "invalid_configuration", "invalid_content_type", "method_not_allowed",
  "https_required", "not_configured", "replayed_request", "rate_limited", "too_large",
  "idempotency_conflict", "insufficient_points", "product_unavailable", "not_eligible", "recipient_changed",
  "execution_disabled", "execution_unavailable", "admission_configuration_missing", "admission_paused",
  "daily_limit_reached", "order_limit_reached", "recipient_busy", "order_busy", "price_changed",
  "no_account", "proxy_gateway_missing", "upstream_failed", "x_query_failed", "service_unavailable",
  "payments_paused", "payment_not_ready", "payment_orders_pending", "payment_configuration_changed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new XApiUpstreamError("invalid_x_api_response", 502, "invalid_x_api_response");
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function parseOrder(value: unknown, expected: Partial<XApiOrder>): XApiOrder {
  if (!isRecord(value)
    || !matches(value.id, /^ord_[a-f0-9]{32}$/)
    || !matches(value.merchant_order_no, /^[A-Za-z0-9_.:-]{1,128}$/)
    || !matches(value.product_code, /^[A-Za-z0-9_-]{1,64}$/)
    || !matches(value.recipient, /^[a-z0-9_]{1,15}$/)
    || !safeInteger(value.points, 1)
    || !matches(value.status, /^(queued|running|unknown|succeeded|failed)$/)
    || !(value.failure_code === null || matches(value.failure_code, /^[a-z0-9_]{1,64}$/))
    || !(value.receipt === null || matches(value.receipt, /^[A-Za-z0-9_.:-]{1,128}$/))
    || (value.status === "succeeded" && (value.receipt === null || value.failure_code !== null))
    || (value.status === "failed" && (value.receipt !== null || value.failure_code === null))
    || Object.entries(expected).some(([key, item]) => value[key] !== item)) invalidResponse();
  return {
    id: value.id,
    merchant_order_no: value.merchant_order_no,
    product_code: value.product_code,
    recipient: value.recipient,
    points: value.points,
    status: value.status as XApiOrderStatus,
    failure_code: value.failure_code,
    receipt: value.receipt,
  };
}

function parseEligibility(value: unknown, requestedUsername: string): XApiEligibility {
  if (!isRecord(value)
    || !matches(value.username, /^[a-z0-9_]{1,15}$/)
    || value.username !== requestedUsername.replace(/^@/, "").toLowerCase()
    || typeof value.eligible !== "boolean"
    || !(value.recipient_id === undefined || matches(value.recipient_id, /^\d{1,25}$/))
    || (value.eligible && value.recipient_id === undefined)
    || !(value.reason === undefined || value.reason === null || value.reason === "not_eligible" || value.reason === "user_not_found")
    || (value.eligible && value.reason != null)) invalidResponse();
  return { username: value.username, recipient_id: value.recipient_id, eligible: value.eligible, reason: value.reason };
}

function parseProducts(value: unknown): XApiProduct[] {
  if (!Array.isArray(value)) invalidResponse();
  const products = value.map((item: unknown): XApiProduct => {
    if (!isRecord(item) || !matches(item.code, /^[A-Za-z0-9_-]{1,64}$/)
      || !safeInteger(item.points, 1) || ![0, 1, true, false].includes(item.enabled as number | boolean)) invalidResponse();
    return { code: item.code, points: item.points, enabled: item.enabled as number | boolean };
  });
  if (new Set(products.map((item) => item.code)).size !== products.length) invalidResponse();
  return products;
}

function parseBalance(value: unknown): { available: number } {
  if (!isRecord(value) || !safeInteger(value.available) || !safeInteger(value.frozen)) invalidResponse();
  return { available: value.available };
}

function parseCapabilities(value: unknown): { accepts_orders: boolean } {
  if (!isRecord(value) || typeof value.accepts_orders !== "boolean" || typeof value.execution_ready !== "boolean"
    || (value.accepts_orders && !value.execution_ready)) invalidResponse();
  return { accepts_orders: value.accepts_orders };
}

export class MockXApiClient implements XApiClient {
  readonly orders = new Map<string, XApiOrder>();
  available = 1_000_000;
  acceptsOrders = true;

  async isPlanAvailable(plan: ProductPlan): Promise<boolean> {
    if (!isXGiftPlan(plan) || !this.acceptsOrders) return false;
    const product = await this.product(plan === "x_premium_3m" ? "x-premium-3m" : "x-premium-6m");
    return Boolean(product && this.available >= product.points);
  }
  async eligibility(username: string): Promise<XApiEligibility> {
    return { username, recipient_id: username === "ineligible" ? undefined : "123456789", eligible: username !== "ineligible" };
  }
  async product(code: string): Promise<XApiProduct | undefined> {
    if (code === "x-premium-3m") return { code, points: 300, enabled: true };
    if (code === "x-premium-6m") return { code, points: 600, enabled: true };
    return undefined;
  }
  async findByMerchantOrder(merchantOrderNo: string): Promise<XApiOrder | undefined> {
    return this.orders.get(merchantOrderNo);
  }
  async getOrder(orderId: string): Promise<XApiOrder> {
    const order = [...this.orders.values()].find((item) => item.id === orderId);
    if (!order) throw new XApiUpstreamError("订单不存在", 404, "not_found");
    return order;
  }
  async createOrder(input: {
    merchantOrderNo: string;
    productCode: string;
    recipient: string;
    expectedPoints: number;
  }): Promise<XApiOrder> {
    const existing = this.orders.get(input.merchantOrderNo);
    if (existing) return existing;
    const order: XApiOrder = {
      id: `ord_${randomBytes(16).toString("hex")}`,
      merchant_order_no: input.merchantOrderNo,
      product_code: input.productCode,
      recipient: input.recipient,
      points: input.expectedPoints,
      status: "queued",
      failure_code: null,
      receipt: null,
    };
    this.orders.set(input.merchantOrderNo, order);
    this.available -= input.expectedPoints;
    return order;
  }
  setStatus(merchantOrderNo: string, status: XApiOrderStatus, failureCode: string | null = null): void {
    const order = this.orders.get(merchantOrderNo);
    if (!order) throw new Error("mock_order_not_found");
    order.status = status;
    order.failure_code = failureCode;
  }
}

function canonicalQuery(params: URLSearchParams): string {
  const encode = (value: string) => encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return Array.from(params, ([key, value]) => [encode(key), encode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1
        : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.ceil(milliseconds) : undefined;
}

export function createXApiClient(config: AppConfig): XApiClient {
  if (config.xApi.mode === "live") return new LiveXApiClient(config.xApi);
  if (config.xApi.mode === "mock") return new MockXApiClient();
  return new DisabledXApiClient();
}
