import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { PaymentClient, PaymentConfirmation } from "../clients/payment.js";
import { AppDatabase } from "../database.js";
import { isXGiftPlan, type OrderRecord } from "../domain.js";
import { ActivationService } from "./activation-service.js";

const POLL_MS = 15_000;
const EXPIRED_POLL_MS = 5 * 60_000;
const OLD_EXPIRED_POLL_MS = 24 * 60 * 60_000;
const LEASE_MS = 60_000;
const BATCH_SIZE = 5;

// Paid orders without a task are included only to recover the local enqueue gap;
// they are never queried again at the payment provider.
const ELIGIBLE = `o.plan IN ('x_premium_3m','x_premium_6m')
  AND COALESCE(o.order_source,'platform') <> 'manual'
  AND COALESCE(o.payment_channel,'alipay') = 'alipay'
  AND o.refunded_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id=o.order_id)
  AND (o.status IN ('pending','expired') OR (o.status='paid'
    AND NOT EXISTS (SELECT 1 FROM activations a WHERE a.order_id=o.order_id)))`;

interface Claim { orderId: string; token: string }
type ReconcileError = "payment_query_unavailable" | "payment_confirmation_invalid" |
  "payment_confirmation_conflict" | "payment_record_unavailable" | "payment_activation_enqueue_failed";

/** Read-only provider reconciliation. This worker never creates a payment or refund. */
export class XPaymentReconciler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly payment: PaymentClient,
    private readonly activations: ActivationService,
    private readonly log: FastifyBaseLogger,
  ) {
    this.db.db.exec(`CREATE TABLE IF NOT EXISTS x_payment_reconciliation (
      order_id TEXT PRIMARY KEY REFERENCES orders(order_id),
      next_check TEXT NOT NULL,
      lease_token TEXT,
      lease_until TEXT,
      last_checked_at TEXT,
      last_error_code TEXT,
      check_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_x_payment_reconciliation_due
      ON x_payment_reconciliation(next_check,lease_until);`);
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const run = () => { void this.tick().catch(() => {
      this.log.error({ code: "payment_reconciliation_tick_failed" }, "payment reconciliation unavailable");
    }); };
    this.timer = setInterval(run, POLL_MS);
    this.timer.unref();
    run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopping) return Promise.resolve();
    const work = this.runBatch().finally(() => { this.inFlight = undefined; });
    this.inFlight = work;
    return work;
  }

  private async runBatch(): Promise<void> {
    const now = new Date().toISOString();
    this.db.db.prepare(`INSERT OR IGNORE INTO x_payment_reconciliation(order_id,next_check,updated_at)
      SELECT o.order_id,COALESCE(o.paid_at,o.created_at),? FROM orders o WHERE ${ELIGIBLE}`).run(now);
    for (let index = 0; index < BATCH_SIZE && !this.stopping; index += 1) {
      const claim = this.claimNext();
      if (!claim) break;
      await this.reconcile(claim);
    }
  }

  private claimNext(): Claim | undefined {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const row = this.db.db.prepare(`SELECT p.order_id FROM x_payment_reconciliation p
        JOIN orders o ON o.order_id=p.order_id WHERE ${ELIGIBLE}
        AND p.next_check<=? AND (p.lease_until IS NULL OR p.lease_until<=?)
        ORDER BY p.next_check,o.created_at,p.order_id LIMIT 1`).get(now, now) as { order_id: string } | undefined;
      if (!row) return undefined;
      const token = randomUUID();
      this.db.db.prepare(`UPDATE x_payment_reconciliation SET lease_token=?,lease_until=?,
        check_count=check_count+1,updated_at=? WHERE order_id=?`)
        .run(token, new Date(Date.now() + LEASE_MS).toISOString(), now, row.order_id);
      return { orderId: row.order_id, token };
    });
  }

  private ownsLease(claim: Claim): boolean {
    return Boolean(this.db.db.prepare(`SELECT 1 FROM x_payment_reconciliation
      WHERE order_id=? AND lease_token=? AND lease_until>?`)
      .get(claim.orderId, claim.token, new Date().toISOString()));
  }

  private eligibleOrder(orderId: string): OrderRecord | undefined {
    const order = this.db.getOrder(orderId);
    if (!order || !isXGiftPlan(order.plan) || order.order_source === "manual" ||
        order.payment_channel === "cash" || order.refunded_at || this.db.getRefundByOrderId(orderId) ||
        !["pending", "expired", "paid"].includes(order.status)) return undefined;
    return order;
  }

  private async reconcile(claim: Claim): Promise<void> {
    let code: ReconcileError | null = null;
    let stage: ReconcileError = "payment_query_unavailable";
    // Keep the lease while draining a slow query. A crashed process stops renewing,
    // allowing another process to recover the read-only query after 60 seconds.
    const heartbeat = setInterval(() => {
      try {
        const now = new Date().toISOString();
        this.db.db.prepare(`UPDATE x_payment_reconciliation SET lease_until=?,updated_at=?
          WHERE order_id=? AND lease_token=? AND lease_until>?`)
          .run(new Date(Date.now() + LEASE_MS).toISOString(), now, claim.orderId, claim.token, now);
      } catch {
        this.log.warn({ orderId: claim.orderId, code: "payment_reconciliation_lease_unavailable" },
          "payment reconciliation lease unavailable");
      }
    }, LEASE_MS / 3);
    heartbeat.unref();
    try {
      let order = this.eligibleOrder(claim.orderId);
      if (!order || !this.ownsLease(claim)) return;
      if (order.status !== "paid") {
        // RuntimePaymentClient delegates to the signed, amount-checked Alipay query.
        const result = await this.payment.queryPayment(order);
        if (!this.ownsLease(claim)) return;
        order = this.eligibleOrder(claim.orderId);
        if (!order) return;
        if (order.status !== "paid") {
          if (!result.paid) return;
          if (!validPaidConfirmation(result)) {
            code = "payment_confirmation_invalid";
            return;
          }
          stage = "payment_record_unavailable";
          order = this.db.markOrderPaid(order.order_id, result.paidAt, result.tradeNo, result.receiptAmount);
        } else if (result.paid && result.tradeNo && order.alipay_trade_no &&
                   result.tradeNo !== order.alipay_trade_no) {
          code = "payment_confirmation_conflict";
          return;
        }
      }
      stage = "payment_activation_enqueue_failed";
      // createActivation has its own transactional refund and uniqueness checks.
      if (this.eligibleOrder(claim.orderId)?.status === "paid") {
        this.activations.createForPaidOrder(claim.orderId);
      }
    } catch {
      code = stage;
    } finally {
      clearInterval(heartbeat);
      const now = new Date().toISOString();
      const order = this.db.getOrder(claim.orderId);
      this.db.db.prepare(`UPDATE x_payment_reconciliation SET next_check=?,lease_token=NULL,lease_until=NULL,
        last_checked_at=?,last_error_code=?,updated_at=? WHERE order_id=? AND lease_token=?`)
        .run(new Date(Date.now() + retryDelay(order)).toISOString(), now, code, now, claim.orderId, claim.token);
      if (code) this.log.warn({ orderId: claim.orderId, code }, "payment reconciliation requires retry");
    }
  }
}

function validPaidConfirmation(result: PaymentConfirmation): boolean {
  return result.paid === true && typeof result.tradeNo === "string" &&
    result.tradeNo.trim().length > 0 && result.tradeNo.length <= 128 &&
    ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(result.tradeStatus ?? "") &&
    typeof result.paidAt === "string" && Number.isFinite(Date.parse(result.paidAt));
}

function retryDelay(order: OrderRecord | undefined): number {
  if (!order || order.status === "paid") return POLL_MS;
  const expiredAt = Date.parse(order.expires_at);
  if (!Number.isFinite(expiredAt)) return OLD_EXPIRED_POLL_MS;
  if (order.status !== "expired" && expiredAt > Date.now()) return POLL_MS;
  return Date.now() - expiredAt < OLD_EXPIRED_POLL_MS ? EXPIRED_POLL_MS : OLD_EXPIRED_POLL_MS;
}
