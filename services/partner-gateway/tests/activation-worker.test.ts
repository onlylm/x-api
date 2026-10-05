import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { loadConfig, type AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { LiveZovoClient, MockZovoClient, ZovoUpstreamError, retryAfterMilliseconds, type ZovoClient } from "../src/clients/zovo.js";
import { ActivationService } from "../src/services/activation-service.js";
import { OrderService } from "../src/services/order-service.js";
import { ActivationWorker } from "../src/services/activation-worker.js";
import { ActivationControl, ActivationLeaseLost } from "../src/services/activation-control.js";
import { encryptValue } from "../src/security.js";

describe("durable activation retry safety", () => {
  let directory: string;
  let config: AppConfig;
  let db: AppDatabase;
  let zovo: MockZovoClient;
  let worker: ActivationWorker;
  let control: ActivationControl;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T00:00:00.000Z"));
    directory = mkdtempSync(join(tmpdir(), "quefa-retry-"));
    config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: join(directory, "test.sqlite"),
      SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });
    config.products = [{ product: "test_plus", name: "Test", name_zh: "测试", plan: "plus",
      cost_price: "99.00", max_sell_price: "159.00", currency: "CNY", max_qty: 1, enabled: true }];
    db = new AppDatabase(config.databasePath);
    db.seedProducts(config.products);
    zovo = new MockZovoClient();
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
    worker = new ActivationWorker(config, db, zovo, log);
    control = new ActivationControl(db);
  });

  afterEach(async () => {
    await worker.stop();
    db.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });

  async function task(suffix = "one") {
    const orders = new OrderService(db, new MockPaymentClient(config.publicBaseUrl), zovo);
    const { order } = await orders.createOrder({ product: "test_plus", quantity: 1,
      sellPrice: "139.00", clientOrderId: "TEST-" + suffix });
    db.markOrderPaid(order.order_id, new Date().toISOString(), "MOCK-" + suffix, "139.00");
    return new ActivationService(config, db).create(order.order_id,
      { user: { email: "customer@example.com" }, accessToken: "secret-customer-session" });
  }

  function inventory(id: string) {
    const card = db.insertReservedCdk({ upstreamCdkId: id, plan: "plus", redemptionDeviceId: `device-${id}`,
      encryptedCode: encryptValue(`ZC-${id}`, config.sessionEncryptionKey, "cdk"), activationId: 999,
      now: new Date().toISOString() });
    db.releaseCdk(card.id, new Date().toISOString());
    return card;
  }

  function markIssueStarted(activationId: number) {
    const lease = control.claim(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())!;
    expect(lease.activation.id).toBe(activationId);
    control.issueStarted(lease);
    control.release(lease);
  }

  function ownIssuedCdk(activationId: number, id: string, attached = true) {
    markIssueStarted(activationId);
    const card = db.insertReservedCdk({ upstreamCdkId: id, plan: "plus", redemptionDeviceId: `device-${id}`,
      encryptedCode: encryptValue(`ZC-${id}`, config.sessionEncryptionKey, "cdk"), activationId,
      now: new Date().toISOString() });
    if (attached) db.attachCdkToActivation(activationId, card.id, new Date().toISOString());
    return card;
  }

  it.each(["unused", "disabled", "frozen", "unknown"])("issues a new task's own CDK without inspecting or reserving unrelated %s stock", async (status) => {
    const a = await task();
    const old = inventory("old-stock"), other = inventory("other-stock");
    const reserve = vi.spyOn(db, "reserveUnusedCdk");
    const issue = vi.spyOn(zovo, "issueCdk"), redeem = vi.spyOn(zovo, "redeem");
    const check = vi.spyOn(zovo, "getCdkStatus").mockResolvedValue(status);
    await worker.tick();
    expect(reserve).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledExactlyOnceWith("plus", `cdk-${a.task_id}`);
    expect(redeem).toHaveBeenCalledTimes(1);
    for (const card of [old, other]) {
      expect(db.getCdk(card.id)).toMatchObject({ status: "unused", assigned_activation_id: null });
    }
    const current = db.listActivations(a.order_id)[0];
    expect(current.status).toBe("success");
    expect([old.id, other.id]).not.toContain(current.cdk_id);
  });

  it("issues a distinct CDK with each new task's own key even when unused inventory exists", async () => {
    const first = await task("first"), second = await task("second");
    const old = inventory("shared-unused");
    const issue = vi.spyOn(zovo, "issueCdk"), reserve = vi.spyOn(db, "reserveUnusedCdk");
    await worker.tick(); await worker.tick();
    expect(issue.mock.calls).toEqual([["plus", `cdk-${first.task_id}`], ["plus", `cdk-${second.task_id}`]]);
    expect(reserve).not.toHaveBeenCalled();
    const firstResult = db.listActivations(first.order_id)[0], secondResult = db.listActivations(second.order_id)[0];
    expect(firstResult.status).toBe("success"); expect(secondResult.status).toBe("success");
    expect(firstResult.cdk_id).not.toBe(secondResult.cdk_id);
    expect([firstResult.cdk_id, secondResult.cdk_id]).not.toContain(old.id);
    expect(db.getCdk(old.id)).toMatchObject({ status: "unused", assigned_activation_id: null });
  });

  it.each(["unused", "disabled", "unknown"])("holds legacy attached stock for review even if its upstream status would be %s", async status => {
    const a = await task(); const old = inventory("legacy-attached");
    db.reserveUnusedCdk("plus", a.id, new Date().toISOString());
    db.attachCdkToActivation(a.id, old.id, new Date().toISOString());
    const check = vi.spyOn(zovo, "getCdkStatus").mockResolvedValue(status);
    const issue = vi.spyOn(zovo, "issueCdk"), redeem = vi.spyOn(zovo, "redeem"), preview = vi.spyOn(zovo, "preview");
    await worker.tick();
    expect(check).not.toHaveBeenCalled(); expect(issue).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
    expect(db.getCdk(old.id)).toMatchObject({ status: "reserved", assigned_activation_id: a.id });
    expect(db.listActivations(a.order_id)[0]).toMatchObject({ cdk_id: old.id, finished: 0, redemption_token: null });
    expect(control.state(a.id)).toMatchObject({ issue_started: 0, needs_review: 1 });
  });

  it("continues the task's own issued card only after confirming it is unused", async () => {
    const a = await task(); const card = ownIssuedCdk(a.id, "own-unused");
    const check = vi.spyOn(zovo, "getCdkStatus").mockResolvedValue("unused");
    const issue = vi.spyOn(zovo, "issueCdk"), preview = vi.spyOn(zovo, "preview"), redeem = vi.spyOn(zovo, "redeem");
    await worker.tick();
    expect(check).toHaveBeenCalledExactlyOnceWith("own-unused");
    expect(issue).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledExactlyOnceWith("ZC-own-unused", "device-own-unused");
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(db.listActivations(a.order_id)[0]).toMatchObject({ cdk_id: card.id, status: "success" });
  });

  it.each(["disabled", "frozen", "consumed", "reserved", "review", "unknown", null, undefined])("does not replace or redeem the task's own issued card with upstream status %s", async status => {
    const a = await task(); const card = ownIssuedCdk(a.id, "own-uncertain");
    inventory("unrelated-unused");
    const check = vi.spyOn(zovo as ZovoClient, "getCdkStatus").mockResolvedValue(status as string | undefined);
    const issue = vi.spyOn(zovo, "issueCdk"), redeem = vi.spyOn(zovo, "redeem"), preview = vi.spyOn(zovo, "preview");
    await worker.tick();
    expect(check).toHaveBeenCalledExactlyOnceWith("own-uncertain");
    expect(issue).not.toHaveBeenCalled(); expect(redeem).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
    expect(db.getCdk(card.id)).toMatchObject({ status: "reserved", assigned_activation_id: a.id });
    expect(control.state(a.id)).toMatchObject({ issue_started: 1, needs_review: 1 });
    expect(db.listActivations(a.order_id)[0]).toMatchObject({ cdk_id: card.id, finished: 0, redemption_token: null });
  });

  it("defers a status timeout while retaining the task's own issued card", async () => {
    const a = await task(); const card = ownIssuedCdk(a.id, "own-timeout");
    vi.spyOn(zovo, "getCdkStatus").mockRejectedValue(new ZovoUpstreamError("timeout", 504));
    const issue = vi.spyOn(zovo, "issueCdk"), preview = vi.spyOn(zovo, "preview"), redeem = vi.spyOn(zovo, "redeem");
    await worker.tick();
    expect(issue).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled(); expect(redeem).not.toHaveBeenCalled();
    expect(db.getCdk(card.id)).toMatchObject({ status: "reserved", assigned_activation_id: a.id });
    expect(control.state(a.id)).toMatchObject({ issue_started: 1, needs_review: 0, next_retry_at: "2026-09-27T00:00:10.000Z" });
  });

  it.each(["redemption_token", "upstream_order_id"])("does not reprovision a corrupted queued task with %s", async field => {
    const a = await task(); inventory("unused");
    db.db.prepare(`UPDATE activations SET ${field} = 'submitted-before' WHERE id = ?`).run(a.id);
    const issue = vi.spyOn(zovo, "issueCdk"), preview = vi.spyOn(zovo, "preview");
    await worker.tick();
    expect(issue).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
    expect(control.state(a.id)?.needs_review).toBe(1);
  });

  it.each(["disabled", "unused"])("does not commit a recovered %s card after lease ownership changes during query", async status => {
    const a = await task(); const card = ownIssuedCdk(a.id, "lease-change", false);
    vi.spyOn(zovo, "getCdkStatus").mockImplementation(async () => {
      db.db.prepare("UPDATE activation_worker_control SET lease_token = 'other-owner' WHERE activation_id = ?").run(a.id);
      return status;
    });
    const issue = vi.spyOn(zovo, "issueCdk"), redeem = vi.spyOn(zovo, "redeem"), preview = vi.spyOn(zovo, "preview");
    await worker.tick();
    expect(issue).not.toHaveBeenCalled(); expect(redeem).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
    expect(db.getCdk(card.id)).toMatchObject({ status: "reserved", assigned_activation_id: a.id });
    expect(db.listActivations(a.order_id)[0]).toMatchObject({ cdk_id: null, redemption_token: null, finished: 0 });
    expect(control.state(a.id)).toMatchObject({ lease_token: "other-owner", needs_review: 0 });
  });

  it.each(["status", "preflight"])("does not recharge when payment changes while awaiting %s", async stage => {
    const a = await task(); ownIssuedCdk(a.id, "own-payment-change");
    const change = () => db.db.prepare("UPDATE orders SET status='refunded', refunded_at=? WHERE order_id=?")
      .run(new Date().toISOString(), a.order_id);
    if (stage === "status") vi.spyOn(zovo, "getCdkStatus").mockImplementation(async () => { change(); return "unused"; });
    else {
      const original = zovo.preflight.bind(zovo);
      vi.spyOn(zovo, "preflight").mockImplementation(async (...args) => { const result = await original(...args); change(); return result; });
    }
    const redeem = vi.spyOn(zovo, "redeem");
    await worker.tick(); expect(redeem).not.toHaveBeenCalled();
    expect(control.state(a.id)?.needs_review).toBe(1);
    expect(db.listActivations(a.order_id)[0].redemption_token).toBeNull();
  });

  it("retries in 5 seconds, persists the original issue key, and ignores a newly available unrelated CDK", async () => {
    const a = await task();
    const issue = vi.spyOn(zovo, "issueCdk");
    issue.mockRejectedValueOnce(new ZovoUpstreamError("lost response", 504, "upstream_timeout"));
    await worker.tick();
    expect(control.state(a.id)).toMatchObject({ attempts: 1, issue_started: 1, lease_token: null,
      next_retry_at: "2026-09-27T00:00:05.000Z" });
    expect(db.listActivations(a.order_id)[0].worker_locked_until).toBeNull();
    db.insertReservedCdk({ upstreamCdkId: "unrelated", plan: "plus", redemptionDeviceId: "unrelated-device",
      encryptedCode: encryptValue("ZC-UNRELATED", config.sessionEncryptionKey, "cdk"),
      activationId: 999, now: new Date().toISOString() });
    db.releaseCdk(db.db.prepare("SELECT id FROM cdks WHERE upstream_cdk_id = 'unrelated'").get()!.id as number,
      new Date().toISOString());
    await worker.tick();
    expect(issue).toHaveBeenCalledTimes(1);
    await worker.stop(); db.close();
    db = new AppDatabase(config.databasePath);
    worker = new ActivationWorker(config, db, zovo, log);
    control = new ActivationControl(db);
    vi.setSystemTime(new Date("2026-09-27T00:00:05.000Z"));
    await worker.tick();
    expect(issue).toHaveBeenCalledTimes(2);
    expect(issue.mock.calls[0]).toEqual(issue.mock.calls[1]);
    expect(db.db.prepare("SELECT status FROM cdks WHERE upstream_cdk_id = 'unrelated'").get()!.status).toBe("unused");
    expect(db.listActivations(a.order_id)[0].status).toBe("success");
  });

  it("limits attempts to one initial call plus three retries and exposes only neutral pending state", async () => {
    const a = await task();
    const issue = vi.spyOn(zovo, "issueCdk").mockRejectedValue(new ZovoUpstreamError("private-upstream-detail", 503, "upstream_unavailable"));
    for (const seconds of [0, 5, 15, 35, 100]) {
      vi.setSystemTime(new Date(Date.parse("2026-09-27T00:00:00Z") + seconds * 1000));
      await worker.tick();
    }
    expect(issue).toHaveBeenCalledTimes(4);
    expect(control.state(a.id)!.needs_review).toBe(1);
    expect(db.listActivations(a.order_id)[0]).toMatchObject({ finished: 0, failure_code: null });
    const external = JSON.stringify(new ActivationService(config, db).list(a.order_id));
    for (const privateField of ["upstream", "retry", "lease", "needs_review", "secret-customer-session", "卡密", "卡台"]) {
      expect(external).not.toContain(privateField);
    }
    expect(db.getAdminOrderDetail(a.order_id)!.audit.some((r: any) => r.action === "activation_review_required")).toBe(true);
    expect(db.claimProvisioning(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())).toBeUndefined();
  });

  it("honors Retry-After across different tasks without treating 429 as customer failure", async () => {
    const a = await task(); await task("two");
    const issue = vi.spyOn(zovo, "issueCdk").mockRejectedValueOnce(new ZovoUpstreamError("rate limited", 429, "RATE_LIMITED", 90_000));
    await worker.tick();
    vi.setSystemTime(new Date("2026-09-27T00:01:00Z"));
    await worker.tick();
    expect(issue).toHaveBeenCalledTimes(1);
    expect(db.listActivations(a.order_id)[0].finished).toBe(0);
    vi.setSystemTime(new Date("2026-09-27T00:01:30Z"));
    await worker.tick();
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("holds configuration failure %s for internal review, without refunding or failing the customer", async (status) => {
    const a = await task();
    vi.spyOn(zovo, "issueCdk").mockRejectedValue(new ZovoUpstreamError("credentials", status, "ACCESS_DENIED"));
    await worker.tick();
    expect(control.state(a.id)!.needs_review).toBe(1);
    expect(db.listActivations(a.order_id)[0].finished).toBe(0);
    expect(db.getOrder(a.order_id)!.status).toBe("paid");
    expect(db.getRefundByOrderId(a.order_id)).toBeUndefined();
  });

  it("never redeems again after an accepted request loses its response, even after worker restart", async () => {
    const a = await task();
    const originalRedeem = zovo.redeem.bind(zovo);
    const redeem = vi.spyOn(zovo, "redeem").mockImplementation(async (...args) => {
      await originalRedeem(...args);
      throw new ZovoUpstreamError("response lost", 504, "upstream_timeout");
    });
    const issue = vi.spyOn(zovo, "issueCdk");
    await worker.tick();
    expect(db.listActivations(a.order_id)[0]).toMatchObject({ worker_state: "polling", finished: 0 });
    await worker.stop();
    worker = new ActivationWorker(config, db, zovo, log);
    vi.setSystemTime(new Date("2026-09-27T00:00:04Z"));
    await worker.tick();
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(db.listActivations(a.order_id)[0].status).toBe("success");
  });

  it("does not refund, release or redeem again when acceptance is still unknown", async () => {
    const a = await task();
    const redeem = vi.spyOn(zovo, "redeem").mockRejectedValue(new ZovoUpstreamError("unknown", 409, "CONFLICT"));
    vi.spyOn(zovo, "getResult").mockRejectedValue(new ZovoUpstreamError("not indexed", 404));
    await worker.tick();
    vi.setSystemTime(new Date("2026-09-27T00:00:10Z")); await worker.tick();
    const current = db.listActivations(a.order_id)[0];
    expect(current.finished).toBe(0);
    expect(db.getCdk(current.cdk_id!)!.status).toBe("reserved");
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it.each([400,422])("finishes explicit subscription rejection %s and returns the platform failure code", async (status) => {
    const a=await task();
    const redeem=vi.spyOn(zovo,"redeem").mockRejectedValue(new ZovoUpstreamError("private provider message",status,"GPT_PLAN_ALREADY_ACTIVE"));
    const result=vi.spyOn(zovo,"getResult");
    vi.spyOn(zovo,"getCdkStatus").mockResolvedValue("unused");
    await worker.tick(); await worker.tick();
    const current=db.listActivations(a.order_id)[0];
    expect(current).toMatchObject({status:"failed",finished:1,failure_code:"account_has_subscription",
      message_zh:"账号现有订阅不支持开通该商品",worker_state:"terminal",session_ciphertext:null});
    expect(db.getCdk(current.cdk_id!)!.status).toBe("unused");
    expect(new ActivationService(config,db).list(a.order_id).items[0]).toMatchObject({
      status:"failed",finished:true,failure_code:"account_has_subscription",message_zh:"账号现有订阅不支持开通该商品"});
    expect(db.getOrder(a.order_id)!.status).toBe("paid");
    expect(db.getRefundByOrderId(a.order_id)).toBeUndefined();
    expect(redeem).toHaveBeenCalledTimes(1);expect(result).not.toHaveBeenCalled();
    expect(db.getAdminOrderDetail(a.order_id)!.audit.some((r:any)=>r.action==="activation_subscription_rejected")).toBe(true);
  });

  it.each(["consumed","unknown"])("does not recycle a CDK whose state is %s after explicit rejection",async(status)=>{
    const a=await task();
    vi.spyOn(zovo,"redeem").mockRejectedValue(new ZovoUpstreamError("rejected",400,"GPT_PLAN_ALREADY_ACTIVE"));
    vi.spyOn(zovo,"getCdkStatus").mockImplementation(async()=>{if(status==="unknown")throw new Error("query offline");return status;});
    await worker.tick();
    const current=db.listActivations(a.order_id)[0];
    expect(current.failure_code).toBe("account_has_subscription");
    expect(db.getCdk(current.cdk_id!)!.status).toBe("reserved");
    expect(db.getRefundByOrderId(a.order_id)).toBeUndefined();
  });

  it.each([[400,"OTHER"],[409,"GPT_PLAN_ALREADY_ACTIVE"],[429,"GPT_PLAN_ALREADY_ACTIVE"],[503,"GPT_PLAN_ALREADY_ACTIVE"]])(
    "does not treat ambiguous redeem response %s %s as definitive failure",async(status,code)=>{
      const a=await task();
      vi.spyOn(zovo,"redeem").mockRejectedValue(new ZovoUpstreamError("uncertain",Number(status),String(code)));
      await worker.tick();
      const current=db.listActivations(a.order_id)[0];
      expect(current).toMatchObject({finished:0,worker_state:"polling",failure_code:null});
      expect(db.getCdk(current.cdk_id!)!.status).toBe("reserved");
    });

  it.each([
    ["preflight","GPT_SESSION_INVALID","session_invalid"],
    ["preflight","GPT_ACCOUNT_NOT_ELIGIBLE","account_not_eligible"],
    ["preflight","GPT_IOS_PLUS_SUBSCRIPTION_CONFLICT","account_has_subscription"],
    ["redeem","GPT_SESSION_INVALID","session_invalid"],
    ["redeem","CLAUDE_SESSION_INVALID","session_invalid"],
    ["redeem","SESSION_REQUIRED","session_invalid"],
    ["redeem","GPT_ACCOUNT_NOT_ELIGIBLE","account_not_eligible"],
    ["redeem","GPT_IOS_PLUS_SUBSCRIPTION_CONFLICT","account_has_subscription"],
    ["redeem","REGION_UNSUPPORTED","region_unsupported"],
  ] as const)("明确拒绝 %s / %s 正确结束并释放次数",async(stage,code,expected)=>{
    const a=await task();
    vi.spyOn(zovo,stage).mockRejectedValue(new ZovoUpstreamError("private provider detail",422,code));
    vi.spyOn(zovo,"getCdkStatus").mockResolvedValue("unused");
    const result=vi.spyOn(zovo,"getResult");
    await worker.tick();await worker.tick();
    const current=db.listActivations(a.order_id)[0];
    expect(current).toMatchObject({status:"failed",finished:1,failure_code:expected,session_ciphertext:null});
    const progress=new ActivationService(config,db).list(a.order_id);
    expect(progress.activation_remaining).toBe(1);
    expect(progress.items[0]).toMatchObject({status:"failed",finished:true,failure_code:expected});
    expect(JSON.stringify(progress)).not.toContain("private provider detail");
    expect(result).not.toHaveBeenCalled();expect(db.getRefundByOrderId(a.order_id)).toBeUndefined();
  });

  it.each([400,422])("泛化 PRECHECK_REJECTED %s 不误报账号 Session 失效",async(status)=>{
    const a=await task();
    vi.spyOn(zovo,"preflight").mockRejectedValue(new ZovoUpstreamError("generic reject",status,"PRECHECK_REJECTED"));
    const redeem=vi.spyOn(zovo,"redeem");
    await worker.tick();
    expect(db.listActivations(a.order_id)[0]).toMatchObject({finished:0,failure_code:null});
    expect(control.state(a.id)?.needs_review).toBe(1);expect(redeem).not.toHaveBeenCalled();
  });

  it.each([
    ["GPT_SESSION_INVALID","session_invalid"],
    ["GPT_PLAN_ALREADY_ACTIVE","account_has_subscription"],
    ["GPT_ACCOUNT_NOT_ELIGIBLE","account_not_eligible"],
    ["REGION_UNSUPPORTED","region_unsupported"],
    ["VERIFICATION_TIMEOUT","verification_timeout"],
    ["UNKNOWN_NEW_CODE","other"],
  ] as const)("结果查询的失败 %s 返回标准原因且不复用未确认卡密",async(code,expected)=>{
    const a=await task();
    vi.spyOn(zovo,"getResult").mockResolvedValue({status:"cancelled",errorCode:code});
    vi.spyOn(zovo,"getCdkStatus").mockRejectedValue(new Error("mock unavailable"));
    await worker.tick();
    const current=db.listActivations(a.order_id)[0];
    expect(current).toMatchObject({status:"failed",finished:1,failure_code:expected});
    expect(db.getCdk(current.cdk_id!)?.status).toBe("reserved");
    expect(new ActivationService(config,db).list(a.order_id).activation_remaining).toBe(1);
  });

  it("上游 external_subscription 终态返回现有订阅不支持，而不是充值失败",async()=>{
    const a=await task();
    vi.spyOn(zovo,"getResult").mockResolvedValue({status:"failed_precharge",stage:"external_subscription",
      message:"不支持网页升级（应用商店/iOS/谷歌订阅）"});
    vi.spyOn(zovo,"getCdkStatus").mockRejectedValue(new Error("mock unavailable"));
    await worker.tick();
    expect(db.listActivations(a.order_id)[0]).toMatchObject({status:"failed",finished:1,
      failure_code:"account_has_subscription",message_zh:"账号现有订阅不支持开通该商品"});
    const progress=new ActivationService(config,db).list(a.order_id);
    expect(progress.items[0]).toMatchObject({status:"failed",finished:true,
      failure_code:"account_has_subscription",message_zh:"账号现有订阅不支持开通该商品"});
  });

  it("预检明确拒绝但卡密状态未知时，不回收卡密",async()=>{
    const a=await task();
    vi.spyOn(zovo,"preflight").mockRejectedValue(new ZovoUpstreamError("mock rejected",400,"GPT_SESSION_INVALID"));
    vi.spyOn(zovo,"getCdkStatus").mockResolvedValue("consumed");
    await worker.tick();
    const current=db.listActivations(a.order_id)[0];
    expect(current.finished).toBe(1);expect(db.getCdk(current.cdk_id!)?.status).toBe("reserved");
  });

  it("recovers a reserved CDK after a crash before attaching it to the activation", async () => {
    const a = await task();
    markIssueStarted(a.id);
    const cdk = db.insertReservedCdk({ upstreamCdkId: "already-issued", plan: "plus", redemptionDeviceId: "stable-device",
      encryptedCode: encryptValue("ZC-ALREADY-ISSUED", config.sessionEncryptionKey, "cdk"), activationId: a.id,
      now: new Date().toISOString() });
    const issue = vi.spyOn(zovo, "issueCdk");
    await worker.tick();
    expect(issue).not.toHaveBeenCalled();
    expect(db.listActivations(a.order_id)[0].cdk_id).toBe(cdk.id);
  });

  it("uses the CDK-bound device for both redemption and result queries", async () => {
    const a = await task();
    markIssueStarted(a.id);
    db.insertReservedCdk({ upstreamCdkId: "old-device", plan: "plus", redemptionDeviceId: "merchant-original-task",
      encryptedCode: encryptValue("ZC-BOUND", config.sessionEncryptionKey, "cdk"), activationId: a.id,
      now: new Date().toISOString() });
    const wire: ZovoClient = zovo;
    const preview = vi.spyOn(wire, "preview"), redeem = vi.spyOn(wire, "redeem"), result = vi.spyOn(wire, "getResult");
    await worker.tick();
    expect(preview.mock.calls[0][1]).toBe("merchant-original-task");
    expect(redeem.mock.calls[0][3]).toBe("merchant-original-task");
    expect(result.mock.calls[0][1]).toBe("merchant-original-task");
  });

  it("prevents two workers from claiming the same slow issue request and waits for shutdown", async () => {
    await task();
    let resolveIssue!: (v: { id: string; code: string; plan: "plus" }) => void;
    const issue = vi.spyOn(zovo, "issueCdk").mockImplementation(() => new Promise(resolve => { resolveIssue = resolve; }));
    const running = worker.tick();
    const other = new ActivationWorker(config, db, zovo, log);
    await other.tick();
    expect(issue).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    resolveIssue({ id: "single", code: "ZC-SINGLE", plan: "plus" });
    await running; await stopping; await other.stop();
    expect(stopped).toBe(true);
  });

  it("fences a stale lease owner and permits recovery only after expiry", async () => {
    const a = await task();
    const first = control.claim(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())!;
    expect(control.claim(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())).toBeUndefined();
    vi.setSystemTime(new Date("2026-09-27T00:01:01Z"));
    const second = control.claim(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())!;
    expect(second.activation.id).toBe(a.id);
    expect(() => control.assertOwned(first)).toThrow(ActivationLeaseLost);
    control.release(first);
    expect(control.state(a.id)!.lease_token).toBe(second.token);
    control.release(second);
  });

  it("renews a slow request lease beyond 60 seconds without allowing a second issuer", async () => {
    const a = await task();
    let done!: (v: { id: string; code: string; plan: "plus" }) => void;
    const issue = vi.spyOn(zovo, "issueCdk").mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const pending = worker.tick();
    await vi.advanceTimersByTimeAsync(65_000);
    const otherDb = new AppDatabase(config.databasePath);
    const otherControl = new ActivationControl(otherDb);
    try {
      expect(otherControl.claim(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())).toBeUndefined();
      expect(control.state(a.id)!.lease_until! > new Date().toISOString()).toBe(true);
    } finally { otherDb.close(); }
    done({ id: "slow-once", code: "ZC-SLOW", plan: "plus" });
    await pending;
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("recovers an expired legacy issue lease with the same key rather than switching CDKs", async () => {
    const a = await task();
    db.claimProvisioning(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
    const cdk = db.insertReservedCdk({ upstreamCdkId: "free-pool", plan: "plus", redemptionDeviceId: "free-device",
      encryptedCode: encryptValue("ZC-FREE", config.sessionEncryptionKey, "cdk"), activationId: 999,
      now: new Date().toISOString() });
    db.releaseCdk(cdk.id, new Date().toISOString());
    const wire: ZovoClient = zovo;
    const issue = vi.spyOn(wire, "issueCdk");
    vi.setSystemTime(new Date("2026-09-27T00:01:01Z"));
    await worker.tick();
    expect(issue).toHaveBeenCalledExactlyOnceWith("plus", "cdk-" + a.task_id);
    expect(db.getCdk(cdk.id)!.status).toBe("unused");
  });

  it("fences late issue responses after ownership loss, without redeeming", async () => {
    const a = await task();
    let done!: (v: { id: string; code: string; plan: "plus" }) => void;
    vi.spyOn(zovo, "issueCdk").mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const redeem = vi.spyOn(zovo, "redeem");
    const pending = worker.tick();
    db.db.prepare("UPDATE activation_worker_control SET lease_token = 'replacement-owner' WHERE activation_id = ?").run(a.id);
    done({ id: "late-issued", code: "ZC-LATE", plan: "plus" });
    await pending;
    expect(redeem).not.toHaveBeenCalled();
    expect(db.listActivations(a.order_id)[0].finished).toBe(0);
    expect(control.state(a.id)!.lease_token).toBe("replacement-owner");
  });

  it("does not repeatedly query indefinite pending results without flagging them for review", async () => {
    const a = await task();
    vi.spyOn(zovo, "getResult").mockResolvedValue({ status: "review" });
    await worker.tick();
    vi.setSystemTime(new Date("2026-09-27T00:31:00Z")); await worker.tick();
    expect(control.state(a.id)!.needs_review).toBe(1);
    expect(db.listActivations(a.order_id)[0].finished).toBe(0);
  });

  it("records stage timings without customer credentials or raw upstream errors", async () => {
    await task();
    vi.spyOn(zovo, "issueCdk").mockRejectedValue(new ZovoUpstreamError("secret-customer-session ZC-PRIVATE", 504, "upstream_timeout"));
    await worker.tick();
    const output = JSON.stringify([vi.mocked(log.info).mock.calls, vi.mocked(log.warn).mock.calls]);
    expect(output).toContain("durationMs");
    expect(output).toContain("activation stage interrupted");
    expect(output).not.toContain("secret-customer-session");
    expect(output).not.toContain("ZC-PRIVATE");
  });

  it("migrates only the new internal table and preserves existing financial data", async () => {
    const a = await task();
    const before = db.getOrder(a.order_id);
    new ActivationControl(db); new ActivationControl(db);
    expect(db.getOrder(a.order_id)).toEqual(before);
    expect(db.db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
  });
});

describe("upstream Retry-After parsing", () => {
  it("supports seconds and HTTP dates, ignores invalid values", () => {
    expect(retryAfterMilliseconds("90")).toBe(90_000);
    expect(retryAfterMilliseconds("Sun, 27 Sep 2026 00:01:00 GMT", Date.parse("2026-09-27T00:00:00Z"))).toBe(60_000);
    expect(retryAfterMilliseconds("invalid")).toBeUndefined();
    expect(retryAfterMilliseconds("-3")).toBeUndefined();
  });
  it("carries the real Retry-After header through the upstream client", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 429, error_code: "RATE_LIMITED" }),
      { status: 429, headers: { "retry-after": "90" } })));
    try {
      const client = new LiveZovoClient({ mode: "live", baseUrl: "https://mock.invalid", appId: "test", apiKey: "test", timeoutMs: 1000 });
      await expect(client.issueCdk("plus", "fixed-key")).rejects.toMatchObject({ httpStatus: 429, retryAfterMs: 90_000 });
    } finally { vi.unstubAllGlobals(); }
  });
});
