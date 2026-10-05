import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/database.js";
import { ActivationControl, ActivationLeaseLost } from "../src/services/activation-control.js";
import { assertUnsubmittedCdkSafe, quarantineUnsubmittedInventoryCdk } from "../src/services/cdk-reuse-guard.js";

describe("unsubmitted inventory CDK quarantine", () => {
  let db: AppDatabase;
  const activationId = 42;
  const cdkId = 7;
  const orderId = "po_inventory_guard";
  const now = "2026-10-02T00:00:00.000Z";

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    new ActivationControl(db);
    db.db.prepare(`INSERT INTO orders (order_id, client_order_id, product, plan, quantity,
      sell_price, amount, status, qr, expires_at, paid_at, created_at, updated_at)
      VALUES (?, 'client_guard', 'test_plus', 'plus', 1, '120.00', '120.00', 'paid', '', ?, ?, ?, ?)`)
      .run(orderId, now, now, now, now);
    db.db.prepare(`INSERT INTO activations (id, order_id, activation_id, task_id, status, finished,
      cdk_id, worker_state, session_ciphertext, created_at, updated_at)
      VALUES (?, ?, 1, 'task_guard', 'queued', 0, ?, 'provisioning', 'secret-session', ?, ?)`)
      .run(activationId, orderId, cdkId, now, now);
    db.db.prepare(`INSERT INTO activation_worker_control (activation_id, issue_started, updated_at)
      VALUES (?, 0, ?)`).run(activationId, now);
    db.db.prepare(`INSERT INTO cdks (id, upstream_cdk_id, plan, code_ciphertext, code_iv, code_tag,
      status, assigned_activation_id, redemption_device_id, created_at, updated_at)
      VALUES (?, '102791', 'plus', 'secret-cdk', 'iv', 'tag', 'reserved', ?, 'original-device', ?, ?)`)
      .run(cdkId, activationId, now, now);
  });

  afterEach(() => db.close());

  function snapshot() {
    return ["orders", "activations", "activation_worker_control", "cdks", "refunds", "order_audit_log"]
      .map(table => db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  }

  function rejectUnchanged(assertOwned: () => void = () => {}) {
    const before = snapshot();
    expect(() => quarantineUnsubmittedInventoryCdk(db, activationId, cdkId, "disabled", assertOwned)).toThrow();
    expect(snapshot()).toEqual(before);
  }

  function refund(status: string) {
    db.db.prepare(`INSERT INTO refunds (refund_id, order_id, client_refund_id, amount, reason,
      status, requested_by, created_at, updated_at) VALUES ('refund_guard', ?, 'refund_client',
      '120.00', 'private refund note', ?, 'admin', ?, ?)`).run(orderId, status, now, now);
  }

  it.each(["disabled", "frozen"] as const)("isolates %s and detaches without changing payment, session or device", status => {
    const orderBefore = db.getOrder(orderId);
    const assertOwned = vi.fn(() => {
      expect(() => db.db.exec("BEGIN IMMEDIATE")).toThrow();
    });
    quarantineUnsubmittedInventoryCdk(db, activationId, cdkId, status, assertOwned);
    expect(assertOwned).toHaveBeenCalledTimes(1);
    expect(db.db.prepare("SELECT status, assigned_activation_id, redemption_device_id FROM cdks WHERE id=?").get(cdkId))
      .toEqual({ status, assigned_activation_id: null, redemption_device_id: "original-device" });
    expect(db.db.prepare("SELECT cdk_id, finished, session_ciphertext, worker_state FROM activations WHERE id=?").get(activationId))
      .toEqual({ cdk_id: null, finished: 0, session_ciphertext: "secret-session", worker_state: "provisioning" });
    expect(db.getOrder(orderId)).toEqual(orderBefore);
    const audit = db.db.prepare("SELECT action, reason, from_status, to_status, operator FROM order_audit_log").get();
    expect(audit).toEqual({ action: "cdk_inventory_quarantined", reason: `activation_id=42; cdk_id=7; upstream_status=${status}`,
      from_status: "cdk:reserved", to_status: `cdk:${status}`, operator: "system" });
    expect(JSON.stringify(audit)).not.toContain("secret");
    expect(db.reserveUnusedCdk("plus", 99, now)).toBeUndefined();
  });

  it("recovers the reservation made before activation attachment", () => {
    db.db.prepare("UPDATE activations SET cdk_id=NULL WHERE id=?").run(activationId);
    quarantineUnsubmittedInventoryCdk(db, activationId, cdkId, "disabled", () => {});
    expect(db.db.prepare("SELECT status FROM cdks WHERE id=?").get(cdkId)?.status).toBe("disabled");
  });

  it("rejects an already started issue so its original idempotency key cannot be bypassed", () => {
    db.db.prepare("UPDATE activation_worker_control SET issue_started=1 WHERE activation_id=?").run(activationId);
    rejectUnchanged();
  });

  it("rejects missing issue control state", () => {
    db.db.prepare("DELETE FROM activation_worker_control WHERE activation_id=?").run(activationId);
    rejectUnchanged();
  });

  it.each([
    ["redemption_token", "submitted-token"],
    ["redemption_token", ""],
    ["upstream_order_id", "123456"],
    ["worker_state", "polling"],
    ["worker_state", "terminal"],
    ["finished", 1],
    ["cdk_id", 8],
  ])("rejects changed activation %s", (field, value) => {
    db.db.prepare(`UPDATE activations SET ${field}=? WHERE id=?`).run(value, activationId);
    rejectUnchanged();
  });

  it.each(["pending", "refunded", "expired", "closed"])("rejects payment status %s", status => {
    db.db.prepare("UPDATE orders SET status=? WHERE order_id=?").run(status, orderId);
    rejectUnchanged();
  });

  it("rejects a refund timestamp even if payment still says paid", () => {
    db.db.prepare("UPDATE orders SET refunded_at=? WHERE order_id=?").run(now, orderId);
    rejectUnchanged();
  });

  it("rejects delivery already completed while an activation still appears active", () => {
    db.db.prepare("UPDATE orders SET delivery_status='success' WHERE order_id=?").run(orderId);
    rejectUnchanged();
  });

  it.each(["requested", "processing", "succeeded"])("rejects dangerous refund state %s", status => {
    refund(status);
    rejectUnchanged();
  });

  it.each(["failed", "rejected"])("does not block on inactive refund state %s", status => {
    refund(status);
    quarantineUnsubmittedInventoryCdk(db, activationId, cdkId, "disabled", () => {});
    expect(db.db.prepare("SELECT status FROM refunds").get()?.status).toBe(status);
  });

  it("leaves all data unchanged after lease loss", () => {
    rejectUnchanged(() => { throw new ActivationLeaseLost("stale-owner"); });
  });

  it.each(["unused", "consumed", "disabled"])("rejects changed local card state %s", status => {
    db.db.prepare("UPDATE cdks SET status=? WHERE id=?").run(status, cdkId);
    rejectUnchanged();
  });

  it("rejects changed card ownership", () => {
    db.db.prepare("UPDATE cdks SET assigned_activation_id=99 WHERE id=?").run(cdkId);
    rejectUnchanged();
  });

  it("rejects another unfinished activation referring to the same card", () => {
    db.db.prepare(`INSERT INTO activations (order_id, activation_id, task_id, status, finished,
      cdk_id, worker_state, created_at, updated_at) VALUES (?, 2, 'other_task', 'queued', 0, ?, 'queued', ?, ?)`)
      .run(orderId, cdkId, now, now);
    rejectUnchanged();
  });

  it("retains a previous finished activation's card reference for history", () => {
    db.db.prepare(`INSERT INTO activations (order_id, activation_id, task_id, status, finished,
      cdk_id, worker_state, created_at, updated_at) VALUES (?, 2, 'old_task', 'failed', 1, ?, 'terminal', ?, ?)`)
      .run(orderId, cdkId, now, now);
    quarantineUnsubmittedInventoryCdk(db, activationId, cdkId, "disabled", () => {});
    expect(db.db.prepare("SELECT cdk_id FROM activations WHERE task_id='old_task'").get()?.cdk_id).toBe(cdkId);
  });

  it("rolls back isolation and detachment when audit persistence fails", () => {
    const audit = vi.spyOn(db, "recordOrderAudit").mockImplementation(() => { throw new Error("audit_unavailable"); });
    try { rejectUnchanged(); } finally { audit.mockRestore(); }
  });

  it("does not accept other upstream states despite a runtime caller bypassing TypeScript", () => {
    const before = snapshot();
    expect(() => quarantineUnsubmittedInventoryCdk(db, activationId, cdkId, "unused" as "disabled", () => {})).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it.each([0, 1])("read-only guard allows owned unsubmitted cards with issue_started=%s", issueStarted => {
    db.db.prepare("UPDATE activation_worker_control SET issue_started=? WHERE activation_id=?").run(issueStarted, activationId);
    const before = snapshot();
    const assertOwned = vi.fn();
    db.transaction(() => assertUnsubmittedCdkSafe(db, activationId, cdkId, assertOwned));
    expect(assertOwned).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(before);
  });

  it.each(["refunded", "submitted", "owner_changed", "finished", "lease_lost"])("read-only guard rejects %s", change => {
    if (change === "refunded") refund("processing");
    if (change === "submitted") db.db.prepare("UPDATE activations SET redemption_token='token' WHERE id=?").run(activationId);
    if (change === "owner_changed") db.db.prepare("UPDATE cdks SET assigned_activation_id=99 WHERE id=?").run(cdkId);
    if (change === "finished") db.db.prepare("UPDATE activations SET finished=1 WHERE id=?").run(activationId);
    const before = snapshot();
    expect(() => assertUnsubmittedCdkSafe(db, activationId, cdkId, () => {
      if (change === "lease_lost") throw new ActivationLeaseLost("stale-owner");
    })).toThrow();
    expect(snapshot()).toEqual(before);
  });
});
