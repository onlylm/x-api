import { randomUUID } from "node:crypto";
import { AppDatabase } from "../database.js";
import type { ActivationRecord } from "../domain.js";

export interface ControlState {
  activation_id: number;
  attempts: number;
  issue_started: number;
  next_retry_at: string | null;
  needs_review: number;
  lease_token: string | null;
  lease_until: string | null;
  review_resumed_at?: string | null;
}
export interface ActivationLease { activation: ActivationRecord; token: string }
export class ActivationLeaseLost extends Error {}

/** Additive internal state; no changes to public response fields or business schemas. */
export class ActivationControl {
  constructor(private readonly db: AppDatabase) {
    db.db.exec(`CREATE TABLE IF NOT EXISTS activation_worker_control (
      activation_id INTEGER PRIMARY KEY REFERENCES activations(id),
      attempts INTEGER NOT NULL DEFAULT 0, issue_started INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT, needs_review INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT, lease_until TEXT, last_stage TEXT,
      last_error_code TEXT, last_http_status INTEGER,
      stage_started_at TEXT, stage_finished_at TEXT, stage_duration_ms INTEGER,
      updated_at TEXT NOT NULL
    );`);
    const columns = db.db.prepare("PRAGMA table_info(activation_worker_control)").all() as Array<{name:string}>;
    if (!columns.some(c => c.name === "review_resumed_at")) {
      db.db.exec("ALTER TABLE activation_worker_control ADD COLUMN review_resumed_at TEXT");
    }
  }

  state(id: number): ControlState | undefined {
    return this.db.db.prepare("SELECT * FROM activation_worker_control WHERE activation_id = ?")
      .get(id) as unknown as ControlState | undefined;
  }

  claim(now: string, until: string, pollingId?: number): ActivationLease | undefined {
    return this.db.transaction(() => {
      // A shared 429 cooldown prevents other queued tasks from immediately hitting the same limit.
      if (this.db.db.prepare(`SELECT 1 FROM activation_worker_control
        WHERE last_http_status = 429 AND next_retry_at > ? LIMIT 1`).get(now)) return undefined;
      const row = this.db.db.prepare(`SELECT a.* FROM activations a
        LEFT JOIN activation_worker_control c ON c.activation_id = a.id
        WHERE a.finished = 0 AND ${pollingId === undefined
          ? "a.worker_state IN ('queued', 'provisioning')"
          : "a.worker_state = 'polling' AND a.id = ?"}
        AND (a.worker_locked_until IS NULL OR a.worker_locked_until <= ?)
        AND COALESCE(c.needs_review, 0) = 0
        AND (c.next_retry_at IS NULL OR c.next_retry_at <= ?)
        AND (c.lease_until IS NULL OR c.lease_until <= ?)
        ORDER BY a.id LIMIT 1`)
        .get(...(pollingId === undefined ? [] : [pollingId]), now, now, now) as unknown as ActivationRecord | undefined;
      if (!row) return undefined;
      // A crashed legacy worker may already have issued a request: retain its idempotency key.
      this.db.db.prepare(`INSERT OR IGNORE INTO activation_worker_control
        (activation_id, issue_started, updated_at) VALUES (?, ?, ?)`)
        .run(row.id, row.worker_state === "provisioning" && !row.cdk_id ? 1 : 0, now);
      const token = randomUUID();
      this.db.db.prepare(`UPDATE activation_worker_control SET lease_token = ?, lease_until = ?,
        next_retry_at = NULL, attempts = attempts + ?, updated_at = ? WHERE activation_id = ?`)
        .run(token, until, pollingId === undefined ? 1 : 0, now, row.id);
      this.db.db.prepare("UPDATE activations SET worker_state = ?, worker_locked_until = ? WHERE id = ?")
        .run(pollingId === undefined ? "provisioning" : "polling", until, row.id);
      return { activation: this.db.db.prepare("SELECT * FROM activations WHERE id = ?")
        .get(row.id) as unknown as ActivationRecord, token };
    });
  }

  assertOwned(lease: ActivationLease): void {
    const s = this.state(lease.activation.id);
    if (s?.lease_token !== lease.token || !s.lease_until || s.lease_until <= new Date().toISOString()) {
      throw new ActivationLeaseLost("activation_lease_lost");
    }
  }

  renew(lease: ActivationLease, until: string): void {
    this.db.transaction(() => {
      this.assertOwned(lease);
      this.db.db.prepare("UPDATE activation_worker_control SET lease_until = ? WHERE activation_id = ?")
        .run(until, lease.activation.id);
      this.db.db.prepare("UPDATE activations SET worker_locked_until = ? WHERE id = ? AND finished = 0")
        .run(until, lease.activation.id);
    });
  }

  issueStarted(lease: ActivationLease): void {
    this.assertOwned(lease);
    this.db.db.prepare("UPDATE activation_worker_control SET issue_started = 1 WHERE activation_id = ?")
      .run(lease.activation.id);
  }

  stage(lease: ActivationLease, stage: string, startedAt: string, durationMs?: number): void {
    this.assertOwned(lease);
    this.db.db.prepare(`UPDATE activation_worker_control SET last_stage = ?, stage_started_at = ?,
      stage_finished_at = ?, stage_duration_ms = ?, updated_at = ? WHERE activation_id = ?`)
      .run(stage, startedAt, durationMs === undefined ? null : new Date().toISOString(),
        durationMs ?? null, new Date().toISOString(), lease.activation.id);
  }

  defer(lease: ActivationLease, delayMs: number, stage: string, errorCode?: string, httpStatus?: number): void {
    this.assertOwned(lease);
    this.db.db.prepare(`UPDATE activation_worker_control SET next_retry_at = ?, last_stage = ?,
      last_error_code = ?, last_http_status = ?, updated_at = ? WHERE activation_id = ?`)
      .run(new Date(Date.now() + delayMs).toISOString(), stage, errorCode ?? null, httpStatus ?? null,
        new Date().toISOString(), lease.activation.id);
  }

  review(lease: ActivationLease, stage: string, reason: string): void {
    this.db.transaction(() => {
      this.assertOwned(lease);
      this.db.db.prepare(`UPDATE activation_worker_control SET needs_review = 1,
        last_stage = ?, last_error_code = ?, updated_at = ? WHERE activation_id = ?`)
        .run(stage, reason, new Date().toISOString(), lease.activation.id);
      this.db.recordOrderAudit({ orderId: lease.activation.order_id, action: "activation_review_required",
        fromStatus: null, toStatus: "internal:review_required", operator: "system",
        reason: `履约任务 ${lease.activation.task_id} 需要人工核查；阶段 ${stage}；原因 ${reason}。结果未确认，不得重新充值或退款。` });
    });
  }

  release(lease: ActivationLease): void {
    this.db.transaction(() => {
      const s = this.state(lease.activation.id);
      if (s?.lease_token !== lease.token) return;
      this.db.db.prepare(`UPDATE activation_worker_control SET lease_token = NULL, lease_until = NULL
        WHERE activation_id = ?`).run(lease.activation.id);
      // Keep legacy workers from retrying tasks that require human review after a rollback.
      this.db.db.prepare("UPDATE activations SET worker_locked_until = ? WHERE id = ? AND finished = 0")
        .run(s.needs_review ? "9999-12-31T23:59:59.999Z" : null, lease.activation.id);
    });
  }
}
