import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { MockXApiClient, type XApiOrder } from "../src/clients/x-api.js";
import { resolveActivationReview, type ReviewInput } from "../src/services/activation-review.js";
import { FinancialLedger } from "../src/services/financial-ledger.js";
import { ledgerScript } from "../src/admin-ui/ledger-workbench.js";

describe("蓝V原单核对与财务隔离", () => {
  let directory:string, config:AppConfig, db:AppDatabase, app:Awaited<ReturnType<typeof buildApp>>;
  let xApi:MockXApiClient, zovo:MockZovoClient;
  let orderId:string, activationId:number, merchantOrderNo:string, upstream:XApiOrder;
  const reviewedAt="2026-10-05T00:00:00.000Z";

  beforeEach(async()=>{
    directory=mkdtempSync(join(tmpdir(),"x-gift-review-"));
    config=loadConfig({NODE_ENV:"test",DATABASE_PATH:join(directory,"gateway.sqlite"),
      SESSION_ENCRYPTION_KEY:Buffer.alloc(32,9).toString("base64"),X_API_MODE:"mock"});
    config.products=[{product:"x_premium_3m",name_zh:"X Premium 3个月",name:"X Premium 3 Months",
      plan:"x_premium_3m",internal_cost_cny:"30.00",cost_price:"30.00",max_sell_price:"35.00",
      currency:"CNY",max_qty:1,enabled:true}];
    db=new AppDatabase(config.databasePath); xApi=new MockXApiClient(); zovo=new MockZovoClient();
    app=await buildApp(config,{db,xApi,zovo,payment:new MockPaymentClient(config.publicBaseUrl),startWorkers:false});
    const created=await app.inject({method:"POST",url:"/api/v1/checkout/orders",
      headers:{"x-api-key":config.platformApiKey},payload:{product:"x_premium_3m",quantity:1,
        sell_price:"35.00",client_order_id:"JD-X-REVIEW-001",recipient:"@example_user"}});
    expect(created.statusCode).toBe(200);
    orderId=created.json().order_id;
    await app.inject({method:"POST",url:`/dev/pay/${orderId}`});
    const activation=db.listActivations(orderId)[0]; activationId=activation.id;
    merchantOrderNo=`jd:${orderId}`;
    upstream={id:"ord_"+"a".repeat(32),merchant_order_no:merchantOrderNo,product_code:"x-premium-3m",
      recipient:"example_user",points:300,status:"unknown",failure_code:null,receipt:null};
    xApi.orders.set(merchantOrderNo,upstream);
    const request={merchantOrderNo,idempotencyKey:merchantOrderNo,productCode:"x-premium-3m",
      recipient:"example_user",recipientId:"123456789",expectedPoints:300};
    db.db.prepare(`INSERT INTO x_gift_submissions(activation_id,merchant_order_no,request_json,submit_started_at,created_at)
      VALUES(?,?,?,?,?)`).run(activationId,merchantOrderNo,JSON.stringify(request),reviewedAt,reviewedAt);
    db.setXActivationSubmitted(activationId,merchantOrderNo,upstream.id,reviewedAt);
    db.db.prepare(`INSERT INTO activation_worker_control(activation_id,needs_review,updated_at,last_stage)
      VALUES(?,1,?,'x_result')`).run(activationId,reviewedAt);
    db.db.prepare("UPDATE activations SET worker_locked_until='9999-12-31T23:59:59.999Z' WHERE id=?").run(activationId);
  });

  afterEach(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});vi.restoreAllMocks();});
  function resolve(action:ReviewInput["action"],extra:Partial<ReviewInput>={}) {
    return resolveActivationReview(db,config,zovo,activationId,{action,expected_updated_at:reviewedAt,
      reason:"核对蓝V原订单",verified:true,...extra},xApi);
  }
  function remainsUnfinished() {
    expect(db.listActivations(orderId)[0]).toMatchObject({finished:0,status:"running"});
    expect(db.db.prepare("SELECT needs_review FROM activation_worker_control WHERE activation_id=?")
      .get(activationId)).toMatchObject({needs_review:1});
  }

  it("没有卡密的蓝V任务可恢复原单只读查询",async()=>{
    const create=vi.spyOn(xApi,"createOrder"), query=vi.spyOn(xApi,"getOrder");
    expect(db.listActivations(orderId)[0].cdk_id).toBeNull();
    await resolve("resume_query");
    expect(db.listActivations(orderId)[0]).toMatchObject({finished:0,worker_state:"polling",
      redemption_token:merchantOrderNo,worker_locked_until:null});
    expect(create).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
    const reviewList=await app.inject({method:"GET",url:"/admin/api/activation-reviews",
      headers:{"x-admin-token":config.adminToken}});
    expect(reviewList.statusCode).toBe(200);
    expect(reviewList.json().items).toHaveLength(0);
  });

  it("核查列表对有提交记录的蓝V显示可恢复",async()=>{
    const response=await app.inject({method:"GET",url:"/admin/api/activation-reviews",
      headers:{"x-admin-token":config.adminToken}});
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({can_resume:1,plan:"x_premium_3m"});
  });

  it("仅原单成功才能确认，实际账号取冻结用户名而非人工邮箱",async()=>{
    upstream.status="succeeded";
    const zovoQuery=vi.spyOn(zovo,"getResult");
    await resolve("confirmed_success",{account_email:"unrelated@example.com"});
    expect(db.listActivations(orderId)[0]).toMatchObject({finished:1,status:"success",account_email_masked:"@example_user"});
    expect(db.getOrder(orderId)?.delivery_status).toBe("success");
    expect(zovoQuery).not.toHaveBeenCalled();
  });

  it.each(["merchant_order_no","product_code","recipient","points"] as const)("拒绝原单响应的 %s 绑定错误",async field=>{
    upstream.status="succeeded";
    Object.assign(upstream,{[field]:field==="points"?600:"wrong_value"});
    await expect(resolve("confirmed_success",{account_email:"owner@example.com"})).rejects.toThrow("不匹配");
    remainsUnfinished();
  });

  it.each(["queued","running","unknown"] as const)("%s 结果不能确认失败或成功",async status=>{
    upstream.status=status;
    await expect(resolve("confirmed_failed",{failure_code:"other"})).rejects.toThrow("未返回明确失败");
    await expect(resolve("confirmed_success",{account_email:"owner@example.com"})).rejects.toThrow("尚未确认成功");
    remainsUnfinished();
  });

  it("查询超时不能释放原任务",async()=>{
    vi.spyOn(xApi,"getOrder").mockRejectedValue(new Error("timeout"));
    await expect(resolve("confirmed_failed",{failure_code:"other"})).rejects.toThrow("仍无法核实");
    remainsUnfinished();
  });

  it("只有绑定原单的明确失败可登记失败",async()=>{
    upstream.status="failed"; upstream.failure_code="card_declined";
    await expect(resolve("confirmed_failed",{failure_code:"other"})).rejects.toThrow("失败原因");
    remainsUnfinished();
    await resolve("confirmed_failed",{failure_code:"payment_blocked"});
    expect(db.listActivations(orderId)[0]).toMatchObject({finished:1,status:"failed",failure_code:"payment_blocked"});
  });

  it("缺少提交标记不能恢复或断言成功",async()=>{
    db.db.prepare("DELETE FROM x_gift_submissions WHERE activation_id=?").run(activationId);
    await expect(resolve("resume_query")).rejects.toThrow("缺少持久化提交记录");
    await expect(resolve("confirmed_success",{account_email:"owner@example.com"})).rejects.toThrow("缺少持久化提交记录");
    remainsUnfinished();
  });

  it("蓝V禁止通过通用人工完成和接管入口绕过原单证据",async()=>{
    db.markActivationFailed(activationId,"other","原单失败",reviewedAt);
    const before=db.listActivations(orderId);
    for(const action of ["confirm_manual_delivery","begin_manual_takeover","report_manual_takeover_issue",
      "release_manual_takeover_not_started","release_manual_takeover_confirmed_failed"]) {
      const response=await app.inject({method:"POST",url:`/admin/api/orders/${orderId}/actions`,
        headers:{"x-admin-token":config.adminToken},payload:{action,reason:"MT-20261005-000000701",
          account_email:"real.person@example.com",verified:true,expected_task_id:before[0].task_id}});
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("x_gift_original_order_required");
    }
    expect(db.listActivations(orderId)).toEqual(before);
    expect(db.getManualActivationTakeover(orderId)).toBeUndefined();
    expect(db.getOrder(orderId)?.delivery_status).toBe("failed");
  });

  it("蓝V不进入 Zovo 成本核对且明确拒绝 GPT 成本草稿，人民币分润仍正常",async()=>{
    upstream.status="succeeded";await resolve("confirmed_success");
    const ledger=new FinancialLedger(db);
    expect(ledger.automaticCandidates()).toHaveLength(0);
    expect(()=>ledger.save(orderId,{revision:0,plan:"x_premium_3m",standard_usd:"15.76",actual_usd:"2.46",
      retained_usd:"0.15",standard_reference:"不能套用GPT",evidence:"测试独立成本校验",source:"manual",
      transaction_ids:["x-card-payment"],fees_checked:true})).toThrow("蓝V成本须独立核实");
    const statement=db.createPlatformSettlement({settlementId:"x-review-statement",
      from:"2000-01-01T00:00:00.000Z",to:"2100-01-01T00:00:00.000Z"});
    expect(statement.settlement).toMatchObject({amount:"5.00",order_count:1});
  });
});

describe("人工核对表单按履约类型提交",()=>{
  it.each(["x_premium_3m","pro_50x"])("%s 的邮箱要求和提交参数正确",async plan=>{
    const nodes=new Map<string,any>();
    const makeNode=()=>({value:"",required:false,disabled:false,textContent:"",placeholder:"",
      checked:true,classList:{toggle:vi.fn(),add:vi.fn()},querySelector:()=>({textContent:""}),
      querySelectorAll:()=>[]});
    const $=(selector:string)=>{
      if(!nodes.has(selector))nodes.set(selector,makeNode());
      return nodes.get(selector);
    };
    const review={id:7,plan,updated_at:"2026-10-05T00:00:00.000Z"};
    const changeBody=ledgerScript.match(/\$\('#reviewAction'\)\.onchange=function\(\)\{([\s\S]*?)\n  \};/)![1];
    const change=new Function("selectedReview","$",changeBody);
    $('#reviewAction').value='confirmed_success';
    $('#reviewEmail').value='buyer@example.com';
    change.call($('#reviewAction'),review,$);
    expect($('#reviewEmail').required).toBe(plan==='pro_50x');
    expect($('#reviewEmail').disabled).toBe(plan!=='pro_50x');
    if(plan!=='pro_50x')expect($('#reviewEmail').value).toBe('');
    // Exercise the actual generated submit handler, including stale email in a hidden field.
    $('#reviewEmail').value='buyer@example.com';
    $('#reviewReason').value='已核对原订单';
    const submitBody=ledgerScript.match(/\$\('#reviewResolveForm'\)\.onsubmit=async function\(e\)\{([\s\S]*?)\n  \};/)![1];
    const send=vi.fn().mockResolvedValue({success:true});
    const submit=new Function('selectedReview','$','confirmAction','busy','send','loadReviewQueue','toast',
      'return async function(e){'+submitBody+'}')(review,$,async()=>true,
        async(_button:unknown,action:()=>Promise<unknown>)=>action(),send,async()=>{},vi.fn());
    await submit.call($('#reviewResolveForm'),{preventDefault:vi.fn()});
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1].account_email).toBe(plan==='pro_50x'?'buyer@example.com':undefined);
    expect(send.mock.calls[0][1].action).toBe('confirmed_success');
  });
});
