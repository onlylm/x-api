import type { AppDatabase } from "../database.js";

interface InventoryActivation {
  order_id: string;
  cdk_id: number | null;
  finished: number;
  redemption_token: string | null;
  upstream_order_id: string | null;
  worker_state: string;
}

/** Recheck current ownership and payment before continuing an unsubmitted attempt. */
export function assertUnsubmittedCdkSafe(
  db: AppDatabase,
  activationId: number,
  cdkId: number,
  assertOwned: () => void,
): void {
  checkUnsubmittedCdk(db, activationId, cdkId, assertOwned);
}

function checkUnsubmittedCdk(
  db: AppDatabase,
  activationId: number,
  cdkId: number,
  assertOwned: () => void,
): { activation: InventoryActivation; issueStarted: number } {
  assertOwned();
  const activation = db.db.prepare(`SELECT order_id, cdk_id, finished,
    redemption_token, upstream_order_id, worker_state FROM activations WHERE id = ?`)
    .get(activationId) as unknown as InventoryActivation | undefined;
  const control = db.db.prepare(`SELECT issue_started FROM activation_worker_control
    WHERE activation_id = ?`).get(activationId) as { issue_started: number } | undefined;
  if (!activation || !control || ![0, 1].includes(control.issue_started) || activation.finished !== 0 ||
      activation.redemption_token !== null || activation.upstream_order_id !== null ||
      !["queued", "provisioning"].includes(activation.worker_state)) {
    throw new Error("cdk_quarantine_submission_not_safe");
  }
  const card = db.db.prepare("SELECT status, assigned_activation_id FROM cdks WHERE id = ?")
    .get(cdkId) as { status: string; assigned_activation_id: number | null } | undefined;
  if (!card || card.status !== "reserved" || card.assigned_activation_id !== activationId ||
      (activation.cdk_id !== null && activation.cdk_id !== cdkId)) {
    throw new Error("cdk_quarantine_ownership_conflict");
  }
  const order = db.db.prepare("SELECT status, delivery_status, refunded_at FROM orders WHERE order_id = ?")
    .get(activation.order_id) as { status: string; delivery_status: string | null; refunded_at: string | null } | undefined;
  if (!order || order.status !== "paid" || order.refunded_at !== null || order.delivery_status === "success" ||
      db.db.prepare(`SELECT 1 FROM refunds WHERE order_id = ?
        AND status IN ('requested', 'processing', 'succeeded') LIMIT 1`).get(activation.order_id)) {
    throw new Error("cdk_quarantine_order_not_safe");
  }
  if (db.db.prepare("SELECT 1 FROM activations WHERE cdk_id = ? AND id <> ? AND finished = 0 LIMIT 1")
    .get(cdkId, activationId)) {
    throw new Error("cdk_quarantine_other_active_owner");
  }
  return { activation, issueStarted: control.issue_started };
}

/** Isolate confirmed unusable inventory only before any redemption was submitted. */
export function quarantineUnsubmittedInventoryCdk(
  db: AppDatabase,
  activationId: number,
  cdkId: number,
  upstreamStatus: "disabled" | "frozen",
  assertOwned: () => void,
): void {
  if (upstreamStatus !== "disabled" && upstreamStatus !== "frozen") {
    throw new Error("cdk_quarantine_status_invalid");
  }
  db.transaction(() => {
    const { activation, issueStarted } = checkUnsubmittedCdk(db, activationId, cdkId, assertOwned);
    if (issueStarted !== 0) {
      throw new Error("cdk_quarantine_submission_not_safe");
    }

    const now = new Date().toISOString();
    const cardUpdate = db.db.prepare(`UPDATE cdks SET status = ?, assigned_activation_id = NULL, updated_at = ?
      WHERE id = ? AND status = 'reserved' AND assigned_activation_id = ?`)
      .run(upstreamStatus, now, cdkId, activationId);
    const activationUpdate = db.db.prepare(`UPDATE activations SET cdk_id = NULL, updated_at = ?
      WHERE id = ? AND finished = 0 AND redemption_token IS NULL AND upstream_order_id IS NULL
        AND worker_state IN ('queued', 'provisioning') AND (cdk_id IS NULL OR cdk_id = ?)`)
      .run(now, activationId, cdkId);
    if (Number(cardUpdate.changes) !== 1 || Number(activationUpdate.changes) !== 1) {
      throw new Error("cdk_quarantine_state_changed");
    }
    db.recordOrderAudit({
      orderId: activation.order_id,
      action: "cdk_inventory_quarantined",
      fromStatus: "cdk:reserved",
      toStatus: `cdk:${upstreamStatus}`,
      reason: `activation_id=${activationId}; cdk_id=${cdkId}; upstream_status=${upstreamStatus}`,
      operator: "system",
      now,
    });
  });
}
