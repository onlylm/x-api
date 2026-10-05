import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../database.js";
import type { ZovoClient } from "../clients/zovo.js";
import { createXApiClient, type XApiClient, type XApiOrder } from "../clients/x-api.js";
import { isXGiftPlan, mapUpstreamFailure, mapZovoStatus, maskEmail, normalizeXUsername, xGiftProductCode, type ActivationRecord, type FailureCode, type OrderRecord } from "../domain.js";
import { decryptValue, hmacHex } from "../security.js";
import { LedgerError } from "./financial-ledger.js";

export interface ReviewInput {
  action: "resume_query" | "confirmed_success" | "confirmed_failed";
  expected_updated_at: string; reason: string; verified: true;
  account_email?: string; failure_code?: FailureCode;
}
interface ReviewControl {
  needs_review: number; updated_at: string; lease_token: string|null; lease_until: string|null;
  last_stage: string|null; last_error_code: string|null;
}

/** Resolves only a paused original attempt, never starts a payment, refund or new redemption. */
export async function resolveActivationReview(db:AppDatabase,config:AppConfig,zovo:ZovoClient,id:number,input:ReviewInput,
  xApi:XApiClient=createXApiClient(config)) {
  const check = () => {
    const a=db.db.prepare("SELECT * FROM activations WHERE id=?").get(id) as unknown as ActivationRecord|undefined;
    const c=db.db.prepare("SELECT * FROM activation_worker_control WHERE activation_id=?").get(id) as unknown as ReviewControl|undefined;
    if(!a||!c||c.needs_review!==1||a.finished||c.updated_at!==input.expected_updated_at) throw new LedgerError("任务状态已变化，请刷新核查队列");
    if(c.lease_token && c.lease_until && c.lease_until>new Date().toISOString()) throw new LedgerError("任务正在处理，请稍后重试");
    const o=db.getOrder(a.order_id);
    if(o?.status!=="paid"||o.refunded_at||db.db.prepare("SELECT 1 FROM refunds WHERE order_id=? AND status IN ('requested','processing','succeeded')").get(a.order_id)) {
      throw new LedgerError("订单支付或退款状态不允许此操作");
    }
    return {a,c,o};
  };
  const snapshot=check();
  if(isXGiftPlan(snapshot.o.plan)) return resolveXGiftReview(db,config,xApi,id,input,check,snapshot);
  const a=snapshot.a;
  let failure:FailureCode|undefined;
  let reusable=false;
  if(input.action==="confirmed_failed") {
    failure=mapUpstreamFailure(snapshot.c.last_error_code??undefined);
    if(a.redemption_token) {
      // A possibly accepted task must be queried to a real failed terminal state.
      // 404, a timeout, or "still running" never authorizes retrying or releasing quota.
      let result;
      try {
        const card=a.cdk_id?db.getCdk(a.cdk_id):undefined;
        result=await zovo.getResult(a.redemption_token,card?.redemption_device_id||"merchant-"+a.task_id);
      } catch { throw new LedgerError("原任务结果仍无法核实，请保留待核查或恢复查询；未改为失败"); }
      if(mapZovoStatus(result.status)!=="failed") throw new LedgerError("原任务未返回明确失败，不能人工置为失败或释放次数");
      if(a.upstream_order_id && result.orderId && a.upstream_order_id!==result.orderId) throw new LedgerError("查询返回的订单号不匹配，请继续人工核查");
      failure=mapUpstreamFailure(result.errorCode,result.status);
    } else if (a.upstream_order_id || !["queued","provisioning"].includes(a.worker_state)) {
      throw new LedgerError("缺少原任务查询凭据，不能确认失败");
    }
    if(!input.failure_code || input.failure_code!==failure) throw new LedgerError("所选失败原因与已核实返回不一致；不能猜测账号问题，无法分类请选择其他");
    if(a.cdk_id) {
      try { reusable=(await zovo.getCdkStatus(db.getCdk(a.cdk_id)!.upstream_cdk_id))==="unused"; }
      catch { reusable=false; }
    }
  }
  if(input.action==="confirmed_success" && !input.account_email) throw new LedgerError("确认成功前必须填写并核对实际充值账号");
  return db.transaction(()=>{
    const current=check();
    if(current.a.redemption_token!==a.redemption_token || current.a.cdk_id!==a.cdk_id || current.a.upstream_order_id!==a.upstream_order_id) throw new LedgerError("任务凭据已变化，请刷新重新核查");
    const time=new Date().toISOString();
    if(input.action==="resume_query"){
      if(!a.redemption_token || !a.cdk_id) throw new LedgerError("缺少原查询凭证；不能重新提交充值，请先人工核实");
      db.db.prepare("UPDATE activations SET worker_state='polling',worker_locked_until=NULL WHERE id=?").run(id);
    }else if(input.action==="confirmed_success"){
      const email=input.account_email!;
      if(a.cdk_id) db.markCdkConsumed(a.cdk_id,time);
      db.db.prepare("UPDATE activations SET email_hash=? WHERE id=?").run(hmacHex(config.emailHmacKey,email.toLowerCase()),id);
      db.markActivationSuccess(id,maskEmail(email),time);
    }else{
      if(a.cdk_id && reusable) db.releaseCdk(a.cdk_id,time);
      db.markActivationFailed(id,failure!,reviewFailureMessage(failure!),time);
    }
    db.db.prepare(`UPDATE activation_worker_control SET needs_review=0,lease_token=NULL,lease_until=NULL,
      next_retry_at=NULL,review_resumed_at=?,updated_at=? WHERE activation_id=?`).run(time,time,id);
    db.recordOrderAudit({orderId:a.order_id,action:"activation_review_"+input.action,fromStatus:"internal:review_required",
      toStatus:input.action==="resume_query"?"polling":input.action==="confirmed_success"?"success":"failed:"+failure,
      reason:input.reason+(input.action==="confirmed_failed"?(reusable?"；卡密确认未使用。":"；卡密未确认可复用，保留占用。"):"")});
    return {success:true};
  });
}

interface XReviewSnapshot { a:ActivationRecord; c:ReviewControl; o:OrderRecord }
interface XSubmission {
  merchant_order_no:string; request_json:string; submit_started_at:string|null;
}
interface XReviewBinding {
  submission:XSubmission; merchantOrderNo:string; productCode:string; username:string; points:number;
}

function xReviewBinding(db:AppDatabase,config:AppConfig,snapshot:XReviewSnapshot):XReviewBinding {
  const {a,o}=snapshot;
  const submission=db.db.prepare("SELECT merchant_order_no,request_json,submit_started_at FROM x_gift_submissions WHERE activation_id=?")
    .get(a.id) as unknown as XSubmission|undefined;
  if(!submission?.submit_started_at) throw new LedgerError("蓝V原任务缺少持久化提交记录，不能猜测结果或重新下单");
  try {
    if(!o.fulfillment_recipient_ciphertext||!o.fulfillment_recipient_iv||!o.fulfillment_recipient_tag) throw new Error("missing_recipient");
    const frozen=JSON.parse(decryptValue({ciphertext:o.fulfillment_recipient_ciphertext,
      iv:o.fulfillment_recipient_iv,tag:o.fulfillment_recipient_tag},config.sessionEncryptionKey,"order-recipient"));
    const request=JSON.parse(submission.request_json);
    const username=normalizeXUsername(frozen.username);
    const productCode=xGiftProductCode(o.plan);
    const merchantOrderNo=`jd:${o.order_id}`;
    if(frozen.username!==username||frozen.product_code!==productCode||
      typeof frozen.recipient_id!=="string"||!/^\d{1,25}$/.test(frozen.recipient_id)||
      !Number.isSafeInteger(frozen.expected_points)||frozen.expected_points<=0||
      request.merchantOrderNo!==merchantOrderNo||request.idempotencyKey!==merchantOrderNo||
      submission.merchant_order_no!==merchantOrderNo||request.productCode!==productCode||
      request.recipient!==username||request.recipientId!==frozen.recipient_id||
      request.expectedPoints!==frozen.expected_points||
      o.fulfillment_recipient_hash!==hmacHex(config.emailHmacKey,username)||
      (a.redemption_token!==null&&a.redemption_token!==merchantOrderNo)) throw new Error("binding_mismatch");
    return {submission,merchantOrderNo,productCode,username,points:frozen.expected_points};
  } catch { throw new LedgerError("蓝V原任务与付款订单的账号、套餐或点数不一致，请保留待核对"); }
}

async function resolveXGiftReview(db:AppDatabase,config:AppConfig,xApi:XApiClient,id:number,input:ReviewInput,
  check:()=>XReviewSnapshot,snapshot:XReviewSnapshot) {
  const binding=xReviewBinding(db,config,snapshot);
  let result:XApiOrder|undefined;
  let failure:FailureCode|undefined;
  if(input.action!=="resume_query") {
    try {
      result=snapshot.a.upstream_order_id?await xApi.getOrder(snapshot.a.upstream_order_id):
        await xApi.findByMerchantOrder(binding.merchantOrderNo);
    } catch { throw new LedgerError("蓝V原订单结果仍无法核实，请保留待核对或恢复查询"); }
    if(!result||!/^ord_[a-f0-9]{32}$/.test(result.id)||
      (snapshot.a.upstream_order_id!==null&&result.id!==snapshot.a.upstream_order_id)||
      result.merchant_order_no!==binding.merchantOrderNo||result.product_code!==binding.productCode||
      result.recipient!==binding.username||result.points!==binding.points) {
      throw new LedgerError("蓝V查询结果与原付款订单不匹配，不能确认成功或失败");
    }
    if(input.action==="confirmed_success"&&result.status!=="succeeded") {
      throw new LedgerError("蓝V原订单尚未确认成功，不能凭人工填写账号登记成功");
    }
    if(input.action==="confirmed_failed") {
      if(result.status!=="failed") throw new LedgerError("蓝V原订单未返回明确失败，不能释放次数或退款");
      failure=mapXReviewFailure(result.failure_code??"");
      if(!input.failure_code||input.failure_code!==failure) throw new LedgerError("所选失败原因与蓝V原订单不一致，请按核实结果处理");
    }
  }
  return db.transaction(()=>{
    const current=check();
    const currentBinding=xReviewBinding(db,config,current);
    if(current.a.upstream_order_id!==snapshot.a.upstream_order_id||
      current.a.redemption_token!==snapshot.a.redemption_token||
      currentBinding.submission.request_json!==binding.submission.request_json||
      currentBinding.submission.submit_started_at!==binding.submission.submit_started_at) {
      throw new LedgerError("蓝V任务凭据已变化，请刷新后核查原单");
    }
    const time=new Date().toISOString();
    if(input.action==="resume_query") {
      db.db.prepare(`UPDATE activations SET status='running',worker_state='polling',worker_locked_until=NULL,
        redemption_token=?,message_zh='正在核对蓝V原订单',updated_at=? WHERE id=?`).run(binding.merchantOrderNo,time,id);
    } else {
      db.setXActivationSubmitted(id,binding.merchantOrderNo,result!.id,time);
      if(input.action==="confirmed_success") db.markActivationSuccess(id,`@${binding.username}`,time);
      else db.markActivationFailed(id,failure!,"蓝V原订单已明确失败，请联系客服处理原订单",time);
    }
    db.db.prepare(`UPDATE activation_worker_control SET needs_review=0,lease_token=NULL,lease_until=NULL,
      next_retry_at=NULL,review_resumed_at=?,updated_at=? WHERE activation_id=?`).run(time,time,id);
    db.recordOrderAudit({orderId:snapshot.a.order_id,action:"activation_review_"+input.action,
      fromStatus:"internal:review_required",toStatus:input.action==="resume_query"?"polling":
        input.action==="confirmed_success"?"success":"failed:"+failure,
      reason:input.reason+"；仅核对蓝V原付款订单，未创建新订单或发起退款。"});
    return {success:true};
  });
}

function mapXReviewFailure(code:string):FailureCode {
  if(["not_eligible","recipient_changed","invalid_input","invalid_recipient"].includes(code)) return "account_not_eligible";
  if(["payment_failed","payment_blocked","card_declined","insufficient_points"].includes(code)) return "payment_blocked";
  return "other";
}
function reviewFailureMessage(code:FailureCode):string {
  const messages:Record<FailureCode,string>={
    session_invalid:"账号登录信息无效，请重新登录后再试",
    account_has_subscription:"账号现有订阅不支持开通该商品",
    account_not_eligible:"账号不满足该商品的其他开通条件",
    region_unsupported:"该账号所在地区暂不支持此商品",
    payment_blocked:"本次充值未能完成扣款，请联系客服",
    verification_timeout:"账号安全验证未在有效时间内完成，请联系客服",
    other:"本次开通未成功，请联系客服并提供订单号",
  };
  return messages[code];
}
