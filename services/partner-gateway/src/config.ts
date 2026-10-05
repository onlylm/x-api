import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import type { ProductConfig } from "./domain.js";

const productSchema = z.object({
  product: z.string().regex(/^[a-z0-9_]{3,64}$/),
  name_zh: z.string().min(1),
  name: z.string().min(1),
  plan: z.enum(["plus", "pro_5x", "pro_20x", "pro_50x", "x_premium_3m", "x_premium_6m"]),
  internal_cost_cny: z.string().regex(/^\d+\.\d{2}$/).optional(),
  cost_price: z.string().regex(/^\d+\.\d{2}$/),
  max_sell_price: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.literal("CNY"),
  max_qty: z.literal(1),
  enabled: z.boolean(),
  payment_country: z.literal("CL").optional(),
  payment_currency: z.literal("CLP").optional(),
}).refine((product) => Boolean(product.payment_country) === Boolean(product.payment_currency), {
  message: "付款地区与币种必须同时配置",
});

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`无效的正整数配置：${value}`);
  return parsed;
}

function readProducts(path: string): ProductConfig[] {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  return z.array(productSchema).min(1).parse(data) as ProductConfig[];
}

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  partnerSalesGateFile?: string;
  databasePath: string;
  trustProxy: boolean;
  platformApiKey: string;
  platformAllowedIps: Set<string>;
  /** Missing on legacy injected configs means enabled. Explicit false preserves outbox without delivery. */
  platformWebhookEnabled?: boolean;
  platformWebhookUrl: string;
  platformWebhookSecret: string;
  adminToken: string;
  sessionEncryptionKey: Buffer;
  emailHmacKey: string;
  products: ProductConfig[];
  paymentProvider: "mock" | "alipay";
  alipay: {
    appId: string;
    privateKey: string;
    publicKey: string;
    sellerId: string;
    gateway: string;
    notifyUrl: string;
    returnUrl: string;
  };
  zovo: {
    mode: "mock" | "live";
    baseUrl: string;
    appId: string;
    apiKey: string;
    timeoutMs: number;
  };
  xApi: {
    mode: "disabled" | "mock" | "live";
    baseUrl: string;
    partnerId: string;
    keyId: string;
    secret: string;
    timeoutMs: number;
  };
  activationPollIntervalMs: number;
  webhookPollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const catalogPath = resolve(cwd, env.PRODUCT_CATALOG_PATH || "./config/products.json");
  if (env.PLATFORM_WEBHOOK_ENABLED !== undefined &&
      !["0", "1", "true", "false", "yes", "no", "on", "off"].includes(env.PLATFORM_WEBHOOK_ENABLED.toLowerCase())) {
    throw new Error("PLATFORM_WEBHOOK_ENABLED 必须是明确的布尔值");
  }
  const platformWebhookEnabled = bool(env.PLATFORM_WEBHOOK_ENABLED, true);
  const key = Buffer.from(
    env.SESSION_ENCRYPTION_KEY || "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "base64",
  );
  if (key.length !== 32) throw new Error("SESSION_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥");

  const config: AppConfig = {
    nodeEnv: env.NODE_ENV || "development",
    host: env.HOST || "127.0.0.1",
    port: positiveInt(env.PORT, 3100),
    publicBaseUrl: env.PUBLIC_BASE_URL || "http://127.0.0.1:3100",
    partnerSalesGateFile: env.PARTNER_SALES_GATE_FILE?.trim() || undefined,
    databasePath: resolve(cwd, env.DATABASE_PATH || "./data/merchant-gateway.sqlite"),
    trustProxy: bool(env.TRUST_PROXY),
    platformApiKey: env.PLATFORM_API_KEY || "dev-platform-key",
    platformAllowedIps: new Set(
      (env.PLATFORM_ALLOWED_IPS || "127.0.0.1,::1")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
    platformWebhookEnabled,
    platformWebhookUrl:
      env.PLATFORM_WEBHOOK_URL || (platformWebhookEnabled ? "https://prodclub.xyz/api/v1/upstream/webhook" : ""),
    platformWebhookSecret: env.PLATFORM_WEBHOOK_SECRET || "dev-webhook-secret",
    adminToken: env.ADMIN_TOKEN || "dev-admin-token",
    sessionEncryptionKey: key,
    emailHmacKey: env.EMAIL_HMAC_KEY || "dev-email-hmac-key",
    products: readProducts(catalogPath),
    paymentProvider: env.PAYMENT_PROVIDER === "alipay" ? "alipay" : "mock",
    alipay: {
      appId: env.ALIPAY_APP_ID || "",
      privateKey: (env.ALIPAY_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      publicKey: (env.ALIPAY_PUBLIC_KEY || "").replace(/\\n/g, "\n"),
      sellerId: env.ALIPAY_SELLER_ID || "",
      gateway: env.ALIPAY_GATEWAY || "https://openapi.alipay.com/gateway.do",
      notifyUrl: env.ALIPAY_NOTIFY_URL || "",
      returnUrl: env.ALIPAY_RETURN_URL || "https://prodclub.xyz",
    },
    zovo: {
      mode: env.ZOVO_MODE === "live" ? "live" : "mock",
      baseUrl: (env.ZOVO_BASE_URL || "https://zovocard.com").replace(/\/$/, ""),
      appId: env.ZOVO_APP_ID || "",
      apiKey: env.ZOVO_API_KEY || "",
      timeoutMs: positiveInt(env.ZOVO_REQUEST_TIMEOUT_MS, 15_000),
    },
    xApi: {
      mode: env.X_API_MODE === "live" ? "live" : env.X_API_MODE === "mock" ? "mock" : "disabled",
      baseUrl: (env.X_API_BASE_URL || "https://x.aifu.me").replace(/\/$/, ""),
      partnerId: env.X_API_PARTNER_ID || "",
      keyId: env.X_API_KEY_ID || "",
      secret: env.X_API_SECRET || "",
      timeoutMs: positiveInt(env.X_API_REQUEST_TIMEOUT_MS, 15_000),
    },
    activationPollIntervalMs: positiveInt(env.ACTIVATION_POLL_INTERVAL_MS, 3_000),
    webhookPollIntervalMs: positiveInt(env.WEBHOOK_POLL_INTERVAL_MS, 5_000),
  };

  if (config.nodeEnv === "production") validateProductionConfig(config);
  return config;
}

function validateProductionConfig(config: AppConfig): void {
  const problems: string[] = [];
  if (!config.publicBaseUrl.startsWith("https://")) problems.push("PUBLIC_BASE_URL 必须使用 HTTPS");
  if (config.platformApiKey.length < 32) problems.push("PLATFORM_API_KEY 至少 32 字符");
  try { validatePlatformWebhookConfiguration(config); }
  catch { problems.push("启用平台通知时必须配置公网 HTTPS 回调地址和独立的至少 32 字符密钥，禁止地址包含凭据或片段"); }
  if (config.adminToken.length < 32) problems.push("ADMIN_TOKEN 至少 32 字符");
  if (config.sessionEncryptionKey.equals(Buffer.alloc(32))) problems.push("必须更换示例 SESSION_ENCRYPTION_KEY");
  if (config.emailHmacKey.length < 32) problems.push("EMAIL_HMAC_KEY 至少 32 字符");
  if (config.paymentProvider !== "alipay") problems.push("生产环境 PAYMENT_PROVIDER 必须为 alipay");
  if (!config.alipay.appId || !config.alipay.privateKey || !config.alipay.publicKey) {
    problems.push("生产环境必须配置支付宝 APP ID、应用私钥和支付宝公钥");
  }
  if (!config.alipay.sellerId || !config.alipay.notifyUrl.startsWith("https://")) {
    problems.push("生产环境必须配置支付宝商户 PID 和 HTTPS 异步通知地址");
  }
  const hasZovoProducts = config.products.some((product) =>
    product.enabled && !product.plan.startsWith("x_premium_"));
  const hasXProducts = config.products.some((product) =>
    product.enabled && product.plan.startsWith("x_premium_"));
  if (hasZovoProducts && (config.zovo.mode !== "live" || !config.zovo.apiKey)) {
    problems.push("生产环境必须启用 ZovoCard live 模式并配置 API Key");
  }
  try { validateXApiConfiguration(config); }
  catch { problems.push("X_API 正式配置无效：需 HTTPS 地址和有效商户密钥，禁止生产模拟履约"); }
  if (hasXProducts && config.xApi.mode !== "live") problems.push("已启用蓝V商品，必须启用 X_API live 模式");
  if (config.products.some((product) => product.enabled && product.cost_price === "0.01")) {
    problems.push("仍有启用商品使用示例价格 0.01");
  }
  if (config.products.some((product) => product.payment_country === "CL" && product.enabled)) {
    problems.push("智利商品的供货价和美元成本基准尚未确认，暂不可启用");
  }
  if (problems.length) throw new Error(`生产配置不完整：\n- ${problems.join("\n- ")}`);
}

export function validateXApiConfiguration(config: AppConfig): void {
  const x = config.xApi;
  if (config.nodeEnv === "production" && x.mode === "mock") throw new Error("x_production_mock_forbidden");
  if (x.mode !== "live") return;
  const url = new URL(x.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !/^usr_[a-f0-9]{32}$/.test(x.partnerId) || !/^key_[a-f0-9]{32}$/.test(x.keyId) ||
      x.secret.length < 32) throw new Error("x_configuration_invalid");
}

export function validatePlatformWebhookConfiguration(config: AppConfig): void {
  if (config.platformWebhookEnabled === false || config.nodeEnv !== "production") return;
  let url: URL;
  try { url = new URL(config.platformWebhookUrl); }
  catch { throw new Error("platform_webhook_configuration_invalid"); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || config.platformWebhookUrl.includes("#") ||
      /[\s\\]/.test(config.platformWebhookUrl) || !isPublicWebhookHostname(hostname) ||
      config.platformWebhookSecret.length < 32 || config.platformWebhookSecret === config.platformApiKey) {
    throw new Error("platform_webhook_configuration_invalid");
  }
}

// Static deployment validation only: no DNS lookups or network requests during startup.
function isPublicWebhookHostname(hostname: string): boolean {
  const family = isIP(hostname);
  if (family === 4) {
    const [a, b] = hostname.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (family === 6) {
    if (hostname === "::" || hostname === "::1" || /^(?:f[cd]|fe[89ab]|ff)/.test(hostname)) return false;
    // WHATWG URL normalizes IPv4-mapped IPv6 to hexadecimal pairs.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
      return isPublicWebhookHostname([high >> 8, high & 255, low >> 8, low & 255].join("."));
    }
    return true;
  }
  return hostname.includes(".") && !/(^|\.)(localhost|local|internal|lan|home|home\.arpa)$/.test(hostname);
}
