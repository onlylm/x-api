import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {AppDatabase} from "../src/database.js";
import {buildApp} from "../src/app.js";
import {MockZovoClient,LiveZovoClient} from "../src/clients/zovo.js";
import {MockPaymentClient} from "../src/clients/payment.js";
import {FinancialLedger,usdToCny} from "../src/services/financial-ledger.js";
import {DailySettlementWorker} from "../src/services/daily-settlement-worker.js";
import {ActivationWorker} from "../src/services/activation-worker.js";
import {ledgerTestConfig} from "./ledger-fixtures.js";
import {adminPageV2} from "../src/admin-page-v2.js";
import {Script} from "node:vm";
describe("真实成本、平台退差、分币种结算闭环",()=>{
  let dir:string,db:AppDatabase,app:Awaited<ReturnType<typeof buildApp>>,ledger:FinancialLedger;
  let config:ReturnType<typeof ledgerTestConfig>,zovo:MockZovoClient,payment:MockPaymentClient;
  const headers={"x-admin-token":"local-ledger-preview"},created="2026-09-25T13:00:00.000Z";
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),"ledger-safe-"));config=ledgerTestConfig(join(dir,"test.sqlite"));
    db=new AppDatabase(config.databasePath);zovo=new MockZovoClient();payment=new MockPaymentClient(config.publicBaseUrl);
    app=await buildApp(config,{db,zovo,payment,startWorkers:false});ledger=new FinancialLedger(db);
  });
  afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await app.close();rmSync(dir,{recursive:true,force:true});});
  async function order(n=1,plan="pro_5x"){
    const res=await app.inject({method:"POST",url:"/api/v1/checkout/orders",headers:{"x-api-key":config.platformApiKey},
      payload:{product:plan==="plus"?"chatgpt_plus_1m":"chatgpt_pro_5x_1m",quantity:1,sell_price:plan==="plus"?"135.00":"680.00",client_order_id:"po_ledger_"+n}});
    expect(res.statusCode).toBe(200);
    const id=res.json().order_id;
    db.markOrderPaid(id,created,"trade-"+n,plan==="plus"?"135.00":"680.00");
    db.db.prepare("UPDATE orders SET delivery_status='success',created_at=?,updated_at=? WHERE order_id=?").run(created,created,id);
    db.db.prepare("INSERT INTO activations(order_id,activation_id,task_id,status,finished,upstream_order_id,worker_state,created_at,updated_at) VALUES (?,1,?,'success',1,?,'terminal',?,?)")
      .run(id,"tsk-ledger-"+n,"upstream-"+n,created,created);
    return id as string;
  }
  function draft(overrides:Record<string,unknown>={}){
    return {revision:0,plan:"pro_5x",standard_usd:"92.98",actual_usd:"89.33",retained_usd:"0.15",
      standard_reference:"5x 标准价格 2026-09-25 截图",evidence:"核对充值订单和卡交易凭证",source:"manual" as const,
      transaction_ids:["transaction-001"],fees_checked:true,fx_rate:"7.00",...overrides};
  }
  function confirm(id:string,overrides:Record<string,unknown>={}){
    const r=ledger.save(id,draft(overrides));return ledger.confirm(id,r.revision);
  }
  function settle(id="statement1"){
    return db.createPlatformSettlement({settlementId:id,from:"2020-01-01T00:00:00.000Z",to:"2099-01-01T00:00:00.000Z"});
  }
  function pay(id:string,currency:"CNY"|"USD",amount:string,key:string){
    return ledger.payment({settlementId:id,currency,amount,paymentId:key,method:"other",reference:key,note:"人工已付",
      paidAt:created});
  }
  it("减少真实成本但不减少原供货价；平台收到基础利润加 USD 退差",async()=>{
    const id=await order();
    ledger.addFee({reference:"fee-one",kind:"topup",amount_usd:"0.10",order_id:id,evidence:"实际充值手续费，不含本金"});
    const r=confirm(id);
    expect(r).toMatchObject({actual_usd:"89.33",fees_usd:"0.10",total_cost_usd:"89.58",rebate_usd:"3.50"});
    expect(db.getOrder(id)).toMatchObject({platform_supply_price:"638.00",upstream_actual_cost_cny:"627.06",customer_price_refund_amount:"0.00"});
    expect(settle().settlement).toMatchObject({amount:"42.00",rebate_usd:"3.50"});
    const report=await app.inject({url:"/admin/api/finance?from=2026-09-24&to=2026-09-27",headers});
    expect(report.json().items[0]).toMatchObject({gross_profit:"0.30",platform_margin:"42.00"});
    expect(ledger.confirm(id,1).status).toBe("confirmed");
    expect(()=>ledger.save(id,draft({revision:1}))).toThrow("不能覆盖");
  });
  it("线下已退美元补差只核销退差，人民币基础利润仍进入次日正常结算",async()=>{
    const id=await order();
    confirm(id,{actual_usd:"77.80"});
    const previewUrl="/admin/api/platform-rebates/"+encodeURIComponent(id)+"/external-payment-preview";
    const paymentUrl="/admin/api/platform-rebates/"+encodeURIComponent(id)+"/external-payment";
    expect((await app.inject({url:previewUrl})).statusCode).toBe(401);
    const preview=await app.inject({url:previewUrl,headers});
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toMatchObject({order_id:id,base_cny:"42.00",base_status:"pending",
      rebate_usd:"15.03",rebate_status:"pending"});
    const payload={payment_id:"external-rebate-payment-001",method:"alipay",reference:"2026092723001498101450760151",
      note:"平台退差已线下支付，人民币基础利润未结算",paid_at:created,applied_usd:"15.00",
      payment_currency:"CNY",payment_amount:"101.00",fx_rate:"6.700000",funding_amount:"100.19",verified:true};
    expect((await app.inject({method:"POST",url:paymentUrl,payload})).statusCode).toBe(401);
    const recorded=await app.inject({method:"POST",url:paymentUrl,headers,payload});
    expect(recorded.statusCode).toBe(200);
    const result=recorded.json();
    expect(result.statement.settlement).toMatchObject({amount:"0.00",rebate_usd:"15.03",cny_paid:"0.00",
      usd_paid:"15.00",status:"partial",generation_mode:"manual",business_date:null});
    expect(result.statement.lines).toHaveLength(0);
    expect(db.db.prepare("SELECT currency,amount,note FROM settlement_payments WHERE payment_id=?").get(payload.payment_id))
      .toMatchObject({currency:"CNY",amount:"101.00",note:expect.stringContaining("我方实际扣款 100.19 CNY")});
    expect(result.statement.rebates[0]).toMatchObject({order_id:id,rebate_usd:"15.03",status:"included"});
    expect((await app.inject({method:"POST",url:paymentUrl,headers,payload})).json().statement.settlement.settlement_id)
      .toBe(result.statement.settlement.settlement_id);
    expect((await app.inject({method:"POST",url:paymentUrl,headers,payload:{...payload,note:"冲突内容"}})).statusCode).toBe(409);
    expect(db.db.prepare("SELECT COUNT(*) n FROM platform_settlement_lines WHERE order_id=?").get(id)).toMatchObject({n:0});
    db.db.prepare("UPDATE orders SET updated_at=? WHERE order_id=?").run("2026-09-26T13:00:00.000Z",id);
    const worker=new DailySettlementWorker(db,app.log);
    await worker.tick(new Date("2026-09-26T14:00:00.000Z"));
    const scheduled=db.getPlatformSettlement("STD20260926")!;
    expect(scheduled.settlement).toMatchObject({amount:"42.00",rebate_usd:"0.00",cny_paid:"0.00",usd_paid:"0.00"});
    expect(scheduled.lines).toHaveLength(1);
    expect(scheduled.lines[0]).toMatchObject({order_id:id,amount:"42.00"});
    expect(db.getPlatformRebate(id)).toMatchObject({status:"included",settlement_id:result.statement.settlement.settlement_id});
  });
  it("没有汇率不猜人民币毛利；Plus 使用 Plus 标准价而不是 5x",async()=>{
    const id=await order(1,"plus");confirm(id,{plan:"plus",standard_usd:"15.76",actual_usd:"15.76",fx_rate:null});
    expect(db.getPlatformRebate(id)).toBeUndefined();
    const response=await app.inject({url:"/admin/api/finance?from=2026-09-24&to=2026-09-27",headers});
    expect(response.json().items[0].gross_profit).toBe("2.00");expect(response.json().summary.gross_profit).toBe("2.00");
    expect(response.json().items[0].supplier_net_income_cny).toBe("110.00");
    expect(response.json().summary.profit_action_required_count).toBe(0);
    expect(()=>usdToCny("1.00","0")).toThrow();
    expect(usdToCny("0.01","7.555555")).toBe("0.08");
  });
  it("不按金额推断套餐，未核实费用不可确认；修改费用使旧核查版本失效",async()=>{
    const id=await order();
    expect(()=>ledger.save(id,draft({plan:"plus"}))).toThrow("套餐");
    ledger.save(id,draft({fees_checked:false}));
    expect(()=>ledger.confirm(id,1)).toThrow("手续费");
    ledger.addFee({reference:"fee-late",kind:"opening",amount_usd:"0.20",order_id:id,evidence:"仅分配一次开卡费"});
    expect(()=>ledger.confirm(id,1)).toThrow("资料已变化");
    expect(ledger.get(id)?.fees_checked).toBe(0);
  });
  it("交易与费用凭证不能重复使用；确认失败原子回滚",async()=>{
    const first=await order(1),second=await order(2);confirm(first);
    ledger.save(second,draft({transaction_ids:["unique-first","transaction-001"]}));
    expect(()=>ledger.confirm(second,1)).toThrow("其他订单");
    expect(db.db.prepare("SELECT * FROM cost_transaction_links WHERE transaction_id='unique-first'").get()).toBeUndefined();
    const fee={reference:"fee-shared",kind:"opening",amount_usd:"0.20",evidence:"无明确归属，费用池待分配"};
    ledger.addFee(fee);ledger.addFee(fee);
    expect(()=>ledger.addFee({...fee,amount_usd:"0.40"})).toThrow("内容不同");
    expect(ledger.list("",1,"").unallocated_fees).toMatchObject({count:1,cents:20});
    expect(()=>ledger.addFee({...fee,reference:"another",order_id:first})).toThrow("不得追加");
  });
  it("旧客户补差、旧版退差、零元和未支付订单不进入自动退差",async()=>{
    const id=await order();
    db.db.prepare("UPDATE orders SET customer_price_refund_amount='9.38' WHERE order_id=?").run(id);
    expect(()=>confirm(id)).toThrow("历史客户补差");
    db.db.prepare("UPDATE orders SET customer_price_refund_amount='0.00' WHERE order_id=?").run(id);
    expect(()=>ledger.save(id,draft({actual_usd:"0.00"}))).toThrow("零元");
    const old=await app.inject({method:"PUT",url:"/admin/api/orders/"+id+"/platform-rebate",headers,
      payload:{standard_usd:"92.98",actual_usd:"89.33",reason:"旧入口尝试绕过"}});
    expect(old.statusCode).toBe(409);
    confirm(id);
    expect(()=>db.setOrderUpstreamCost({orderId:id,amount:"1.00",currency:"USD",cny:"7.00"})).toThrow("不能");
    expect(()=>db.recordCustomerPriceRefund({orderId:id,amount:"1.00",reference:"customer-ref",reason:"测试重复",refundedAt:created})).toThrow("重复");
  });
  it("币种独立、部分支付、重复提交和超额付款保护",async()=>{
    const id=await order();confirm(id);settle();
    expect(()=>db.recordPlatformSettlementPayment({settlementId:"statement1",method:"other",reference:"bad-all",note:"",paidAt:created})).toThrow("分别");
    expect(pay("statement1","USD","1.00","pay-usd-1")).toMatchObject({status:"partial",usd_paid:"1.00",cny_paid:"0.00"});
    expect(db.getPlatformRebateSummary()).toMatchObject({payable:"2.50",paid:"1.00"});
    expect(pay("statement1","USD","1.00","pay-usd-1").usd_paid).toBe("1.00");
    expect(()=>pay("statement1","USD","2.00","pay-usd-1")).toThrow("不一致");
    expect(()=>pay("statement1","USD","2.51","pay-usd-over")).toThrow("不超过");
    expect(pay("statement1","CNY","20.00","pay-cny-1").status).toBe("partial");
    const report=await app.inject({url:"/admin/api/finance?from=2026-09-24&to=2026-09-27",headers});
    expect(report.json().summary).toMatchObject({platform_settled:"20.00",platform_payable:"22.00"});
    pay("statement1","USD","2.50","pay-usd-2");
    expect(db.getPlatformRebate(id)?.status).toBe("paid");
    expect(pay("statement1","CNY","22.00","pay-cny-2").status).toBe("paid");
    expect(db.getPlatformSettlement("statement1")?.settlement).toMatchObject({cny_paid:"42.00",usd_paid:"3.50"});
  });
  it("结算单按业务日期和实际核销状态查询，并可导出平台核对明细",async()=>{
    await order(1,"plus");
    settle("STMT-PAID");
    db.db.prepare("UPDATE platform_settlements SET business_date='2026-09-25' WHERE settlement_id='STMT-PAID'").run();
    pay("STMT-PAID","CNY","25.00","settlement-paid-cny");
    db.db.prepare("UPDATE platform_settlements SET status='pending' WHERE settlement_id='STMT-PAID'").run();
    await order(2,"plus");
    settle("STMT-PENDING");
    db.db.prepare("UPDATE platform_settlements SET business_date='2026-09-26' WHERE settlement_id='STMT-PENDING'").run();
    const paid=await app.inject({url:"/admin/api/platform-settlements?status=paid&from=2026-09-25&to=2026-09-25&q=STMT&page=1&page_size=20",headers});
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({summary:{count:1,amount:"25.00",cny_paid:"25.00"},pagination:{total:1,page:1,page_size:20,pages:1}});
    expect(paid.json().items[0]).toMatchObject({settlement_id:"STMT-PAID",status:"paid",business_date:"2026-09-25"});
    const pending=await app.inject({url:"/admin/api/platform-settlements?status=pending&from=2026-09-26&to=2026-09-26&page=1&page_size=20",headers});
    expect(pending.json().items).toHaveLength(1);
    expect(pending.json().items[0]).toMatchObject({settlement_id:"STMT-PENDING",status:"pending"});
    const csv=await app.inject({url:"/admin/api/platform-settlements/STMT-PAID/export.csv",headers});
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-disposition"]).toContain("settlement-STMT-PAID.csv");
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body).toContain("结算单号,业务日期,核销状态");
    expect(csv.body).toContain("po_ledger_1");
    expect(csv.body).toContain("人民币平台利润");
    expect(csv.body).toContain("settlement-paid-cny");
  });
  it("22 点重复运行不重复出单，迟到退差单独补入下一天",async()=>{
    const id=await order();const worker=new DailySettlementWorker(db,app.log);
    await worker.tick(new Date("2026-09-25T14:00:00.000Z"));
    expect(db.getPlatformSettlement("STD20260925")?.settlement).toMatchObject({amount:"42.00",rebate_usd:"0.00"});
    pay("STD20260925","CNY","42.00","base-cny");
    confirm(id);
    db.db.prepare("UPDATE platform_rebates SET created_at='2026-09-26T13:59:59.000Z' WHERE order_id=?").run(id);
    await worker.tick(new Date("2026-09-26T14:00:00.000Z"));await worker.tick(new Date("2026-09-26T14:00:01.000Z"));
    expect(db.getPlatformSettlement("STD20260926")?.settlement).toMatchObject({amount:"0.00",rebate_usd:"3.50"});
    expect(db.getPlatformSettlement("STD20260925")?.settlement).toMatchObject({status:"paid",amount:"42.00",rebate_usd:"0.00"});
    expect(db.db.prepare("SELECT COUNT(*) n FROM platform_settlement_lines").get()).toMatchObject({n:1});
  });
  it("每天 22 点纳入所有历史未结算订单，不限于当天创建",async()=>{
    const old=await order(31,"plus"),recent=await order(32,"plus");
    db.db.prepare("UPDATE orders SET created_at='2026-09-20T01:00:00.000Z',updated_at='2026-09-20T01:10:00.000Z' WHERE order_id=?").run(old);
    db.db.prepare("UPDATE orders SET created_at='2026-09-26T11:00:00.000Z',updated_at='2026-09-26T11:10:00.000Z' WHERE order_id=?").run(recent);
    const worker=new DailySettlementWorker(db,app.log);
    await worker.tick(new Date("2026-09-26T14:00:00.000Z"));
    const statement=db.getPlatformSettlement("STD20260926")!;
    expect(statement.lines.map(row=>row.order_id).sort()).toEqual([old,recent].sort());
    expect(statement.settlement).toMatchObject({order_count:2,amount:"50.00"});
  });
  it("明确清算、真实金额相符才可确认，来源变化进入争议并暂停核销",async()=>{
    const id=await order();
    const t={transaction_id:"transaction-001",card_id:"card-id",amount_usd:"89.33",status:"PENDING",type:"Authorization",occurred_at:created,merchant:"OPENAI"};
    ledger.importTransactions([t]);
    expect(()=>ledger.save(id,draft({source:"card_api"}))).toThrow("最终清算");
    ledger.importTransactions([{...t,status:"COMPLETE"}]);
    expect(()=>ledger.save(id,draft({source:"card_api",actual_usd:"1.00"}))).toThrow("不一致");
    confirm(id,{source:"card_api"});settle();
    ledger.importTransactions([{...t,status:"COMPLETE",amount_usd:"88.00"}]);
    expect(ledger.get(id)?.status).toBe("disputed");
    expect(()=>pay("statement1","USD","3.50","dispute-pay")).toThrow("争议");
    expect(db.getOrder(id)?.upstream_actual_cost_amount).toBe("89.48");
  });
  it("未授权用户不能读取成本、交易、凭证或人工核查队列",async()=>{
    for(const url of ["/admin/api/cost-reviews","/admin/api/activation-reviews","/admin/api/cost-fees","/admin/api/platform-settlements/nonexistent"]){
      expect((await app.inject({url})).statusCode).toBe(401);
    }
    expect((await app.inject({method:"POST",url:"/admin/api/cost-transactions/sync",payload:{page:1}})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/admin/api/cost-transactions/sync",headers,payload:{page:1}})).statusCode).toBe(409);
  });
  it("人工恢复只查询原任务，不重复充值；未知结果仍保留查询宽限期",async()=>{
    const id=await order();const a=db.listActivations(id)[0];
    db.db.prepare("INSERT INTO cdks(upstream_cdk_id,plan,code_ciphertext,code_iv,code_tag,status,created_at,updated_at) VALUES ('cdk-test','pro_5x','x','x','x','reserved',?,?)").run(created,created);
    const cdkId=Number((db.db.prepare("SELECT id FROM cdks LIMIT 1").get() as {id:number}).id);
    db.db.prepare("UPDATE activations SET finished=0,status='running',worker_state='polling',redemption_token='private-token',cdk_id=? WHERE id=?").run(cdkId,a.id);
    db.db.prepare("UPDATE orders SET delivery_status='running' WHERE order_id=?").run(id);
    db.db.prepare("INSERT INTO activation_worker_control(activation_id,needs_review,updated_at,last_stage) VALUES (?,1,?,'result')").run(a.id,created);
    const queue=await app.inject({url:"/admin/api/activation-reviews",headers});
    expect(queue.body).not.toContain("private-token");expect(queue.json().items[0].can_resume).toBe(1);
    const result=await app.inject({method:"POST",url:"/admin/api/activation-reviews/"+a.id+"/resolve",headers,
      payload:{action:"resume_query",expected_updated_at:created,reason:"原任务已核实，继续查询结果",verified:true}});
    expect(result.statusCode).toBe(200);
    const issue=vi.spyOn(zovo,"issueCdk"),redeem=vi.spyOn(zovo,"redeem");
    vi.spyOn(zovo,"getResult").mockResolvedValue({status:"processing"});
    await new ActivationWorker(config,db,zovo,app.log).tick();
    expect(issue).not.toHaveBeenCalled();expect(redeem).not.toHaveBeenCalled();
    expect(db.db.prepare("SELECT needs_review FROM activation_worker_control WHERE activation_id=?").get(a.id)).toMatchObject({needs_review:0});
    const repeat=await app.inject({method:"POST",url:"/admin/api/activation-reviews/"+a.id+"/resolve",headers,
      payload:{action:"confirmed_success",expected_updated_at:created,reason:"重复处理必须拒绝",verified:true}});
    expect(repeat.statusCode).toBe(409);
  });
  it("人工确认完成需要明确凭证，拒绝有活动租约；不触发资金或上游请求",async()=>{
    const id=await order(),a=db.listActivations(id)[0];
    db.db.prepare("UPDATE activations SET finished=0,status='running' WHERE id=?").run(a.id);
    db.db.prepare("INSERT INTO activation_worker_control(activation_id,needs_review,updated_at,lease_token,lease_until) VALUES (?,1,?,'busy',?)")
      .run(a.id,created,new Date(Date.now()+60000).toISOString());
    const payload={action:"confirmed_success",expected_updated_at:created,reason:"人工已充值，凭证 MANUAL-001",verified:true,account_email:"customer@example.com"};
    expect((await app.inject({method:"POST",url:"/admin/api/activation-reviews/"+a.id+"/resolve",headers,payload})).statusCode).toBe(409);
    db.db.prepare("UPDATE activation_worker_control SET lease_token=NULL,lease_until=NULL WHERE activation_id=?").run(a.id);
    const redeem=vi.spyOn(zovo,"redeem"),refund=vi.spyOn(payment,"refundPayment");
    expect((await app.inject({method:"POST",url:"/admin/api/activation-reviews/"+a.id+"/resolve",headers,payload})).statusCode).toBe(200);
    expect(db.listActivations(id)[0]).toMatchObject({status:"success",finished:1});
    expect(redeem).not.toHaveBeenCalled();expect(refund).not.toHaveBeenCalled();
  });
  it("后台所有内联脚本可解析，核查模块不含自动付款函数",()=>{
    const scripts=[...adminPageV2.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBe(4);
    for(const script of scripts)new Script(script[1]);
    expect(adminPageV2).toContain('真实成本与平台退差');
  });
});
describe("卡台交易查询只读适配",()=>{
  afterEach(()=>{vi.unstubAllGlobals();});
  it("只做 GET 且不保留卡号，使用 USD 清算金额而非 PHP 授权额",async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({code:0,data:[
      {auth_id:"auth-1",card_id:"card1",card_number:"4111111111111111",auth_amount:"5600",auth_currency:"PHP",
        settle_amount:"89.33",settle_currency:"USD",status:"COMPLETE",type:"Authorization",auth_time:"2026-09-25",merchant_name:"OPENAI"},
      {auth_id:"php",settle_amount:"5600",settle_currency:"PHP"}]}),{status:200}));
    vi.stubGlobal("fetch",fetcher);
    const client=new LiveZovoClient({mode:"live",baseUrl:"https://example.invalid",apiKey:"fake",appId:"fake",timeoutMs:1000});
    const rows=await client.listCardTransactions(1);
    expect(rows).toHaveLength(1);expect(rows[0].amount_usd).toBe("89.33");
    expect(JSON.stringify(rows)).not.toContain("411111");
    expect(fetcher.mock.calls[0][1].method).toBe("GET");
    expect(String(fetcher.mock.calls[0][0])).toContain("sync=0");
  });
  it("接受上游 Pro 50x 成本快照，但不把 PHP 金额当成 USD 成本",async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({code:0,data:{order:{
      order_id:293829,client_request_id:"tsk-safe",plan:"pro_50x",status:"completed",card_id:398191,
      card_last_four:"9380",final_amount_minor:2900893,quoted_amount_minor:2900893,currency:"PHP",
      completed_at:"2026-09-26T14:52:41.542Z"}}}),{status:200}));
    vi.stubGlobal("fetch",fetcher);
    const client=new LiveZovoClient({mode:"live",baseUrl:"https://example.invalid",apiKey:"fake",appId:"fake",timeoutMs:1000});
    const order=await client.getCdkOrderCost("293829");
    expect(order).toMatchObject({order_id:"293829",plan:"pro_50x",card_id:"398191",currency:"PHP",
      final_amount_minor:2900893,completed_at:"2026-09-26T14:52:41.542Z"});
    expect(fetcher.mock.calls[0][1].method).toBe("GET");
    expect(String(fetcher.mock.calls[0][0])).toContain("/gpt-direct/cdk-orders/293829");
    expect(JSON.stringify(order)).not.toContain("apiKey");
  });
});
