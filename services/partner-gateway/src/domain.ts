export type PaymentStatus = "pending" | "paid" | "expired" | "refunded" | "closed";
export type RefundStatus = "requested" | "processing" | "succeeded" | "failed" | "rejected";
export type ActivationStatus = "submitting" | "queued" | "running" | "success" | "failed";
export type FailureCode =
  | "session_invalid"
  | "account_has_subscription"
  | "account_not_eligible"
  | "region_unsupported"
  | "payment_blocked"
  | "verification_timeout"
  | "other";

export type ProductPlan =
  | "plus"
  | "pro_5x"
  | "pro_20x"
  | "pro_50x"
  | "x_premium_3m"
  | "x_premium_6m";

export function isXGiftPlan(plan: ProductPlan): plan is "x_premium_3m" | "x_premium_6m" {
  return plan === "x_premium_3m" || plan === "x_premium_6m";
}

export function xGiftProductCode(plan: ProductPlan): "x-premium-3m" | "x-premium-6m" {
  if (plan === "x_premium_3m") return "x-premium-3m";
  if (plan === "x_premium_6m") return "x-premium-6m";
  throw new Error("not_x_gift_plan");
}

export function normalizeXUsername(value: unknown): string {
  const username = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(username)) throw new Error("invalid_x_username");
  return username;
}

/** Omitted on legacy orders: upstream CDK issuance defaults to PH/PHP. */
export interface PaymentRegion {
  payment_country: "CL";
  payment_currency: "CLP";
}

export interface ProductConfig {
  product: string;
  name_zh: string;
  name: string;
  plan: ProductPlan;
  cost_price: string;
  max_sell_price: string;
  currency: "CNY";
  max_qty: 1;
  enabled: boolean;
  /** 仅供运营与财务使用，绝不返回给平台。 */
  internal_cost_cny?: string;
  payment_country?: PaymentRegion["payment_country"] | null;
  payment_currency?: PaymentRegion["payment_currency"] | null;
}

export interface OrderRecord {
  order_id: string;
  client_order_id: string;
  product: string;
  plan: ProductConfig["plan"];
  payment_country?: PaymentRegion["payment_country"] | null;
  payment_currency?: PaymentRegion["payment_currency"] | null;
  quantity: number;
  sell_price: string;
  amount: string;
  status: PaymentStatus;
  qr: string;
  expires_at: string;
  alipay_trade_no: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  delivery_status: string | null;
  platform_supply_price: string | null;
  platform_max_sell_price: string | null;
  upstream_estimated_cost_cny: string | null;
  upstream_actual_cost_amount: string | null;
  upstream_actual_cost_currency: string | null;
  upstream_actual_cost_cny: string | null;
  alipay_receipt_amount: string | null;
  customer_price_refund_amount: string;
  customer_price_refund_reference: string | null;
  customer_price_refund_reason: string | null;
  customer_price_refunded_at: string | null;
  order_source?: "platform" | "manual";
  manual_customer_ref?: string | null;
  manual_note?: string | null;
  payment_channel?: "alipay" | "cash";
  manual_payment_reference?: string | null;
  fulfillment_recipient_ciphertext?: string | null;
  fulfillment_recipient_iv?: string | null;
  fulfillment_recipient_tag?: string | null;
  fulfillment_recipient_hash?: string | null;
  fulfillment_recipient_masked?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundRecord {
  refund_id: string;
  order_id: string;
  client_refund_id: string;
  amount: string;
  reason: string;
  status: RefundStatus;
  requested_by: "platform" | "admin";
  alipay_trade_no: string | null;
  alipay_refund_fee: string | null;
  failure_code: string | null;
  failure_message: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivationRecord {
  id: number;
  order_id: string;
  activation_id: number;
  task_id: string;
  status: ActivationStatus;
  finished: number;
  failure_code: FailureCode | null;
  message_zh: string | null;
  account_email_masked: string | null;
  email_hash: string | null;
  session_ciphertext: string | null;
  session_iv: string | null;
  session_tag: string | null;
  cdk_id: number | null;
  redemption_token: string | null;
  upstream_order_id: string | null;
  worker_state: "queued" | "provisioning" | "polling" | "terminal";
  worker_locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface CdkRecord {
  id: number;
  upstream_cdk_id: string;
  plan: ProductConfig["plan"];
  payment_country?: PaymentRegion["payment_country"] | null;
  payment_currency?: PaymentRegion["payment_currency"] | null;
  redemption_device_id: string | null;
  code_ciphertext: string;
  code_iv: string;
  code_tag: string;
  status: "unused" | "reserved" | "consumed" | "disabled" | "frozen";
  assigned_activation_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function moneyToCents(value: string): number {
  if (!/^\d+\.\d{2}$/.test(value)) {
    throw new Error("金额必须是两位小数的字符串");
  }
  const [whole, fraction] = value.split(".");
  const cents = Number(BigInt(whole) * 100n + BigInt(fraction));
  if (!Number.isSafeInteger(cents)) throw new Error("金额超出安全范围");
  return cents;
}

export function centsToMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error("金额超出安全范围");
  const absolute = BigInt(Math.abs(cents));
  return `${cents < 0 ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

/** Only computed profit may be negative; payment/refund inputs still use moneyToCents. */
export function signedMoneyToCents(value: string): number {
  return value.startsWith("-") ? -moneyToCents(value.slice(1)) : moneyToCents(value);
}

export function sumMoney(values: string[]): string {
  const total = values.reduce((sum,value) => sum + BigInt(signedMoneyToCents(value)), 0n);
  return centsToMoney(Number(total));
}

export class FinancialAmountError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface FinancialAmounts {
  customerPayment: string;
  serviceReceipt: string;
  supplyCost: string;
  customerPriceRefund: string;
  platformProfit: string;
  invoiceableAmount: string;
  customerPaymentCents: number;
  serviceReceiptCents: number;
  supplyCostCents: number;
  customerPriceRefundCents: number;
  platformProfitCents: number;
  invoiceableAmountCents: number;
}

/**
 * 单笔订单唯一的财务计算口径。所有输入先转换为整数分，避免浮点误差。
 * 负平台利润是可识别的业务结果（例如历史供货价高于实际收款），不会在
 * 这里被静默改成 0；结算逻辑必须明确排除非正利润。
 */
export function calculateFinancialAmounts(input: {
  customerPayment: string;
  serviceReceipt: string;
  supplyCost: string;
  customerPriceRefund: string;
}): FinancialAmounts {
  const customerPaymentCents = moneyToCents(input.customerPayment);
  const serviceReceiptCents = moneyToCents(input.serviceReceipt);
  const supplyCostCents = moneyToCents(input.supplyCost);
  const customerPriceRefundCents = moneyToCents(input.customerPriceRefund);
  const platformProfitCents = serviceReceiptCents - supplyCostCents - customerPriceRefundCents;
  const invoiceableAmountCents = serviceReceiptCents - customerPriceRefundCents;
  return {
    customerPayment: centsToMoney(customerPaymentCents),
    serviceReceipt: centsToMoney(serviceReceiptCents),
    supplyCost: centsToMoney(supplyCostCents),
    customerPriceRefund: centsToMoney(customerPriceRefundCents),
    platformProfit: centsToMoney(platformProfitCents),
    invoiceableAmount: centsToMoney(invoiceableAmountCents),
    customerPaymentCents,
    serviceReceiptCents,
    supplyCostCents,
    customerPriceRefundCents,
    platformProfitCents,
    invoiceableAmountCents,
  };
}

export type FinancialConsistencyError =
  | "service_receipt_exceeds_customer_payment"
  | "customer_price_refund_exceeds_receipt"
  | "customer_price_refund_exceeds_platform_margin";

/** 返回需要阻断资金动作的金额异常；负利润本身会保留并单独呈现。 */
export function financialConsistencyErrors(amounts: FinancialAmounts): FinancialConsistencyError[] {
  const errors: FinancialConsistencyError[] = [];
  if (amounts.serviceReceiptCents > amounts.customerPaymentCents) {
    errors.push("service_receipt_exceeds_customer_payment");
  }
  if (amounts.customerPriceRefundCents > amounts.serviceReceiptCents) {
    errors.push("customer_price_refund_exceeds_receipt");
  }
  if (amounts.customerPriceRefundCents > 0 && amounts.platformProfitCents < 0) {
    errors.push("customer_price_refund_exceeds_platform_margin");
  }
  return errors;
}

export function maskEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (local.length === 1) return `*${"@"}${domain}`;
  if (local.length === 2) return `${local[0]}*${"@"}${domain}`;
  return `${local[0]}***${local.at(-1)}@${domain}`;
}

export function mapUpstreamFailure(errorCode?: string, status?: string, stage?: string): FailureCode {
  const code = (errorCode ?? "").toUpperCase().replace(/^(GPT|CLAUDE)_/, "");
  const known: Record<string, FailureCode> = {
    SESSION_INVALID: "session_invalid", SESSION_EXPIRED: "session_invalid", SESSION_REQUIRED: "session_invalid",
    CREDENTIAL_INVALID: "session_invalid", CREDENTIALS_INVALID: "session_invalid",
    PLAN_ALREADY_ACTIVE: "account_has_subscription", ACCOUNT_HAS_SUBSCRIPTION: "account_has_subscription",
    SUBSCRIPTION_CONFLICT: "account_has_subscription", SUBSCRIPTION_INCOMPATIBLE: "account_has_subscription",
    IOS_PLUS_SUBSCRIPTION_CONFLICT: "account_has_subscription",
    ACCOUNT_NOT_ELIGIBLE: "account_not_eligible", PLAN_NOT_ELIGIBLE: "account_not_eligible",
    PRODUCT_NOT_ELIGIBLE: "account_not_eligible", REQUIRES_20X_HISTORY: "account_not_eligible",
    IOS_EXPIRY_WINDOW: "account_not_eligible", IOS_SUBSCRIPTION_WINDOW: "account_not_eligible",
    REGION_UNSUPPORTED: "region_unsupported", REGION_NOT_SUPPORTED: "region_unsupported",
    VERIFICATION_TIMEOUT: "verification_timeout", PAYMENT_BLOCKED: "payment_blocked",
    PAYMENT_DECLINED: "payment_blocked", CARD_DECLINED: "payment_blocked",
  };
  if (known[code]) return known[code];
  if ((stage ?? "").toLowerCase() === "external_subscription") return "account_has_subscription";
  if (["declined", "failed_precharge"].includes(status ?? "")) return "payment_blocked";
  return "other";
}

/** Only explicit validation refusals on 400/422 prove redemption was not accepted. */
export function definitiveActivationFailure(code: string | undefined, httpStatus: number | undefined): FailureCode | undefined {
  if (httpStatus !== 400 && httpStatus !== 422) return undefined;
  const mapped = mapUpstreamFailure(code);
  return ["session_invalid", "account_has_subscription", "account_not_eligible", "region_unsupported"].includes(mapped)
    ? mapped : undefined;
}


export function mapZovoStatus(status: string): ActivationStatus {
  if (status === "completed") return "success";
  if (["declined", "failed_precharge", "cancelled"].includes(status)) return "failed";
  if (["queued", "awaiting_card", "funding_pending", "dispatching"].includes(status)) {
    return "queued";
  }
  return "running";
}
