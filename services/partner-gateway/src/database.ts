import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FinancialLedger, LedgerError, migrateFinancialLedger } from "./services/financial-ledger.js";
import type {
  ActivationRecord,
  CdkRecord,
  EncryptedValue,
  FailureCode,
  OrderRecord,
  PaymentRegion,
  ProductConfig,
  ProductPlan,
  RefundRecord,
} from "./domain.js";
import {
  calculateFinancialAmounts,
  centsToMoney,
  financialConsistencyErrors,
  FinancialAmountError,
  isXGiftPlan,
  moneyToCents,
} from "./domain.js";

export interface ManualActivationTakeover {
  id: number;
  order_id: string;
  source_activation_id: number;
  status: "claimed" | "review_required" | "completed" | "released";
  reason: string;
  claimed_at: string;
  completed_at: string | null;
}

export class AppDatabase {
  readonly db: DatabaseSync;

  constructor(path: string, options: {migrate?:boolean} = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if(options.migrate!==false){
      this.migrate();
      this.transaction(() => migrateFinancialLedger(this.db));
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL UNIQUE,
        product TEXT NOT NULL,
        plan TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        sell_price TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        qr TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        alipay_trade_no TEXT,
        paid_at TEXT,
        refunded_at TEXT,
        delivery_status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL REFERENCES orders(order_id),
        activation_id INTEGER NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0,
        failure_code TEXT,
        message_zh TEXT,
        account_email_masked TEXT,
        email_hash TEXT,
        session_ciphertext TEXT,
        session_iv TEXT,
        session_tag TEXT,
        cdk_id INTEGER,
        redemption_token TEXT,
        upstream_order_id TEXT,
        worker_state TEXT NOT NULL DEFAULT 'queued',
        worker_locked_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(order_id, activation_id)
      );

      CREATE TABLE IF NOT EXISTS cdks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upstream_cdk_id TEXT NOT NULL UNIQUE,
        plan TEXT NOT NULL,
        code_ciphertext TEXT NOT NULL,
        code_iv TEXT NOT NULL,
        code_tag TEXT NOT NULL,
        status TEXT NOT NULL,
        assigned_activation_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        delivered_at TEXT,
        exhausted_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS manual_activation_takeovers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL REFERENCES orders(order_id),
        source_activation_id INTEGER NOT NULL REFERENCES activations(id),
        status TEXT NOT NULL CHECK(status IN ('claimed', 'review_required', 'completed', 'released')),
        reason TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_manual_takeover_order_latest
        ON manual_activation_takeovers(order_id, id DESC);

      CREATE TABLE IF NOT EXISTS runtime_settings (
        setting_key TEXT PRIMARY KEY,
        value_ciphertext TEXT NOT NULL,
        value_iv TEXT NOT NULL,
        value_tag TEXT NOT NULL,
        is_secret INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS product_settings (
        product TEXT PRIMARY KEY,
        name_zh TEXT NOT NULL,
        name TEXT NOT NULL,
        plan TEXT NOT NULL,
        internal_cost_cny TEXT NOT NULL DEFAULT '0.00',
        cost_price TEXT NOT NULL,
        max_sell_price TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'CNY',
        max_qty INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_audit (
        client_order_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        replay_count INTEGER NOT NULL DEFAULT 0,
        conflict_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        action TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        reason TEXT NOT NULL,
        operator TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refunds (
        refund_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id),
        client_refund_id TEXT NOT NULL UNIQUE,
        amount TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        alipay_trade_no TEXT,
        alipay_refund_fee TEXT,
        failure_code TEXT,
        failure_message TEXT,
        refunded_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_settlements (
        settlement_id TEXT PRIMARY KEY,
        period_from TEXT NOT NULL,
        period_to TEXT NOT NULL,
        amount TEXT NOT NULL,
        order_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        payment_method TEXT,
        payment_reference TEXT,
        payment_note TEXT,
        paid_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_settlement_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        settlement_id TEXT NOT NULL REFERENCES platform_settlements(settlement_id),
        order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id),
        amount TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_rebates (
        rebate_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id),
        upstream_order_id TEXT,
        card_transaction_id TEXT UNIQUE,
        standard_usd TEXT NOT NULL,
        actual_usd TEXT NOT NULL,
        fee_usd TEXT NOT NULL DEFAULT '0.15',
        rebate_usd TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT NOT NULL,
        settlement_id TEXT REFERENCES platform_settlements(settlement_id),
        settled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invoices (
        invoice_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id),
        title_type TEXT NOT NULL,
        title TEXT NOT NULL,
        tax_id TEXT,
        recipient_email TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        request_note TEXT,
        invoice_number TEXT,
        invoice_date TEXT,
        invoice_url TEXT,
        issue_note TEXT,
        issued_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activations_worker ON activations(worker_state, worker_locked_until);
      CREATE INDEX IF NOT EXISTS idx_outbox_due ON webhook_outbox(delivered_at, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
      CREATE INDEX IF NOT EXISTS idx_idempotency_last_seen ON idempotency_audit(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_order_audit_order ON order_audit_log(order_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_platform_settlements_status ON platform_settlements(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_platform_settlement_lines_settlement ON platform_settlement_lines(settlement_id);
      CREATE INDEX IF NOT EXISTS idx_platform_rebates_status ON platform_rebates(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, created_at);
    `);
    const outboxColumns = this.db.prepare("PRAGMA table_info(webhook_outbox)").all() as Array<{
      name: string;
    }>;
    if (!outboxColumns.some((column) => column.name === "exhausted_at")) {
      this.db.exec("ALTER TABLE webhook_outbox ADD COLUMN exhausted_at TEXT");
    }
    this.addColumns("orders", {
      payment_country: "TEXT",
      payment_currency: "TEXT",
      platform_supply_price: "TEXT",
      platform_max_sell_price: "TEXT",
      upstream_estimated_cost_cny: "TEXT",
      upstream_actual_cost_amount: "TEXT",
      upstream_actual_cost_currency: "TEXT",
      upstream_actual_cost_cny: "TEXT",
      alipay_receipt_amount: "TEXT",
      customer_price_refund_amount: "TEXT NOT NULL DEFAULT '0.00'",
      customer_price_refund_reference: "TEXT",
      customer_price_refund_reason: "TEXT",
      customer_price_refunded_at: "TEXT",
      order_source: "TEXT NOT NULL DEFAULT 'platform'",
      manual_customer_ref: "TEXT",
      manual_note: "TEXT",
      payment_channel: "TEXT NOT NULL DEFAULT 'alipay'",
      manual_payment_reference: "TEXT",
      fulfillment_recipient_ciphertext: "TEXT",
      fulfillment_recipient_iv: "TEXT",
      fulfillment_recipient_tag: "TEXT",
      fulfillment_recipient_hash: "TEXT",
      fulfillment_recipient_masked: "TEXT",
    });
    this.addColumns("invoices", {
      unit_address: "TEXT",
      phone: "TEXT",
      bank_name: "TEXT",
      bank_account: "TEXT",
    });
    this.db.exec(`CREATE TABLE IF NOT EXISTS x_gift_submissions (
      activation_id INTEGER PRIMARY KEY REFERENCES activations(id),
      merchant_order_no TEXT NOT NULL UNIQUE,
      request_json TEXT NOT NULL,
      submit_started_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
    this.addColumns("cdks", {
      redemption_device_id: "TEXT",
      payment_country: "TEXT",
      payment_currency: "TEXT",
    });
    this.addColumns("product_settings", {
      payment_country: "TEXT",
      payment_currency: "TEXT",
    });
    this.addColumns("platform_settlements", {
      rebate_usd: "TEXT NOT NULL DEFAULT '0.00'",
      generation_mode: "TEXT NOT NULL DEFAULT 'manual'",
      business_date: "TEXT",
    });
    this.addColumns("platform_settlement_lines", {
      customer_payment_amount: "TEXT",
      receipt_amount: "TEXT",
      supply_price: "TEXT",
      customer_refund_amount: "TEXT",
    });
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_settlements_business_date
      ON platform_settlements(business_date) WHERE business_date IS NOT NULL
    `);
    // 旧数据在第一次 preview 后已经与设备标识绑定。用最早关联的开通任务回填，
    // 后续即使用户重新提交 Session，也必须沿用同一设备标识。
    this.db.exec(`
      UPDATE cdks
      SET redemption_device_id = (
        SELECT 'merchant-' || activations.task_id
        FROM activations
        WHERE activations.cdk_id = cdks.id
        ORDER BY activations.id ASC
        LIMIT 1
      )
      WHERE redemption_device_id IS NULL
    `);
  }

  private addColumns(table: string, columns: Record<string, string>): void {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
    );
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  seedProducts(products: ProductConfig[]): void {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO product_settings (
        product, name_zh, name, plan, internal_cost_cny, cost_price, max_sell_price,
        currency, max_qty, enabled, payment_country, payment_currency, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const product of products) {
      statement.run(
        product.product,
        product.name_zh,
        product.name,
        product.plan,
        product.internal_cost_cny ?? "0.00",
        product.cost_price,
        product.max_sell_price,
        product.currency,
        product.max_qty,
        product.enabled ? 1 : 0,
        product.payment_country ?? null,
        product.payment_currency ?? null,
        now,
      );
    }
  }

  listProducts(): ProductConfig[] {
    const rows = this.db.prepare("SELECT * FROM product_settings ORDER BY rowid ASC").all() as Array<
      Omit<ProductConfig, "enabled"> & { enabled: number }
    >;
    return rows.map((row) => ({
      product: row.product,
      name_zh: row.name_zh,
      name: row.name,
      plan: row.plan,
      internal_cost_cny: row.internal_cost_cny,
      payment_country: row.payment_country ?? null,
      payment_currency: row.payment_currency ?? null,
      cost_price: row.cost_price,
      max_sell_price: row.max_sell_price,
      currency: "CNY",
      max_qty: 1,
      enabled: Boolean(row.enabled),
    }));
  }

  updateProduct(input: {
    product: string;
    internalCostCny: string;
    supplyPrice: string;
    enabled: boolean;
  }): ProductConfig {
    const existing = this.listProducts().find((item) => item.product === input.product);
    if (!existing) throw new Error("product_not_found");
    if (existing.payment_country === "CL" && input.enabled) {
      throw new Error("chile_price_not_verified");
    }
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE product_settings SET internal_cost_cny = ?, cost_price = ?,
      enabled = ?, updated_at = ? WHERE product = ?
    `).run(
      input.internalCostCny,
      input.supplyPrice,
      input.enabled ? 1 : 0,
      now,
      input.product,
    );
    if (!result.changes) throw new Error("product_not_found");
    return this.listProducts().find((item) => item.product === input.product)!;
  }

  getSetting(key: string): (EncryptedValue & { isSecret: boolean; updatedAt: string }) | undefined {
    const row = this.db.prepare("SELECT * FROM runtime_settings WHERE setting_key = ?").get(key) as
      | {
          value_ciphertext: string;
          value_iv: string;
          value_tag: string;
          is_secret: number;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      ciphertext: row.value_ciphertext,
      iv: row.value_iv,
      tag: row.value_tag,
      isSecret: Boolean(row.is_secret),
      updatedAt: row.updated_at,
    };
  }

  setSetting(key: string, value: EncryptedValue, isSecret: boolean, now = new Date().toISOString()): void {
    this.db.prepare(`
      INSERT INTO runtime_settings (
        setting_key, value_ciphertext, value_iv, value_tag, is_secret, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        value_ciphertext = excluded.value_ciphertext,
        value_iv = excluded.value_iv,
        value_tag = excluded.value_tag,
        is_secret = excluded.is_secret,
        updated_at = excluded.updated_at
    `).run(key, value.ciphertext, value.iv, value.tag, isSecret ? 1 : 0, now);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getOrder(orderId: string): OrderRecord | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId) as
      | OrderRecord
      | undefined;
  }

  getOrderByClientId(clientOrderId: string): OrderRecord | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE client_order_id = ?").get(clientOrderId) as
      | OrderRecord
      | undefined;
  }

  recordIdempotencyHit(
    clientOrderId: string,
    orderId: string,
    outcome: "replay" | "conflict",
    now = new Date().toISOString(),
  ): void {
    const replay = outcome === "replay" ? 1 : 0;
    const conflict = outcome === "conflict" ? 1 : 0;
    this.db.prepare(`
      INSERT INTO idempotency_audit (
        client_order_id, order_id, replay_count, conflict_count, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_order_id) DO UPDATE SET
        replay_count = replay_count + excluded.replay_count,
        conflict_count = conflict_count + excluded.conflict_count,
        last_seen_at = excluded.last_seen_at
    `).run(clientOrderId, orderId, replay, conflict, now, now);
  }

  getOperationsSnapshot(since: string, staleBefore: string): {
    orders: Record<string, number>;
    activations: Record<string, number>;
    webhooks: Record<string, number>;
    idempotency: Record<string, number>;
    refunds: Record<string, number>;
    alerts: Array<Record<string, unknown>>;
    recentWebhooks: Array<Record<string, unknown>>;
  } {
    const orders = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
        SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded,
        SUM(CASE WHEN status = 'paid' AND delivery_status = 'failed' THEN 1 ELSE 0 END) AS delivery_failed,
        SUM(CASE WHEN status = 'paid' AND delivery_status IS NULL THEN 1 ELSE 0 END) AS awaiting_delivery
      FROM orders WHERE created_at >= ?
    `).get(since) as Record<string, number>;
    const activations = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN finished = 0 THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN finished = 0 AND created_at < ? THEN 1 ELSE 0 END) AS stale,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM activations WHERE created_at >= ?
    `).get(staleBefore, since) as Record<string, number>;
    const webhooks = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN delivered_at IS NULL AND exhausted_at IS NULL THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN exhausted_at IS NOT NULL THEN 1 ELSE 0 END) AS exhausted,
        COALESCE(SUM(attempt_count), 0) AS retry_attempts
      FROM webhook_outbox WHERE created_at >= ?
    `).get(since) as Record<string, number>;
    const idempotency = this.db.prepare(`
      SELECT
        COALESCE(SUM(replay_count), 0) AS replays,
        COALESCE(SUM(conflict_count), 0) AS conflicts,
        COUNT(*) AS affected_keys
      FROM idempotency_audit WHERE last_seen_at >= ?
    `).get(since) as Record<string, number>;
    const refunds = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'requested' THEN 1 ELSE 0 END) AS requested,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM refunds WHERE created_at >= ?
    `).get(since) as Record<string, number>;
    const alerts = [
      ...(this.db.prepare(`
        SELECT 'delivery_failed' AS type, o.order_id AS ref, o.client_order_id AS title,
          CASE
            WHEN a.failure_code IS NOT NULL THEN
              COALESCE(NULLIF(a.message_zh, ''), '履约失败，请核查订单') || ' · ' || a.failure_code
            ELSE '已收款但履约失败，请查看订单审计记录'
          END AS message,
          o.updated_at AS occurred_at
        FROM orders o
        LEFT JOIN activations a ON a.id = (
          SELECT latest.id FROM activations latest
          WHERE latest.order_id = o.order_id
          ORDER BY latest.id DESC LIMIT 1
        )
        WHERE o.status = 'paid' AND o.delivery_status = 'failed'
        ORDER BY o.updated_at DESC LIMIT 10
      `).all() as Array<Record<string, unknown>>),
      ...(this.db.prepare(`
        SELECT 'activation_stale' AS type, order_id AS ref, task_id AS title,
          '开通任务长时间未结束，需要检查上游状态' AS message, updated_at AS occurred_at
        FROM activations WHERE finished = 0 AND created_at < ?
        ORDER BY updated_at DESC LIMIT 10
      `).all(staleBefore) as Array<Record<string, unknown>>),
      ...(this.db.prepare(`
        SELECT 'webhook_exhausted' AS type, event_key AS ref, event AS title,
          COALESCE(last_error, '平台回调重试已耗尽') AS message, updated_at AS occurred_at
        FROM (
          SELECT *, COALESCE(exhausted_at, next_attempt_at, created_at) AS updated_at
          FROM webhook_outbox
        ) WHERE exhausted_at IS NOT NULL
        ORDER BY updated_at DESC LIMIT 10
      `).all() as Array<Record<string, unknown>>),
      ...(this.db.prepare(`
        SELECT 'refund_attention' AS type, order_id AS ref, client_refund_id AS title,
          CASE WHEN status = 'requested' THEN '平台申请退款，等待人工核查订单与上游履约状态'
               WHEN status = 'failed' THEN COALESCE(failure_message, '支付宝退款失败')
               ELSE '退款长时间处理中，需要主动查询支付宝' END AS message,
          updated_at AS occurred_at
        FROM refunds
        WHERE status IN ('requested', 'failed') OR (status = 'processing' AND created_at < ?)
        ORDER BY updated_at DESC LIMIT 10
      `).all(staleBefore) as Array<Record<string, unknown>>),
    ].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, 20);
    const recentWebhooks = this.db.prepare(`
      SELECT event_key, event, attempt_count, next_attempt_at, delivered_at,
        exhausted_at, last_error, created_at
      FROM webhook_outbox ORDER BY id DESC LIMIT 20
    `).all() as Array<Record<string, unknown>>;
    return { orders, activations, webhooks, idempotency, refunds, alerts, recentWebhooks };
  }

  listDailyMetrics(fromDate: string, toDate: string): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`
      WITH RECURSIVE dates(day) AS (
        SELECT ?
        UNION ALL
        SELECT date(day, '+1 day') FROM dates WHERE day < ?
      ), daily AS (
        SELECT date(datetime(created_at, '+8 hours')) AS day,
          COUNT(*) AS order_count,
          SUM(CASE WHEN paid_at IS NOT NULL THEN 1 ELSE 0 END) AS paid_count,
          SUM(CASE WHEN delivery_status = 'success' THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END) AS failed_count
        FROM orders
        WHERE datetime(created_at) >= datetime(?, '-8 hours')
          AND datetime(created_at) < datetime(?, '+1 day', '-8 hours')
        GROUP BY date(datetime(created_at, '+8 hours'))
      )
      SELECT dates.day,
        COALESCE(daily.order_count, 0) AS order_count,
        COALESCE(daily.paid_count, 0) AS paid_count,
        COALESCE(daily.success_count, 0) AS success_count,
        COALESCE(daily.failed_count, 0) AS failed_count
      FROM dates LEFT JOIN daily ON daily.day = dates.day
      ORDER BY dates.day DESC
    `).all(fromDate, toDate, fromDate, toDate) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const success = Number(row.success_count ?? 0);
      const failed = Number(row.failed_count ?? 0);
      const completed = success + failed;
      return {
        ...row,
        success_rate: completed ? (success / completed * 100).toFixed(1) : "0.0",
        failure_rate: completed ? (failed / completed * 100).toFixed(1) : "0.0",
      };
    });
  }

  listAdminOrders(input: {
    from: string;
    to: string;
    search?: string;
    paymentStatus?: string;
    deliveryStatus?: string;
    paidOnly?: boolean;
    timeField?: "created_at" | "paid_at";
    page: number;
    pageSize: number;
  }): {
    items: Array<OrderRecord & Record<string, unknown>>;
    total: number;
    summary: { waiting: number; failed: number; success: number };
  } {
    const timeField = input.timeField === "paid_at" ? "o.paid_at" : "o.created_at";
    const baseConditions = [`${timeField} >= ?`, `${timeField} < ?`];
    const baseParams: Array<string | number> = [input.from, input.to];
    const search = String(input.search ?? "").trim().toLowerCase();
    if (search) {
      baseConditions.push("LOWER(o.client_order_id || ' ' || o.order_id || ' ' || o.product) LIKE ?");
      baseParams.push(`%${search}%`);
    }
    if (input.paidOnly) baseConditions.push("o.status = 'paid'");
    if (input.paymentStatus) {
      baseConditions.push("o.status = ?");
      baseParams.push(input.paymentStatus);
    }

    const itemConditions = [...baseConditions];
    const itemParams = [...baseParams];
    if (input.deliveryStatus === "pending") {
      itemConditions.push("COALESCE(o.delivery_status, '') = ''");
    } else if (input.deliveryStatus) {
      itemConditions.push("o.delivery_status = ?");
      itemParams.push(input.deliveryStatus);
    }
    const where = itemConditions.join(" AND ");
    const baseWhere = baseConditions.join(" AND ");
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM orders o WHERE ${where}`)
      .get(...itemParams) as { count: number }).count ?? 0);
    const summaryRow = this.db.prepare(`
      SELECT
        SUM(CASE WHEN COALESCE(o.delivery_status, '') = '' THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN o.delivery_status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN o.delivery_status = 'success' THEN 1 ELSE 0 END) AS success
      FROM orders o WHERE ${baseWhere}
    `).get(...baseParams) as Record<string, number | null>;
    const offset = (input.page - 1) * input.pageSize;
    const items = this.db.prepare(`
      SELECT o.*, s.settlement_id AS platform_settlement_id,
        s.status AS platform_settlement_status,
        s.paid_at AS platform_settled_at,
        s.payment_reference AS platform_payment_reference,
        cr.status AS cost_review_status, cr.total_cost_usd AS verified_cost_usd,
        cr.rebate_cny AS verified_rebate_cny, cr.standard_usd AS reviewed_standard_usd,
        cr.actual_usd AS reviewed_actual_usd, cr.fees_usd AS reviewed_fees_usd,
        cr.retained_usd AS reviewed_retained_usd, cr.fx_rate AS reviewed_fx_rate,
        pr.rebate_id AS platform_rebate_id, pr.rebate_usd AS platform_rebate_usd,
        pr.status AS platform_rebate_status,
        (SELECT MIN(first_activation.created_at) FROM activations first_activation
          WHERE first_activation.order_id = o.order_id) AS fulfillment_submitted_at,
        (SELECT MAX(finished_activation.updated_at) FROM activations finished_activation
          WHERE finished_activation.order_id = o.order_id AND finished_activation.finished = 1) AS fulfillment_completed_at,
        a.status AS latest_activation_status,
        a.failure_code AS latest_failure_code,
        a.message_zh AS latest_activation_message
      FROM orders o
      LEFT JOIN platform_settlement_lines sl ON sl.order_id = o.order_id
      LEFT JOIN platform_settlements s ON s.settlement_id = sl.settlement_id
      LEFT JOIN order_cost_reviews cr ON cr.order_id = o.order_id
      LEFT JOIN platform_rebates pr ON pr.order_id = o.order_id
      LEFT JOIN activations a ON a.id = (
        SELECT latest.id FROM activations latest
        WHERE latest.order_id = o.order_id
        ORDER BY latest.id DESC LIMIT 1
      )
      WHERE ${where}
      ORDER BY ${timeField} DESC, o.order_id DESC
      LIMIT ? OFFSET ?
    `).all(...itemParams, input.pageSize, offset) as unknown as Array<OrderRecord & Record<string, unknown>>;
    return {
      items,
      total,
      summary: {
        waiting: Number(summaryRow.waiting ?? 0),
        failed: Number(summaryRow.failed ?? 0),
        success: Number(summaryRow.success ?? 0),
      },
    };
  }

  listCustomers(input?: { search?: string; page?: number; pageSize?: number }): {
    items: Array<Record<string, unknown>>;
    total: number;
  } {
    const search = String(input?.search ?? "").trim().toLowerCase();
    const page = Math.max(1, Number(input?.page ?? 1));
    const pageSize = Math.max(1, Math.min(100, Number(input?.pageSize ?? 20)));
    const customerSummary = `
      WITH customer_orders AS (
        SELECT a.email_hash, MAX(a.account_email_masked) AS email_masked,
          o.order_id, o.status, o.delivery_status, o.alipay_receipt_amount,
          o.amount, o.paid_at, o.created_at
        FROM activations a
        JOIN orders o ON o.order_id = a.order_id
        WHERE a.email_hash IS NOT NULL
        GROUP BY a.email_hash, o.order_id
      ), customer_summary AS (
        SELECT
          email_hash AS customer_id,
          MAX(email_masked) AS email_masked,
          COUNT(*) AS order_count,
          SUM(CASE WHEN status = 'paid' THEN CAST(COALESCE(alipay_receipt_amount, amount) AS REAL) ELSE 0 END) AS paid_amount,
          SUM(CASE WHEN delivery_status = 'success' THEN 1 ELSE 0 END) AS fulfilled_count,
          SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
          MAX(COALESCE(paid_at, created_at)) AS last_order_at
        FROM customer_orders
        GROUP BY email_hash
      )
    `;
    const where = search ? "WHERE LOWER(COALESCE(email_masked, '') || ' ' || customer_id) LIKE ?" : "";
    const params = search ? [`%${search}%`] : [];
    const total = Number((this.db.prepare(`${customerSummary} SELECT COUNT(*) AS count FROM customer_summary ${where}`)
      .get(...params) as { count: number }).count ?? 0);
    const items = this.db.prepare(`${customerSummary}
      SELECT * FROM customer_summary ${where}
      ORDER BY last_order_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    return { items, total };
  }

  getCustomerDetail(customerId: string): {
    customer: Record<string, unknown>;
    orders: Array<Record<string, unknown>>;
  } | undefined {
    const customer = this.db.prepare(`
      WITH customer_orders AS (
        SELECT a.email_hash, MAX(a.account_email_masked) AS email_masked,
          o.order_id, o.status, o.delivery_status, o.alipay_receipt_amount,
          o.amount, o.paid_at, o.created_at
        FROM activations a
        JOIN orders o ON o.order_id = a.order_id
        WHERE a.email_hash = ?
        GROUP BY a.email_hash, o.order_id
      )
      SELECT
        email_hash AS customer_id,
        MAX(email_masked) AS email_masked,
        COUNT(*) AS order_count,
        SUM(CASE WHEN status = 'paid' THEN CAST(COALESCE(alipay_receipt_amount, amount) AS REAL) ELSE 0 END) AS paid_amount,
        SUM(CASE WHEN delivery_status = 'success' THEN 1 ELSE 0 END) AS fulfilled_count,
        SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        MIN(created_at) AS first_order_at,
        MAX(COALESCE(paid_at, created_at)) AS last_order_at
      FROM customer_orders
      GROUP BY email_hash
    `).get(customerId) as Record<string, unknown> | undefined;
    if (!customer) return undefined;

    const orders = this.db.prepare(`
      WITH customer_orders AS (
        SELECT a.order_id, MAX(a.account_email_masked) AS email_masked,
          MAX(a.status) AS activation_status, MAX(a.updated_at) AS activation_updated_at
        FROM activations a
        WHERE a.email_hash = ?
        GROUP BY a.order_id
      )
      SELECT o.order_id, o.client_order_id, o.product, o.status, o.delivery_status,
        o.amount, o.alipay_receipt_amount, o.created_at, o.paid_at,
        customer_orders.activation_status, customer_orders.activation_updated_at
      FROM customer_orders
      JOIN orders o ON o.order_id = customer_orders.order_id
      ORDER BY o.created_at DESC
      LIMIT 200
    `).all(customerId) as Array<Record<string, unknown>>;
    return { customer, orders };
  }

  getAdminOrderDetail(orderId: string): {
    order: OrderRecord & Record<string, unknown>;
    activations: ActivationRecord[];
    refund: RefundRecord | undefined;
    platformRebate: Record<string, unknown> | undefined;
    audit: Array<Record<string, unknown>>;
  } | undefined {
    const order = this.db.prepare(`
      SELECT o.*, sl.settlement_id AS platform_settlement_id,
        s.status AS platform_settlement_status,
        i.invoice_id, i.status AS invoice_status
      FROM orders o
      LEFT JOIN platform_settlement_lines sl ON sl.order_id = o.order_id
      LEFT JOIN platform_settlements s ON s.settlement_id = sl.settlement_id
      LEFT JOIN invoices i ON i.order_id = o.order_id
      WHERE o.order_id = ?
      LIMIT 1
    `).get(orderId) as unknown as (OrderRecord & Record<string, unknown>) | undefined;
    if (!order) return undefined;
    const audit = this.db.prepare(`
      SELECT action, from_status, to_status, reason, operator, created_at
      FROM order_audit_log WHERE order_id = ? ORDER BY id DESC
    `).all(orderId) as Array<Record<string, unknown>>;
    return {
      order,
      activations: this.listActivations(orderId),
      refund: this.getRefundByOrderId(orderId),
      platformRebate: this.getPlatformRebate(orderId),
      audit,
    };
  }

  recordOrderAudit(input: {
    orderId: string;
    action: string;
    fromStatus: string | null;
    toStatus: string | null;
    reason: string;
    operator?: string;
    now?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO order_audit_log (
        order_id, action, from_status, to_status, reason, operator, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.orderId,
      input.action,
      input.fromStatus,
      input.toStatus,
      input.reason,
      input.operator ?? "admin",
      input.now ?? new Date().toISOString(),
    );
  }

  setDeliveryStatusByAdmin(orderId: string, next: "failed" | null, reason: string): OrderRecord {
    return this.transaction(() => {
      const current = this.getOrder(orderId);
      if (!current) throw new Error("order_not_found");
      if (this.hasActiveManualActivationTakeover(orderId)) throw new Error("manual_takeover_in_progress");
      if (current.status !== "paid") throw new Error("order_must_be_paid");
      if (current.delivery_status === "success") throw new Error("successful_delivery_is_immutable");
      if (next === null && current.delivery_status !== "failed") throw new Error("delivery_not_failed");
      if (this.db.prepare("SELECT 1 FROM activations WHERE order_id=? AND finished=0").get(orderId)) {
        throw new Error("activation_requires_review");
      }
      const now = new Date().toISOString();
      const from = current.delivery_status ?? "pending";
      this.db.prepare("UPDATE orders SET delivery_status = ?, updated_at = ? WHERE order_id = ?").run(next, now, orderId);
      this.recordOrderAudit({
        orderId,
        action: next === "failed" ? "mark_delivery_failed" : "restore_delivery_pending",
        fromStatus: `delivery:${from}`,
        toStatus: `delivery:${next ?? "pending"}`,
        reason,
        now,
      });
      return this.getOrder(orderId)!;
    });
  }

  confirmManualDelivery(input: { orderId: string; taskId: string; reason: string; accountEmailMasked: string; emailHash: string }): {
    order: OrderRecord;
    activation: ActivationRecord;
  } {
    return this.transaction(() => {
      const current = this.getOrder(input.orderId);
      if (!current) throw new Error("order_not_found");
      if (current.status !== "paid") throw new Error("order_must_be_paid");
      if (current.delivery_status === "success") throw new Error("successful_delivery_is_immutable");

      const activationState = this.db.prepare(`
        SELECT
          SUM(CASE WHEN finished = 0 THEN 1 ELSE 0 END) AS in_progress,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
          MAX(activation_id) AS latest_activation_id
        FROM activations WHERE order_id = ?
      `).get(input.orderId) as {
        in_progress: number | null;
        succeeded: number | null;
        latest_activation_id: number | null;
      };
      if (Number(activationState.in_progress ?? 0) > 0) throw new Error("activation_blocks_manual_delivery");
      if (Number(activationState.succeeded ?? 0) > 0) throw new Error("activation_already_succeeded");
      const takeover = this.getManualActivationTakeover(input.orderId);
      if (current.order_source !== "manual" && activationState.latest_activation_id !== null &&
          !["claimed", "review_required"].includes(takeover?.status ?? "")) throw new Error("manual_takeover_required");
      if (takeover && ["claimed", "review_required"].includes(takeover.status)) {
        if (!/^MT-[0-9]{8}-[0-9]{9}$/.test(input.reason)) {
          throw new Error("manual_takeover_ticket_required");
        }
        const source = this.db.prepare("SELECT email_hash FROM activations WHERE id = ? AND order_id = ?")
          .get(takeover.source_activation_id, input.orderId) as { email_hash: string | null } | undefined;
        if (!source?.email_hash || source.email_hash !== input.emailHash) {
          throw new Error("manual_takeover_account_mismatch");
        }
      }

      const refund = this.getRefundByOrderId(input.orderId);
      if (refund && ["requested", "processing", "succeeded"].includes(refund.status)) {
        throw new Error("refund_blocks_manual_delivery");
      }

      const now = new Date().toISOString();
      const activationId = Number(activationState.latest_activation_id ?? 0) + 1;
      if (!input.accountEmailMasked.includes("@") || !input.emailHash) throw new Error("manual_account_required");
      const result = this.db.prepare(`
        INSERT INTO activations (
          order_id, activation_id, task_id, status, finished, message_zh,
          worker_state, account_email_masked, email_hash, created_at, updated_at
        ) VALUES (?, ?, ?, 'success', 1, '开通成功', 'terminal', ?, ?, ?, ?)
      `).run(input.orderId, activationId, input.taskId, input.accountEmailMasked, input.emailHash, now, now);
      this.db.prepare(`
        UPDATE orders SET delivery_status = 'success', updated_at = ? WHERE order_id = ?
      `).run(now, input.orderId);
      if (takeover && ["claimed", "review_required"].includes(takeover.status)) {
        this.db.prepare("UPDATE manual_activation_takeovers SET status = 'completed', completed_at = ? WHERE id = ?")
          .run(now, takeover.id);
      }
      this.recordOrderAudit({
        orderId: input.orderId,
        action: "manual_delivery_confirmed",
        fromStatus: `delivery:${current.delivery_status ?? "pending"}`,
        toStatus: "delivery:success",
        reason: input.reason,
        now,
      });
      this.enqueueActivatedWebhook(input.orderId, now);
      return {
        order: this.getOrder(input.orderId)!,
        activation: this.db.prepare("SELECT * FROM activations WHERE id = ?").get(result.lastInsertRowid) as unknown as ActivationRecord,
      };
    });
  }

  getManualActivationTakeover(orderId: string): ManualActivationTakeover | undefined {
    return this.db.prepare("SELECT * FROM manual_activation_takeovers WHERE order_id = ? ORDER BY id DESC LIMIT 1")
      .get(orderId) as unknown as ManualActivationTakeover | undefined;
  }

  hasActiveManualActivationTakeover(orderId: string): boolean {
    return ["claimed", "review_required"].includes(this.getManualActivationTakeover(orderId)?.status ?? "");
  }

  /** Advisory for the admin UI; beginManualActivationTakeover repeats the guard inside BEGIN IMMEDIATE. */
  canBeginUnsubmittedManualTakeover(orderId: string): boolean {
    const order = this.getOrder(orderId);
    if (!order || order.order_source === "manual" || order.status !== "paid" || order.refunded_at ||
        order.delivery_status === "success" || this.getRefundByOrderId(orderId) ||
        this.hasActiveManualActivationTakeover(orderId)) return false;
    const attempts = this.listActivations(orderId);
    const source = attempts[attempts.length - 1];
    return !!source && attempts.slice(0, -1).every((item) => item.finished && item.status === "failed") &&
      this.isNeverClaimedActivation(source);
  }

  private isNeverClaimedActivation(source: ActivationRecord): boolean {
    if (source.finished || source.status !== "queued" || source.worker_state !== "queued" ||
        source.worker_locked_until !== null || source.cdk_id !== null ||
        source.redemption_token !== null || source.upstream_order_id !== null) return false;
    // The control table is created before the worker starts. If absent, historical claim state is unknown.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activation_worker_control'")
      .get()) return false;
    if (this.db.prepare("SELECT 1 FROM activation_worker_control WHERE activation_id = ?")
      .get(source.id)) return false;
    return !this.db.prepare("SELECT 1 FROM cdks WHERE assigned_activation_id = ? LIMIT 1")
      .get(source.id);
  }

  beginManualActivationTakeover(orderId: string, reason: string, expectedTaskId?: string): ManualActivationTakeover {
    return this.transaction(() => {
      if (!/^MT-[0-9]{8}-[0-9]{9}$/.test(reason)) throw new Error("manual_takeover_ticket_required");
      const order = this.getOrder(orderId);
      if (!order) throw new Error("order_not_found");
      if (order.order_source === "manual") throw new Error("manual_takeover_platform_only");
      if (order.status !== "paid" || order.refunded_at) throw new Error("order_must_be_paid");
      if (order.delivery_status === "success") throw new Error("activation_already_succeeded");
      if (this.getRefundByOrderId(orderId)) throw new Error("refund_blocks_manual_delivery");
      const previous = this.getManualActivationTakeover(orderId);
      if (previous?.status === "claimed") {
        if (expectedTaskId) {
          const claimedSource = this.db.prepare("SELECT task_id FROM activations WHERE id = ? AND order_id = ?")
            .get(previous.source_activation_id, orderId) as { task_id: string } | undefined;
          if (claimedSource?.task_id !== expectedTaskId) throw new Error("manual_takeover_task_mismatch");
        }
        return previous;
      }
      if (previous?.status === "review_required") throw new Error("manual_takeover_review_required");
      const attempts = this.listActivations(orderId);
      if (!attempts.length) throw new Error("manual_takeover_requires_failed_activation");
      const source = attempts[attempts.length - 1];
      if (expectedTaskId && source.task_id !== expectedTaskId) throw new Error("manual_takeover_task_mismatch");
      const previousAttemptsFailed = attempts.slice(0, -1).every((item) => item.finished && item.status === "failed");
      if (!previousAttemptsFailed) throw new Error("manual_takeover_requires_failed_activation");
      const now = new Date().toISOString();
      let fromStatus = "activation:failed";
      if (!(source.finished && source.status === "failed")) {
        if (!expectedTaskId || source.task_id !== expectedTaskId) throw new Error("manual_takeover_task_mismatch");
        // A queued task may be cancelled only if the worker has NEVER claimed it.
        // A control row is durable evidence of a previous claim, even after its lease expires.
        // Do not infer safety from a missing upstream order number or a stale worker lease.
        if (!this.isNeverClaimedActivation(source)) throw new Error("manual_takeover_pre_submit_not_proven");
        const cancelled = this.db.prepare(`UPDATE activations
          SET status = 'failed', finished = 1, failure_code = 'other',
          message_zh = '原自动任务未领取、未触达上游，已转人工接管',
          worker_state = 'terminal', worker_locked_until = NULL,
          session_ciphertext = NULL, session_iv = NULL, session_tag = NULL, updated_at = ?
          WHERE id = ? AND status = 'queued' AND worker_state = 'queued' AND finished = 0
            AND worker_locked_until IS NULL AND cdk_id IS NULL
            AND redemption_token IS NULL AND upstream_order_id IS NULL`)
          .run(now, source.id);
        if (cancelled.changes !== 1) throw new Error("manual_takeover_pre_submit_not_proven");
        this.db.prepare("UPDATE orders SET delivery_status = 'failed', updated_at = ? WHERE order_id = ?")
          .run(now, orderId);
        this.recordOrderAudit({
          orderId,
          action: "unsubmitted_activation_cancelled_for_manual_takeover",
          fromStatus: "activation:queued",
          toStatus: "activation:failed",
          reason: `任务 ${source.task_id} 从未被 worker 领取、未触达上游；工单 ${reason}`,
          now,
        });
        fromStatus = "activation:queued";
      }
      this.db.prepare(`INSERT INTO manual_activation_takeovers
        (order_id, source_activation_id, status, reason, claimed_at)
        VALUES (?, ?, 'claimed', ?, ?)`).run(orderId, source.id, reason, now);
      this.recordOrderAudit({
        orderId,
        action: "manual_activation_takeover_claimed",
        fromStatus,
        toStatus: "manual_takeover:claimed",
        reason,
        now,
      });
      return this.getManualActivationTakeover(orderId)!;
    });
  }

  reportManualActivationTakeoverIssue(orderId: string, reference: string): ManualActivationTakeover {
    return this.transaction(() => {
      if (!/^MT-[0-9]{8}-[0-9]{9}$/.test(reference)) throw new Error("manual_takeover_ticket_required");
      const takeover = this.getManualActivationTakeover(orderId);
      if (takeover?.status !== "claimed") throw new Error("manual_takeover_not_claimed");
      this.db.prepare("UPDATE manual_activation_takeovers SET status = 'review_required' WHERE id = ?")
        .run(takeover.id);
      this.recordOrderAudit({
        orderId,
        action: "manual_activation_takeover_review_required",
        fromStatus: "manual_takeover:claimed",
        toStatus: "manual_takeover:review_required",
        reason: `人工操作结果未确认；工单 ${reference}；持续禁止自动重提和退款`,
      });
      return this.getManualActivationTakeover(orderId)!;
    });
  }

  releaseManualActivationTakeover(input: {
    orderId: string;
    reference: string;
    outcome: "not_started" | "confirmed_not_activated";
  }): ManualActivationTakeover {
    return this.transaction(() => {
      if (!/^MT-[0-9]{8}-[0-9]{9}$/.test(input.reference)) throw new Error("manual_takeover_ticket_required");
      const takeover = this.getManualActivationTakeover(input.orderId);
      if (!takeover || !["claimed", "review_required"].includes(takeover.status)) {
        throw new Error("manual_takeover_not_active");
      }
      if (input.outcome === "not_started" && takeover.status !== "claimed") {
        throw new Error("manual_takeover_requires_confirmed_failure");
      }
      if (input.outcome === "confirmed_not_activated" && takeover.status !== "review_required") {
        throw new Error("manual_takeover_requires_review");
      }
      const order = this.getOrder(input.orderId);
      if (!order || order.status !== "paid" || order.refunded_at ||
          order.delivery_status === "success" || this.getRefundByOrderId(input.orderId)) {
        throw new Error("manual_takeover_release_blocked");
      }
      const attempts = this.listActivations(input.orderId);
      if (!attempts.length || attempts.some((item) => !item.finished || item.status !== "failed")) {
        throw new Error("manual_takeover_requires_failed_activation");
      }
      this.db.prepare("UPDATE manual_activation_takeovers SET status = 'released', completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), takeover.id);
      this.recordOrderAudit({
        orderId: input.orderId,
        action: "manual_activation_takeover_released",
        fromStatus: `manual_takeover:${takeover.status}`,
        toStatus: "manual_takeover:released",
        reason: input.outcome === "not_started"
          ? `人工操作明确尚未开始；原自动任务已失败或在未提交前安全终止；工单 ${input.reference}`
          : `人工开通经核实明确未发生；原自动任务已失败或在未提交前安全终止；工单 ${input.reference}`,
      });
      return this.getManualActivationTakeover(input.orderId)!;
    });
  }

  closeTestOrderWithoutRefund(orderId: string, reason: string): OrderRecord {
    const current = this.getOrder(orderId);
    if (!current) throw new Error("order_not_found");
    if (this.hasActiveManualActivationTakeover(orderId)) throw new Error("manual_takeover_in_progress");
    if (!current.client_order_id.startsWith("ADMINTEST-")) throw new Error("only_test_order_can_close");
    if (current.status === "closed") return current;
    if (current.status !== "paid") throw new Error("order_must_be_paid");
    const activation = this.db.prepare(`
      SELECT COUNT(*) AS count FROM activations
      WHERE order_id = ? AND (finished = 0 OR status = 'success')
    `).get(orderId) as { count: number };
    if (Number(activation.count) > 0) throw new Error("activation_blocks_close");
    const refund = this.getRefundByOrderId(orderId);
    if (refund && ["requested", "processing", "succeeded"].includes(refund.status)) {
      throw new Error("refund_blocks_close");
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE orders SET status = 'closed', delivery_status = 'closed', updated_at = ?
      WHERE order_id = ?
    `).run(now, orderId);
    this.recordOrderAudit({
      orderId,
      action: "close_test_order",
      fromStatus: `payment:${current.status}`,
      toStatus: "payment:closed",
      reason,
      now,
    });
    return this.getOrder(orderId)!;
  }

  listPaidTestOrders(): OrderRecord[] {
    return this.db
      .prepare(`
        SELECT * FROM orders
        WHERE client_order_id LIKE 'ADMINTEST-%' AND status = 'paid'
        ORDER BY created_at DESC
        LIMIT 50
      `)
      .all() as unknown as OrderRecord[];
  }

  createOrder(order: OrderRecord): OrderRecord {
    this.db
      .prepare(`
        INSERT INTO orders (
          order_id, client_order_id, product, plan, payment_country, payment_currency, quantity, sell_price, amount, status,
          qr, expires_at, alipay_trade_no, paid_at, refunded_at, delivery_status,
          platform_supply_price, platform_max_sell_price, upstream_estimated_cost_cny,
          upstream_actual_cost_amount, upstream_actual_cost_currency, upstream_actual_cost_cny,
          alipay_receipt_amount, order_source, manual_customer_ref, manual_note,
          payment_channel, manual_payment_reference,
          fulfillment_recipient_ciphertext, fulfillment_recipient_iv,
          fulfillment_recipient_tag, fulfillment_recipient_hash, fulfillment_recipient_masked,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        order.order_id,
        order.client_order_id,
        order.product,
        order.plan,
        order.payment_country ?? null,
        order.payment_currency ?? null,
        order.quantity,
        order.sell_price,
        order.amount,
        order.status,
        order.qr,
        order.expires_at,
        order.alipay_trade_no,
        order.paid_at,
        order.refunded_at,
        order.delivery_status,
        order.platform_supply_price,
        order.platform_max_sell_price,
        order.upstream_estimated_cost_cny,
        order.upstream_actual_cost_amount,
        order.upstream_actual_cost_currency,
        order.upstream_actual_cost_cny,
        order.alipay_receipt_amount,
        order.order_source ?? "platform",
        order.manual_customer_ref ?? null,
        order.manual_note ?? null,
        order.payment_channel ?? "alipay",
        order.manual_payment_reference ?? null,
        order.fulfillment_recipient_ciphertext ?? null,
        order.fulfillment_recipient_iv ?? null,
        order.fulfillment_recipient_tag ?? null,
        order.fulfillment_recipient_hash ?? null,
        order.fulfillment_recipient_masked ?? null,
        order.created_at,
        order.updated_at,
      );
    return order;
  }

  markOrderPaid(orderId: string, paidAt: string, tradeNo: string | null, receiptAmount?: string | null): OrderRecord {
    return this.transaction(() => {
      const current = this.getOrder(orderId);
      if (!current) throw new Error("order_not_found");
      if (current.status === "paid") return current;
      // These checks must stay inside BEGIN IMMEDIATE: a late callback or query
      // must not revive an order closed/refunded by another process meanwhile.
      // Preserve the original receipt, refund and reconciliation records for review.
      if (current.status === "closed") throw new Error("closed_order_cannot_be_paid");
      if (current.status === "refunded" || current.refunded_at) throw new Error("refunded_order_cannot_be_paid");
      if (this.getRefundByOrderId(orderId)) throw new Error("refund_exists_order_cannot_be_paid");
      const confirmedReceipt = receiptAmount ?? current.alipay_receipt_amount ?? current.amount;
      const amounts = calculateFinancialAmounts({
        customerPayment: current.amount,
        serviceReceipt: confirmedReceipt,
        supplyCost: current.platform_supply_price ?? "0.00",
        customerPriceRefund: current.customer_price_refund_amount ?? "0.00",
      });
      if (financialConsistencyErrors(amounts).includes("service_receipt_exceeds_customer_payment")) {
        throw new Error("payment_amount_inconsistent");
      }
      this.db
        .prepare(`
          UPDATE orders SET status = 'paid', paid_at = ?, alipay_trade_no = COALESCE(?, alipay_trade_no),
          alipay_receipt_amount = COALESCE(?, alipay_receipt_amount, amount),
          updated_at = ? WHERE order_id = ?
        `)
        .run(paidAt, tradeNo, confirmedReceipt, paidAt, orderId);
      const updated = this.getOrder(orderId)!;
      if (updated.order_source !== "manual") {
        this.enqueueWebhook(
          `${orderId}:order.paid`,
          "order.paid",
          { event: "order.paid", order_id: orderId, client_order_id: updated.client_order_id },
          paidAt,
        );
      }
      return updated;
    });
  }

  getRefundByOrderId(orderId: string): RefundRecord | undefined {
    return this.db.prepare("SELECT * FROM refunds WHERE order_id = ?").get(orderId) as
      | RefundRecord
      | undefined;
  }

  getRefundByClientId(clientRefundId: string): RefundRecord | undefined {
    return this.db.prepare("SELECT * FROM refunds WHERE client_refund_id = ?").get(clientRefundId) as
      | RefundRecord
      | undefined;
  }

  assertFullRefundAmount(orderId: string, refundAmount: string): OrderRecord {
    const order = this.getOrder(orderId);
    if (!order) throw new Error("order_not_found");
    try {
      const receipt = moneyToCents(order.alipay_receipt_amount ?? order.amount);
      if (receipt <= 0 || receipt > moneyToCents(order.amount) ||
          moneyToCents(refundAmount) !== receipt ||
          moneyToCents(order.customer_price_refund_amount ?? "0.00") !== 0) throw new Error("mismatch");
    } catch {
      throw new FinancialAmountError("financial_refund_amount_inconsistent",
        "订单实收、已登记补差与全额退款金额不一致，请人工核实；未新增退款操作");
    }
    return order;
  }

  createRefund(input: {
    refundId: string;
    orderId: string;
    clientRefundId: string;
    amount: string;
    reason: string;
    requestedBy: "platform" | "admin";
    now: string;
  }): RefundRecord {
    return this.transaction(() => {
      const order = this.getOrder(input.orderId);
      if (!order) throw new Error("order_not_found");
      if (order.status !== "paid") throw new Error("only_paid_order_can_be_refunded");
      if (order.delivery_status === "success") throw new Error("already_activated");
      if (this.hasActiveManualActivationTakeover(input.orderId)) throw new Error("manual_takeover_blocks_refund");
      const activationState = this.db.prepare(`
        SELECT
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
          SUM(CASE WHEN finished = 0 THEN 1 ELSE 0 END) AS in_progress
        FROM activations WHERE order_id = ?
      `).get(input.orderId) as { succeeded: number | null; in_progress: number | null };
      if (Number(activationState.succeeded ?? 0) > 0) throw new Error("already_activated");
      if (Number(activationState.in_progress ?? 0) > 0) throw new Error("activation_in_progress");
      this.assertFullRefundAmount(input.orderId, input.amount);
      this.db.prepare(`
        INSERT INTO refunds (
          refund_id, order_id, client_refund_id, amount, reason, status, requested_by,
          alipay_trade_no, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)
      `).run(
        input.refundId,
        input.orderId,
        input.clientRefundId,
        input.amount,
        input.reason,
        input.requestedBy,
        order.alipay_trade_no,
        input.now,
        input.now,
      );
      this.recordOrderAudit({
        orderId: input.orderId,
        action: "refund_requested",
        fromStatus: "payment:paid",
        toStatus: "refund:requested",
        reason: `${input.reason}；退款请求号：${input.clientRefundId}`,
        operator: input.requestedBy,
        now: input.now,
      });
      return this.getRefundByOrderId(input.orderId)!;
    });
  }

  approveRefund(input: { refundId: string; reason: string; now: string }): RefundRecord {
    return this.transaction(() => {
      const refund = this.db.prepare("SELECT * FROM refunds WHERE refund_id = ?").get(input.refundId) as
        | RefundRecord
        | undefined;
      if (!refund) throw new Error("refund_not_found");
      if (refund.status === "succeeded" || refund.status === "processing") return refund;
      if (refund.status === "rejected") throw new Error("rejected_refund_cannot_be_approved");
      const order = this.getOrder(refund.order_id);
      if (!order) throw new Error("order_not_found");
      if (order.status !== "paid") throw new Error("only_paid_order_can_be_refunded");
      if (order.delivery_status === "success") throw new Error("fulfilled_order_refund_requires_review");
      if (this.hasActiveManualActivationTakeover(refund.order_id)) throw new Error("manual_takeover_blocks_refund");
      const active = this.db.prepare(`
        SELECT COUNT(*) AS count FROM activations
        WHERE order_id = ? AND (finished = 0 OR status = 'success')
      `).get(refund.order_id) as { count: number };
      if (Number(active.count) > 0) throw new Error("activation_blocks_refund");
      this.assertFullRefundAmount(refund.order_id, refund.amount);
      const previousStatus = refund.status;
      this.db.prepare(`
        UPDATE refunds SET status = 'processing', failure_code = NULL, failure_message = NULL,
          updated_at = ? WHERE refund_id = ?
      `).run(input.now, refund.refund_id);
      this.recordOrderAudit({
        orderId: refund.order_id,
        action: "refund_approved",
        fromStatus: `refund:${previousStatus}`,
        toStatus: "refund:processing",
        reason: input.reason,
        operator: "admin",
        now: input.now,
      });
      return this.getRefundByOrderId(refund.order_id)!;
    });
  }

  rejectRefund(input: { refundId: string; reason: string; now: string }): RefundRecord {
    return this.transaction(() => {
      const refund = this.db.prepare("SELECT * FROM refunds WHERE refund_id = ?").get(input.refundId) as
        | RefundRecord
        | undefined;
      if (!refund) throw new Error("refund_not_found");
      if (refund.status !== "requested") throw new Error("only_requested_refund_can_be_rejected");
      this.db.prepare(`
        UPDATE refunds SET status = 'rejected', failure_code = 'rejected_by_admin',
          failure_message = ?, updated_at = ? WHERE refund_id = ?
      `).run(input.reason.slice(0, 500), input.now, refund.refund_id);
      this.recordOrderAudit({
        orderId: refund.order_id,
        action: "refund_rejected",
        fromStatus: "refund:requested",
        toStatus: "refund:rejected",
        reason: input.reason,
        operator: "admin",
        now: input.now,
      });
      return this.getRefundByOrderId(refund.order_id)!;
    });
  }

  recordRefundProviderResult(input: {
    refundId: string;
    status: "processing" | "failed";
    failureCode?: string | null;
    failureMessage?: string | null;
    now: string;
  }): RefundRecord {
    const result = this.db.prepare(`
      UPDATE refunds SET status = ?, failure_code = ?, failure_message = ?, updated_at = ?
      WHERE refund_id = ? AND status != 'succeeded'
    `).run(
      input.status,
      input.failureCode ?? null,
      input.failureMessage?.slice(0, 500) ?? null,
      input.now,
      input.refundId,
    );
    if (!result.changes) {
      const current = this.db.prepare("SELECT * FROM refunds WHERE refund_id = ?").get(input.refundId) as
        | RefundRecord
        | undefined;
      if (!current) throw new Error("refund_not_found");
      return current;
    }
    return this.db.prepare("SELECT * FROM refunds WHERE refund_id = ?").get(input.refundId) as unknown as RefundRecord;
  }

  completeRefund(input: {
    refundId: string;
    tradeNo: string | null;
    refundFee: string | null;
    refundedAt: string;
  }): RefundRecord {
    return this.transaction(() => this.completeRefundInTransaction(input));
  }

  recordVerifiedExternalRefundDuringTakeover(input: {
    refundId: string;
    orderId: string;
    clientRefundId: string;
    amount: string;
    reason: string;
    tradeNo: string | null;
    refundedAt: string;
  }): RefundRecord {
    return this.transaction(() => {
      const order = this.getOrder(input.orderId);
      if (!order || order.status !== "paid" || !order.paid_at) throw new Error("only_paid_order_can_be_refunded");
      if (!this.hasActiveManualActivationTakeover(input.orderId)) throw new Error("manual_takeover_not_active");
      if (this.getRefundByOrderId(input.orderId)) throw new Error("refund_already_exists");
      this.assertFullRefundAmount(input.orderId, input.amount);
      this.db.prepare(`INSERT INTO refunds
        (refund_id, order_id, client_refund_id, amount, reason, status, requested_by,
         alipay_trade_no, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'requested', 'admin', ?, ?, ?)`)
        .run(input.refundId, input.orderId, input.clientRefundId, input.amount, input.reason,
          order.alipay_trade_no, input.refundedAt, input.refundedAt);
      this.recordOrderAudit({
        orderId: input.orderId,
        action: "external_refund_verified_during_manual_takeover",
        fromStatus: "manual_takeover:claimed",
        toStatus: "refund:requested",
        reason: "支付宝主动查单确认已全额退款；停止人工开通，保留接管锁待复核",
        now: input.refundedAt,
      });
      const takeover = this.getManualActivationTakeover(input.orderId);
      if (takeover?.status === "claimed") {
        this.db.prepare("UPDATE manual_activation_takeovers SET status = 'review_required' WHERE id = ?")
          .run(takeover.id);
      }
      return this.completeRefundInTransaction({
        refundId: input.refundId,
        tradeNo: input.tradeNo,
        refundFee: input.amount,
        refundedAt: input.refundedAt,
      });
    });
  }

  private completeRefundInTransaction(input: {
    refundId: string;
    tradeNo: string | null;
    refundFee: string | null;
    refundedAt: string;
  }): RefundRecord {
      const refund = this.db.prepare("SELECT * FROM refunds WHERE refund_id = ?").get(input.refundId) as
        | RefundRecord
        | undefined;
      if (!refund) throw new Error("refund_not_found");
      if (refund.status === "succeeded") return refund;
      const order = this.getOrder(refund.order_id);
      if (!order) throw new Error("order_not_found");
      if (order.status !== "paid" && order.status !== "refunded") {
        throw new Error("only_paid_order_can_be_refunded");
      }
      this.assertFullRefundAmount(refund.order_id, refund.amount);
      try {
        if (input.refundFee === null || moneyToCents(input.refundFee) !== moneyToCents(refund.amount)) throw new Error("mismatch");
        if (input.tradeNo && order.alipay_trade_no && input.tradeNo !== order.alipay_trade_no) throw new Error("trade_mismatch");
      } catch {
        throw new FinancialAmountError("financial_refund_confirmation_mismatch",
          "退款回执金额缺失、不符或交易号不匹配，不能确认全额退款成功；请人工核实");
      }
      this.db.prepare(`
        UPDATE refunds SET status = 'succeeded', alipay_trade_no = COALESCE(?, alipay_trade_no),
        alipay_refund_fee = ?, failure_code = NULL, failure_message = NULL,
        refunded_at = ?, updated_at = ? WHERE refund_id = ?
      `).run(input.tradeNo, input.refundFee, input.refundedAt, input.refundedAt, input.refundId);
      this.db.prepare(`
        UPDATE orders SET status = 'refunded', refunded_at = ?, updated_at = ? WHERE order_id = ?
      `).run(input.refundedAt, input.refundedAt, refund.order_id);
      if (order.order_source !== "manual") {
        this.enqueueWebhook(
          `${refund.order_id}:order.refunded`,
          "order.refunded",
          {
            event: "order.refunded",
            order_id: refund.order_id,
            client_order_id: order.client_order_id,
          },
          input.refundedAt,
        );
      }
      this.recordOrderAudit({
        orderId: refund.order_id,
        action: "refund_succeeded",
        fromStatus: "refund:processing",
        toStatus: "payment:refunded",
        reason: `支付宝原路退款成功；退款请求号：${refund.client_refund_id}`,
        operator: "admin",
        now: input.refundedAt,
      });
      return this.getRefundByOrderId(refund.order_id)!;
  }

  markOrderRefunded(orderId: string, refundedAt: string): OrderRecord {
    return this.transaction(() => {
      const current = this.getOrder(orderId);
      if (!current) throw new Error("order_not_found");
      if (current.status === "refunded") return current;
      if (current.status !== "paid") throw new Error("only_paid_order_can_be_refunded");
      this.db
        .prepare("UPDATE orders SET status = 'refunded', refunded_at = ?, updated_at = ? WHERE order_id = ?")
        .run(refundedAt, refundedAt, orderId);
      const updated = this.getOrder(orderId)!;
      if (updated.order_source !== "manual") {
        this.enqueueWebhook(
          `${orderId}:order.refunded`,
          "order.refunded",
          { event: "order.refunded", order_id: orderId, client_order_id: updated.client_order_id },
          refundedAt,
        );
      }
      return updated;
    });
  }

  expirePendingOrders(now: string): number {
    const result = this.db
      .prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at < ?")
      .run(now, now);
    return Number(result.changes);
  }

  listActivations(orderId: string): ActivationRecord[] {
    return this.db
      .prepare("SELECT * FROM activations WHERE order_id = ? ORDER BY activation_id ASC")
      .all(orderId) as unknown as ActivationRecord[];
  }

  createActivation(input: {
    orderId: string;
    taskId: string;
    encryptedSession: EncryptedValue;
    emailMasked: string;
    emailHash: string;
    now: string;
  }): ActivationRecord {
    return this.transaction(() => {
      const existing = this.listActivations(input.orderId);
      const order = this.getOrder(input.orderId);
      if (!order) throw new Error("order_not_found");
      if (order.status !== "paid") throw new Error("order_not_paid");
      if (this.hasActiveManualActivationTakeover(input.orderId)) throw new Error("manual_takeover_in_progress");
      if (this.getRefundByOrderId(input.orderId)) throw new Error("refund_pending");
      if (existing.some((item) => !item.finished)) throw new Error("activation_in_progress");
      if (existing.some((item) => item.status === "success")) throw new Error("activation_quota_used");
      const activationId = existing.length ? Math.max(...existing.map((item) => item.activation_id)) + 1 : 1;
      const result = this.db
        .prepare(`
          INSERT INTO activations (
            order_id, activation_id, task_id, status, finished, account_email_masked, email_hash,
            session_ciphertext, session_iv, session_tag, worker_state, created_at, updated_at
          ) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, 'queued', ?, ?)
        `)
        .run(
          input.orderId,
          activationId,
          input.taskId,
          input.emailMasked,
          input.emailHash,
          input.encryptedSession.ciphertext,
          input.encryptedSession.iv,
          input.encryptedSession.tag,
          input.now,
          input.now,
        );
      return this.db.prepare("SELECT * FROM activations WHERE id = ?").get(result.lastInsertRowid) as unknown as ActivationRecord;
    });
  }

  claimProvisioning(now: string, lockedUntil: string): ActivationRecord | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(`
          SELECT * FROM activations
          WHERE finished = 0
            AND worker_state IN ('queued', 'provisioning')
            AND (worker_locked_until IS NULL OR worker_locked_until < ?)
          ORDER BY id ASC LIMIT 1
        `)
        .get(now) as ActivationRecord | undefined;
      if (!row) return undefined;
      this.db
        .prepare(`
          UPDATE activations SET worker_state = 'provisioning', worker_locked_until = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(lockedUntil, now, row.id);
      return this.db.prepare("SELECT * FROM activations WHERE id = ?").get(row.id) as unknown as ActivationRecord;
    });
  }

  setActivationPrepared(input: {
    id: number;
    cdkId: number;
    redemptionToken: string;
    upstreamOrderId: string | null;
    now: string;
  }): void {
    this.db
      .prepare(`
        UPDATE activations SET status = 'running', worker_state = 'polling', worker_locked_until = NULL,
        cdk_id = ?, redemption_token = ?, upstream_order_id = ?, message_zh = '正在开通', updated_at = ?
        WHERE id = ?
      `)
      .run(input.cdkId, input.redemptionToken, input.upstreamOrderId, input.now, input.id);
  }

  attachCdkToActivation(id: number, cdkId: number, now: string): void {
    this.db.prepare("UPDATE activations SET cdk_id = ?, updated_at = ? WHERE id = ?").run(cdkId, now, id);
  }

  setActivationUpstreamOrder(id: number, upstreamOrderId: string | null, now: string): void {
    this.db
      .prepare("UPDATE activations SET upstream_order_id = ?, updated_at = ? WHERE id = ?")
      .run(upstreamOrderId, now, id);
  }

  setXActivationSubmitted(id: number, merchantOrderNo: string, upstreamOrderId: string | null, now: string): void {
    this.db
      .prepare(`
        UPDATE activations SET status = 'running', worker_state = 'polling',
        worker_locked_until = NULL, redemption_token = ?, upstream_order_id = ?,
        message_zh = '蓝V订单已提交，正在赠送', updated_at = ?
        WHERE id = ? AND finished = 0
      `)
      .run(merchantOrderNo, upstreamOrderId, now, id);
  }

  clearProvisioningLock(id: number, now: string): void {
    this.db
      .prepare("UPDATE activations SET worker_state = 'queued', worker_locked_until = NULL, updated_at = ? WHERE id = ?")
      .run(now, id);
  }

  listPollingActivations(): ActivationRecord[] {
    return this.db
      .prepare("SELECT * FROM activations WHERE finished = 0 AND worker_state = 'polling' ORDER BY id ASC")
      .all() as unknown as ActivationRecord[];
  }

  markActivationSuccess(id: number, maskedAccount: string, now: string): void {
    const binding = this.db.prepare(`SELECT o.plan FROM activations a
      JOIN orders o ON o.order_id=a.order_id WHERE a.id=?`).get(id) as {plan: ProductPlan} | undefined;
    const validAccount = binding && isXGiftPlan(binding.plan)
      ? /^@[A-Za-z0-9_]{1,15}$/.test(maskedAccount)
      : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(maskedAccount);
    if (!validAccount) {
      throw new Error("activation_success_account_required");
    }
    const write = () => {
      const activation = this.db.prepare("SELECT order_id FROM activations WHERE id = ?")
        .get(id) as { order_id: string } | undefined;
      if (!activation) throw new Error("activation_not_found");
      this.db
        .prepare(`
          UPDATE activations SET status = 'success', finished = 1, worker_state = 'terminal',
          message_zh = '开通成功', account_email_masked = ?, session_ciphertext = NULL,
          session_iv = NULL, session_tag = NULL, worker_locked_until = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(maskedAccount, now, id);
      this.db.prepare("UPDATE orders SET delivery_status = 'success', updated_at = ? WHERE order_id = ?")
        .run(now, activation.order_id);
      this.enqueueActivatedWebhook(activation.order_id, now);
    };
    // Worker/review paths already own a transaction; direct calls still need the
    // success record and its notification to commit atomically.
    if (this.db.isTransaction) write();
    else this.transaction(write);
  }

  private enqueueActivatedWebhook(orderId: string, now: string): void {
    const order = this.getOrder(orderId);
    if (!order || order.order_source === "manual") return;
    this.enqueueWebhook(
      `${orderId}:order.activated`,
      "order.activated",
      { event: "order.activated", order_id: orderId, client_order_id: order.client_order_id },
      now,
    );
  }

  markActivationFailed(id: number, failureCode: FailureCode, message: string, now: string): void {
    this.db
      .prepare(`
        UPDATE activations SET status = 'failed', finished = 1, worker_state = 'terminal',
        failure_code = ?, message_zh = ?, session_ciphertext = NULL, session_iv = NULL,
        session_tag = NULL, worker_locked_until = NULL, updated_at = ? WHERE id = ?
      `)
      .run(failureCode, message, now, id);
    this.db.prepare("UPDATE orders SET delivery_status = 'failed', updated_at = ? WHERE order_id = (SELECT order_id FROM activations WHERE id = ?)").run(now, id);
  }

  reserveUnusedCdk(plan: ProductConfig["plan"], activationId: number, now: string,
    region?: PaymentRegion): CdkRecord | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(`SELECT * FROM cdks WHERE plan = ? AND status = 'unused'
          AND COALESCE(payment_country,'PH') = ? AND COALESCE(payment_currency,'PHP') = ?
          ORDER BY id ASC LIMIT 1`)
        .get(plan, region?.payment_country ?? "PH", region?.payment_currency ?? "PHP") as CdkRecord | undefined;
      if (!row) return undefined;
      this.db
        .prepare("UPDATE cdks SET status = 'reserved', assigned_activation_id = ?, updated_at = ? WHERE id = ?")
        .run(activationId, now, row.id);
      return this.db.prepare("SELECT * FROM cdks WHERE id = ?").get(row.id) as unknown as CdkRecord;
    });
  }

  insertReservedCdk(input: {
    upstreamCdkId: string;
    plan: ProductConfig["plan"];
    region?: PaymentRegion;
    redemptionDeviceId: string;
    encryptedCode: EncryptedValue;
    activationId: number;
    now: string;
  }): CdkRecord {
    const result = this.db
      .prepare(`
        INSERT INTO cdks (
          upstream_cdk_id, plan, payment_country, payment_currency, redemption_device_id, code_ciphertext, code_iv, code_tag, status,
          assigned_activation_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)
      `)
      .run(
        input.upstreamCdkId,
        input.plan,
        input.region?.payment_country ?? null,
        input.region?.payment_currency ?? null,
        input.redemptionDeviceId,
        input.encryptedCode.ciphertext,
        input.encryptedCode.iv,
        input.encryptedCode.tag,
        input.activationId,
        input.now,
        input.now,
      );
    return this.db.prepare("SELECT * FROM cdks WHERE id = ?").get(result.lastInsertRowid) as unknown as CdkRecord;
  }

  getCdk(id: number): CdkRecord | undefined {
    return this.db.prepare("SELECT * FROM cdks WHERE id = ?").get(id) as CdkRecord | undefined;
  }

  ensureCdkRedemptionDevice(id: number, fallbackDeviceId: string, now: string): string {
    this.db
      .prepare(`
        UPDATE cdks SET redemption_device_id = ?, updated_at = ?
        WHERE id = ? AND redemption_device_id IS NULL
      `)
      .run(fallbackDeviceId, now, id);
    const row = this.getCdk(id);
    if (!row?.redemption_device_id) throw new Error("cdk_device_missing");
    return row.redemption_device_id;
  }

  markCdkConsumed(id: number, now: string): void {
    this.db.prepare("UPDATE cdks SET status = 'consumed', updated_at = ? WHERE id = ?").run(now, id);
  }

  releaseCdk(id: number, now: string): void {
    this.db
      .prepare("UPDATE cdks SET status = 'unused', assigned_activation_id = NULL, updated_at = ? WHERE id = ?")
      .run(now, id);
  }

  enqueueWebhook(eventKey: string, event: string, payload: unknown, now: string): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO webhook_outbox (
          event_key, event, payload_json, attempt_count, next_attempt_at, created_at
        ) VALUES (?, ?, ?, 0, ?, ?)
      `)
      .run(eventKey, event, JSON.stringify(payload), now, now);
  }

  getDueWebhooks(now: string, limit = 10): Array<Record<string, unknown>> {
    return this.db
      .prepare(`
        SELECT * FROM webhook_outbox
        WHERE delivered_at IS NULL AND exhausted_at IS NULL AND next_attempt_at <= ?
        ORDER BY id ASC LIMIT ?
      `)
      .all(now, limit) as Array<Record<string, unknown>>;
  }

  markWebhookDelivered(id: number, now: string): void {
    this.db.prepare("UPDATE webhook_outbox SET delivered_at = ?, last_error = NULL WHERE id = ?").run(now, id);
  }

  markWebhookFailed(id: number, attemptCount: number, nextAttemptAt: string, error: string): void {
    this.db
      .prepare(`
        UPDATE webhook_outbox SET attempt_count = ?, next_attempt_at = ?, last_error = ? WHERE id = ?
      `)
      .run(attemptCount, nextAttemptAt, error.slice(0, 500), id);
  }

  markWebhookExhausted(id: number, attemptCount: number, now: string, error: string): void {
    this.db
      .prepare(`
        UPDATE webhook_outbox SET attempt_count = ?, exhausted_at = ?, last_error = ? WHERE id = ?
      `)
      .run(attemptCount, now, error.slice(0, 500), id);
  }

  listOrdersForReport(from: string, to: string): Array<OrderRecord & Record<string, unknown>> {
    return this.db
      .prepare(`
        SELECT o.*, s.settlement_id AS platform_settlement_id,
          s.status AS platform_settlement_status,
          s.paid_at AS platform_settled_at,
          s.payment_reference AS platform_payment_reference,
          s.cny_paid AS settlement_cny_paid, s.amount AS settlement_cny_total,
          COALESCE((SELECT SUM(CAST(REPLACE(prev.amount,'.','') AS INTEGER)) FROM platform_settlement_lines prev
            WHERE prev.settlement_id=sl.settlement_id AND prev.id<sl.id),0) AS settlement_prior_cny_cents,
          cr.status AS cost_review_status, cr.total_cost_usd AS verified_cost_usd,
          cr.rebate_cny AS verified_rebate_cny,
          cr.standard_usd AS reviewed_standard_usd, cr.actual_usd AS reviewed_actual_usd,
          cr.fees_usd AS reviewed_fees_usd, cr.retained_usd AS reviewed_retained_usd,
          cr.fx_rate AS reviewed_fx_rate,
          pr.rebate_id AS platform_rebate_id,
          pr.standard_usd AS platform_rebate_standard_usd,
          pr.actual_usd AS platform_rebate_actual_usd,
          pr.fee_usd AS platform_rebate_fee_usd,
          pr.rebate_usd AS platform_rebate_usd,
          pr.status AS platform_rebate_status,
          pr.settlement_id AS platform_rebate_settlement_id,
          pr.settled_at AS platform_rebate_settled_at,
          (SELECT MIN(first_activation.created_at) FROM activations first_activation
            WHERE first_activation.order_id = o.order_id) AS fulfillment_submitted_at,
          (SELECT MAX(finished_activation.updated_at) FROM activations finished_activation
            WHERE finished_activation.order_id = o.order_id AND finished_activation.finished = 1) AS fulfillment_completed_at,
          a.status AS latest_activation_status,
          a.failure_code AS latest_failure_code,
          a.message_zh AS latest_activation_message
        FROM orders o
        LEFT JOIN platform_settlement_lines sl ON sl.order_id = o.order_id
        LEFT JOIN platform_settlements s ON s.settlement_id = sl.settlement_id
        LEFT JOIN platform_rebates pr ON pr.order_id = o.order_id
        LEFT JOIN order_cost_reviews cr ON cr.order_id = o.order_id
        LEFT JOIN activations a ON a.id = (
          SELECT latest.id FROM activations latest
          WHERE latest.order_id = o.order_id
          ORDER BY latest.id DESC LIMIT 1
        )
        WHERE o.created_at >= ? AND o.created_at < ?
        ORDER BY o.created_at ASC
      `)
      .all(from, to) as unknown as Array<OrderRecord & Record<string, unknown>>;
  }

  createPlatformSettlement(input: {
    settlementId: string;
    from: string;
    to: string;
    generationMode?: "manual" | "scheduled";
    businessDate?: string | null;
    allowEmpty?: boolean;
  }): {
    settlement: Record<string, unknown>;
    lines: Array<Record<string, unknown>>;
    rebates: Array<Record<string, unknown>>;
  } {
    return this.transaction(() => {
    if (input.businessDate) {
      const existing = this.db.prepare("SELECT settlement_id FROM platform_settlements WHERE business_date = ?")
        .get(input.businessDate) as { settlement_id: string } | undefined;
      if (existing) return this.getPlatformSettlement(existing.settlement_id)!;
    }
    const candidates = this.db.prepare(`
      SELECT o.* FROM orders o
      LEFT JOIN platform_settlement_lines sl ON sl.order_id = o.order_id
      WHERE ${input.generationMode === "scheduled" ? "o.updated_at < ?" : "o.created_at >= ? AND o.created_at < ?"}
        AND o.status = 'paid' AND o.delivery_status = 'success' AND o.refunded_at IS NULL
        AND COALESCE(o.order_source, 'platform') <> 'manual'
        ${input.generationMode === "scheduled" ? "AND o.client_order_id NOT LIKE 'ADMINTEST-%'" : ""}
        AND sl.order_id IS NULL
      ORDER BY o.created_at ASC
    `).all(...(input.generationMode === "scheduled" ? [input.to] : [input.from, input.to])) as unknown as OrderRecord[];
    const lines = candidates.map((order) => {
      const receipt = order.alipay_receipt_amount ?? order.amount;
      const supply = order.platform_supply_price ?? "0.00";
      const customerRefund = order.customer_price_refund_amount ?? "0.00";
      const amounts = calculateFinancialAmounts({
        customerPayment: order.amount,
        serviceReceipt: receipt,
        supplyCost: supply,
        customerPriceRefund: customerRefund,
      });
      if (financialConsistencyErrors(amounts).length) throw new Error("financial_amount_inconsistent");
      return {
        order_id: order.order_id,
        amount: amounts.platformProfit,
        cents: amounts.platformProfitCents,
        customerPayment: order.amount,
        receipt,
        supply,
        customerRefund,
      };
    }).filter((line) => line.cents > 0);
    const rebates = this.db.prepare(`
      SELECT r.* FROM platform_rebates r JOIN orders o ON o.order_id = r.order_id
      WHERE r.status = 'pending' AND r.settlement_id IS NULL
        AND EXISTS (SELECT 1 FROM order_cost_reviews c WHERE c.order_id=r.order_id AND c.status='confirmed')
        AND ${input.generationMode === "scheduled" ? "r.created_at < ?" : "r.created_at >= ? AND r.created_at < ?"}
        AND o.status = 'paid' AND o.delivery_status = 'success' AND o.refunded_at IS NULL
        ${input.generationMode === "scheduled" ? "AND o.client_order_id NOT LIKE 'ADMINTEST-%'" : ""}
      ORDER BY r.created_at ASC
    `).all(...(input.generationMode === "scheduled" ? [input.to] : [input.from, input.to])) as Array<Record<string, unknown>>;
    if (!lines.length && !rebates.length && !input.allowEmpty) throw new Error("no_platform_payable");
    const amount = centsToMoney(lines.reduce((sum, line) => sum + line.cents, 0));
    const rebateUsd = centsToMoney(
      rebates.reduce((sum, rebate) => sum + moneyToCents(String(rebate.rebate_usd)), 0),
    );
    const orderCount = new Set([
      ...lines.map((line) => line.order_id),
      ...rebates.map((rebate) => String(rebate.order_id)),
    ]).size;
    const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO platform_settlements (
          settlement_id, period_from, period_to, amount, rebate_usd, order_count, status,
          generation_mode, business_date, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        input.settlementId,
        input.from,
        input.to,
        amount,
        rebateUsd,
        orderCount,
        input.generationMode ?? "manual",
        input.businessDate ?? null,
        now,
        now,
      );
      const insertLine = this.db.prepare(`
        INSERT INTO platform_settlement_lines (
          settlement_id, order_id, amount, created_at,
          customer_payment_amount, receipt_amount, supply_price, customer_refund_amount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const line of lines) insertLine.run(input.settlementId, line.order_id, line.amount, now,
        line.customerPayment, line.receipt, line.supply, line.customerRefund);
      const includeRebate = this.db.prepare(`
        UPDATE platform_rebates SET status = 'included', settlement_id = ?, updated_at = ?
        WHERE rebate_id = ? AND status = 'pending' AND settlement_id IS NULL
      `);
      for (const rebate of rebates) includeRebate.run(input.settlementId, now, String(rebate.rebate_id));
    return this.getPlatformSettlement(input.settlementId)!;
    });
  }

  getPlatformSettlement(settlementId: string): {
    settlement: Record<string, unknown>;
    lines: Array<Record<string, unknown>>;
    rebates: Array<Record<string, unknown>>;
  } | undefined {
    const settlement = this.db.prepare("SELECT * FROM platform_settlements WHERE settlement_id = ?")
      .get(settlementId) as Record<string, unknown> | undefined;
    if (!settlement) return undefined;
    const lines = this.db.prepare(`
      SELECT sl.order_id, sl.amount, o.client_order_id, o.product, o.created_at, o.paid_at,
        COALESCE(sl.customer_payment_amount, o.amount) AS customer_payment_amount,
        COALESCE(sl.receipt_amount, o.alipay_receipt_amount, o.amount) AS receipt_amount,
        COALESCE(sl.supply_price, o.platform_supply_price, '0.00') AS supply_price,
        COALESCE(sl.customer_refund_amount, o.customer_price_refund_amount, '0.00') AS customer_refund_amount
      FROM platform_settlement_lines sl
      JOIN orders o ON o.order_id = sl.order_id
      WHERE sl.settlement_id = ? ORDER BY sl.id ASC
    `).all(settlementId) as Array<Record<string, unknown>>;
    const rebates = this.db.prepare(`
      SELECT r.*, o.client_order_id, o.product
      FROM platform_rebates r
      JOIN orders o ON o.order_id = r.order_id
      WHERE r.settlement_id = ? ORDER BY r.created_at ASC
    `).all(settlementId) as Array<Record<string, unknown>>;
    return { settlement, lines, rebates };
  }

  listPlatformSettlements(limit = 100): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT * FROM platform_settlements ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
  }

  listPlatformSettlementsPage(input: { page: number; pageSize: number; status?: string; q?: string; from?: string; to?: string }): {
    items: Array<Record<string, unknown>>;
    total: number;
    summary: { count: number; amount: string; cny_paid: string; rebate_usd: string; usd_paid: string };
  } {
    const status = ["pending", "partial", "paid"].includes(input.status ?? "") ? input.status! : "";
    const query = `%${(input.q ?? "").trim().replace(/[\\%_]/g, "\\$&")}%`;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(input.from ?? "") ? input.from! : "";
    const to = /^\d{4}-\d{2}-\d{2}$/.test(input.to ?? "") ? input.to! : "";
    const day = "COALESCE(business_date,substr(datetime(created_at,'+8 hours'),1,10))";
    const effectiveStatus = `CASE
      WHEN CAST(ROUND(CAST(amount AS REAL)*100) AS INTEGER) <= CAST(ROUND(CAST(cny_paid AS REAL)*100) AS INTEGER)
       AND CAST(ROUND(CAST(rebate_usd AS REAL)*100) AS INTEGER) <= CAST(ROUND(CAST(usd_paid AS REAL)*100) AS INTEGER) THEN 'paid'
      WHEN CAST(ROUND(CAST(cny_paid AS REAL)*100) AS INTEGER) > 0
        OR CAST(ROUND(CAST(usd_paid AS REAL)*100) AS INTEGER) > 0 THEN 'partial'
      ELSE 'pending' END`;
    const where = `(? = '' OR ${effectiveStatus} = ?) AND (settlement_id LIKE ? ESCAPE '\\' OR ${day} LIKE ? ESCAPE '\\')
      AND (? = '' OR ${day} >= ?) AND (? = '' OR ${day} <= ?)`;
    const params = [status, status, query, query, from, from, to, to];
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM platform_settlements WHERE ${where}`)
      .get(...params) as { total: number };
    const totals = this.db.prepare(`SELECT COUNT(*) count,
      COALESCE(SUM(CAST(ROUND(CAST(amount AS REAL)*100) AS INTEGER)),0) amount_cents,
      COALESCE(SUM(CAST(ROUND(CAST(cny_paid AS REAL)*100) AS INTEGER)),0) cny_paid_cents,
      COALESCE(SUM(CAST(ROUND(CAST(rebate_usd AS REAL)*100) AS INTEGER)),0) rebate_cents,
      COALESCE(SUM(CAST(ROUND(CAST(usd_paid AS REAL)*100) AS INTEGER)),0) usd_paid_cents
      FROM platform_settlements WHERE ${where}`).get(...params) as Record<string, number>;
    const items = this.db.prepare(`SELECT *, ${effectiveStatus} AS status FROM platform_settlements WHERE ${where}
      ORDER BY period_to DESC, created_at DESC, settlement_id DESC LIMIT ? OFFSET ?`)
      .all(...params, input.pageSize, (input.page - 1) * input.pageSize) as Array<Record<string, unknown>>;
    return { items, total: Number(total.total), summary: { count:Number(totals.count),
      amount:centsToMoney(Number(totals.amount_cents)),cny_paid:centsToMoney(Number(totals.cny_paid_cents)),
      rebate_usd:centsToMoney(Number(totals.rebate_cents)),usd_paid:centsToMoney(Number(totals.usd_paid_cents)) } };
  }

  getPlatformRebateSummary(): {
    pending: string;
    included: string;
    paid: string;
    payable: string;
  } {
    const rows = this.db.prepare(`
      SELECT status, rebate_usd FROM platform_rebates
    `).all() as Array<{ status: string; rebate_usd: string }>;
    const totals = { pending: 0, included: 0, paid: 0 };
    for (const row of rows) {
      if (row.status === "pending" || row.status === "included" || row.status === "paid") {
        totals[row.status] += moneyToCents(row.rebate_usd);
      }
    }
    const partial = (this.db.prepare("SELECT usd_paid FROM platform_settlements WHERE status<>'paid'")
      .all() as Array<{usd_paid:string}>).reduce((sum,r)=>sum+moneyToCents(r.usd_paid),0);
    // USD-complete statements may still await CNY; their rebate rows are already paid.
    const paidPartial = (this.db.prepare("SELECT usd_paid FROM platform_settlements WHERE status<>'paid' AND usd_paid<>rebate_usd")
      .all() as Array<{usd_paid:string}>).reduce((sum,r)=>sum+moneyToCents(r.usd_paid),0);
    return {pending:centsToMoney(totals.pending), included:centsToMoney(totals.included-paidPartial),
      paid:centsToMoney(totals.paid+paidPartial), payable:centsToMoney(totals.pending+totals.included-paidPartial)};
  }

  getPlatformSettlementByBusinessDate(businessDate: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM platform_settlements WHERE business_date = ?")
      .get(businessDate) as Record<string, unknown> | undefined;
  }

  getLatestPlatformSettlementBusinessDate(): string | undefined {
    const row = this.db.prepare(`
      SELECT business_date FROM platform_settlements
      WHERE business_date IS NOT NULL
      ORDER BY business_date DESC LIMIT 1
    `).get() as { business_date: string } | undefined;
    return row?.business_date;
  }

  recordPlatformSettlementPayment(input: {
    settlementId: string; method: string; reference: string; note: string; paidAt: string;
    paymentId?: string; currency?: "CNY" | "USD"; amount?: string;
  }): Record<string, unknown> {
    const current = this.getPlatformSettlement(input.settlementId)?.settlement;
    if (!current) throw new Error("settlement_not_found");
    // Legacy CNY-only callers remain safe. A mixed statement always requires explicit currency and amount.
    if ((!input.currency || !input.amount) && current.rebate_usd !== "0.00") {
      throw new LedgerError("含美元退差的结算单必须分别选择币种和实际结算金额");
    }
    return new FinancialLedger(this).payment({
      ...input, paymentId: input.paymentId ?? "legacy:" + input.settlementId + ":" + input.reference,
      currency: input.currency ?? "CNY", amount: input.amount ?? String(current.amount),
    });
  }

  getPlatformRebate(orderId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM platform_rebates WHERE order_id = ?").get(orderId) as
      | Record<string, unknown>
      | undefined;
  }

  recordPlatformRebate(input: {
    rebateId: string;
    orderId: string;
    standardUsd: string;
    actualUsd: string;
    feeUsd: string;
    cardTransactionId: string | null;
    reason: string;
  }): Record<string, unknown> {
    if (!this.getPlatformRebate(input.orderId)) throw new LedgerError("请从真实成本核查入口确认，确认后自动生成退差");
    return this.transaction(() => {
    const order = this.getOrder(input.orderId);
    if (!order) throw new Error("order_not_found");
    if (order.order_source === "manual") throw new Error("platform_order_required");
    if (order.status !== "paid" || order.delivery_status !== "success" || order.refunded_at) {
      throw new Error("successful_paid_order_required");
    }
    const existing = this.getPlatformRebate(input.orderId);
    if (existing) {
      if (
        existing.standard_usd === input.standardUsd &&
        existing.actual_usd === input.actualUsd &&
        existing.fee_usd === input.feeUsd &&
        existing.card_transaction_id === input.cardTransactionId
      ) return existing;
      throw new Error("platform_rebate_already_recorded");
    }
    if (input.cardTransactionId) {
      const used = this.db.prepare("SELECT order_id FROM platform_rebates WHERE card_transaction_id = ?")
        .get(input.cardTransactionId) as { order_id: string } | undefined;
      if (used && used.order_id !== input.orderId) throw new Error("card_transaction_already_used");
    }
    const rebateCents = moneyToCents(input.standardUsd) - moneyToCents(input.actualUsd) - moneyToCents(input.feeUsd);
    if (rebateCents <= 0) throw new Error("no_platform_rebate_due");
    const activation = this.db.prepare(`
      SELECT upstream_order_id FROM activations
      WHERE order_id = ? AND status = 'success'
      ORDER BY id DESC LIMIT 1
    `).get(input.orderId) as { upstream_order_id: string | null } | undefined;
    if (!activation?.upstream_order_id) throw new Error("upstream_order_required");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO platform_rebates (
        rebate_id, order_id, upstream_order_id, card_transaction_id,
        standard_usd, actual_usd, fee_usd, rebate_usd, status, reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      input.rebateId,
      input.orderId,
      activation.upstream_order_id,
      input.cardTransactionId,
      input.standardUsd,
      input.actualUsd,
      input.feeUsd,
      centsToMoney(rebateCents),
      input.reason,
      now,
      now,
    );
    this.recordOrderAudit({
      orderId: input.orderId,
      action: "platform_rebate_recorded",
      fromStatus: null,
      toStatus: `platform_rebate:${centsToMoney(rebateCents)}USD`,
      reason: `${input.reason}；标准 ${input.standardUsd}U，实际 ${input.actualUsd}U，手续费 ${input.feeUsd}U`,
      now,
    });
    return this.getPlatformRebate(input.orderId)!;
    });
  }

  findOrderForInvoice(orderNumber: string): Record<string, unknown> | undefined {
    return this.db.prepare(`
      SELECT o.order_id, o.client_order_id, o.product, o.status, o.delivery_status,
        o.amount, o.alipay_receipt_amount, o.customer_price_refund_amount,
        o.alipay_trade_no, o.paid_at, o.refunded_at,
        o.created_at, i.invoice_id, i.status AS invoice_status
      FROM orders o
      LEFT JOIN invoices i ON i.order_id = o.order_id
      WHERE o.order_id = ? OR o.client_order_id = ?
      LIMIT 1
    `).get(orderNumber, orderNumber) as Record<string, unknown> | undefined;
  }

  invoiceableAmount(orderId: string): string {
    const order = this.getOrder(orderId);
    if (!order || order.status !== "paid" || order.refunded_at) {
      throw new FinancialAmountError("financial_invoice_order_invalid", "订单未付款或已退款，不能登记开票");
    }
    if (this.db.prepare("SELECT 1 FROM refunds WHERE order_id=? AND status IN ('requested','processing','succeeded')").get(orderId)) {
      throw new FinancialAmountError("financial_invoice_refund_pending", "订单正在退款核查或已经退款，暂不能登记开票");
    }
    try {
      const amounts = calculateFinancialAmounts({
        customerPayment:order.amount, serviceReceipt:order.alipay_receipt_amount ?? order.amount,
        supplyCost:order.platform_supply_price ?? "0.00", customerPriceRefund:order.customer_price_refund_amount ?? "0.00",
      });
      if (financialConsistencyErrors(amounts).length || amounts.invoiceableAmountCents <= 0) throw new Error("mismatch");
      return amounts.invoiceableAmount;
    } catch {
      throw new FinancialAmountError("financial_invoice_amount_inconsistent",
        "实收、补差或可开票金额不一致，或可开票金额为零，请先人工核查");
    }
  }

  createInvoice(input: {
    invoiceId: string;
    orderId: string;
    titleType: string;
    title: string;
    taxId: string | null;
    unitAddress: string;
    phone: string;
    bankName: string;
    bankAccount: string;
    recipientEmail: string;
    amount: string;
    requestNote: string;
  }): Record<string, unknown> {
    return this.transaction(() => {
    const expected = this.invoiceableAmount(input.orderId);
    if (input.amount !== expected) throw new FinancialAmountError("financial_invoice_amount_inconsistent", "开票金额与当前可开票金额不一致，请刷新后核查");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO invoices (
        invoice_id, order_id, title_type, title, tax_id, unit_address, phone,
        bank_name, bank_account, recipient_email, amount,
        status, request_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)
    `).run(
      input.invoiceId,
      input.orderId,
      input.titleType,
      input.title,
      input.taxId,
      input.unitAddress,
      input.phone,
      input.bankName,
      input.bankAccount,
      input.recipientEmail,
      input.amount,
      input.requestNote,
      now,
      now,
    );
    return this.db.prepare("SELECT * FROM invoices WHERE invoice_id = ?").get(input.invoiceId) as Record<string, unknown>;
    });
  }

  listInvoices(input?: {
    from?: string;
    to?: string;
    status?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }): { items: Array<Record<string, unknown>>; total: number } {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (input?.from) { conditions.push("i.created_at >= ?"); params.push(input.from); }
    if (input?.to) { conditions.push("i.created_at < ?"); params.push(input.to); }
    if (input?.status) { conditions.push("i.status = ?"); params.push(input.status); }
    const search = String(input?.search ?? "").trim().toLowerCase();
    if (search) {
      conditions.push("LOWER(i.invoice_id || ' ' || i.order_id || ' ' || o.client_order_id || ' ' || i.title) LIKE ?");
      params.push(`%${search}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const page = Math.max(1, Number(input?.page ?? 1));
    const pageSize = Math.max(1, Math.min(100, Number(input?.pageSize ?? 20)));
    const total = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM invoices i
      JOIN orders o ON o.order_id = i.order_id ${where}
    `).get(...params) as { count: number }).count ?? 0);
    const items = this.db.prepare(`
      SELECT i.*, o.client_order_id, o.product, o.alipay_trade_no, o.paid_at
      FROM invoices i
      JOIN orders o ON o.order_id = i.order_id
      ${where}
      ORDER BY i.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    return { items, total };
  }

  markInvoiceIssued(input: {
    invoiceId: string;
    invoiceNumber: string;
    invoiceDate: string;
    invoiceUrl: string | null;
    issueNote: string;
  }): Record<string, unknown> {
    return this.transaction(() => {
    const current = this.db.prepare("SELECT * FROM invoices WHERE invoice_id = ?").get(input.invoiceId) as Record<string, unknown> | undefined;
    if (!current) throw new Error("invoice_not_found");
    if (current.status === "issued") return current;
    if (current.status !== "requested") throw new Error("invoice_not_requested");
    if (String(current.amount) !== this.invoiceableAmount(String(current.order_id))) {
      throw new FinancialAmountError("financial_invoice_amount_inconsistent", "当前订单可开票金额已变化，请人工复核，未登记开票完成");
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE invoices SET status = 'issued', invoice_number = ?, invoice_date = ?,
        invoice_url = ?, issue_note = ?, issued_at = ?, updated_at = ?
      WHERE invoice_id = ? AND status = 'requested'
    `).run(input.invoiceNumber, input.invoiceDate, input.invoiceUrl, input.issueNote, now, now, input.invoiceId);
    return this.db.prepare("SELECT * FROM invoices WHERE invoice_id = ?").get(input.invoiceId) as Record<string, unknown>;
    });
  }

  setOrderUpstreamCost(input: {
    orderId: string;
    amount: string | null;
    currency: string | null;
    cny: string | null;
  }): OrderRecord {
    try {
      if (input.amount !== null) {
        moneyToCents(input.amount);
        if (!input.currency || !/^[A-Z]{3}$/.test(input.currency)) throw new Error("currency");
      }
      if (input.cny !== null) moneyToCents(input.cny);
      if (input.currency === "CNY" && input.amount !== null && input.cny !== null &&
          moneyToCents(input.amount) !== moneyToCents(input.cny)) throw new Error("cny_mismatch");
    } catch {
      throw new FinancialAmountError("financial_cost_amount_inconsistent", "成本金额或币种不合法；人民币原币与人民币成本必须一致");
    }
    if (this.db.prepare("SELECT 1 FROM order_cost_reviews WHERE order_id=?").get(input.orderId)) {
      throw new LedgerError("订单已进入真实成本核查，不能从旧入口覆盖");
    }
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE orders SET upstream_actual_cost_amount = ?, upstream_actual_cost_currency = ?,
      upstream_actual_cost_cny = ?, updated_at = ? WHERE order_id = ?
    `).run(input.amount, input.currency, input.cny, now, input.orderId);
    if (!result.changes) throw new Error("order_not_found");
    return this.getOrder(input.orderId)!;
  }

  recordCustomerPriceRefund(input: {
    orderId: string;
    amount: string;
    reference: string;
    reason: string;
    refundedAt: string;
  }): OrderRecord {
    if (this.db.prepare("SELECT 1 FROM order_cost_reviews WHERE order_id=?").get(input.orderId) ||
        this.getPlatformRebate(input.orderId)) throw new LedgerError("已进入平台退差流程，禁止再登记客户补差造成重复支付");
    const current = this.db.prepare(`
      SELECT o.*, sl.settlement_id, i.invoice_id
      FROM orders o
      LEFT JOIN platform_settlement_lines sl ON sl.order_id = o.order_id
      LEFT JOIN invoices i ON i.order_id = o.order_id
      WHERE o.order_id = ?
      LIMIT 1
    `).get(input.orderId) as unknown as (OrderRecord & { settlement_id?: string; invoice_id?: string }) | undefined;
    if (!current) throw new Error("order_not_found");
    if (current.order_source === "manual") throw new Error("platform_order_required");
    if (current.status !== "paid" || current.delivery_status !== "success" || current.refunded_at) {
      throw new Error("successful_paid_order_required");
    }
    if (current.settlement_id) throw new Error("settlement_already_created");
    if (current.invoice_id) throw new Error("invoice_already_created");
    const receipt = current.alipay_receipt_amount ?? current.amount;
    const supply = current.platform_supply_price ?? "0.00";
    const amount = moneyToCents(input.amount);
    if (amount <= 0) throw new Error("price_refund_must_be_positive");
    const previous = current.customer_price_refund_amount ?? "0.00";
    if (moneyToCents(previous) > 0) {
      if (previous === input.amount && current.customer_price_refund_reference === input.reference) return current;
      throw new Error("price_refund_already_recorded");
    }
    const amounts = calculateFinancialAmounts({
      customerPayment: current.amount,
      serviceReceipt: receipt,
      supplyCost: supply,
      customerPriceRefund: input.amount,
    });
    const consistencyErrors = financialConsistencyErrors(amounts);
    if (consistencyErrors.includes("service_receipt_exceeds_customer_payment")) {
      throw new Error("financial_amount_inconsistent");
    }
    if (
      consistencyErrors.includes("customer_price_refund_exceeds_receipt") ||
      consistencyErrors.includes("customer_price_refund_exceeds_platform_margin")
    ) {
      throw new Error("price_refund_exceeds_platform_margin");
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE orders SET customer_price_refund_amount = ?,
          customer_price_refund_reference = ?, customer_price_refund_reason = ?,
          customer_price_refunded_at = ?, updated_at = ?
        WHERE order_id = ?
      `).run(input.amount, input.reference, input.reason, input.refundedAt, now, input.orderId);
      this.recordOrderAudit({
        orderId: input.orderId,
        action: "customer_price_refund_recorded",
        fromStatus: `price_refund:${previous}`,
        toStatus: `price_refund:${input.amount}`,
        reason: `${input.reason}；退款凭证：${input.reference}`,
        now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getOrder(input.orderId)!;
  }

  markOrderManual(input: { orderId: string; customerRef: string; note: string }): OrderRecord {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE orders SET order_source = 'manual', manual_customer_ref = ?, manual_note = ?, updated_at = ?
      WHERE order_id = ?
    `).run(input.customerRef, input.note, now, input.orderId);
    if (!result.changes) throw new Error("order_not_found");
    this.recordOrderAudit({
      orderId: input.orderId,
      action: "manual_order_created",
      fromStatus: null,
      toStatus: "payment:pending",
      reason: input.note ? `人工补录：${input.note}` : "人工补录订单",
      operator: "admin",
      now,
    });
    return this.getOrder(input.orderId)!;
  }
}
