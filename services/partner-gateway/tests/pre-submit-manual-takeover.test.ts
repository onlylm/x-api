import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { AppDatabase } from "../src/database.js";
import { ActivationControl } from "../src/services/activation-control.js";
import { ActivationService } from "../src/services/activation-service.js";
import { ActivationWorker } from "../src/services/activation-worker.js";
import { OrderService } from "../src/services/order-service.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";

describe("预提交单任务人工接管（隔离库）", () => {
  let directory: string;
  let db: AppDatabase;
  let second: AppDatabase | undefined;
  let app: FastifyInstance;
  let config: ReturnType<typeof ledgerTestConfig>;
  let payment: MockPaymentClient;
  let zovo: MockZovoClient;
  let orders: OrderService;
  const admin = { "x-admin-token": "local-ledger-preview" };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "pre-submit-takeover-"));
    config = ledgerTestConfig(join(directory, "test.sqlite"));
    db = new AppDatabase(config.databasePath);
    payment = new MockPaymentClient(config.publicBaseUrl);
    zovo = new MockZovoClient();
    app = await buildApp(config, { db, payment, zovo, startWorkers: false });
    orders = new OrderService(db, payment, zovo);
  });

  afterEach(async () => {
    second?.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function queuedOrder(suffix = "one") {
    const { order } = await orders.createOrder({
      product: "chatgpt_plus_1m", quantity: 1, sellPrice: "126.00",
      clientOrderId: `po_presubmit_${suffix}`,
    });
    db.markOrderPaid(order.order_id, new Date().toISOString(), `mock-presubmit-${suffix}`, "126.00");
    const activation = new ActivationService(config, db).create(order.order_id, {
      user: { email: "buyer@example.com" }, accessToken: "test-only-session",
    });
    return { order, activation };
  }

  function action(orderId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST", url: `/admin/api/orders/${orderId}/actions`,
      headers: admin, payload: body,
    });
  }

  function begin(orderId: string, taskId = db.listActivations(orderId).at(-1)?.task_id) {
    return action(orderId, {
      action: "begin_manual_takeover", reason: "MT-20261005-000000101",
      expected_task_id: taskId,
    });
  }

  function activatedCount(orderId: string): number {
    return (db.db.prepare("SELECT COUNT(*) AS n FROM webhook_outbox WHERE event_key=?")
      .get(`${orderId}:order.activated`) as { n: number }).n;
  }

  it("领取真正未开始的 queued 任务后终止旧任务；人工成功才写进度和回调", async () => {
    const { order, activation } = await queuedOrder();
    const issue = vi.spyOn(zovo, "issueCdk");
    expect(activatedCount(order.order_id)).toBe(0);

    const claimed = await begin(order.order_id);
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().manual_takeover).toMatchObject({ status: "claimed", source_activation_id: activation.id });
    const original = db.listActivations(order.order_id)[0];
    expect(original).toMatchObject({ id: activation.id, status: "failed", finished: 1, worker_state: "terminal" });
    expect(original.session_ciphertext).toBeNull();
    expect(original.cdk_id).toBeNull();
    expect(original.redemption_token).toBeNull();
    expect(original.upstream_order_id).toBeNull();
    expect(activatedCount(order.order_id)).toBe(0);
    expect(JSON.stringify(db.getAdminOrderDetail(order.order_id)?.audit)).not.toContain("test-only-session");

    await new ActivationWorker(config, db, zovo, app.log).tick();
    expect(issue).not.toHaveBeenCalled();
    const resubmit = await app.inject({
      method: "POST", url: `/api/v1/checkout/orders/${order.order_id}/activate`,
      headers: { "x-api-key": config.platformApiKey },
      payload: { session_data: { user: { email: "buyer@example.com" }, accessToken: "different-test-session" } },
    });
    expect(resubmit.statusCode).toBe(409);
    expect(resubmit.json().error).toBe("manual_takeover_in_progress");

    const confirmed = await action(order.order_id, {
      action: "confirm_manual_delivery", reason: "MT-20261005-000000101",
      account_email: "buyer@example.com", verified: true,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(db.getManualActivationTakeover(order.order_id)?.status).toBe("completed");
    expect(activatedCount(order.order_id)).toBe(1);
    const progress = await app.inject({
      method: "GET", url: `/api/v1/checkout/orders/${order.order_id}/activation`,
      headers: { "x-api-key": config.platformApiKey },
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({ activation_used: 1, activation_remaining: 0 });
    expect(progress.json().items).toContainEqual(expect.objectContaining({
      status: "success", finished: true, account_email: "b***r@example.com",
    }));
    expect((await action(order.order_id, {
      action: "confirm_manual_delivery", reason: "MT-20261005-000000101",
      account_email: "buyer@example.com", verified: true,
    })).statusCode).toBe(409);
    expect(activatedCount(order.order_id)).toBe(1);
  });

  it("预提交接管必须指定刚核实的任务号；遗漏或旧任务号不改变订单", async () => {
    const { order, activation } = await queuedOrder("exact-task");
    for (const body of [
      { action: "begin_manual_takeover", reason: "MT-20261005-000000101" },
      { action: "begin_manual_takeover", reason: "MT-20261005-000000101", expected_task_id: "tsk_stale" },
    ]) {
      const denied = await action(order.order_id, body);
      expect(denied.statusCode).toBe(409);
      expect(db.getManualActivationTakeover(order.order_id)).toBeUndefined();
      expect(db.listActivations(order.order_id)[0]).toMatchObject({ id: activation.id, finished: 0 });
    }
    expect((await begin(order.order_id, activation.task_id)).statusCode).toBe(200);
  });

  it("历史失败任务加最新 queued 任务时，只取消准确指定的最新任务", async () => {
    const { order, activation: previous } = await queuedOrder("retry-queued");
    const now = new Date().toISOString();
    db.markActivationFailed(previous.id, "payment_blocked", "旧任务已明确失败", now);
    const latest = new ActivationService(config, db).create(order.order_id, {
      user: { email: "buyer@example.com" }, accessToken: "retry-test-session",
    });
    expect((await begin(order.order_id, previous.task_id)).statusCode).toBe(409);
    expect(db.listActivations(order.order_id)[1]).toMatchObject({ id: latest.id, finished: 0 });
    expect((await begin(order.order_id, latest.task_id)).statusCode).toBe(200);
    expect(db.getManualActivationTakeover(order.order_id)?.source_activation_id).toBe(latest.id);
    expect(db.listActivations(order.order_id)).toMatchObject([
      { id: previous.id, status: "failed", finished: 1 },
      { id: latest.id, status: "failed", finished: 1, session_ciphertext: null },
    ]);
  });

  it.each([
    "active_lease", "stale_control", "issue_started", "attached_cdk", "assigned_cdk",
    "redemption_token", "upstream_order_id", "needs_review", "polling",
  ])("%s 留有潜在上游副作用时拒绝接管，不凭上游单号为空判定安全", async (condition) => {
    const { order, activation } = await queuedOrder(condition);
    const now = new Date().toISOString();
    const control = new ActivationControl(db);
    if (condition === "active_lease") {
      const lease = control.claim(now, new Date(Date.now() + 60_000).toISOString());
      expect(lease?.activation.id).toBe(activation.id);
    } else if (["stale_control", "issue_started", "needs_review"].includes(condition)) {
      db.db.prepare(`INSERT INTO activation_worker_control
        (activation_id, issue_started, needs_review, updated_at) VALUES (?, ?, ?, ?)`).run(
          activation.id, condition === "issue_started" ? 1 : 0,
          condition === "needs_review" ? 1 : 0, now,
        );
    } else if (condition === "attached_cdk" || condition === "assigned_cdk") {
      const card = db.insertReservedCdk({
        upstreamCdkId: `presubmit-${condition}`, plan: "plus", redemptionDeviceId: "test-device",
        encryptedCode: { ciphertext: "test", iv: "test", tag: "test" },
        activationId: activation.id, now,
      });
      if (condition === "attached_cdk") db.attachCdkToActivation(activation.id, card.id, now);
    } else if (condition === "redemption_token" || condition === "upstream_order_id") {
      db.db.prepare(`UPDATE activations SET ${condition}=? WHERE id=?`).run("upstream-value", activation.id);
    } else {
      db.db.prepare("UPDATE activations SET worker_state='polling',status='running' WHERE id=?").run(activation.id);
    }
    const denied = await begin(order.order_id);
    expect(denied.statusCode).toBe(409);
    expect(db.getManualActivationTakeover(order.order_id)).toBeUndefined();
    expect(db.listActivations(order.order_id)[0]).toMatchObject({ finished: 0 });
    expect(activatedCount(order.order_id)).toBe(0);
  });

  it("控制表缺失时保守拒绝，不把缺表误判为任务未领取", async () => {
    const { order, activation } = await queuedOrder("missing-control-table");
    db.db.exec("DROP TABLE activation_worker_control");
    const result = await begin(order.order_id);
    expect(result.statusCode).toBe(409);
    expect(db.getManualActivationTakeover(order.order_id)).toBeUndefined();
    expect(db.listActivations(order.order_id)[0]).toMatchObject({ id: activation.id, finished: 0 });
  });

  it("已有退款记录或成功履约不能被预提交接管覆盖", async () => {
    const refunding = await queuedOrder("refund-existing");
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO refunds
      (refund_id,order_id,client_refund_id,amount,reason,status,requested_by,
       alipay_trade_no,created_at,updated_at)
      VALUES (?,?,?,?,?,'requested','admin',?,?,?)`).run(
        "RF-PRESUBMIT", refunding.order.order_id, "refund-presubmit", "126.00", "历史退款申请",
        "mock-presubmit-refund-existing", now, now,
      );
    expect((await begin(refunding.order.order_id)).statusCode).toBe(409);
    expect(db.getManualActivationTakeover(refunding.order.order_id)).toBeUndefined();

    const succeeded = await queuedOrder("already-success");
    db.markActivationSuccess(succeeded.activation.id, "b***r@example.com", now);
    expect((await begin(succeeded.order.order_id)).statusCode).toBe(409);
    expect(db.getManualActivationTakeover(succeeded.order.order_id)).toBeUndefined();
    expect(activatedCount(succeeded.order.order_id)).toBe(1);
  });

  it("人工接管阻止主动退款，但真实发生的外部退款仍可核销", async () => {
    const { order } = await queuedOrder("external-refund");
    expect((await begin(order.order_id)).statusCode).toBe(200);
    const requested = await app.inject({
      method: "POST", url: `/api/v1/checkout/orders/${order.order_id}/refund`,
      headers: { "x-api-key": config.platformApiKey },
      payload: { refund_id: "refund-while-claimed", reason: "接管中禁止主动退款" },
    });
    expect(requested.statusCode).toBe(409);
    expect(requested.json().error).toBe("manual_takeover_blocks_refund");

    payment.markExternallyRefunded(order.order_id);
    const verified = await action(order.order_id, {
      action: "confirm_external_refund", reason: "支付渠道真实退款已发生：工单 MT-20261005-000000101",
    });
    expect(verified.statusCode).toBe(200);
    expect(db.getOrder(order.order_id)?.status).toBe("refunded");
    expect(db.getManualActivationTakeover(order.order_id)?.status).toBe("review_required");
    expect(activatedCount(order.order_id)).toBe(0);
  });

  it("双数据库连接同时争领只建立一个接管记录，worker 不再能领取旧任务", async () => {
    const { order, activation } = await queuedOrder("two-connections");
    second = new AppDatabase(config.databasePath);
    const [first, again] = await Promise.all([
      Promise.resolve().then(() => db.beginManualActivationTakeover(
        order.order_id, "MT-20261005-000000101", activation.task_id)),
      Promise.resolve().then(() => second!.beginManualActivationTakeover(
        order.order_id, "MT-20261005-000000101", activation.task_id)),
    ]);
    expect(first.id).toBe(again.id);
    const count = db.db.prepare("SELECT COUNT(*) AS n FROM manual_activation_takeovers WHERE order_id=?")
      .get(order.order_id) as { n: number };
    expect(count.n).toBe(1);
    expect(db.listActivations(order.order_id)[0]).toMatchObject({ id: activation.id, finished: 1 });
    expect(new ActivationControl(second).claim(new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString())).toBeUndefined();
  });

  it("若另一个连接的 worker 已先取得 lease，人工接管不能覆盖该任务", async () => {
    const { order, activation } = await queuedOrder("worker-won");
    second = new AppDatabase(config.databasePath);
    const lease = new ActivationControl(second).claim(new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString());
    expect(lease?.activation.id).toBe(activation.id);
    expect((await begin(order.order_id)).statusCode).toBe(409);
    expect(db.getManualActivationTakeover(order.order_id)).toBeUndefined();
    expect(db.listActivations(order.order_id)[0]).toMatchObject({ finished: 0, worker_state: "provisioning" });
  });
});
