import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateCostReconciliation } from "../src/services/cost-reconciliation.js";
import { AppDatabase } from "../src/database.js";
import { buildApp } from "../src/app.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";
import { DailySettlementWorker } from "../src/services/daily-settlement-worker.js";

const base = {supplyCny:"100.00",standardCostCny:"80.00",platformBaseProfitCny:"20.00",standardUsd:"80.00",
  actualUsd:"75.00",feesUsd:"0.00",retainedUsd:"0.00",fxRate:"1.00"};
describe("成本节省另退平台：用户确认的 80 / 100 / 120 口径",()=>{
  it("实际少扣 5，平台收到 20+5，我方 95-75=20；1:1 仅用于同币种示例",()=>{
    expect(calculateCostReconciliation(base)).toMatchObject({
      original_supply_cny:"100.00",platform_base_profit_cny:"20.00",saving_usd:"5.00",
      rebate_usd:"5.00",total_cost_usd:"75.00",supplier_net_income_cny:"95.00",
      gross_profit_cny:"20.00",platform_total_equivalent_cny:"25.00",
    });
  });
  it.each(["79.99","75.00","70.00","40.00"])("无额外费用时不同少扣金额 %s 保持原毛利",actualUsd=>{
    expect(calculateCostReconciliation({...base,actualUsd}).gross_profit_cny).toBe("20.00");
  });
  it("0.15 预留作为内置手续费与退差同步抵消；另行费用单独减少毛利",()=>{
    const withoutFee=calculateCostReconciliation({...base,retainedUsd:"0.15"});
    expect(withoutFee).toMatchObject({retained_applied_usd:"0.15",rebate_usd:"4.85",
      total_cost_usd:"75.15",supplier_net_income_cny:"95.15",gross_profit_cny:"20.00"});
    expect(calculateCostReconciliation({...base,retainedUsd:"0.15",feesUsd:"0.15"}))
      .toMatchObject({total_cost_usd:"75.30",profit_adjustment_usd:"-0.15",gross_profit_cny:"19.85"});
  });
  it("少于1U的差额视为汇率波动，不生成退差或人工成本差异",()=>{
    expect(calculateCostReconciliation({...base,actualUsd:"79.90",retainedUsd:"0.15"}))
      .toMatchObject({saving_usd:"0.00",ignored_variance_usd:"0.10",retained_applied_usd:"0.00",
        rebate_usd:"0.00",total_cost_usd:"79.90",gross_profit_cny:"20.00"});
  });
  it("15.76与15.74的差额自动忽略，但保留真实扣款作为审计证据",()=>{
    expect(calculateCostReconciliation({...base,standardUsd:"15.76",actualUsd:"15.74",
      standardCostCny:"110.00",supplyCny:"110.00",retainedUsd:"0.15",fxRate:null})).toMatchObject({
        saving_usd:"0.00",ignored_variance_usd:"0.02",rebate_usd:"0.00",
        actual_usd:"15.74",actual_cost_cny:"110.00",gross_profit_cny:"0.00",
      });
  });
  it("差额恰好1U时进入正常差额计算",()=>{
    expect(calculateCostReconciliation({...base,standardUsd:"15.76",actualUsd:"14.76",
      retainedUsd:"0.15"})).toMatchObject({
        saving_usd:"1.00",ignored_variance_usd:"0.00",rebate_usd:"0.85",
      });
  });
  it("正常扣款、超扣不自动追加应收或修改供货报价",()=>{
    expect(calculateCostReconciliation({...base,actualUsd:"80.00"}))
      .toMatchObject({rebate_usd:"0.00",supplier_net_income_cny:"100.00",gross_profit_cny:"20.00"});
    expect(calculateCostReconciliation({...base,actualUsd:"85.00"}))
      .toMatchObject({rebate_usd:"0.00",supplier_net_income_cny:"100.00",gross_profit_cny:"15.00"});
  });
  it("正常扣款没有美元退差时，无需汇率即可带入人民币供货价作为净结算收入",()=>{
    expect(calculateCostReconciliation({...base,actualUsd:"80.00",fxRate:null})).toMatchObject({
      rebate_usd:"0.00",rebate_equivalent_cny:"0.00",supplier_net_income_cny:"100.00",
      platform_total_equivalent_cny:"20.00",actual_cost_cny:"80.00",gross_profit_cny:"20.00",
    });
  });
  it("缺少真实资金汇率时仅生成 USD 差额，不用 7 或市场牌价猜 CNY 毛利",()=>{
    expect(calculateCostReconciliation({...base,fxRate:null})).toMatchObject({
      rebate_usd:"5.00",fx_rate:null,actual_cost_cny:null,rebate_equivalent_cny:null,
      gross_profit_cny:"20.00",supplier_net_income_cny:null,platform_total_equivalent_cny:null,
    });
  });
  it("按显式核算汇率换算，保留真实负毛利而非强制保底",()=>{
    expect(calculateCostReconciliation({...base,supplyCny:"638.00",standardCostCny:"637.00",standardUsd:"92.98",
      actualUsd:"89.33",feesUsd:"0.10",retainedUsd:"0.15",fxRate:"7.00"}))
      .toMatchObject({actual_cost_cny:"627.06",rebate_equivalent_cny:"24.50",
        base_gross_profit_cny:"1.00",profit_adjustment_usd:"-0.10",gross_profit_cny:"0.30"});
    expect(()=>calculateCostReconciliation({...base,fxRate:"0"})).toThrow("汇率");
  });
});

describe("后台核查、报表、导出及 22 点结算使用同一退差口径",()=>{
  let dir:string,db:AppDatabase,app:Awaited<ReturnType<typeof buildApp>>,
    payment:MockPaymentClient,zovo:MockZovoClient,id:string;
  const headers={"x-admin-token":"local-ledger-preview"},created="2026-09-25T13:00:00.000Z";
  const input={revision:0,plan:"pro_5x",standard_usd:"80.00",actual_usd:"75.00",
    retained_usd:"0.00",fx_rate:"1.00",standard_reference:"测试套餐预期扣款 80（模拟）",
    evidence:"本地模拟核查交易，汇率 1 仅为同币种示例",source:"manual",
    transaction_ids:["test-cost-80-75"],fees_checked:true};
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),"quefa-rebate-rule-"));
    const config=ledgerTestConfig(join(dir,"test.sqlite"));
    config.products[0].cost_price="100.00";config.products[0].internal_cost_cny="80.00";
    db=new AppDatabase(config.databasePath);payment=new MockPaymentClient(config.publicBaseUrl);zovo=new MockZovoClient();
    app=await buildApp(config,{db,payment,zovo,startWorkers:false});
    const res=await app.inject({method:"POST",url:"/api/v1/checkout/orders",
      headers:{"x-api-key":config.platformApiKey},payload:{product:"chatgpt_pro_5x_1m",quantity:1,
        sell_price:"120.00",client_order_id:"po_local_rebate_rule"}});
    expect(res.statusCode).toBe(200);id=res.json().order_id;
    db.markOrderPaid(id,created,"mock-rule-trade","120.00");
    db.db.prepare("UPDATE orders SET delivery_status='success',created_at=?,updated_at=? WHERE order_id=?").run(created,created,id);
    db.db.prepare("INSERT INTO activations(order_id,activation_id,task_id,status,finished,upstream_order_id,worker_state,created_at,updated_at) VALUES (?,1,'tsk-local-rule','success',1,'upstream-local-rule','terminal',?,?)").run(id,created,created);
  });
  afterEach(async()=>{vi.restoreAllMocks();await app.close();rmSync(dir,{recursive:true,force:true});});
  async function save(overrides:Record<string,unknown>={}){
    const r=await app.inject({method:"PUT",url:"/admin/api/cost-reviews/"+id,headers,payload:{...input,...overrides}});
    expect(r.statusCode).toBe(200);return r.json().review;
  }
  async function confirm(){
    const r=await app.inject({method:"POST",url:"/admin/api/cost-reviews/"+id+"/confirm",headers,payload:{revision:1,verified:true}});
    expect(r.statusCode).toBe(200);return r.json();
  }
  const report=()=>app.inject({url:"/admin/api/finance?from=2026-09-24&to=2026-09-27",headers});
  it("确认后原价100不变、真实成本75、净收入95、毛利20，导出和详情一致；无资金调用",async()=>{
    const refund=vi.spyOn(payment,"refundPayment"),issue=vi.spyOn(zovo,"issueCdk"),redeem=vi.spyOn(zovo,"redeem");
    await save();await confirm();await confirm();
    expect(db.getOrder(id)).toMatchObject({platform_supply_price:"100.00",amount:"120.00",
      alipay_receipt_amount:"120.00",upstream_actual_cost_cny:"75.00",customer_price_refund_amount:"0.00"});
    const detail=(await app.inject({url:"/admin/api/cost-reviews/"+id,headers})).json();
    expect(detail.reconciliation).toMatchObject({platform_base_profit_cny:"20.00",
      rebate_usd:"5.00",supplier_net_income_cny:"95.00",gross_profit_cny:"20.00",platform_total_equivalent_cny:"25.00"});
    const f=(await report()).json();
    expect(f.items[0]).toMatchObject({platform_margin:"20.00",gross_profit:"20.00",
      supplier_net_income_cny:"95.00",rebate_equivalent_cny:"5.00",profit_basis:"verified"});
    expect(f.summary).toMatchObject({platform_margin:"20.00",platform_rebate_payable_usd:"5.00",gross_profit:"20.00"});
    for (const path of ["orders","fulfillment"]) {
      const list=await app.inject({url:"/admin/api/"+path+"?from=2026-09-24&to=2026-09-27",headers});
      expect(list.statusCode).toBe(200);
      expect(list.json().items[0]).toMatchObject({gross_profit:"20.00",supplier_net_income_cny:"95.00",profit_basis:"verified"});
    }
    const order=(await app.inject({url:"/admin/api/orders/"+id,headers})).json();
    expect(order.cost_reconciliation).toEqual(detail.reconciliation);
    const csv=(await app.inject({url:"/admin/api/finance.csv?from=2026-09-24&to=2026-09-27",headers})).body;
    expect(csv).toContain("我方净结算收入(CNY)");expect(csv).toContain("95.00");expect(csv).toContain("已核实");
    expect(db.db.prepare("SELECT COUNT(*) n FROM platform_rebates").get()).toMatchObject({n:1});
    expect(refund).not.toHaveBeenCalled();expect(issue).not.toHaveBeenCalled();expect(redeem).not.toHaveBeenCalled();
  });
  it("已保存未确认的试算不计作实际毛利，确认后争议重新变待核算",async()=>{
    await save();
    expect((await report()).json().items[0]).toMatchObject({gross_profit:null,supplier_net_income_cny:null,profit_basis:"pending"});
    await confirm();
    await app.inject({method:"POST",url:"/admin/api/cost-reviews/"+id+"/dispute",headers,payload:{reason:"凭证需重新核查"}});
    expect((await report()).json().items[0]).toMatchObject({gross_profit:null,supplier_net_income_cny:null,profit_basis:"pending"});
    expect((await app.inject({url:"/admin/api/cost-reviews/"+id,headers})).json().reconciliation).toBeNull();
  });
  it("无汇率确认仍出美元退差，退差与成本下降抵消后基础毛利可直接显示",async()=>{
    await save({fx_rate:null,retained_usd:undefined});await confirm();
    expect(db.getPlatformRebate(id)?.rebate_usd).toBe("4.85");
    expect((await report()).json().items[0]).toMatchObject({gross_profit:"20.00",supplier_net_income_cny:null,profit_basis:"estimated"});
    expect((await report()).json().summary).toMatchObject({gross_profit:"20.00",profit_pending_count:0,profit_estimated_count:1});
    const statement=db.createPlatformSettlement({settlementId:"LOCAL-NO-FX",from:"2020-01-01",to:"2099-01-01"});
    expect(statement.settlement).toMatchObject({amount:"20.00",rebate_usd:"4.85",status:"pending"});
  });
  it("无退差时从订单冻结供货价和人民币成本直接计算基础毛利",async()=>{
    await save({actual_usd:"80.00",fx_rate:null});await confirm();
    const detail=(await app.inject({url:"/admin/api/cost-reviews/"+id,headers})).json();
    expect(detail.reconciliation).toMatchObject({rebate_usd:"0.00",rebate_equivalent_cny:"0.00",
      supplier_net_income_cny:"100.00",actual_cost_cny:"80.00",gross_profit_cny:"20.00"});
    expect(db.getOrder(id)?.upstream_actual_cost_cny).toBe("80.00");
    expect((await report()).json().items[0]).toMatchObject({supplier_net_income_cny:"100.00",
      gross_profit:"20.00",cost_basis_cny:"80.00",profit_basis:"verified"});
    expect((await report()).json().summary).toMatchObject({gross_profit:"20.00",profit_pending_count:0,profit_action_required_count:0,profit_estimated_count:0});
    expect(db.getPlatformRebate(id)).toBeUndefined();
  });
  it("22点只生成20元基础利润和5美元退差，重复出单不增款、登记付款不再扣利润",async()=>{
    await save();await confirm();
    db.db.prepare("UPDATE orders SET updated_at=? WHERE order_id=?").run(created,id);
    db.db.prepare("UPDATE platform_rebates SET created_at=? WHERE order_id=?").run(created,id);
    const worker=new DailySettlementWorker(db,app.log);
    await worker.tick(new Date("2026-09-25T14:00:00Z"));await worker.tick(new Date("2026-09-25T14:00:01Z"));
    expect(db.getPlatformSettlement("STD20260925")?.settlement).toMatchObject({amount:"20.00",rebate_usd:"5.00",status:"pending"});
    expect(db.db.prepare("SELECT COUNT(*) n FROM settlement_payments").get()).toMatchObject({n:0});
    db.recordPlatformSettlementPayment({settlementId:"STD20260925",currency:"USD",amount:"5.00",
      method:"other",reference:"test-paid-usd",note:"模拟人工已付",paidAt:created});
    expect((await report()).json().items[0]).toMatchObject({gross_profit:"20.00",supplier_net_income_cny:"95.00"});
    expect(db.getPlatformRebate(id)?.status).toBe("paid");
  });
});
