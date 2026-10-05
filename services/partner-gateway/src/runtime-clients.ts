import type { AppConfig } from "./config.js";
import type { OrderRecord, ProductConfig } from "./domain.js";
import {
  AlipayPaymentClient,
  MockPaymentClient,
  type PaymentClient,
  type PaymentConfirmation,
  type RefundConfirmation,
} from "./clients/payment.js";
import {
  LiveZovoClient,
  MockZovoClient,
  type CdkOrderCostSnapshot,
  type IssuedCdk,
  type PreflightResult,
  type PreviewResult,
  type RedeemResult,
  type RedemptionResult,
  type ZovoClient,
} from "./clients/zovo.js";
import { RuntimeSettings } from "./runtime-settings.js";

export class RuntimePaymentClient implements PaymentClient {
  private cached: { fingerprint: string; client: PaymentClient } | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly settings: RuntimeSettings,
  ) {}

  isMock(): boolean {
    return this.settings.paymentMode() === "mock";
  }

  async createPaymentUrl(
    order: Pick<OrderRecord, "order_id" | "amount" | "product">,
    returnUrl?: string,
  ): Promise<string> {
    return this.client().createPaymentUrl(order, returnUrl);
  }

  async verifyNotification(payload: Record<string, string>, order: OrderRecord): Promise<PaymentConfirmation> {
    return this.client().verifyNotification(payload, order);
  }

  async queryPayment(order: OrderRecord): Promise<PaymentConfirmation> {
    return this.client().queryPayment(order);
  }

  async refundPayment(order: OrderRecord, outRequestNo: string, reason: string): Promise<RefundConfirmation> {
    return this.client().refundPayment(order, outRequestNo, reason);
  }

  async queryRefund(order: OrderRecord, outRequestNo: string): Promise<RefundConfirmation> {
    return this.client().queryRefund(order, outRequestNo);
  }

  private client(): PaymentClient {
    const mode = this.settings.paymentMode();
    const alipay = this.settings.alipayConfig();
    const fingerprint = JSON.stringify([mode, alipay.appId, alipay.privateKey, alipay.publicKey, alipay.sellerId]);
    if (this.cached?.fingerprint === fingerprint) return this.cached.client;
    if (mode === "alipay" && (!alipay.appId || !alipay.privateKey || !alipay.publicKey || !alipay.sellerId)) {
      throw new Error("alipay_configuration_incomplete");
    }
    const client = mode === "alipay" ? new AlipayPaymentClient(alipay) : new MockPaymentClient(this.config.publicBaseUrl);
    this.cached = { fingerprint, client };
    return client;
  }
}

export class RuntimeZovoClient implements ZovoClient {
  private cached: { fingerprint: string; client: ZovoClient } | null = null;

  constructor(private readonly settings: RuntimeSettings) {}

  async isPlanAvailable(plan: ProductConfig["plan"]): Promise<boolean> {
    return this.client().isPlanAvailable(plan);
  }

  async getCdkStatus(upstreamCdkId: string): Promise<string | undefined> {
    return this.client().getCdkStatus(upstreamCdkId);
  }
  async listCardTransactions(page:number) {
    const client=this.client();
    if(!client.listCardTransactions) throw new Error("card_query_unavailable");
    return client.listCardTransactions(page);
  }

  async getCdkOrderCost(orderId:string):Promise<CdkOrderCostSnapshot> {
    const client=this.client();
    if(!client.getCdkOrderCost) throw new Error("cdk_order_cost_unavailable");
    return client.getCdkOrderCost(orderId);
  }

  async issueCdk(plan: ProductConfig["plan"], idempotencyKey: string): Promise<IssuedCdk> {
    return this.client().issueCdk(plan, idempotencyKey);
  }

  async preview(code: string, deviceId: string): Promise<PreviewResult> {
    return this.client().preview(code, deviceId);
  }

  async preflight(token: string, session: Record<string, unknown>, deviceId: string): Promise<PreflightResult> {
    return this.client().preflight(token, session, deviceId);
  }

  async redeem(token: string, preflightToken: string, requestId: string, deviceId: string): Promise<RedeemResult> {
    return this.client().redeem(token, preflightToken, requestId, deviceId);
  }

  async getResult(token: string, deviceId: string): Promise<RedemptionResult> {
    return this.client().getResult(token, deviceId);
  }

  private client(): ZovoClient {
    const config = this.settings.zovoConfig();
    const fingerprint = JSON.stringify([config.mode, config.baseUrl, config.appId, config.apiKey]);
    if (this.cached?.fingerprint === fingerprint) return this.cached.client;
    if (config.mode === "live" && !config.apiKey) throw new Error("zovo_configuration_incomplete");
    const client = config.mode === "live" ? new LiveZovoClient(config) : new MockZovoClient();
    this.cached = { fingerprint, client };
    return client;
  }
}
