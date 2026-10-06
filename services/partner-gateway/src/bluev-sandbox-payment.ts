import { createPrivateKey, createPublicKey } from "node:crypto";
import { AlipaySdk } from "alipay-sdk";
import type { AppConfig } from "./config.js";
import { moneyToCents, type OrderRecord } from "./domain.js";
import { AlipayPaymentClient, alipayPaymentSubject, type PaymentClient, type PaymentConfirmation } from "./clients/payment.js";
import { BluevPaymentError } from "./bluev-payment-errors.js";
export { BluevPaymentError, describeBluevPaymentError, type BluevPaymentErrorCode } from "./bluev-payment-errors.js";

export interface BluevRecoveryPayment extends PaymentClient {
  queryForRecovery(order: OrderRecord): Promise<{
    state: "not_found" | "trade_exists" | "unknown";
    confirmation: PaymentConfirmation;
  }>;
}

type AlipayConfig = AppConfig["alipay"];
type PaymentOrder = Pick<OrderRecord, "order_id" | "amount" | "product"> & Partial<Pick<OrderRecord, "expires_at">>;

function checkedConfig(config: AlipayConfig): AlipayConfig {
  try {
    if (!config.appId || !config.sellerId || !config.privateKey || !config.publicKey) throw new Error();
    if (createPrivateKey(config.privateKey).asymmetricKeyType !== "rsa"
      || createPublicKey(config.publicKey).asymmetricKeyType !== "rsa") throw new Error();
    for (const address of [config.gateway, config.notifyUrl]) {
      const url = new URL(address);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
    }
    return { ...config };
  } catch { throw new BluevPaymentError("bluev_payment_local_config"); }
}

function blankConfirmation(): PaymentConfirmation {
  return { paid: false, tradeNo: null, paidAt: new Date().toISOString(), receiptAmount: null, tradeStatus: null };
}

function value(response: Record<string, unknown>, camel: string, snake: string): string {
  const item = response[camel] ?? response[snake];
  return typeof item === "string" || typeof item === "number" ? String(item) : "";
}

function businessError(response: Record<string, unknown>): BluevPaymentError {
  const permissions = new Set(["ACQ.ACCESS_FORBIDDEN", "ACQ.ACCESS_TOKEN_ERROR", "isv.insufficient-isv-permissions",
    "isv.app-id-not-exist", "isv.app-unbind-partner", "isv.insufficient-user-permissions"]);
  return new BluevPaymentError(permissions.has(value(response, "subCode", "sub_code"))
    ? "bluev_payment_provider_permission" : "bluev_payment_provider_rejected");
}

function isMatchingAmount(actual: string, expected: string): boolean {
  try { return !!actual && moneyToCents(actual) === moneyToCents(expected); } catch { return false; }
}

function transportError(error: unknown): BluevPaymentError {
  // alipay-sdk wraps urllib failures in AlipayRequestError.cause. Inspect only bounded
  // code/name fields; do not preserve, stringify or return any original error content.
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object" && !seen.has(current); depth++) {
    seen.add(current);
    const code = "code" in current && typeof current.code === "string" ? current.code : "";
    const name = "name" in current && typeof current.name === "string" ? current.name : "";
    if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)
      || ["TimeoutError", "ConnectTimeoutError", "HeadersTimeoutError", "BodyTimeoutError"].includes(name)) {
      return new BluevPaymentError("bluev_payment_timeout");
    }
    if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET"].includes(code)) {
      return new BluevPaymentError("bluev_payment_network");
    }
    if (code.startsWith("ERR_OSSL_") || code.startsWith("ERR_CRYPTO_")) return new BluevPaymentError("bluev_payment_local_config");
    current = "cause" in current ? current.cause : undefined;
  }
  return new BluevPaymentError("bluev_payment_unknown");
}

/** Isolated blueV behavior: does not alter legacy payment clients or their configuration. */
export class BluevSandboxPaymentClient extends AlipayPaymentClient implements BluevRecoveryPayment {
  private readonly bluevConfig: AlipayConfig;

  constructor(config: AlipayConfig) {
    const safeConfig = checkedConfig(config);
    super(safeConfig);
    this.bluevConfig = safeConfig;
  }

  private async signedExec(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // An SDK and verification scope per request prevent simultaneous query/precreate results mixing.
    let verificationStarted = false;
    let verified = false;
    try {
      const sdk = new AlipaySdk({ appId: this.bluevConfig.appId, privateKey: this.bluevConfig.privateKey,
        alipayPublicKey: this.bluevConfig.publicKey, gateway: this.bluevConfig.gateway, signType: "RSA2",
        charset: "utf-8", version: "1.0", keyType: this.bluevConfig.privateKey.includes("BEGIN PRIVATE KEY") ? "PKCS8" : "PKCS1",
        camelcase: true, timeout: 10_000 });
      const check = sdk.checkResponseSign.bind(sdk);
      sdk.checkResponseSign = (...args: Parameters<AlipaySdk["checkResponseSign"]>) => {
        verificationStarted = true;
        // Always delegate to the actual SDK verifier. Neither unsigned error_response nor sub_msg
        // can establish a business rejection or authorize an original-order retry.
        check(...args);
        if (args[1] !== `${method.replaceAll(".", "_")}_response` || !args[2]) {
          throw new BluevPaymentError("bluev_payment_signature_unverified");
        }
        verified = true;
      };
      const response = await sdk.exec(method, params, { validateSign: true });
      if (!verified) throw new BluevPaymentError("bluev_payment_signature_unverified");
      if (!response || typeof response !== "object" || Array.isArray(response)) throw new BluevPaymentError("bluev_payment_unknown");
      return response as Record<string, unknown>;
    } catch (error) {
      if (error instanceof BluevPaymentError) throw error;
      if (verificationStarted && !verified) throw new BluevPaymentError("bluev_payment_signature_unverified");
      throw transportError(error);
    }
  }

  override async createPaymentUrl(order: PaymentOrder, _returnUrl?: string): Promise<string> {
    const expires = order.expires_at && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(order.expires_at)
      ? Date.parse(order.expires_at) : NaN;
    if (!Number.isFinite(expires)) throw new BluevPaymentError("bluev_payment_invalid_expiry");
    if (Math.floor(expires / 1000) * 1000 <= Date.now()) throw new BluevPaymentError("bluev_payment_expired");
    // Never implicitly renew the original intent with timeout_express=20m. A renewal must be
    // explicitly authorized and saved by the caller before reaching this adapter.
    const absoluteExpiry = new Date(expires + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const response = await this.signedExec("alipay.trade.precreate", { notify_url: this.bluevConfig.notifyUrl,
      bizContent: { out_trade_no: order.order_id, product_code: "FACE_TO_FACE_PAYMENT", total_amount: order.amount,
        subject: alipayPaymentSubject(order.order_id), time_expire: absoluteExpiry } });
    if (String(response.code ?? "") !== "10000") throw businessError(response);
    if (value(response, "outTradeNo", "out_trade_no") !== order.order_id) throw new BluevPaymentError("bluev_payment_order_mismatch");
    const qr = value(response, "qrCode", "qr_code");
    if (!qr) throw new BluevPaymentError("bluev_payment_missing_qr");
    try {
      const url = new URL(qr);
      if (/[\u0000-\u0020\u007f]/.test(qr) || !qr.startsWith("https://qr.alipay.com/") || url.protocol !== "https:"
        || url.hostname !== "qr.alipay.com" || url.username || url.password || url.port || url.hash) throw new Error();
    } catch { throw new BluevPaymentError("bluev_payment_invalid_qr"); }
    return qr;
  }

  async queryForRecovery(order: OrderRecord): Promise<{
    state: "not_found" | "trade_exists" | "unknown"; confirmation: PaymentConfirmation;
  }> {
    const response = await this.signedExec("alipay.trade.query", { bizContent: { out_trade_no: order.order_id } });
    const code = String(response.code ?? "");
    if (code === "40004" && value(response, "subCode", "sub_code") === "ACQ.TRADE_NOT_EXIST") {
      return { state: "not_found", confirmation: blankConfirmation() };
    }
    if (code !== "10000") return { state: "unknown", confirmation: blankConfirmation() };
    if (value(response, "outTradeNo", "out_trade_no") !== order.order_id) throw new BluevPaymentError("bluev_payment_order_mismatch");
    if (!isMatchingAmount(value(response, "totalAmount", "total_amount"), order.amount)) {
      throw new BluevPaymentError("bluev_payment_amount_mismatch");
    }
    const tradeStatus = value(response, "tradeStatus", "trade_status");
    const tradeNo = value(response, "tradeNo", "trade_no");
    const paid = ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(tradeStatus);
    if (paid && !tradeNo) throw new BluevPaymentError("bluev_payment_unknown");
    const sentAt = value(response, "sendPayDate", "send_pay_date");
    const paidDate = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(sentAt) ? new Date(sentAt.replace(" ", "T") + "+08:00") : null;
    return { state: "trade_exists", confirmation: { paid, tradeNo: tradeNo || null,
      paidAt: paidDate && !Number.isNaN(paidDate.getTime()) ? paidDate.toISOString() : new Date().toISOString(),
      receiptAmount: value(response, "receiptAmount", "receipt_amount") || order.amount, tradeStatus: tradeStatus || null } };
  }

  override async queryPayment(order: OrderRecord): Promise<PaymentConfirmation> {
    return (await this.queryForRecovery(order)).confirmation;
  }
}
