import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { AlipaySdk } from "alipay-sdk";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./database.js";
import { moneyToCents, type OrderRecord } from "./domain.js";
import type { PaymentConfirmation, RefundConfirmation } from "./clients/payment.js";
import { BluevSandboxPaymentClient, type BluevRecoveryPayment } from "./bluev-sandbox-payment.js";
import { decryptValue, encryptValue } from "./security.js";
import { BLUEV_ALIPAY_NOTIFY_URL, BluevAlipaySettingsError, type BluevAlipaySettingsDto } from "./bluev-alipay-contract.js";
export { BluevAlipaySettingsError } from "./bluev-alipay-contract.js";

// Deployment rollback checks use this capability marker before switching to older code.
export const BLUEV_PAYMENT_PROFILE_SCHEMA_VERSION = 1;
const GATEWAY = "https://openapi.alipay.com/gateway.do";
type AlipayConfig = AppConfig["alipay"];
type PaymentOrder = Pick<OrderRecord, "order_id" | "amount" | "product"> & Partial<OrderRecord>;
export type BluevAlipayClientFactory = (config: AlipayConfig) => BluevRecoveryPayment;
type VersionRow = { revision: number; identity_id: string; app_id: string; seller_id: string; gateway: string;
  secret_ciphertext: string; secret_iv: string; secret_tag: string; created_at: string };
type BindingRow = { order_id: string; identity_id: string; bound_revision: number; bound_at: string };
const inputSchema = z.object({ app_id: z.string().trim().regex(/^\d{16}$/), seller_id: z.string().trim().regex(/^\d{16}$/),
  private_key: z.string().max(8192).transform(value => value.trim()), public_key: z.string().max(8192).transform(value => value.trim()),
  expected_revision: z.number().int().min(1).max(1_000_000), confirm_apply: z.literal(true) }).strict();

function identityId(config: Pick<AlipayConfig, "appId" | "sellerId" | "gateway">): string {
  return createHash("sha256").update(JSON.stringify([config.appId, config.sellerId, config.gateway])).digest("hex");
}
function purpose(revision: number, identity: string): string {
  return `bluev-alipay-config:v${BLUEV_PAYMENT_PROFILE_SCHEMA_VERSION}:revision:${revision}:identity:${identity}`;
}
function safeError(error: unknown): never {
  if (error instanceof BluevAlipaySettingsError) throw error;
  throw new BluevAlipaySettingsError("bluev_alipay_storage_unavailable");
}
function normalizeKey(value: string, kind: "private" | "public"): string {
  const invalid = () => new BluevAlipaySettingsError(kind === "private" ? "bluev_alipay_invalid_private_key" : "bluev_alipay_invalid_public_key");
  const source = value.trim().replace(/\\r\\n|\\n/g, "\n");
  if (!source || source.length > 8192) throw invalid();
  if (source.includes("-----BEGIN") && !(kind === "private"
    ? /^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(source)
    : /^-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(source))) throw invalid();
  const parse = (pem: string): KeyObject => kind === "private" ? createPrivateKey(pem) : createPublicKey(pem);
  const candidates = [source];
  const compact = source.replace(/\s/g, "");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    for (const label of kind === "private" ? ["PRIVATE KEY", "RSA PRIVATE KEY"] : ["PUBLIC KEY", "RSA PUBLIC KEY"]) {
      candidates.push(`-----BEGIN ${label}-----\n${compact.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----`);
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = parse(candidate);
      const bits = parsed.asymmetricKeyDetails?.modulusLength;
      if (parsed.asymmetricKeyType !== "rsa" || !bits || bits < 2048 || bits > 8192) continue;
      return parsed.export({ type: kind === "private" ? "pkcs8" : "spki", format: "pem" }).toString();
    } catch { /* Try only local supported PEM envelopes; never echo key parsing diagnostics. */ }
  }
  throw invalid();
}
function seedConfig(config: AlipayConfig): AlipayConfig {
  if (!/^\d{16}$/.test(config.appId) || !/^\d{16}$/.test(config.sellerId) || config.gateway !== GATEWAY || config.notifyUrl !== BLUEV_ALIPAY_NOTIFY_URL) {
    throw new BluevAlipaySettingsError("bluev_alipay_invalid_config");
  }
  return { ...config, privateKey: normalizeKey(config.privateKey, "private"), publicKey: normalizeKey(config.publicKey, "public"),
    notifyUrl: BLUEV_ALIPAY_NOTIFY_URL, returnUrl: "" };
}

/** Encrypted, append-only payment profiles for the independent blueV database only. */
export class BluevAlipaySettings {
  private readonly encryptionKey: Buffer;
  private readonly clientFactory: BluevAlipayClientFactory;

  constructor(private readonly database: AppDatabase, seed: AlipayConfig, encryptionKey: Buffer,
    clientFactory: BluevAlipayClientFactory = config => new BluevSandboxPaymentClient(config)) {
    if (encryptionKey.length !== 32 || encryptionKey.equals(Buffer.alloc(32))) throw new BluevAlipaySettingsError("bluev_alipay_invalid_config");
    this.encryptionKey = Buffer.from(encryptionKey);
    this.clientFactory = clientFactory;
    try {
      this.database.transaction(() => {
        this.database.db.exec(`CREATE TABLE IF NOT EXISTS bluev_alipay_versions (
          revision INTEGER PRIMARY KEY CHECK(revision>0), identity_id TEXT NOT NULL, app_id TEXT NOT NULL,
          seller_id TEXT NOT NULL, gateway TEXT NOT NULL, secret_ciphertext TEXT NOT NULL,
          secret_iv TEXT NOT NULL, secret_tag TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bluev_alipay_identity_revision ON bluev_alipay_versions(identity_id,revision);
        CREATE TABLE IF NOT EXISTS bluev_alipay_settings (
          id INTEGER PRIMARY KEY CHECK(id=1), active_revision INTEGER NOT NULL REFERENCES bluev_alipay_versions(revision)
        );
        CREATE TABLE IF NOT EXISTS bluev_alipay_order_identities (
          order_id TEXT PRIMARY KEY, identity_id TEXT NOT NULL,
          bound_revision INTEGER NOT NULL REFERENCES bluev_alipay_versions(revision), bound_at TEXT NOT NULL
        );`);
        if (this.database.db.prepare("SELECT active_revision FROM bluev_alipay_settings WHERE id=1").get()) {
          this.configFrom(this.active()); // Wrong encryption key or broken references must fail closed.
          return;
        }
        if (this.database.db.prepare("SELECT 1 FROM bluev_alipay_versions LIMIT 1").get()) throw new BluevAlipaySettingsError("bluev_alipay_storage_unavailable");
        const initial = seedConfig(seed);
        this.insertVersion(1, initial);
        this.database.db.prepare("INSERT INTO bluev_alipay_settings(id,active_revision) VALUES(1,1)").run();
        // Upgrade only: all pre-existing orders and intents belong to the environment identity.
        // Do not modify order_json, payment state, amounts, or previously saved QR codes.
        const identity = identityId(initial);
        const ids = new Set<string>();
        for (const row of this.database.db.prepare("SELECT order_id FROM orders").all()) ids.add(String(row.order_id));
        if (this.hasIntents()) {
          for (const row of this.database.db.prepare("SELECT order_json FROM checkout_intents").all()) {
            const original: unknown = JSON.parse(String(row.order_json));
            if (!original || typeof original !== "object" || !("order_id" in original) || typeof original.order_id !== "string") {
              throw new BluevAlipaySettingsError("bluev_alipay_storage_unavailable");
            }
            ids.add(original.order_id);
          }
        }
        for (const orderId of ids) this.bind(orderId, identity, 1);
      });
    } catch (error) { safeError(error); }
  }

  private hasIntents(): boolean {
    return Boolean(this.database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkout_intents'").get());
  }
  private active(): VersionRow {
    const row = this.database.db.prepare(`SELECT v.* FROM bluev_alipay_settings s
      JOIN bluev_alipay_versions v ON v.revision=s.active_revision WHERE s.id=1`).get() as VersionRow | undefined;
    if (!row) throw new BluevAlipaySettingsError("bluev_alipay_storage_unavailable");
    return row;
  }
  private insertVersion(revision: number, config: AlipayConfig): void {
    const identity = identityId(config);
    const secret = encryptValue(JSON.stringify({ private_key: config.privateKey, public_key: config.publicKey }), this.encryptionKey, purpose(revision, identity));
    this.database.db.prepare(`INSERT INTO bluev_alipay_versions
      (revision,identity_id,app_id,seller_id,gateway,secret_ciphertext,secret_iv,secret_tag,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(revision, identity, config.appId, config.sellerId, config.gateway, secret.ciphertext, secret.iv, secret.tag, new Date().toISOString());
  }
  private configFrom(row: VersionRow): AlipayConfig {
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !/^\d{16}$/.test(row.app_id) || !/^\d{16}$/.test(row.seller_id)
      || row.gateway !== GATEWAY || row.identity_id !== identityId({ appId: row.app_id, sellerId: row.seller_id, gateway: row.gateway })) {
      throw new BluevAlipaySettingsError("bluev_alipay_storage_unavailable");
    }
    const decoded = JSON.parse(decryptValue({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag },
      this.encryptionKey, purpose(row.revision, row.identity_id))) as Record<string, unknown>;
    if (!decoded || typeof decoded.private_key !== "string" || !decoded.private_key || typeof decoded.public_key !== "string" || !decoded.public_key) {
      throw new BluevAlipaySettingsError("bluev_alipay_storage_unavailable");
    }
    return { appId: row.app_id, sellerId: row.seller_id, privateKey: decoded.private_key, publicKey: decoded.public_key,
      gateway: row.gateway, notifyUrl: BLUEV_ALIPAY_NOTIFY_URL, returnUrl: "" };
  }
  private dto(row: VersionRow): BluevAlipaySettingsDto {
    this.configFrom(row); // Authenticate stored ciphertext without ever returning either key.
    return { revision: row.revision, app_id: row.app_id, seller_id: row.seller_id, has_private_key: true, has_public_key: true,
      notify_url: BLUEV_ALIPAY_NOTIFY_URL, updated_at: row.created_at };
  }

  read(): BluevAlipaySettingsDto {
    try { return this.dto(this.active()); } catch (error) { return safeError(error); }
  }

  save(input: unknown): BluevAlipaySettingsDto {
    const result = inputSchema.safeParse(input);
    if (!result.success) throw new BluevAlipaySettingsError("bluev_alipay_invalid_request");
    const value = result.data;
    try {
      return this.database.transaction(() => {
        const previous = this.active();
        if (previous.revision !== value.expected_revision) throw new BluevAlipaySettingsError("bluev_alipay_revision_conflict");
        const sameIdentity = previous.app_id === value.app_id && previous.seller_id === value.seller_id && previous.gateway === GATEWAY;
        if (!sameIdentity && (!value.private_key || !value.public_key)) throw new BluevAlipaySettingsError("bluev_alipay_keys_required");
        const retained = this.configFrom(previous);
        const config: AlipayConfig = { appId: value.app_id, sellerId: value.seller_id, gateway: GATEWAY,
          privateKey: value.private_key ? normalizeKey(value.private_key, "private") : retained.privateKey,
          publicKey: value.public_key ? normalizeKey(value.public_key, "public") : retained.publicKey,
          notifyUrl: BLUEV_ALIPAY_NOTIFY_URL, returnUrl: "" };
        const revision = Number(this.database.db.prepare("SELECT MAX(revision) AS n FROM bluev_alipay_versions").get()!.n) + 1;
        if (!Number.isSafeInteger(revision) || revision > 1_000_000) throw new BluevAlipaySettingsError("bluev_alipay_storage_unavailable");
        this.insertVersion(revision, config);
        this.database.db.prepare("UPDATE bluev_alipay_settings SET active_revision=? WHERE id=1 AND active_revision=?")
          .run(revision, previous.revision);
        return this.dto(this.active());
      });
    } catch (error) { return safeError(error); }
  }

  private bind(orderId: string, identity: string, revision: number): void {
    if (!/^UP[A-Z0-9]+$/.test(orderId)) throw new BluevAlipaySettingsError("bluev_alipay_binding_mismatch");
    this.database.db.prepare("INSERT INTO bluev_alipay_order_identities(order_id,identity_id,bound_revision,bound_at) VALUES(?,?,?,?)")
      .run(orderId, identity, revision, new Date().toISOString());
  }
  private sourceOrder(order: PaymentOrder): { saved: OrderRecord; complete: boolean } {
    let saved = this.database.getOrder(order.order_id);
    const complete = Boolean(saved);
    if (!saved && this.hasIntents()) {
      const rows = this.database.db.prepare("SELECT order_json FROM checkout_intents WHERE json_extract(order_json,'$.order_id')=? LIMIT 2").all(order.order_id);
      if (rows.length > 1) throw new BluevAlipaySettingsError("bluev_alipay_binding_mismatch");
      if (rows.length) saved = JSON.parse(String(rows[0].order_json)) as OrderRecord;
    }
    if (!saved) throw new BluevAlipaySettingsError("bluev_alipay_binding_missing");
    if (saved.order_id !== order.order_id || saved.product !== order.product || saved.amount !== order.amount
      || (order.client_order_id !== undefined && order.client_order_id !== saved.client_order_id)) {
      throw new BluevAlipaySettingsError("bluev_alipay_binding_mismatch");
    }
    return { saved, complete };
  }
  private resolve(order: PaymentOrder, allowNewBinding: boolean): { config: AlipayConfig; identity: string } {
    try {
      return this.database.transaction(() => {
        const source = this.sourceOrder(order);
        let binding = this.database.db.prepare("SELECT * FROM bluev_alipay_order_identities WHERE order_id=?").get(order.order_id) as BindingRow | undefined;
        if (!binding) {
          // A new intent can exist after a crash between durable reservation and the first payment call.
          // There could not have been an outgoing request before its binding. Never infer an identity
          // for a completed order or an incoming callback from untrusted notification fields.
          if (!allowNewBinding || source.complete || source.saved.status !== "pending" || source.saved.qr !== ""
            || source.saved.paid_at !== null || source.saved.alipay_trade_no !== null) {
            throw new BluevAlipaySettingsError("bluev_alipay_binding_missing");
          }
          const active = this.active();
          this.bind(order.order_id, active.identity_id, active.revision);
          binding = { order_id: order.order_id, identity_id: active.identity_id, bound_revision: active.revision, bound_at: "" };
        }
        const bound = this.database.db.prepare("SELECT * FROM bluev_alipay_versions WHERE revision=?").get(binding.bound_revision) as VersionRow | undefined;
        if (!bound || bound.identity_id !== binding.identity_id) throw new BluevAlipaySettingsError("bluev_alipay_binding_mismatch");
        const latest = this.database.db.prepare("SELECT * FROM bluev_alipay_versions WHERE identity_id=? ORDER BY revision DESC LIMIT 1")
          .get(binding.identity_id) as VersionRow | undefined;
        if (!latest) throw new BluevAlipaySettingsError("bluev_alipay_binding_missing");
        return { config: this.configFrom(latest), identity: binding.identity_id };
      });
    } catch (error) { return safeError(error); }
  }

  /** Internal router hook; clients/configuration never enter the settings DTO. */
  async withOrderClient<T>(order: PaymentOrder, use: (client: BluevRecoveryPayment) => Promise<T>): Promise<T> {
    const selected = this.resolve(order, true);
    return use(this.clientFactory(selected.config));
  }

  async verifyBoundNotification(payload: Record<string, string>, order: OrderRecord): Promise<PaymentConfirmation> {
    const selected = this.resolve(order, false);
    const config = selected.config;
    const invalid = () => new BluevAlipaySettingsError("bluev_alipay_notification_invalid");
    if (payload.app_id !== config.appId || payload.seller_id !== config.sellerId || payload.out_trade_no !== order.order_id
      || !payload.trade_no || !["TRADE_SUCCESS", "TRADE_FINISHED"].includes(payload.trade_status)) throw invalid();
    try { if (moneyToCents(payload.total_amount) !== moneyToCents(order.amount)) throw invalid(); }
    catch { throw invalid(); }
    let verified = false;
    try {
      const previous = this.database.db.prepare("SELECT * FROM bluev_alipay_versions WHERE identity_id=? ORDER BY revision DESC")
        .all(selected.identity) as VersionRow[];
      const tried = new Set<string>();
      for (const version of previous) {
        const historicalPublicKey = this.configFrom(version).publicKey;
        if (tried.has(historicalPublicKey)) continue;
        tried.add(historicalPublicKey);
        const sdk = new AlipaySdk({ appId: config.appId, privateKey: config.privateKey, alipayPublicKey: historicalPublicKey,
          gateway: GATEWAY, signType: "RSA2", keyType: "PKCS8" });
        if (sdk.checkNotifySignV2({ ...payload })) { verified = true; break; }
      }
    } catch (error) { safeError(error); }
    if (!verified) throw invalid();
    // Old-signature notifications may be delayed. Use only the identity's latest keys for the
    // active query, never the historical signing/private-key pair and never the globally active app.
    const confirmation = await this.clientFactory(config).queryPayment(order);
    if (!confirmation.paid || confirmation.tradeNo !== payload.trade_no || !["TRADE_SUCCESS", "TRADE_FINISHED"].includes(confirmation.tradeStatus ?? "")) throw invalid();
    return confirmation;
  }
}

/** PaymentClient façade: saving/reading configuration never calls any of these payment methods. */
export class BluevAlipayPaymentRouter implements BluevRecoveryPayment {
  constructor(private readonly settings: BluevAlipaySettings) {}
  createPaymentUrl(order: PaymentOrder, returnUrl?: string): Promise<string> {
    return this.settings.withOrderClient(order, client => client.createPaymentUrl(order, returnUrl));
  }
  queryPayment(order: OrderRecord): Promise<PaymentConfirmation> {
    return this.settings.withOrderClient(order, client => client.queryPayment(order));
  }
  queryForRecovery(order: OrderRecord): ReturnType<BluevRecoveryPayment["queryForRecovery"]> {
    return this.settings.withOrderClient(order, client => client.queryForRecovery(order));
  }
  verifyNotification(payload: Record<string, string>, order: OrderRecord): Promise<PaymentConfirmation> {
    return this.settings.verifyBoundNotification(payload, order);
  }
  async refundPayment(_order: OrderRecord, _outRequestNo: string, _reason: string): Promise<RefundConfirmation> {
    throw new BluevAlipaySettingsError("bluev_alipay_refund_disabled");
  }
  async queryRefund(_order: OrderRecord, _outRequestNo: string): Promise<RefundConfirmation> {
    throw new BluevAlipaySettingsError("bluev_alipay_refund_disabled");
  }
}
