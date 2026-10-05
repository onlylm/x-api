import { randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { ProductConfig } from "../domain.js";
export interface CardCostTransaction {
  transaction_id:string; card_id:string; amount_usd:string; status:string; type:string; occurred_at:string; merchant:string;
}

export interface CdkOrderCostSnapshot {
  order_id: string;
  client_request_id: string;
  plan: ProductConfig["plan"];
  status: string;
  card_id: string;
  card_last_four?: string;
  final_amount_minor: number;
  quoted_amount_minor: number;
  currency: string;
  completed_at?: string;
}

export interface IssuedCdk {
  id: string;
  code: string;
  plan: ProductConfig["plan"];
}

export interface PreviewResult {
  redemptionToken: string;
  plan: string;
}

export interface PreflightResult {
  email: string;
  preflightToken: string;
}

export interface RedeemResult {
  orderId: string | null;
  status: string;
}

export interface RedemptionResult {
  status: string;
  stage?: string;
  message?: string;
  errorCode?: string;
  accountEmail?: string;
  orderId?: string;
}

export type UpstreamCredential =
  | { mode: "session"; session: string }
  | { mode: "access_token"; accessToken: string };

export interface ZovoClient {
  listCardTransactions?(page: number): Promise<CardCostTransaction[]>;
  getCdkOrderCost?(orderId: string): Promise<CdkOrderCostSnapshot>;
  isPlanAvailable(plan: ProductConfig["plan"]): Promise<boolean>;
  getCdkStatus(upstreamCdkId: string): Promise<string | undefined>;
  issueCdk(plan: ProductConfig["plan"], idempotencyKey: string): Promise<IssuedCdk>;
  preview(code: string, deviceId: string): Promise<PreviewResult>;
  preflight(redemptionToken: string, sessionData: Record<string, unknown>, deviceId: string): Promise<PreflightResult>;
  redeem(
    redemptionToken: string,
    preflightToken: string,
    clientRequestId: string,
    deviceId: string,
  ): Promise<RedeemResult>;
  getResult(redemptionToken: string, deviceId: string): Promise<RedemptionResult>;
}

export class ZovoUpstreamError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly errorCode?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class LiveZovoClient implements ZovoClient {
  async listCardTransactions(page: number): Promise<CardCostTransaction[]> {
    const data = await this.request("/openapi/v1/cards/all-transactions?page=" + page + "&page_size=50&sync=0",
      {method:"GET",authenticated:true});
    if (!Array.isArray(data)) throw new ZovoUpstreamError("交易响应格式不符合文档",502,"invalid_transactions");
    return data.filter((r:any)=>r.settle_currency==="USD").map((r:any)=>{
      const amount=String(r.settle_amount);
      if(!r.auth_id || !/^\d+(\.\d{1,2})?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount)>9_999_999.99) {
        throw new ZovoUpstreamError("交易金额或标识无效",502,"invalid_transaction");
      }
      return {transaction_id:String(r.auth_id),card_id:String(r.local_card_id??r.card_id??""),
        amount_usd:Number(amount).toFixed(2),status:String(r.status),type:String(r.type),
        occurred_at:String(r.auth_time??r.create_time??""),merchant:String(r.merchant_name??"").slice(0,120)};
    });
  }

  async getCdkOrderCost(orderId: string): Promise<CdkOrderCostSnapshot> {
    if (!/^\d{1,20}$/.test(orderId)) throw new ZovoUpstreamError("充值订单号格式无效", 422, "invalid_order_id");
    const data = await this.request(`/openapi/v1/gpt-direct/cdk-orders/${orderId}`, {
      method: "GET",
      authenticated: true,
    });
    const order = data?.order;
    const plan = String(order?.plan ?? "");
    const validPlans = new Set<ProductConfig["plan"]>(["plus", "pro_5x", "pro_20x", "pro_50x"]);
    const numeric = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value : Number.NaN;
    const finalAmount = numeric(order?.final_amount_minor);
    const quotedAmount = numeric(order?.quoted_amount_minor);
    if (!order || String(order.order_id) !== orderId || !validPlans.has(plan as ProductConfig["plan"]) ||
      !String(order.card_id ?? "") || !Number.isFinite(finalAmount) || !Number.isFinite(quotedAmount)) {
      throw new ZovoUpstreamError("充值订单成本信息不完整", 502, "invalid_cdk_order_cost");
    }
    return {
      order_id: String(order.order_id),
      client_request_id: String(order.client_request_id ?? ""),
      plan: plan as ProductConfig["plan"],
      status: String(order.status ?? ""),
      card_id: String(order.card_id),
      card_last_four: order.card_last_four ? String(order.card_last_four) : undefined,
      final_amount_minor: finalAmount,
      quoted_amount_minor: quotedAmount,
      currency: String(order.currency ?? ""),
      completed_at: order.completed_at ? String(order.completed_at) : undefined,
    };
  }
  private plansCache: { expiresAt: number; data: any } | null = null;

  constructor(private readonly config: AppConfig["zovo"]) {}

  async isPlanAvailable(plan: ProductConfig["plan"]): Promise<boolean> {
    try {
      const data = await this.getPlans();
      const row = Array.isArray(data.registry)
        ? data.registry.find((item: any) => item.product === "gpt" && item.key === plan)
        : undefined;
      if (!row || row.purchasable !== true) return false;
      return data.plans?.[row.acc_plan_key]?.enabled === true;
    } catch {
      return false;
    }
  }

  async getCdkStatus(upstreamCdkId: string): Promise<string | undefined> {
    const query = new URLSearchParams({ q: upstreamCdkId, page: "1", page_size: "20" });
    const data = await this.request(`/openapi/v1/gpt-direct/cdks?${query}`, {
      method: "GET",
      authenticated: true,
    });
    const item = Array.isArray(data?.list)
      ? data.list.find((row: any) => String(row.id) === upstreamCdkId)
      : undefined;
    return item?.status === undefined ? undefined : String(item.status);
  }

  async issueCdk(plan: ProductConfig["plan"], idempotencyKey: string): Promise<IssuedCdk> {
    const data = await this.request("/openapi/v1/gpt-direct/cdks", {
      method: "POST",
      authenticated: true,
      headers: { "Idempotency-Key": idempotencyKey },
      body: { plan, count: 1, funding_confirmed: true },
    });
    const issued = data?.issued?.[0];
    if (!issued?.code || issued.id === undefined) {
      throw new ZovoUpstreamError("CDK 签发响应缺少完整码", 502, "invalid_upstream_response");
    }
    return { id: String(issued.id), code: String(issued.code), plan };
  }

  async preview(code: string, deviceId: string): Promise<PreviewResult> {
    const data = await this.request("/api/v1/cdk/preview", {
      method: "POST",
      deviceId,
      body: { code },
    });
    return { redemptionToken: String(data.redemption_token), plan: String(data.plan) };
  }

  async preflight(
    redemptionToken: string,
    sessionData: Record<string, unknown>,
    deviceId: string,
  ): Promise<PreflightResult> {
    const data = await this.request("/api/v1/cdk/preflight", {
      method: "POST",
      deviceId,
      body: {
        redemption_token: redemptionToken,
        credential: buildUpstreamCredential(sessionData),
      },
    });
    return { email: String(data.email), preflightToken: String(data.preflight_token) };
  }

  async redeem(
    redemptionToken: string,
    preflightToken: string,
    clientRequestId: string,
    deviceId: string,
  ): Promise<RedeemResult> {
    const data = await this.request("/api/v1/cdk/redeem", {
      method: "POST",
      deviceId,
      body: {
        redemption_token: redemptionToken,
        preflight_token: preflightToken,
        client_request_id: clientRequestId,
      },
    });
    return {
      orderId: data.id === undefined ? null : String(data.id),
      status: String(data.status ?? "queued"),
    };
  }

  async getResult(redemptionToken: string, deviceId: string): Promise<RedemptionResult> {
    const query = new URLSearchParams({ token: redemptionToken });
    const data = await this.request(`/api/v1/cdk/result?${query}`, {
      method: "GET",
      deviceId,
    });
    const order = data.order ?? {};
    return {
      status: String(order.status ?? "running"),
      stage: order.stage ? String(order.stage) : undefined,
      message: order.message ? String(order.message) : undefined,
      errorCode: order.error_code ? String(order.error_code) : undefined,
      accountEmail: order.account_email ? String(order.account_email) : undefined,
      orderId: order.id === undefined ? undefined : String(order.id),
    };
  }

  private async getPlans(): Promise<any> {
    if (this.plansCache && this.plansCache.expiresAt > Date.now()) return this.plansCache.data;
    const data = await this.request("/openapi/v1/gpt-direct/plans?product=gpt", {
      method: "GET",
      authenticated: true,
    });
    this.plansCache = { data, expiresAt: Date.now() + 30_000 };
    return data;
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST";
      authenticated?: boolean;
      deviceId?: string;
      headers?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
      if (options.authenticated) headers["X-API-Key"] = this.config.apiKey;
      if (options.authenticated && this.config.appId) headers["X-App-Id"] = this.config.appId;
      if (options.deviceId) headers["X-Redemption-Device"] = options.deviceId;
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as any;
      if (!response.ok || payload.code !== 0) {
        throw new ZovoUpstreamError(
          "上游请求未成功",
          response.status,
          payload.error_code ? String(payload.error_code) : undefined,
          retryAfterMilliseconds(response.headers.get("retry-after")),
        );
      }
      return payload.data;
    } catch (error) {
      if (error instanceof ZovoUpstreamError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ZovoUpstreamError("上游请求超时", 504, "upstream_timeout");
      }
      throw new ZovoUpstreamError("上游连接失败", 503, "upstream_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.ceil(milliseconds) : undefined;
}

/**
 * The platform session response contains an OpenAI access token.  ZovoCard
 * distinguishes that credential from the ChatGPT session cookie: sending an
 * access token as `mode: "session"` is rejected with GPT_ACCESS_TOKEN_UNSUPPORTED.
 * Prefer a real session token when one is present; otherwise use the explicit
 * access_token mode required by the upstream API.
 */
export function buildUpstreamCredential(sessionData: Record<string, unknown>): UpstreamCredential {
  const sessionToken = findSessionToken(sessionData);
  if (sessionToken) return { mode: "session", session: sessionToken };

  const accessToken = asNonEmptyString(sessionData.accessToken);
  if (accessToken) return { mode: "access_token", accessToken };

  throw new ZovoUpstreamError("Session 缺少可用凭据", 422, "GPT_SESSION_INVALID");
}

function findSessionToken(sessionData: Record<string, unknown>): string | undefined {
  for (const value of [sessionData.sessionToken, sessionData.session_token]) {
    const token = asNonEmptyString(value);
    if (token) return token;
  }

  const cookies = sessionData.cookies;
  if (cookies && typeof cookies === "object" && !Array.isArray(cookies)) {
    const cookieMap = cookies as Record<string, unknown>;
    for (const key of [
      "__Secure-next-auth.session-token",
      "next-auth.session-token",
      "sessionToken",
      "session_token",
    ]) {
      const token = asNonEmptyString(cookieMap[key]);
      if (token) return token;
    }
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

export class MockZovoClient implements ZovoClient {
  private readonly tokens = new Map<string, { email?: string; status: string; orderId?: string }>();

  async isPlanAvailable(): Promise<boolean> {
    return true;
  }

  async getCdkStatus(): Promise<string> {
    return "unused";
  }

  async issueCdk(plan: ProductConfig["plan"]): Promise<IssuedCdk> {
    const id = randomBytes(8).toString("hex");
    return { id, code: `ZC-MOCK-${id.toUpperCase()}`, plan };
  }

  async preview(): Promise<PreviewResult> {
    const token = `rt_${randomBytes(12).toString("hex")}`;
    this.tokens.set(token, { status: "previewed" });
    return { redemptionToken: token, plan: "mock" };
  }

  async preflight(
    redemptionToken: string,
    sessionData: Record<string, unknown>,
  ): Promise<PreflightResult> {
    const user = (sessionData.user ?? {}) as Record<string, unknown>;
    const email = String(user.email ?? "");
    if (!email) {
      throw new ZovoUpstreamError("无效 Session", 400, "GPT_SESSION_INVALID");
    }
    buildUpstreamCredential(sessionData);
    const current = this.tokens.get(redemptionToken);
    if (!current) throw new ZovoUpstreamError("兑换令牌无效", 404, "not_found");
    current.email = email;
    return { email, preflightToken: `pt_${randomBytes(12).toString("hex")}` };
  }

  async redeem(redemptionToken: string): Promise<RedeemResult> {
    const current = this.tokens.get(redemptionToken);
    if (!current) throw new ZovoUpstreamError("兑换令牌无效", 404, "not_found");
    current.status = "completed";
    current.orderId = `mock_${randomBytes(6).toString("hex")}`;
    return { orderId: current.orderId, status: "queued" };
  }

  async getResult(redemptionToken: string): Promise<RedemptionResult> {
    const current = this.tokens.get(redemptionToken);
    if (!current) throw new ZovoUpstreamError("兑换令牌无效", 404, "not_found");
    return {
      status: current.status,
      accountEmail: current.email,
      orderId: current.orderId,
      message: current.status === "completed" ? "开通成功" : "处理中",
    };
  }
}

export function createZovoClient(config: AppConfig): ZovoClient {
  return config.zovo.mode === "live" ? new LiveZovoClient(config.zovo) : new MockZovoClient();
}
