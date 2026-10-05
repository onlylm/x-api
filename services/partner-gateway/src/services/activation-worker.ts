import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import { AppDatabase } from "../database.js";
import {
  definitiveActivationFailure,
  isXGiftPlan,
  mapUpstreamFailure,
  mapZovoStatus,
  maskEmail,
  normalizeXUsername,
  xGiftProductCode,
  type ActivationRecord,
  type FailureCode,
  type ProductPlan,
} from "../domain.js";
import { decryptValue, encryptValue } from "../security.js";
import type { CdkRecord } from "../domain.js";
import { ZovoUpstreamError, type ZovoClient } from "../clients/zovo.js";
import { DisabledXApiClient, XApiUpstreamError, type XApiClient, type XApiOrder } from "../clients/x-api.js";
import { ActivationService, encryptedFromActivation } from "./activation-service.js";
import { ActivationControl, ActivationLeaseLost, type ActivationLease } from "./activation-control.js";
import { assertUnsubmittedCdkSafe } from "./cdk-reuse-guard.js";

export class ActivationWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly control: ActivationControl;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly zovo: ZovoClient,
    private readonly log: FastifyBaseLogger,
    private readonly xApi: XApiClient = new DisabledXApiClient(),
  ) { this.control = new ActivationControl(db); }

  start(): void {
    if (this.timer) return;
    const run = () => void this.tick().catch(() => this.log.error("activation worker cycle failed; will retry safely"));
    this.timer = setInterval(run, this.config.activationPollIntervalMs);
    this.timer.unref();
    run();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      new ActivationService(this.config, this.db).reconcilePaidOrders();
      await this.provisionOne();
      await this.pollRunning();
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async provisionOne(): Promise<void> {
    const now = new Date();
    const lease = this.control.claim(now.toISOString(), this.leaseUntil());
    if (!lease) return;
    const activation = lease.activation;
    const heartbeat = this.heartbeat(lease);
    let cdk: CdkRecord | undefined;
    let stage: "issue" | "cdk_status" | "preview" | "preflight" | "redeem" = "issue";
    try {
      const order = this.db.getOrder(activation.order_id);
      if (!order) throw new Error("order_not_found");
      if (isXGiftPlan(order.plan)) {
        await this.provisionXGift(lease, activation, order.plan);
        return;
      }
      if (this.control.state(activation.id)!.attempts > 4) {
        this.control.review(lease, "issue", "retry_limit_after_restart");
        return;
      }
      this.log.info({ activationId: activation.id, taskId: activation.task_id,
        queueAgeMs: Date.now() - Date.parse(activation.created_at),
        attempt: this.control.state(activation.id)!.attempts }, "activation preparation started");
      if (activation.redemption_token || activation.upstream_order_id) {
        this.control.review(lease, "cdk_status", "submitted_task_in_provisioning");
        return;
      }
      const session = JSON.parse(
        decryptValue(encryptedFromActivation(activation), this.config.sessionEncryptionKey, "session"),
      ) as Record<string, unknown>;
      cdk = activation.cdk_id ? this.db.getCdk(activation.cdk_id) : undefined;
      if (!cdk) {
        cdk = this.db.db.prepare("SELECT * FROM cdks WHERE assigned_activation_id = ? AND status = 'reserved' LIMIT 1")
          .get(activation.id) as unknown as CdkRecord | undefined;
      }
      // One task, one idempotent issuance. Never allocate unrelated/old inventory.
      // Only a card recovered from this task's own issue request may be continued.
      if (cdk) {
        if (!this.control.state(activation.id)!.issue_started) {
          this.control.review(lease, "cdk_status", "legacy_inventory_requires_review");
          return;
        }
        if (cdk.status !== "reserved" || cdk.assigned_activation_id !== activation.id) {
          this.control.review(lease, "cdk_status", "cdk_ownership_conflict");
          return;
        }
        stage = "cdk_status";
        const upstreamStatus = await this.stage(lease, stage, () => this.zovo.getCdkStatus(cdk!.upstream_cdk_id));
        if (upstreamStatus !== "unused") {
          this.control.review(lease, stage, "cdk_not_confirmed_reusable");
          return;
        }
      }
      if (!cdk) {
        stage = "issue";
        this.control.issueStarted(lease);
        const issued = await this.stage(lease, "issue", () => this.zovo.issueCdk(order.plan, `cdk-${activation.task_id}`));
        cdk = this.db.insertReservedCdk({
          upstreamCdkId: issued.id,
          plan: order.plan,
          redemptionDeviceId: deviceFor(activation.task_id),
          encryptedCode: encryptValue(issued.code, this.config.sessionEncryptionKey, "cdk"),
          activationId: activation.id,
          now: new Date().toISOString(),
        });
      }
      if (cdk.status !== "reserved" || cdk.assigned_activation_id !== activation.id) {
        this.control.review(lease, stage, "cdk_ownership_conflict");
        return;
      }
      assertUnsubmittedCdkSafe(this.db, activation.id, cdk.id, () => this.control.assertOwned(lease));
      this.db.attachCdkToActivation(activation.id, cdk.id, new Date().toISOString());
      const code = decryptValue(
        { ciphertext: cdk.code_ciphertext, iv: cdk.code_iv, tag: cdk.code_tag },
        this.config.sessionEncryptionKey,
        "cdk",
      );
      const deviceId = this.db.ensureCdkRedemptionDevice(
        cdk.id,
        deviceFor(activation.task_id),
        new Date().toISOString(),
      );
      stage = "preview";
      const preview = await this.stage(lease, stage, () => this.zovo.preview(code, deviceId));
      stage = "preflight";
      const preflight = await this.stage(lease, stage, () => this.zovo.preflight(preview.redemptionToken, session, deviceId));
      const sessionEmail = String((session.user as Record<string, unknown> | undefined)?.email ?? "")
        .trim()
        .toLowerCase();
      if (!preflight.email || preflight.email.trim().toLowerCase() !== sessionEmail) {
        const reusable = await this.cdkIsReusable(lease, cdk);
        this.finish(lease, () => {
          if (reusable) this.db.releaseCdk(cdk!.id, new Date().toISOString());
          this.db.markActivationFailed(
          activation.id,
          "session_invalid",
          "Session 邮箱与预检账号不一致",
          new Date().toISOString(),
          );
        });
        return;
      }

      // 在发起 redeem 前先持久化 token。即使请求超时，也只查结果，绝不盲目创建第二单。
      this.db.transaction(() => {
        assertUnsubmittedCdkSafe(this.db, activation.id, cdk!.id, () => this.control.assertOwned(lease));
        this.db.setActivationPrepared({
          id: activation.id,
          cdkId: cdk!.id,
          redemptionToken: preview.redemptionToken,
          upstreamOrderId: null,
          now: new Date().toISOString(),
        });
      });
      stage = "redeem";
      const accepted = await this.stage(lease, stage, () => this.zovo.redeem(
        preview.redemptionToken,
        preflight.preflightToken,
        activation.task_id,
        deviceId,
      ));
      this.db.setActivationUpstreamOrder(activation.id, accepted.orderId, new Date().toISOString());
    } catch (error) {
      if (error instanceof ActivationLeaseLost) return;
      const errorCode = safeErrorCode(error);
      const httpStatus = error instanceof ZovoUpstreamError ? error.httpStatus : undefined;
      // This is an explicit pre-acceptance business rejection, not an uncertain transport outcome.
      // Keep the allowlist narrow: unknown 4xx, timeouts, 429 and 5xx must remain query-only.
      const rejected = definitiveActivationFailure(errorCode, httpStatus);
      if (stage === "redeem" && rejected) {
        let reusable = false;
        if (cdk) {
          try {
            reusable = (await this.stage(lease, "rejected_cdk_status",
              () => this.zovo.getCdkStatus(cdk!.upstream_cdk_id))) === "unused";
          } catch (statusError) {
            if (statusError instanceof ActivationLeaseLost) throw statusError;
            // A failed status check cannot undo the explicit rejection or authorize CDK reuse.
          }
        }
        this.finish(lease, () => {
          const finishedAt = new Date().toISOString();
          if (cdk && reusable) this.db.releaseCdk(cdk.id, finishedAt);
          this.db.markActivationFailed(activation.id, rejected, failureMessage(rejected), finishedAt);
          this.db.recordOrderAudit({orderId:activation.order_id, action:rejected === "account_has_subscription" ? "activation_subscription_rejected" : "activation_business_rejected",
            fromStatus:"running",toStatus:"failed:" + rejected,operator:"system",now:finishedAt,
            reason:"充值提交被明确拒绝：" + errorCode + "；未重新充值、未退款。" +
              (reusable ? "卡密状态确认未使用，已释放。" : "卡密未确认可复用，保留占用待人工核查。")});
        });
        this.log.warn({activationId:activation.id,stage,httpStatus,errorCode,cdkReusable:reusable},
          "activation explicitly rejected");
        return;
      }
      // Once redemption may have been sent, never issue a new CDK or redeem again.
      if (stage === "redeem") {
        this.control.defer(lease, Math.max(this.config.activationPollIntervalMs,
          error instanceof ZovoUpstreamError ? error.retryAfterMs ?? 0 : 0), "result", errorCode, httpStatus);
        this.log.warn({ activationId: activation.id, stage, httpStatus, errorCode }, "activation acceptance uncertain; query only");
        return;
      }
      const cdkAgeMs = cdk ? Date.now() - new Date(cdk.created_at).getTime() : Number.POSITIVE_INFINITY;
      const activationAgeMs = Date.now() - new Date(activation.created_at).getTime();
      let upstreamStillUnused = false;
      if (stage === "preview" && httpStatus === 400 && cdk && activationAgeMs < 20 * 60_000) {
        try {
          upstreamStillUnused = (await this.stage(lease, "cdk_status", () => this.zovo.getCdkStatus(cdk!.upstream_cdk_id))) === "unused";
        } catch {
          // 管理查询失败时不覆盖原始 preview 结果。
        }
      }
      // 新签发 CDK 在上游节点间可能短暂尚未同步。此时 preview 会返回 400，不能误判为
      // 永久失败。已预览但尚未兑换的 CDK 也可能在旧 token 的 15 分钟有效期内返回统一 400；
      // 管理查询窗口保留 20 分钟；自动尝试有次数上限，耗尽后转内部核查。
      const previewRetryable =
        stage === "preview" &&
        httpStatus === 400 &&
        (cdkAgeMs < 2 * 60_000 || upstreamStillUnused);
      const permanent = stage === "preflight" && rejected !== undefined && !previewRetryable;
      if (permanent) {
        this.log.warn(
          { activationId: activation.id, stage, httpStatus, errorCode, previewRetryable, upstreamStillUnused },
          "activation provisioning failed",
        );
        const failureCode = mapUpstreamFailure(errorCode);
        const reusable = await this.cdkIsReusable(lease, cdk);
        this.finish(lease, () => {
          if (cdk && reusable) this.db.releaseCdk(cdk.id, new Date().toISOString());
          this.db.markActivationFailed(
          activation.id,
          failureCode,
          failureMessage(failureCode),
          new Date().toISOString(),
          );
          this.db.recordOrderAudit({orderId:activation.order_id,action:"activation_business_rejected",
            fromStatus:"running",toStatus:"failed:"+failureCode,operator:"system",
            reason:"预检明确拒绝："+errorCode+"；未充值、未退款。" +
              (reusable?"卡密已确认未使用。":"卡密未确认可复用，保留占用。")});
        });
      } else {
        const attempts = this.control.state(activation.id)!.attempts;
        const nonRetryable = !previewRetryable && httpStatus !== undefined && httpStatus < 500
          && ![408, 425, 429].includes(httpStatus);
        if (attempts >= 4 || nonRetryable || !(error instanceof ZovoUpstreamError)) {
          this.control.review(lease, stage, nonRetryable ? "configuration_or_validation_error" : "retry_limit_or_local_error");
        } else {
          const delayMs = Math.max([5_000, 10_000, 20_000][Math.min(attempts - 1, 2)], error.retryAfterMs ?? 0);
          this.control.defer(lease, delayMs, stage, errorCode, httpStatus);
        }
        this.log.warn(
          { activationId: activation.id, stage, httpStatus, errorCode, previewRetryable, upstreamStillUnused },
          "activation provisioning delayed",
        );
      }
    } finally {
      clearInterval(heartbeat);
      this.control.release(lease);
    }
  }

  private async pollRunning(): Promise<void> {
    const rows = this.db.listPollingActivations();
    for (const activation of rows) {
      const order = this.db.getOrder(activation.order_id);
      if (order && isXGiftPlan(order.plan)) {
        await this.pollXGift(activation);
        continue;
      }
      if (!activation.redemption_token || !activation.cdk_id) continue;
      const lease = this.control.claim(new Date().toISOString(), this.leaseUntil(), activation.id);
      if (!lease) continue;
      const heartbeat = this.heartbeat(lease);
      try {
        const cdk = this.db.getCdk(activation.cdk_id);
        const device = cdk?.redemption_device_id || deviceFor(activation.task_id);
        const result = await this.stage(lease, "result", () => this.zovo.getResult(activation.redemption_token!, device));
        if (!activation.upstream_order_id && result.orderId) {
          this.db.setActivationUpstreamOrder(activation.id, result.orderId, new Date().toISOString());
        }
        const mapped = mapZovoStatus(result.status);
        if (mapped === "success") {
          this.finish(lease, () => {
          this.db.markCdkConsumed(activation.cdk_id!, new Date().toISOString());
          this.db.markActivationSuccess(
            activation.id,
            maskEmail(result.accountEmail || activation.account_email_masked || ""),
            new Date().toISOString(),
          );
          });
        } else if (mapped === "failed") {
          const reusable = await this.cdkIsReusable(lease, cdk);
          this.finish(lease, () => {
          if (reusable) this.db.releaseCdk(activation.cdk_id!, new Date().toISOString());
          const failureCode = mapUpstreamFailure(result.errorCode, result.status, result.stage);
          this.db.markActivationFailed(
            activation.id,
            failureCode,
          failureMessage(failureCode),
          new Date().toISOString(),
          );
          this.db.recordOrderAudit({orderId:activation.order_id,action:"activation_result_failed",
            fromStatus:"running",toStatus:"failed:"+failureCode,operator:"system",
            reason:"原任务返回失败终态；未重充、未退款。" +
              (reusable?"卡密已确认未使用。":"卡密未确认可复用，保留占用。")});
          });
        } else if (Date.now() - Date.parse(this.control.state(activation.id)?.review_resumed_at || activation.created_at) > 30 * 60_000) {
          this.control.review(lease, "result", "result_not_final_after_30_minutes");
        }
      } catch (error) {
        if (error instanceof ActivationLeaseLost) continue;
        const escalated = await this.reviewConsumedCdkWithMissingResult(activation, error, lease);
        if (escalated) continue;
        if (Date.now() - Date.parse(this.control.state(activation.id)?.review_resumed_at || activation.created_at) > 30 * 60_000) {
          this.control.review(lease, "result", "result_unknown_after_30_minutes");
        } else {
          this.control.defer(lease, Math.max(5_000,
            error instanceof ZovoUpstreamError ? error.retryAfterMs ?? 0 : 0), "result", safeErrorCode(error),
            error instanceof ZovoUpstreamError ? error.httpStatus : undefined);
        }
        // result 是唯一事实来源。查询失败时维持 running，等待下一轮，绝不重复 redeem。
        this.log.warn(
          {
            activationId: activation.id,
            errorCode: safeErrorCode(error),
          },
          "activation result query delayed",
        );
      } finally {
        clearInterval(heartbeat);
        this.control.release(lease);
      }
    }
  }

  private async provisionXGift(
    lease: ActivationLease,
    activation: ActivationRecord,
    plan: ProductPlan,
  ): Promise<void> {
    const merchantOrderNo = `jd:${activation.order_id}`;
    let submitting = false;
    try {
      const credential = JSON.parse(
        decryptValue(encryptedFromActivation(activation), this.config.sessionEncryptionKey, "session"),
      ) as Record<string, unknown>;
      const username = normalizeXUsername(credential.username);
      const request = {
        merchantOrderNo, idempotencyKey: merchantOrderNo,
        productCode: xGiftProductCode(plan), recipient: username,
        recipientId: String(credential.recipient_id ?? ""),
        expectedPoints: Number(credential.expected_points),
      };
      if (credential.product_code !== request.productCode || !/^\d{1,25}$/.test(request.recipientId) ||
          !Number.isSafeInteger(request.expectedPoints) || request.expectedPoints <= 0) {
        this.control.review(lease, "x_prepare", "x_frozen_order_invalid");
        return;
      }
      const alreadySubmitted = this.db.db.prepare("SELECT 1 FROM x_gift_submissions WHERE activation_id=?")
        .get(activation.id);
      if (alreadySubmitted) {
        this.db.setXActivationSubmitted(activation.id, merchantOrderNo, activation.upstream_order_id, new Date().toISOString());
        return;
      }
      const previous = await this.stage(lease, "x_lookup", () =>
        this.xApi.findByMerchantOrder(merchantOrderNo));
      if (previous) {
        this.db.transaction(() => {
          this.control.assertOwned(lease);
          this.db.db.prepare("INSERT INTO x_gift_submissions VALUES(?,?,?,?,?)")
            .run(activation.id, merchantOrderNo, JSON.stringify(request), new Date().toISOString(), new Date().toISOString());
          this.db.setXActivationSubmitted(activation.id, merchantOrderNo, null, new Date().toISOString());
        });
        this.applyXGiftResult(lease, activation, previous, username);
        return;
      }
      const eligibility = await this.stage(lease, "x_eligibility", () => this.xApi.eligibility(username));
      if (!eligibility.eligible || eligibility.recipient_id !== request.recipientId) {
        this.finish(lease, () => this.db.markActivationFailed(
          activation.id,
          "account_not_eligible",
          "该 X 账号当前不能接收 Premium 赠送",
          new Date().toISOString(),
        ));
        return;
      }
      const productCode = xGiftProductCode(plan);
      const product = await this.stage(lease, "x_product", () => this.xApi.product(productCode));
      if (!product || !Boolean(product.enabled) || product.points !== request.expectedPoints) {
        throw new XApiUpstreamError("蓝V商品当前不可用", 409, "product_unavailable");
      }
      // Persist uncertainty BEFORE touching the charge-creating endpoint.
      // Restarts and transport failures can only query this immutable request.
      this.db.transaction(() => {
        this.control.assertOwned(lease);
        this.db.db.prepare("INSERT INTO x_gift_submissions VALUES(?,?,?,?,?)")
          .run(activation.id, merchantOrderNo, JSON.stringify(request), new Date().toISOString(), new Date().toISOString());
        this.db.setXActivationSubmitted(activation.id, merchantOrderNo, null, new Date().toISOString());
      });
      submitting = true;
      const accepted = await this.stage(lease, "x_submit", () => this.xApi.createOrder(request));
      submitting = false;
      this.applyXGiftResult(lease, activation, accepted, username);
    } catch (error) {
      if (error instanceof ActivationLeaseLost) throw error;
      const httpStatus = upstreamHttpStatus(error);
      const errorCode = safeErrorCode(error);
      const wasSubmitted = !!this.db.db.prepare("SELECT 1 FROM x_gift_submissions WHERE activation_id=?").get(activation.id);
      if (!wasSubmitted && error instanceof Error && error.message === "invalid_x_username") {
        this.finish(lease, () => this.db.markActivationFailed(
          activation.id, "account_not_eligible", "X 用户名格式无效", new Date().toISOString()));
        return;
      }
      const explicitRejection = submitting && [400, 409, 422].includes(httpStatus ?? 0) &&
        ["not_eligible", "recipient_changed", "product_unavailable", "insufficient_points", "recipient_busy"].includes(errorCode);
      if (explicitRejection) {
        const failureCode = mapXFailure(errorCode);
        this.finish(lease, () => {
          this.db.markActivationFailed(activation.id, failureCode, xFailureMessage(failureCode, errorCode), new Date().toISOString());
          this.db.recordOrderAudit({
            orderId: activation.order_id,
            action: "x_gift_rejected",
            fromStatus: "running",
            toStatus: `failed:${failureCode}`,
            operator: "system",
            reason: `蓝V原单被明确拒绝：${errorCode}；未创建第二单、未自动退款。`,
          });
        });
        return;
      }
      const attempts = this.control.state(activation.id)?.attempts ?? 1;
      if (wasSubmitted) {
        this.xQueryAttention(lease, activation, errorCode);
      } else if (attempts >= 4) {
        this.db.db.prepare("UPDATE activations SET message_zh=? WHERE id=?")
          .run("赠送尚未提交，请联系客服核对配置", activation.id);
        this.control.review(lease, "x_submit", "x_local_error_requires_review");
      } else {
        this.control.defer(
          lease,
          Math.max(5_000, error instanceof XApiUpstreamError ? error.retryAfterMs ?? 0 : 0),
          "x_lookup",
          errorCode,
          httpStatus,
        );
      }
      this.log.warn({ activationId: activation.id, errorCode, httpStatus },
        "x gift submission uncertain; original merchant order will be queried");
    }
  }

  private async pollXGift(activation: ActivationRecord): Promise<void> {
    const lease = this.control.claim(new Date().toISOString(), this.leaseUntil(), activation.id);
    if (!lease) return;
    const heartbeat = this.heartbeat(lease);
    try {
      const current = activation.upstream_order_id
        ? await this.stage(lease, "x_result", () => this.xApi.getOrder(activation.upstream_order_id!))
        : await this.stage(lease, "x_result", () =>
          this.xApi.findByMerchantOrder(activation.redemption_token || `jd:${activation.order_id}`));
      if (!current) {
        this.xQueryAttention(lease, activation, "submitted_x_order_not_found");
        return;
      }
      const username = normalizeXUsername(activation.account_email_masked);
      this.applyXGiftResult(lease, activation, current, username);
      if (["queued", "running"].includes(current.status) &&
          Date.now() - Date.parse(this.control.state(activation.id)?.review_resumed_at || activation.created_at) > 30 * 60_000) {
        this.xQueryAttention(lease, activation, "x_result_not_final_after_30_minutes");
      }
    } catch (error) {
      if (error instanceof ActivationLeaseLost) return;
      this.xQueryAttention(lease, activation, safeErrorCode(error),
        error instanceof XApiUpstreamError ? error.retryAfterMs : undefined);
      this.log.warn({ activationId: activation.id, errorCode: safeErrorCode(error) },
        "x gift result query delayed");
    } finally {
      clearInterval(heartbeat);
      this.control.release(lease);
    }
  }

  private applyXGiftResult(
    lease: ActivationLease,
    activation: ActivationRecord,
    result: XApiOrder,
    username: string,
  ): void {
    const submission = this.db.db.prepare("SELECT request_json FROM x_gift_submissions WHERE activation_id=?")
      .get(activation.id) as {request_json: string} | undefined;
    const expected = submission ? JSON.parse(submission.request_json) as Record<string, unknown> : undefined;
    if (!expected || result.merchant_order_no !== expected.merchantOrderNo ||
        result.product_code !== expected.productCode || result.recipient !== expected.recipient ||
        result.points !== expected.expectedPoints || result.recipient !== username ||
        (activation.upstream_order_id && result.id !== activation.upstream_order_id)) {
      throw new XApiUpstreamError("x_order_identity_mismatch", 502, "x_order_identity_mismatch");
    }
    this.control.assertOwned(lease);
    if (!activation.upstream_order_id) {
      this.db.setXActivationSubmitted(activation.id, result.merchant_order_no, result.id, new Date().toISOString());
    }
    if (result.status === "succeeded") {
      this.finish(lease, () => this.db.markActivationSuccess(
        activation.id, `@${username}`, new Date().toISOString()));
      return;
    }
    if (result.status === "failed") {
      const failureCode = mapXFailure(result.failure_code ?? "x_order_failed");
      this.finish(lease, () => {
        this.db.markActivationFailed(
          activation.id,
          failureCode,
          xFailureMessage(failureCode, result.failure_code ?? "x_order_failed"),
          new Date().toISOString(),
        );
        this.db.recordOrderAudit({
          orderId: activation.order_id,
          action: "x_gift_failed",
          fromStatus: "running",
          toStatus: `failed:${failureCode}`,
          operator: "system",
          reason: `蓝V原单返回失败终态：${result.failure_code ?? "unknown"}；未创建第二单、未自动退款。`,
        });
      });
      return;
    }
    if (result.status === "unknown") {
      this.xQueryAttention(lease, activation, "x_order_unknown");
    } else {
      this.db.db.prepare("UPDATE activations SET status=?,message_zh=?,updated_at=? WHERE id=? AND finished=0")
        .run(result.status === "queued" ? "queued" : "running",
          result.status === "queued" ? "赠送正在排队" : "正在赠送",
          new Date().toISOString(), activation.id);
    }
  }

  private xQueryAttention(lease: ActivationLease, activation: ActivationRecord, code: string, delayMs = 0): void {
    this.control.assertOwned(lease);
    this.db.db.prepare("UPDATE activations SET status='running', message_zh=?, updated_at=? WHERE id=? AND finished=0")
      .run("赠送结果待核对，正在查询原订单，请勿重新购买", new Date().toISOString(), activation.id);
    if (!this.db.db.prepare("SELECT 1 FROM order_audit_log WHERE order_id=? AND action='x_result_attention'")
      .get(activation.order_id)) {
      this.db.recordOrderAudit({
        orderId: activation.order_id, action: "x_result_attention", fromStatus: "running",
        toStatus: "query_only", reason: "赠送结果待核对：" + code, operator: "system",
      });
    }
    this.control.defer(lease, Math.max(30_000, delayMs), "x_result", code);
  }

  private async reviewConsumedCdkWithMissingResult(
    activation: ReturnType<AppDatabase["listPollingActivations"]>[number],
    error: unknown,
    lease: ActivationLease,
  ): Promise<boolean> {
    // 上游开放 API：CDK consumed 仅代表确认付款后的卡密核销；
    // 套餐流程还可能 pending/review，只有 result.completed 才确认开通成功。
    // 404 还可能是 token/设备不匹配。不能凭 consumed 补写 success 或发送 activated。
    if (!(error instanceof ZovoUpstreamError) || error.httpStatus !== 404) return false;
    if (!activation.upstream_order_id || !activation.cdk_id) return false;
    if (Date.now() - new Date(activation.updated_at).getTime() < 60_000) return false;
    const cdk = this.db.getCdk(activation.cdk_id);
    if (!cdk) return false;
    try {
      if ((await this.stage(lease, "reconcile", () => this.zovo.getCdkStatus(cdk.upstream_cdk_id))) !== "consumed") return false;
      this.control.review(lease, "result", "cdk_consumed_activation_not_confirmed");
      this.log.warn(
        { activationId: activation.id, upstreamOrderId: activation.upstream_order_id },
        "CDK consumed but activation result unavailable; manual review required",
      );
      return true;
    } catch {
      return false;
    }
  }

  private async cdkIsReusable(lease: ActivationLease, cdk: CdkRecord | undefined): Promise<boolean> {
    if (!cdk) return false;
    try {
      return await this.stage(lease, "rejected_cdk_status", () => this.zovo.getCdkStatus(cdk.upstream_cdk_id)) === "unused";
    } catch (error) {
      if (error instanceof ActivationLeaseLost) throw error;
      return false;
    }
  }

  private leaseUntil(): string {
    return new Date(Date.now() + Math.max(
      60_000,
      this.config.zovo.timeoutMs * 2 + 10_000,
      this.config.xApi.timeoutMs * 2 + 10_000,
    )).toISOString();
  }

  private heartbeat(lease: ActivationLease): NodeJS.Timeout {
    const timer = setInterval(() => {
      try { this.control.renew(lease, this.leaseUntil()); }
      catch { /* Ownership is checked again before any subsequent request or database update. */ }
    }, 10_000);
    timer.unref();
    return timer;
  }

  private async stage<T>(lease: ActivationLease, stage: string, call: () => Promise<T>): Promise<T> {
    this.control.renew(lease, this.leaseUntil());
    const start = Date.now();
    const startedAt = new Date(start).toISOString();
    this.control.stage(lease, stage, startedAt);
    this.log.info({ activationId: lease.activation.id, stage, startedAt }, "activation stage started");
    try {
      const result = await call();
      this.control.assertOwned(lease);
      this.control.stage(lease, stage, startedAt, Date.now() - start);
      this.log.info({ activationId: lease.activation.id, stage, durationMs: Date.now() - start }, "activation stage completed");
      return result;
    } catch (error) {
      this.control.assertOwned(lease);
      this.control.stage(lease, stage, startedAt, Date.now() - start);
      this.log.warn({ activationId: lease.activation.id, stage, durationMs: Date.now() - start,
        httpStatus: upstreamHttpStatus(error),
        errorCode: safeErrorCode(error) }, "activation stage interrupted");
      throw error;
    }
  }

  private finish(lease: ActivationLease, write: () => void): void {
    this.db.transaction(() => {
      this.control.assertOwned(lease);
      const row = this.db.db.prepare("SELECT finished FROM activations WHERE id = ?")
        .get(lease.activation.id) as { finished: number } | undefined;
      if (row && !row.finished) write();
    });
  }
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof ZovoUpstreamError) && !(error instanceof XApiUpstreamError)) return "local_error";
  const code = error.errorCode;
  return code && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(code) ? code : "upstream_error";
}

function upstreamHttpStatus(error: unknown): number | undefined {
  return error instanceof ZovoUpstreamError || error instanceof XApiUpstreamError
    ? error.httpStatus
    : undefined;
}

function mapXFailure(code: string): FailureCode {
  if (["not_eligible", "recipient_changed", "invalid_input", "invalid_recipient"].includes(code)) {
    return "account_not_eligible";
  }
  if (["payment_failed", "payment_blocked", "card_declined", "insufficient_points"].includes(code)) {
    return "payment_blocked";
  }
  return "other";
}

function xFailureMessage(code: FailureCode, upstreamCode: string): string {
  if (code === "account_not_eligible") return "该 X 账号当前不能接收 Premium 赠送";
  if (code === "payment_blocked") return "蓝V赠送通道未完成扣款，请联系客服核对原订单";
  return `蓝V充值未完成，请联系客服并提供订单号（${upstreamCode}）`;
}

function deviceFor(taskId: string): string {
  return `merchant-${taskId}`;
}

function failureMessage(code: FailureCode): string {
  const messages: Record<FailureCode, string> = {
    session_invalid: "账号 Session 已失效或校验未通过，请重新登录后获取最新 Session 再试",
    account_has_subscription: "账号现有订阅不支持开通该商品",
    account_not_eligible: "账号订阅状态正常，但不满足该商品的其他开通条件，请更换符合条件的账号",
    region_unsupported: "该账号所在地区暂不支持此套餐，请更换符合条件的账号",
    payment_blocked: "充值通道未能完成扣款，请稍后重试；如仍失败请联系客服",
    verification_timeout: "账号安全验证未在有效时间内完成，请联系客服核实后重试",
    other: "充值服务未能完成本次处理，请联系客服并提供订单号",
  };
  return messages[code];
}
