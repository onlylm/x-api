import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { AppDatabase } from "../src/database.js";
import { ActivationService } from "../src/services/activation-service.js";
import { OrderService } from "../src/services/order-service.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";

describe("人工开通接管（隔离库与模拟上游）", () => {
  let directory: string;
  let db: AppDatabase;
  let app: FastifyInstance;
  let config: ReturnType<typeof ledgerTestConfig>;
  let orders: OrderService;
  let payment: MockPaymentClient;
  const admin = { "x-admin-token": "local-ledger-preview" };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "manual-takeover-"));
    config = ledgerTestConfig(join(directory, "test.sqlite"));
    db = new AppDatabase(config.databasePath);
    const zovo = new MockZovoClient();
    payment = new MockPaymentClient(config.publicBaseUrl);
    app = await buildApp(config, { db, zovo, payment, startWorkers: false });
    orders = new OrderService(db, payment, zovo);
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function paidOrder(): Promise<string> {
    const { order } = await orders.createOrder({
      product: "chatgpt_plus_1m",
      quantity: 1,
      sellPrice: "135.00",
      clientOrderId: "po_manual_takeover_test",
    });
    db.markOrderPaid(order.order_id, new Date().toISOString(), "mock-manual-takeover", "135.00");
    return order.order_id;
  }

  async function failedAttempt(orderId: string) {
    const activation = new ActivationService(config, db).create(orderId, {
      user: { email: "buyer@example.com" },
      accessToken: "test-only-session",
    });
    const now = new Date().toISOString();
    const cdk = db.insertReservedCdk({
      upstreamCdkId: "test-cdk-1",
      plan: "plus",
      redemptionDeviceId: "test-device",
      encryptedCode: { ciphertext: "test", iv: "test", tag: "test" },
      activationId: activation.id,
      now,
    });
    db.attachCdkToActivation(activation.id, cdk.id, now);
    db.markActivationFailed(activation.id, "payment_blocked", "原任务已明确失败", now);
    return { activation, cdk };
  }

  function action(orderId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/admin/api/orders/${orderId}/actions`,
      headers: admin,
      payload: body,
    });
  }

  it("没有明确失败的原任务时不能接管", async () => {
    const orderId = await paidOrder();
    const request = { action: "begin_manual_takeover", reason: "MT-20261005-000000001" };
    expect((await action(orderId, request)).statusCode).toBe(409);
    const pending = new ActivationService(config, db).create(orderId, {
      user: { email: "buyer@example.com" },
      accessToken: "test-only-session",
    });
    db.db.prepare("INSERT INTO activation_worker_control(activation_id,needs_review,updated_at) VALUES (?,1,?)")
      .run(pending.id, new Date().toISOString());
    expect((await action(orderId, request)).statusCode).toBe(409);
    expect(db.getManualActivationTakeover(orderId)).toBeUndefined();
    expect(db.db.prepare("SELECT 1 FROM webhook_outbox WHERE event_key=?")
      .get(`${orderId}:order.activated`)).toBeUndefined();
  });

  it("先锁定失败任务，再人工成功；期间阻止自动重提和退款且不误耗原 CDK", async () => {
    const orderId = await paidOrder();
    const { cdk } = await failedAttempt(orderId);
    const completed = {
      action: "confirm_manual_delivery",
      reason: "MT-20261005-000000001",
      account_email: "buyer@example.com",
      verified: true,
    };
    expect((await action(orderId, completed)).statusCode).toBe(409);

    const begin = await action(orderId, { action: "begin_manual_takeover", reason: "MT-20261005-000000001" });
    expect(begin.statusCode).toBe(200);
    expect(begin.json().manual_takeover.status).toBe("claimed");
    expect((await action(orderId, { action: "begin_manual_takeover", reason: "MT-20261005-000000001" })).statusCode).toBe(200);
    const auditCount = db.db.prepare("SELECT COUNT(*) n FROM order_audit_log WHERE order_id=? AND action='manual_activation_takeover_claimed'")
      .get(orderId) as { n: number };
    expect(auditCount.n).toBe(1);

    const resubmit = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/activate`,
      headers: { "x-api-key": config.platformApiKey },
      payload: { session_data: { user: { email: "buyer@example.com" }, accessToken: "new-test-session" } },
    });
    expect(resubmit.statusCode).toBe(409);
    expect(resubmit.json().error).toBe("manual_takeover_in_progress");
    const refund = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers: { "x-api-key": config.platformApiKey },
      payload: { refund_id: "test-refund-mt-001", reason: "测试接管期间退款" },
    });
    expect(refund.statusCode).toBe(409);
    expect(refund.json().error).toBe("manual_takeover_blocks_refund");
    expect(db.getRefundByOrderId(orderId)).toBeUndefined();

    const wrongAccount = await action(orderId, { ...completed, account_email: "someone-else@example.com" });
    expect(wrongAccount.statusCode).toBe(409);
    expect(db.getManualActivationTakeover(orderId)?.status).toBe("claimed");
    expect(db.db.prepare("SELECT 1 FROM webhook_outbox WHERE event_key=?")
      .get(`${orderId}:order.activated`)).toBeUndefined();

    const confirm = await action(orderId, completed);
    expect(confirm.statusCode).toBe(200);
    expect(db.getManualActivationTakeover(orderId)?.status).toBe("completed");
    expect(db.getCdk(cdk.id)?.status).toBe("reserved");
    const rows = db.listActivations(orderId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: "success", finished: 1, cdk_id: null, redemption_token: null });
    expect(new ActivationService(config, db).list(orderId)).toMatchObject({
      activation_used: 1,
      activation_remaining: 0,
    });
    const webhook = db.db.prepare("SELECT event FROM webhook_outbox WHERE event_key=?")
      .get(`${orderId}:order.activated`) as { event: string } | undefined;
    expect(webhook?.event).toBe("order.activated");
    expect((await action(orderId, completed)).statusCode).toBe(409);
  });

  it("已有退款请求或含 Session 的备注不能开始接管", async () => {
    const orderId = await paidOrder();
    await failedAttempt(orderId);
    const secret = await action(orderId, {
      action: "begin_manual_takeover",
      reason: "accessToken: sensitive-test-value",
    });
    expect(secret.statusCode).toBe(422);
    expect(db.getManualActivationTakeover(orderId)).toBeUndefined();
    db.createRefund({
      refundId: "RF-TEST-TAKEOVER",
      orderId,
      clientRefundId: "refund-takeover-test",
      amount: "135.00",
      reason: "测试已有退款",
      requestedBy: "admin",
      now: new Date().toISOString(),
    });
    expect((await action(orderId, {
      action: "begin_manual_takeover",
      reason: "MT-20261005-000000002",
    })).statusCode).toBe(409);
  });

  it("接管锁阻止主动退款，但已发生的外部退款仍可核验入账", async () => {
    const orderId = await paidOrder();
    await failedAttempt(orderId);
    expect((await action(orderId, {
      action: "begin_manual_takeover",
      reason: "MT-20261005-000000002",
    })).statusCode).toBe(200);
    const sync = { action: "confirm_external_refund", reason: "核验支付宝已发生的退款，工单 MT-002" };
    expect((await action(orderId, sync)).statusCode).toBe(409);
    expect(db.getRefundByOrderId(orderId)).toBeUndefined();

    payment.markExternallyRefunded(orderId);
    const confirmed = await action(orderId, sync);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().refund.status).toBe("succeeded");
    expect(db.getOrder(orderId)?.status).toBe("refunded");
    expect(db.getManualActivationTakeover(orderId)?.status).toBe("review_required");
    expect((await action(orderId, {
      action: "confirm_manual_delivery",
      reason: "MT-20261005-000000002",
      account_email: "buyer@example.com",
      verified: true,
    })).statusCode).toBe(409);
    const event = db.db.prepare("SELECT event FROM webhook_outbox WHERE event_key=?")
      .get(`${orderId}:order.refunded`) as { event: string } | undefined;
    expect(event?.event).toBe("order.refunded");
  });

  it("误接管只有确认尚未开始人工操作并留下工单号后才能解除", async () => {
    const orderId = await paidOrder();
    await failedAttempt(orderId);
    expect((await action(orderId, { action: "begin_manual_takeover", reason: "MT-20261005-000000003" })).statusCode).toBe(200);
    const release = { action: "release_manual_takeover_not_started", reason: "MT-20261005-000000003" };
    expect((await action(orderId, release)).statusCode).toBe(422);
    expect(db.hasActiveManualActivationTakeover(orderId)).toBe(true);
    const confirmed = await action(orderId, { ...release, verified: true });
    expect(confirmed.statusCode).toBe(200);
    expect(db.getManualActivationTakeover(orderId)?.status).toBe("released");
    expect(db.getAdminOrderDetail(orderId)?.audit.some((entry) =>
      entry.action === "manual_activation_takeover_released")).toBe(true);
    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/activate`,
      headers: { "x-api-key": config.platformApiKey },
      payload: { session_data: { user: { email: "buyer@example.com" }, accessToken: "new-test-session" } },
    });
    expect(retry.statusCode).toBe(200);
  });

  it("人工尝试失败或结果未知保持锁；只有复核明确未开通才可解除", async () => {
    const orderId = await paidOrder();
    await failedAttempt(orderId);
    expect((await action(orderId, { action: "begin_manual_takeover", reason: "MT-20261005-000000004" })).statusCode).toBe(200);
    const issue = await action(orderId, { action: "report_manual_takeover_issue", reason: "MT-20261005-000000004" });
    expect(issue.statusCode).toBe(200);
    expect(issue.json().manual_takeover.status).toBe("review_required");
    expect(db.hasActiveManualActivationTakeover(orderId)).toBe(true);
    const refundWhileUnknown = await app.inject({
      method: "POST",
      url: `/api/v1/checkout/orders/${orderId}/refund`,
      headers: { "x-api-key": config.platformApiKey },
      payload: { refund_id: "refund-unknown-mt", reason: "未知结果仍应阻止主动退款" },
    });
    expect(refundWhileUnknown.statusCode).toBe(409);
    expect((await action(orderId, {
      action: "release_manual_takeover_not_started", reason: "MT-20261005-000000004", verified: true,
    })).statusCode).toBe(409);
    expect((await action(orderId, {
      action: "release_manual_takeover_confirmed_failed", reason: "MT-20261005-000000004",
    })).statusCode).toBe(422);
    expect((await action(orderId, {
      action: "confirm_manual_delivery", reason: "MT-20261005-000000004",
      account_email: "buyer@example.com",
    })).statusCode).toBe(422);
    expect(db.db.prepare("SELECT 1 FROM webhook_outbox WHERE event_key=?")
      .get(`${orderId}:order.activated`)).toBeUndefined();
    const release = await action(orderId, {
      action: "release_manual_takeover_confirmed_failed", reason: "MT-20261005-000000004", verified: true,
    });
    expect(release.statusCode).toBe(200);
    expect(db.getManualActivationTakeover(orderId)?.status).toBe("released");
  });

  it("即使出现旧退款申请，接管中也不能批准执行资金退款", async () => {
    const orderId = await paidOrder();
    await failedAttempt(orderId);
    expect((await action(orderId, {
      action: "begin_manual_takeover", reason: "MT-20261005-000000006",
    })).statusCode).toBe(200);
    db.db.prepare(`INSERT INTO refunds
      (refund_id,order_id,client_refund_id,amount,reason,status,requested_by,
       alipay_trade_no,created_at,updated_at)
      VALUES (?,?,?,?,?,'requested','admin',?,?,?)`)
      .run("RF-OLD-MT", orderId, "refund-old-mt", "135.00", "旧请求核查",
        "mock-manual-takeover", new Date().toISOString(), new Date().toISOString());
    expect(() => db.approveRefund({
      refundId: "RF-OLD-MT",
      reason: "接管期间不得执行",
      now: new Date().toISOString(),
    })).toThrow("manual_takeover_blocks_refund");
  });

  it("待核查后若最终确认人工成功，可明确登记成功并关闭接管锁", async () => {
    const orderId = await paidOrder();
    await failedAttempt(orderId);
    expect((await action(orderId, { action: "begin_manual_takeover", reason: "MT-20261005-000000005" })).statusCode).toBe(200);
    expect((await action(orderId, { action: "report_manual_takeover_issue", reason: "MT-20261005-000000005" })).statusCode).toBe(200);
    expect(db.getManualActivationTakeover(orderId)?.status).toBe("review_required");
    const confirmed = await action(orderId, {
      action: "confirm_manual_delivery",
      reason: "MT-20261005-000000005",
      account_email: "buyer@example.com",
      verified: true,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(db.getManualActivationTakeover(orderId)?.status).toBe("completed");
    expect(db.getOrder(orderId)?.delivery_status).toBe("success");
  });
});
