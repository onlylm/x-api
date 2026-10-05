import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database.js";
import { calculateFinancialAmounts, centsToMoney, isXGiftPlan, moneyToCents, sumMoney } from "../domain.js";
import { calculateCostReconciliation, COST_VARIANCE_TOLERANCE_USD_CENTS, usdToCny as convertUsdToCny } from "./cost-reconciliation.js";

type Row = Record<string, any>;
export class LedgerError extends Error {}
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LedgerError(message);
}
const now = () => new Date().toISOString();
export const CURRENT_STANDARD_COST_USD = {
  plus: "15.76",
  pro_5x: "92.98",
  pro_20x: "143.12",
  // Upstream pricing registry version 263: PHP 29,008.93, converted with the
  // same pricing snapshot ratio used by the existing GPT plan baselines.
  pro_50x: "465.47",
} as const;
const AUTO_REVIEW_ACTION = "cost_auto_review_required";

function derivedReviewStatusSql(): string {
  return `CASE
    WHEN c.status IS NOT NULL THEN c.status
    WHEN EXISTS (SELECT 1 FROM platform_settlement_lines settled WHERE settled.order_id=o.order_id)
      OR EXISTS (SELECT 1 FROM platform_rebates legacy_rebate WHERE legacy_rebate.order_id=o.order_id)
      THEN 'historical'
    WHEN EXISTS (SELECT 1 FROM order_audit_log review_audit
      WHERE review_audit.order_id=o.order_id AND review_audit.action='${AUTO_REVIEW_ACTION}')
      THEN 'review_required'
    ELSE 'missing' END`;
}
export function usdToCny(usd: string, rate: string): string {
  try { return convertUsdToCny(usd, rate); }
  catch (error) { throw new LedgerError(error instanceof Error ? error.message : "汇率无效"); }
}

/** Only additive local schema. No network or payment operations. */
export function migrateFinancialLedger(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_transactions (
      transaction_id TEXT PRIMARY KEY, card_id TEXT NOT NULL, amount_usd TEXT NOT NULL,
      status TEXT NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL,
      merchant TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_cost_reviews (
      order_id TEXT PRIMARY KEY REFERENCES orders(order_id), revision INTEGER NOT NULL,
      status TEXT NOT NULL, plan TEXT NOT NULL, upstream_order_id TEXT NOT NULL,
      standard_usd TEXT NOT NULL, actual_usd TEXT NOT NULL, retained_usd TEXT NOT NULL,
      fees_usd TEXT NOT NULL DEFAULT '0.00', total_cost_usd TEXT,
      fx_rate TEXT, rebate_cny TEXT, standard_reference TEXT NOT NULL,
      evidence TEXT NOT NULL, source TEXT NOT NULL, transaction_ids TEXT NOT NULL,
      fees_checked INTEGER NOT NULL, rebate_usd TEXT NOT NULL,
      confirmed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cost_transaction_links (
      transaction_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(order_id)
    );
    CREATE TABLE IF NOT EXISTS cost_fees (
      fee_id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      amount_usd TEXT NOT NULL, order_id TEXT REFERENCES orders(order_id),
      evidence TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settlement_payments (
      payment_id TEXT PRIMARY KEY, settlement_id TEXT NOT NULL REFERENCES platform_settlements(settlement_id),
      currency TEXT NOT NULL CHECK(currency IN ('CNY','USD')), amount TEXT NOT NULL,
      method TEXT NOT NULL, reference TEXT NOT NULL, note TEXT NOT NULL, paid_at TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(method, reference, currency)
    );
    CREATE INDEX IF NOT EXISTS idx_cost_reviews_status ON order_cost_reviews(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_cost_fee_order ON cost_fees(order_id);
  `);
  const columns = new Set((db.prepare("PRAGMA table_info(platform_settlements)").all() as Row[]).map(r => r.name));
  if (!columns.has("cny_paid")) {
    db.exec("ALTER TABLE platform_settlements ADD COLUMN cny_paid TEXT NOT NULL DEFAULT '0.00'");
    db.exec("ALTER TABLE platform_settlements ADD COLUMN usd_paid TEXT NOT NULL DEFAULT '0.00'");
    // Preserve historical paid statements; never invent a second payment record.
    db.exec("UPDATE platform_settlements SET cny_paid = amount, usd_paid = rebate_usd WHERE status = 'paid'");
  }
}

export interface CostDraft {
  revision: number; plan: string; standard_usd: string; actual_usd: string;
  retained_usd: string; fx_rate?: string | null; standard_reference: string; evidence: string;
  source: "manual" | "card_api"; transaction_ids: string[]; fees_checked: boolean;
}
export interface SettlementPayment {
  settlementId: string; paymentId: string; currency: "CNY" | "USD"; amount: string;
  method: string; reference: string; note: string; paidAt: string;
}
export interface ExternalRebatePayment {
  orderNumber: string; paymentId: string; method: string; reference: string; note: string; paidAt: string;
  appliedUsd: string; paymentCurrency: "CNY" | "USD"; paymentAmount: string;
  fxRate?: string | null; fundingAmount?: string | null;
}

export class FinancialLedger {
  constructor(private readonly db: AppDatabase) {}
  private order(id: string): Row {
    const o = this.db.getOrder(id);
    requireThat(o, "订单不存在");
    requireThat(!isXGiftPlan(o.plan), "蓝V成本须独立核实，不能套用 ChatGPT 美元基准或卡台流水；人民币供货结算不受影响");
    requireThat(o.order_source !== "manual" && !o.client_order_id.startsWith("ADMINTEST-"), "仅支持真实平台供货订单");
    requireThat(o.status === "paid" && o.delivery_status === "success" && !o.refunded_at, "订单须已支付、履约成功且未退款");
    requireThat(!this.db.db.prepare("SELECT 1 FROM refunds WHERE order_id = ? AND status IN ('requested','processing','succeeded')").get(id),
      "订单存在退款申请或退款记录，须先人工核对");
    requireThat(moneyToCents(o.customer_price_refund_amount || "0.00") === 0, "存在历史客户补差，须人工核清；禁止重复退差");
    return o;
  }
  get(id: string): Row | undefined {
    return this.db.db.prepare("SELECT * FROM order_cost_reviews WHERE order_id = ?").get(id) as Row | undefined;
  }
  private reconcile(o: Row, r: CostDraft | Row, fees: string) {
    const amounts = calculateFinancialAmounts({customerPayment:o.amount,
      serviceReceipt:o.alipay_receipt_amount ?? o.amount, supplyCost:o.platform_supply_price ?? "0.00",
      customerPriceRefund:o.customer_price_refund_amount ?? "0.00"});
    return calculateCostReconciliation({supplyCny:amounts.supplyCost,standardCostCny:o.upstream_estimated_cost_cny ?? "0.00",platformBaseProfitCny:amounts.platformProfit,
      standardUsd:r.standard_usd,actualUsd:r.actual_usd,retainedUsd:r.retained_usd,feesUsd:fees,fxRate:r.fx_rate});
  }
  detail(id: string): Row {
    const o = this.db.getOrder(id);
    requireThat(o, "订单不存在");
    const a = this.db.db.prepare("SELECT upstream_order_id FROM activations WHERE order_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1").get(id) as Row | undefined;
    const review = this.get(id) ?? null;
    const reviewState = this.db.db.prepare(`SELECT ${derivedReviewStatusSql()} status,
      (SELECT reason FROM order_audit_log WHERE order_id=o.order_id AND action=?
       ORDER BY id DESC LIMIT 1) auto_review_reason
      FROM orders o LEFT JOIN order_cost_reviews c ON c.order_id=o.order_id WHERE o.order_id=?`)
      .get(AUTO_REVIEW_ACTION,id) as Row | undefined;
    const fees = this.db.db.prepare("SELECT * FROM cost_fees WHERE order_id = ?").all(id) as Row[];
    const reconciliation = review && ["draft","confirmed"].includes(review.status) &&
      o.status === "paid" && o.delivery_status === "success" && !o.refunded_at
      ? this.reconcile(o,review,review.status === "confirmed" ? review.fees_usd : sumMoney(fees.map(f=>f.amount_usd))) : null;
    return { order_id: id, client_order_id: o.client_order_id, plan: o.plan, supply_cny: o.platform_supply_price,
      upstream_order_id: a?.upstream_order_id ?? null, review, reconciliation, fees,
      review_state: reviewState?.status ?? "missing", auto_review_reason: reviewState?.auto_review_reason ?? null,
      rebate: this.db.getPlatformRebate(id) ?? null };
  }
  list(q: string, page: number, status: string): Row {
    const search = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    const reviewStatus = derivedReviewStatusSql();
    const where = `o.status = 'paid' AND o.delivery_status = 'success' AND COALESCE(o.order_source,'platform') <> 'manual'
      AND o.client_order_id NOT LIKE 'ADMINTEST-%'
      AND (o.order_id LIKE ? ESCAPE '\\' OR o.client_order_id LIKE ? ESCAPE '\\')
      AND (? = '' OR ${reviewStatus} = ?)`;
    const args = [search, search, status, status];
    const total = this.db.db.prepare(`SELECT COUNT(*) n FROM orders o LEFT JOIN order_cost_reviews c ON c.order_id=o.order_id WHERE ${where}`).get(...args) as Row;
    const rows = this.db.db.prepare(`SELECT o.order_id,o.client_order_id,o.plan,o.platform_supply_price,
      o.upstream_estimated_cost_cny,o.upstream_actual_cost_cny,o.amount,o.alipay_receipt_amount,o.customer_price_refund_amount,
      ${reviewStatus} status,c.revision,c.standard_usd,c.actual_usd,c.retained_usd,c.fees_usd,c.total_cost_usd,c.rebate_usd,c.fx_rate,c.updated_at
      FROM orders o LEFT JOIN order_cost_reviews c ON c.order_id=o.order_id WHERE ${where}
      ORDER BY o.created_at DESC, o.order_id LIMIT 20 OFFSET ?`).all(...args, (page-1)*20) as Row[];
    const items=rows.map(row=>{
      const reconciliation=row.status==="confirmed" && moneyToCents(row.upstream_estimated_cost_cny??"0.00")>0
        ? this.reconcile(row,row,row.fees_usd??"0.00") : null;
      return {...row,gross_profit_cny:reconciliation?.gross_profit_cny??null};
    });
    return { items, total: total.n, page, page_size:20,
      unallocated_fees: this.db.db.prepare("SELECT COUNT(*) count, COALESCE(SUM(CAST(ROUND(CAST(amount_usd AS REAL)*100) AS INTEGER)),0) cents FROM cost_fees WHERE order_id IS NULL").get() };
  }
  automaticCandidates(limit = 20): Row[] {
    requireThat(Number.isInteger(limit) && limit > 0 && limit <= 50, "自动核对批次大小无效");
    return this.db.db.prepare(`SELECT o.order_id,o.client_order_id,o.plan,a.task_id,a.upstream_order_id,a.updated_at AS activation_updated_at
      FROM orders o JOIN activations a ON a.id=(
        SELECT latest.id FROM activations latest
        WHERE latest.order_id=o.order_id AND latest.status='success' AND latest.upstream_order_id IS NOT NULL
        ORDER BY latest.id DESC LIMIT 1)
      WHERE o.status='paid' AND o.delivery_status='success' AND o.refunded_at IS NULL
        AND o.plan NOT IN ('x_premium_3m','x_premium_6m')
        AND COALESCE(o.order_source,'platform')<>'manual' AND o.client_order_id NOT LIKE 'ADMINTEST-%'
        AND COALESCE(o.customer_price_refund_amount,'0.00')='0.00'
        AND NOT EXISTS(SELECT 1 FROM refunds r WHERE r.order_id=o.order_id)
        AND NOT EXISTS(SELECT 1 FROM order_cost_reviews c WHERE c.order_id=o.order_id)
        AND NOT EXISTS(SELECT 1 FROM platform_settlement_lines s WHERE s.order_id=o.order_id)
        AND NOT EXISTS(SELECT 1 FROM platform_rebates p WHERE p.order_id=o.order_id)
        AND NOT EXISTS(SELECT 1 FROM order_audit_log l WHERE l.order_id=o.order_id AND l.action=?
          AND l.reason<>?)
      ORDER BY o.created_at DESC,o.order_id LIMIT ?`).all(AUTO_REVIEW_ACTION,
        "同一卡片在完成时间附近存在多笔扣款，无法唯一关联",limit) as Row[];
  }
  automaticIgnorableVarianceDrafts(limit = 20): Row[] {
    requireThat(Number.isInteger(limit) && limit > 0 && limit <= 50, "自动核对批次大小无效");
    return this.db.db.prepare(`SELECT order_id,revision,standard_usd,actual_usd
      FROM order_cost_reviews
      WHERE status='draft' AND source='card_api' AND fees_checked=1
        AND plan NOT IN ('x_premium_3m','x_premium_6m')
        AND ABS(
          CAST(ROUND(CAST(standard_usd AS REAL)*100) AS INTEGER) -
          CAST(ROUND(CAST(actual_usd AS REAL)*100) AS INTEGER)
        ) < ?
      ORDER BY updated_at,order_id LIMIT ?`).all(COST_VARIANCE_TOLERANCE_USD_CENTS,limit) as Row[];
  }
  markAutomaticReviewRequired(id: string, reason: string): void {
    const o=this.db.getOrder(id);
    requireThat(o,"订单不存在");
    const previous=this.db.db.prepare(`SELECT reason FROM order_audit_log
      WHERE order_id=? AND action=? ORDER BY id DESC LIMIT 1`).get(id,AUTO_REVIEW_ACTION) as Row|undefined;
    if(previous?.reason===reason)return;
    this.db.recordOrderAudit({orderId:id,action:AUTO_REVIEW_ACTION,fromStatus:"missing",
      toStatus:"review_required",operator:"system",reason});
  }
  save(id: string, input: CostDraft): Row {
    return this.db.transaction(() => {
      const o = this.order(id), existing = this.get(id);
      requireThat(!existing || existing.status === "draft", "已确认的成本不能覆盖；异常请登记争议后人工处理");
      requireThat((existing?.revision ?? 0) === input.revision, "资料已变化，请刷新后重试");
      requireThat(input.plan === o.plan, "套餐不匹配；不可根据扣款金额猜测套餐");
      requireThat(!this.db.getPlatformRebate(id), "已有旧版退差记录，须先人工核清，不能重复生成");
      const a = this.db.db.prepare("SELECT upstream_order_id FROM activations WHERE order_id=? AND status='success' ORDER BY id DESC LIMIT 1").get(id) as Row | undefined;
      requireThat(a?.upstream_order_id, "缺少可核查的充值订单号");
      const standard = moneyToCents(input.standard_usd), actual = moneyToCents(input.actual_usd);
      requireThat(standard > 0 && actual > 0, "标准价格与实际扣款须大于 0；零元验证不计成本");
      requireThat(new Set(input.transaction_ids).size === input.transaction_ids.length && input.transaction_ids.length > 0,
        "须填写唯一的扣款交易号；多笔以逗号分隔");
      if (input.fx_rate) usdToCny("1.00", input.fx_rate);
      if (input.source === "card_api") this.verifyTransactions(input.transaction_ids, actual);
      const rebate = this.reconcile(o,input,"0.00").rebate_usd;
      const time = now();
      this.db.db.prepare(`INSERT INTO order_cost_reviews
        (order_id,revision,status,plan,upstream_order_id,standard_usd,actual_usd,retained_usd,fx_rate,
        standard_reference,evidence,source,transaction_ids,fees_checked,rebate_usd,created_at,updated_at)
        VALUES (?,?, 'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(order_id) DO UPDATE SET revision=excluded.revision,standard_usd=excluded.standard_usd,
        actual_usd=excluded.actual_usd,retained_usd=excluded.retained_usd,fx_rate=excluded.fx_rate,
        standard_reference=excluded.standard_reference,evidence=excluded.evidence,source=excluded.source,
        transaction_ids=excluded.transaction_ids,fees_checked=excluded.fees_checked,rebate_usd=excluded.rebate_usd,
        upstream_order_id=excluded.upstream_order_id,updated_at=excluded.updated_at`)
        .run(id,input.revision+1,o.plan,a.upstream_order_id,input.standard_usd,input.actual_usd,input.retained_usd,
          input.fx_rate || null,input.standard_reference,input.evidence,input.source,JSON.stringify(input.transaction_ids),
          input.fees_checked ? 1:0,rebate,time,time);
      this.db.recordOrderAudit({orderId:id,action:"cost_review_draft",fromStatus:existing?.status??null,toStatus:"draft",
        reason:input.evidence});
      return this.get(id)!;
    });
  }
  private verifyTransactions(ids: string[], expected: number): void {
    let sum = 0;
    for (const id of ids) {
      const t = this.db.db.prepare("SELECT * FROM cost_transactions WHERE transaction_id=?").get(id) as Row | undefined;
      requireThat(t && t.status === "COMPLETE" && ["Authorization","Settlement"].includes(t.type), "交易未最终清算或类型不支持；请先核对扣款");
      requireThat(moneyToCents(t.amount_usd)>0,"零元交易不计入充值成本");
      sum += moneyToCents(t.amount_usd);
    }
    requireThat(sum===expected,"实际金额与所选交易的美元清算金额不一致");
  }
  confirm(id: string, revision: number): Row {
    return this.db.transaction(() => {
      const o = this.order(id), r = this.get(id);
      requireThat(r && r.revision===revision, "资料已变化，请重新核查");
      if (r.status === "confirmed") return r;
      requireThat(r.status==="draft" && r.fees_checked===1,"须先核实开卡费、充值手续费；未核清不能确认");
      requireThat(!this.db.getPlatformRebate(id),"已存在退差记录，不能重复确认");
      const ids: string[] = JSON.parse(r.transaction_ids);
      if (r.source === "card_api") this.verifyTransactions(ids,moneyToCents(r.actual_usd));
      for (const tid of ids) {
        requireThat(!this.db.db.prepare("SELECT 1 FROM cost_transaction_links WHERE transaction_id=?").get(tid),
          "扣款交易已被其他订单使用");
        requireThat(!this.db.db.prepare("SELECT 1 FROM platform_rebates WHERE card_transaction_id=?").get(tid),
          "扣款交易已有旧版退差记录");
        this.db.db.prepare("INSERT INTO cost_transaction_links VALUES (?,?)").run(tid,id);
      }
      const fees = sumMoney((this.db.db.prepare("SELECT amount_usd FROM cost_fees WHERE order_id=?").all(id) as Row[])
        .map(f=>f.amount_usd));
      const split = this.reconcile(o,r,fees);
      requireThat(split.rebate_usd === r.rebate_usd,"退差金额与成本不一致，请重新核查");
      const cost = split.total_cost_usd, time = now();
      const cny = split.actual_cost_cny, rebateCny = split.rebate_equivalent_cny;
      this.db.db.prepare(`UPDATE order_cost_reviews SET status='confirmed',fees_usd=?,total_cost_usd=?,
        rebate_cny=?,confirmed_at=?,updated_at=? WHERE order_id=?`).run(fees,cost,rebateCny,time,time,id);
      this.db.db.prepare(`UPDATE orders SET upstream_actual_cost_amount=?,upstream_actual_cost_currency='USD',
        upstream_actual_cost_cny=?,updated_at=? WHERE order_id=?`).run(cost,cny,time,id);
      if (moneyToCents(r.rebate_usd)>0) this.db.db.prepare(`INSERT INTO platform_rebates
        (rebate_id,order_id,upstream_order_id,card_transaction_id,standard_usd,actual_usd,fee_usd,rebate_usd,status,reason,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)`)
        .run("PR"+randomUUID(),id,r.upstream_order_id,ids[0],r.standard_usd,r.actual_usd,r.retained_usd,r.rebate_usd,
          "已核实真实成本；退给平台，由平台处理客户；"+r.evidence,time,time);
      this.db.recordOrderAudit({orderId:id,action:"cost_confirmed",fromStatus:"draft",toStatus:"confirmed",
        reason:`实际扣款 ${r.actual_usd} USD；实际费用 ${fees} USD；应返平台 ${r.rebate_usd} USD（另加平台基础利润）；原供货价 ${o.platform_supply_price} CNY 不变；净结算收入 ${split.supplier_net_income_cny ?? "待核算"} CNY；${r.evidence}`});
      return this.get(id)!;
    });
  }
  dispute(id: string, reason: string): void {
    this.db.transaction(() => {
      const r = this.get(id);
      requireThat(r?.status==="confirmed","只能对已确认成本发起核查");
      this.db.db.prepare("UPDATE order_cost_reviews SET status='disputed',updated_at=? WHERE order_id=?").run(now(),id);
      this.db.recordOrderAudit({orderId:id,action:"cost_disputed",fromStatus:"confirmed",toStatus:"disputed",reason});
    });
  }
  addFee(input: {reference:string;kind:string;amount_usd:string;order_id?:string|null;evidence:string}): Row {
    return this.db.transaction(() => {
      requireThat(moneyToCents(input.amount_usd)>0,"费用须大于 0；充值本金不能重复作为手续费");
      const orderId = input.order_id || null;
      if (orderId) {
        this.order(orderId);
        requireThat(!this.get(orderId) || this.get(orderId)?.status==="draft","已确认订单不得追加费用，请先发起人工核查");
      }
      const old = this.db.db.prepare("SELECT * FROM cost_fees WHERE reference=?").get(input.reference) as Row | undefined;
      if (old) {
        requireThat(old.amount_usd===input.amount_usd && old.kind===input.kind && old.order_id===orderId && old.evidence===input.evidence,
          "此费用凭证已登记且内容不同");
        return old;
      }
      const id=randomUUID();
      this.db.db.prepare("INSERT INTO cost_fees VALUES (?,?,?,?,?,?,?)")
        .run(id,input.reference,input.kind,input.amount_usd,orderId,input.evidence,now());
      if (orderId) {
        this.db.db.prepare("UPDATE order_cost_reviews SET revision=revision+1,fees_checked=0,updated_at=? WHERE order_id=?").run(now(),orderId);
        this.db.recordOrderAudit({orderId,action:"cost_fee_registered",fromStatus:null,toStatus:"fee:"+input.amount_usd+"USD",reason:input.evidence});
      }
      return this.db.db.prepare("SELECT * FROM cost_fees WHERE fee_id=?").get(id) as Row;
    });
  }
  importTransactions(items: Array<{transaction_id:string;card_id:string;amount_usd:string;status:string;type:string;occurred_at:string;merchant:string}>): number {
    return this.db.transaction(() => {
      for (const t of items) {
        moneyToCents(t.amount_usd);
        const old = this.db.db.prepare("SELECT * FROM cost_transactions WHERE transaction_id=?").get(t.transaction_id) as Row | undefined;
        const link = this.db.db.prepare("SELECT order_id FROM cost_transaction_links WHERE transaction_id=?").get(t.transaction_id) as Row | undefined;
        if (old && link && (old.amount_usd!==t.amount_usd || old.status!==t.status || old.type!==t.type || old.card_id!==t.card_id)) {
          this.db.db.prepare("UPDATE order_cost_reviews SET status='disputed',updated_at=? WHERE order_id=?").run(now(),link.order_id);
          this.db.recordOrderAudit({orderId:link.order_id,action:"cost_transaction_changed",fromStatus:"confirmed",toStatus:"disputed",operator:"system",reason:"扣款来源变动，暂停未完成结算，需人工核对；原结算不覆盖"});
        }
        this.db.db.prepare(`INSERT INTO cost_transactions VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(transaction_id) DO UPDATE SET amount_usd=excluded.amount_usd,status=excluded.status,type=excluded.type,
          card_id=excluded.card_id,occurred_at=excluded.occurred_at,merchant=excluded.merchant,updated_at=excluded.updated_at`)
          .run(t.transaction_id,t.card_id,t.amount_usd,t.status,t.type,t.occurred_at,t.merchant,now());
      }
      return items.length;
    });
  }
  externalRebatePaymentPreview(orderNumber: string): Row {
    const o=this.db.db.prepare(`SELECT * FROM orders WHERE order_id=? OR client_order_id=?`).get(orderNumber,orderNumber) as Row|undefined;
    requireThat(o,"订单不存在");
    requireThat(o.order_source!=="manual"&&!String(o.client_order_id).startsWith("ADMINTEST-"),"仅支持真实平台供货订单");
    requireThat(o.status==="paid"&&o.delivery_status==="success"&&!o.refunded_at,"订单须已支付、履约成功且未退款");
    const rebate=this.db.getPlatformRebate(o.order_id) as Row|undefined;
    requireThat(rebate,"该订单没有需要退给平台的美元差价");
    const amounts=calculateFinancialAmounts({customerPayment:o.amount,
      serviceReceipt:o.alipay_receipt_amount??o.amount,supplyCost:o.platform_supply_price??"0.00",
      customerPriceRefund:o.customer_price_refund_amount??"0.00"});
    const base=this.db.db.prepare(`SELECT l.settlement_id,s.status,l.amount,s.paid_at
      FROM platform_settlement_lines l JOIN platform_settlements s ON s.settlement_id=l.settlement_id
      WHERE l.order_id=?`).get(o.order_id) as Row|undefined;
    return {order_id:o.order_id,client_order_id:o.client_order_id,plan:o.plan,base_cny:amounts.platformProfit,
      base_status:base?(base.status==="paid"?"paid":base.status==="partial"?"partial":"included"):"pending",base_settlement_id:base?.settlement_id??null,
      rebate_usd:rebate.rebate_usd,rebate_status:rebate.status,rebate_settlement_id:rebate.settlement_id??null,
      rebate_settled_at:rebate.settled_at??null};
  }
  recordExternalRebatePayment(input: ExternalRebatePayment): Row {
    return this.db.transaction(()=>{
      const preview=this.externalRebatePaymentPreview(input.orderNumber);
      const paidAt=Date.parse(input.paidAt);
      requireThat(Number.isFinite(paidAt)&&paidAt<=Date.now()+60_000,"付款时间无效或晚于当前时间");
      const dueCents=moneyToCents(preview.rebate_usd),appliedCents=moneyToCents(input.appliedUsd);
      const paymentCents=moneyToCents(input.paymentAmount);
      requireThat(appliedCents>0&&appliedCents<=dueCents,"本次核销美元须大于 0 且不超过待退差额");
      requireThat(paymentCents>0,"实际付款金额须大于 0");
      const fxRate=input.fxRate?.trim()||null,fundingAmount=input.fundingAmount?.trim()||null;
      if(input.paymentCurrency==="USD"){
        requireThat(paymentCents===appliedCents,"美元实付金额须与本次核销美元一致");
        requireThat(!fxRate&&!fundingAmount,"美元付款不需要填写人民币汇率或实际扣款");
      }else{
        requireThat(!!fxRate,"人民币折算付款必须填写实际换算汇率");
        const expectedCents=moneyToCents(usdToCny(input.appliedUsd,fxRate!));
        requireThat(Math.abs(expectedCents-paymentCents)<=100,"人民币付款金额与核销美元、汇率不匹配，超出 1 元人工取整范围");
        if(fundingAmount)requireThat(moneyToCents(fundingAmount)>0,"人民币实际扣款须大于 0");
      }
      const evidenceNote=[input.note,
        `核销 ${input.appliedUsd} USD；平台收款 ${input.paymentAmount} ${input.paymentCurrency}`,
        fxRate?`换算汇率 ${fxRate} CNY/USD`:"",
        fundingAmount?`我方实际扣款 ${fundingAmount} CNY`:""].filter(Boolean).join("；");
      const prior=this.db.db.prepare(`SELECT * FROM settlement_payments
        WHERE payment_id=? OR (method=? AND reference=? AND currency=?)`)
        .get(input.paymentId,input.method,input.reference,input.paymentCurrency) as Row|undefined;
      if(prior){
        const linked=this.db.db.prepare("SELECT * FROM platform_rebates WHERE order_id=? AND settlement_id=?")
          .get(preview.order_id,prior.settlement_id) as Row|undefined;
        requireThat(linked&&prior.currency===input.paymentCurrency&&prior.amount===input.paymentAmount&&prior.method===input.method&&
          prior.reference===input.reference&&prior.note===evidenceNote&&prior.paid_at===input.paidAt,
          "付款请求号或凭证已使用，且内容不一致");
        return {preview,statement:this.db.getPlatformSettlement(prior.settlement_id)!,rebate:linked};
      }
      requireThat(preview.rebate_status==="pending"&&!preview.rebate_settlement_id,
        preview.rebate_status==="paid"?"该美元退差已经登记付给平台":"该美元退差已进入结算单，请在原结算单内核销");
      const complete=appliedCents===dueCents;
      const time=now(),settlementId="MANR"+randomUUID().replaceAll("-","").slice(0,20).toUpperCase();
      this.db.db.prepare(`INSERT INTO platform_settlements
        (settlement_id,period_from,period_to,amount,rebate_usd,order_count,status,payment_method,payment_reference,
         payment_note,paid_at,created_at,updated_at,generation_mode,business_date,cny_paid,usd_paid)
        VALUES (?,?,?,'0.00',?,1,?,?,?,?,?,?,?,'manual',NULL,'0.00',?)`)
        .run(settlementId,input.paidAt,input.paidAt,preview.rebate_usd,complete?"paid":"partial",input.method,input.reference,
          evidenceNote,complete?input.paidAt:null,time,time,input.appliedUsd);
      const changed=this.db.db.prepare(`UPDATE platform_rebates SET status=?,settlement_id=?,settled_at=?,updated_at=?
        WHERE order_id=? AND status='pending' AND settlement_id IS NULL`)
        .run(complete?"paid":"included",settlementId,complete?input.paidAt:null,time,preview.order_id);
      requireThat(changed.changes===1,"美元退差状态已变化，请刷新后重试");
      this.db.db.prepare("INSERT INTO settlement_payments VALUES (?,?,?,?,?,?,?,?,?)")
        .run(input.paymentId,settlementId,input.paymentCurrency,input.paymentAmount,input.method,input.reference,evidenceNote,input.paidAt,time);
      this.db.recordOrderAudit({orderId:preview.order_id,action:"platform_rebate_payment_registered_external",
        fromStatus:"pending",toStatus:complete?"paid":"included",reason:`已线下支付平台退差等值 ${input.appliedUsd} USD（${input.paymentAmount} ${input.paymentCurrency}），剩余 ${centsToMoney(dueCents-appliedCents)} USD；人民币基础利润 ${preview.base_cny} CNY 保持待结算；仅登记凭证，未调用转账`});
      return {preview,statement:this.db.getPlatformSettlement(settlementId)!,rebate:this.db.getPlatformRebate(preview.order_id)!};
    });
  }  payment(input: SettlementPayment): Row {
    return this.db.transaction(() => {
      const prior = this.db.db.prepare("SELECT * FROM settlement_payments WHERE payment_id=? OR (method=? AND reference=? AND currency=?)")
        .get(input.paymentId,input.method,input.reference,input.currency) as Row | undefined;
      if (prior) {
        requireThat(prior.settlement_id===input.settlementId && prior.currency===input.currency && prior.amount===input.amount &&
          prior.method===input.method && prior.reference===input.reference && prior.paid_at===input.paidAt && prior.note===input.note,
          "结算凭证或请求号已使用，且内容不一致");
        return this.db.getPlatformSettlement(input.settlementId)!.settlement;
      }
      const s = this.db.getPlatformSettlement(input.settlementId)?.settlement;
      requireThat(s,"结算单不存在");
      requireThat(!this.db.db.prepare(`SELECT 1 FROM order_cost_reviews c WHERE c.status='disputed' AND (
        EXISTS(SELECT 1 FROM platform_rebates r WHERE r.order_id=c.order_id AND r.settlement_id=?) OR
        EXISTS(SELECT 1 FROM platform_settlement_lines l WHERE l.order_id=c.order_id AND l.settlement_id=?))`)
        .get(input.settlementId,input.settlementId),"结算单含争议成本，暂停核销；请人工核查");
      requireThat(input.currency==="CNY" || input.currency==="USD","请选择结算币种");
      const due = moneyToCents(String(input.currency==="CNY" ? s.amount:s.rebate_usd));
      const previous = moneyToCents(String(input.currency==="CNY" ? s.cny_paid:s.usd_paid));
      const payment = moneyToCents(input.amount);
      requireThat(payment>0 && payment<=due-previous,"登记金额须大于 0 且不超过该币种待付金额");
      requireThat(!Number.isNaN(Date.parse(input.paidAt)) && Date.parse(input.paidAt)<=Date.now()+60_000,"结算时间无效或晚于当前时间");
      const cny = input.currency==="CNY" ? centsToMoney(previous+payment):String(s.cny_paid);
      const usd = input.currency==="USD" ? centsToMoney(previous+payment):String(s.usd_paid);
      const complete = cny===s.amount && usd===s.rebate_usd;
      const time=now();
      this.db.db.prepare("INSERT INTO settlement_payments VALUES (?,?,?,?,?,?,?,?,?)")
        .run(input.paymentId,input.settlementId,input.currency,input.amount,input.method,input.reference,input.note,input.paidAt,time);
      this.db.db.prepare(`UPDATE platform_settlements SET cny_paid=?,usd_paid=?,status=?,payment_method=?,
        payment_reference=?,payment_note=?,paid_at=?,updated_at=? WHERE settlement_id=?`)
        .run(cny,usd,complete?"paid":"partial",input.method,input.reference,input.note,complete?input.paidAt:null,time,input.settlementId);
      if (usd===s.rebate_usd) this.db.db.prepare("UPDATE platform_rebates SET status='paid',settled_at=?,updated_at=? WHERE settlement_id=? AND status='included'")
        .run(input.paidAt,time,input.settlementId);
      for (const row of this.db.db.prepare(`SELECT order_id FROM platform_settlement_lines WHERE settlement_id=?
        UNION SELECT order_id FROM platform_rebates WHERE settlement_id=?`).all(input.settlementId,input.settlementId) as Row[]) {
        this.db.recordOrderAudit({orderId:row.order_id,action:"platform_payment_registered",fromStatus:String(s.status),
          toStatus:complete?"paid":"partial",reason:`${input.settlementId} 登记 ${input.amount} ${input.currency}，凭证 ${input.reference}；仅记账，未调用转账；${input.note}`});
      }
      return this.db.getPlatformSettlement(input.settlementId)!.settlement;
    });
  }
}
