import type { FastifyBaseLogger } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardCostTransaction, CdkOrderCostSnapshot } from "../src/clients/zovo.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { AppDatabase } from "../src/database.js";
import { buildApp } from "../src/app.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { CostAutoReviewWorker } from "../src/services/cost-auto-review-worker.js";
import { FinancialLedger } from "../src/services/financial-ledger.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";

class CostAwareZovo extends MockZovoClient {
  transactions:CardCostTransaction[]=[];
  snapshots=new Map<string,CdkOrderCostSnapshot>();
  async listCardTransactions():Promise<CardCostTransaction[]>{return this.transactions;}
  async getCdkOrderCost(orderId:string):Promise<CdkOrderCostSnapshot>{
    const value=this.snapshots.get(orderId);
    if(!value)throw new Error("missing test snapshot");
    return value;
  }
}

describe("卡台流水自动成本核对",()=>{
  let dir:string,db:AppDatabase,app:Awaited<ReturnType<typeof buildApp>>,zovo:CostAwareZovo;
  let config:ReturnType<typeof ledgerTestConfig>;
  const log={info:vi.fn(),warn:vi.fn(),error:vi.fn()} as unknown as FastifyBaseLogger;
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),"cost-auto-review-"));
    config=ledgerTestConfig(join(dir,"test.sqlite"));
    db=new AppDatabase(config.databasePath);zovo=new CostAwareZovo();
    app=await buildApp(config,{db,zovo,payment:new MockPaymentClient(config.publicBaseUrl),startWorkers:false});
  });
  afterEach(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});vi.clearAllMocks();});

  async function order(n:number,plan:"plus"|"pro_5x"="plus"){
    const response=await app.inject({method:"POST",url:"/api/v1/checkout/orders",headers:{"x-api-key":config.platformApiKey},
      payload:{product:plan==="plus"?"chatgpt_plus_1m":"chatgpt_pro_5x_1m",quantity:1,
        sell_price:plan==="plus"?"135.00":"680.00",client_order_id:"po_auto_"+n}});
    const id=response.json().order_id as string,created="2026-09-26T14:50:00.000Z";
    db.markOrderPaid(id,created,"trade-auto-"+n,plan==="plus"?"135.00":"680.00");
    db.db.prepare("UPDATE orders SET delivery_status='success',created_at=?,updated_at=? WHERE order_id=?").run(created,created,id);
    db.db.prepare(`INSERT INTO activations(order_id,activation_id,task_id,status,finished,upstream_order_id,worker_state,created_at,updated_at)
      VALUES (?,1,?,'success',1,?,'terminal',?,?)`).run(id,"tsk-auto-"+n,String(290000+n),created,created);
    return {id,upstream:String(290000+n),task:"tsk-auto-"+n,plan};
  }
  function snapshot(o:Awaited<ReturnType<typeof order>>,cardId:string):CdkOrderCostSnapshot{
    return {order_id:o.upstream,client_request_id:o.task,plan:o.plan,status:"completed",card_id:cardId,
      final_amount_minor:o.plan==="plus"?98214:579464,quoted_amount_minor:o.plan==="plus"?98214:579464,
      currency:"PHP",completed_at:"2026-09-26T14:52:41.000Z"};
  }
  function transaction(cardId:string,amount:string,id:string,occurredAt="2026-09-26 22:52:41"):CardCostTransaction{
    return {transaction_id:id,card_id:cardId,amount_usd:amount,status:"COMPLETE",type:"Authorization",
      occurred_at:occurredAt,merchant:"OPENAI* CHATGPT SUBSCR"};
  }

  it("当前基准价与唯一关联流水一致时自动确认，费用仍在独立费用账",async()=>{
    const o=await order(1),card="card-plus";
    zovo.snapshots.set(o.upstream,snapshot(o,card));
    zovo.transactions=[transaction(card,"15.76","auth-plus")];
    const result=await new CostAutoReviewWorker(db,zovo,log).tick(new Date("2026-09-26T15:10:00.000Z"));
    expect(result).toMatchObject({scanned:1,confirmed:1,review_required:0,pending:0});
    expect(new FinancialLedger(db).get(o.id)).toMatchObject({status:"confirmed",standard_usd:"15.76",
      actual_usd:"15.76",fees_usd:"0.00",total_cost_usd:"15.76"});
    expect(db.db.prepare("SELECT COUNT(*) n FROM cost_fees").get()).toMatchObject({n:0});
    expect(db.getPlatformRebate(o.id)).toBeUndefined();
    expect(new FinancialLedger(db).list(o.id,1,"").items[0]).toMatchObject({
      status:"confirmed",upstream_estimated_cost_cny:"108.00",gross_profit_cny:"2.00",
    });
  });

  it("标准成本与实际扣款相差少于1U时按汇率波动自动确认，不生成补差",async()=>{
    const o=await order(7),card="card-fx-noise";
    zovo.snapshots.set(o.upstream,snapshot(o,card));
    zovo.transactions=[transaction(card,"15.74","auth-fx-noise")];
    const result=await new CostAutoReviewWorker(db,zovo,log).tick(new Date("2026-09-26T15:10:00.000Z"));
    expect(result).toMatchObject({scanned:1,confirmed:1,review_required:0,pending:0});
    expect(new FinancialLedger(db).get(o.id)).toMatchObject({status:"confirmed",standard_usd:"15.76",
      actual_usd:"15.74",rebate_usd:"0.00",total_cost_usd:"15.74"});
    expect(db.getPlatformRebate(o.id)).toBeUndefined();
  });

  it("历史遗留的卡台小额波动草稿会在下一轮自动确认",async()=>{
    const o=await order(8),card="card-fx-draft",tx=transaction(card,"15.74","auth-fx-draft");
    const ledger=new FinancialLedger(db);
    ledger.importTransactions([tx]);
    ledger.save(o.id,{revision:0,plan:"plus",standard_usd:"15.76",actual_usd:"15.74",
      retained_usd:"0.15",fx_rate:null,standard_reference:"当前成本基准 2026-09-27",
      evidence:"历史自动核查草稿",source:"card_api",transaction_ids:[tx.transaction_id],fees_checked:true});
    zovo.transactions=[tx];
    const result=await new CostAutoReviewWorker(db,zovo,log).tick(new Date("2026-09-26T15:10:00.000Z"));
    expect(result).toMatchObject({scanned:1,confirmed:1,review_required:0,pending:0});
    expect(ledger.get(o.id)).toMatchObject({status:"confirmed",rebate_usd:"0.00"});
  });

  it("差额恰好1U时不属于波动容差，仍进入人工核查",async()=>{
    const o=await order(9),card="card-one-dollar";
    zovo.snapshots.set(o.upstream,snapshot(o,card));
    zovo.transactions=[transaction(card,"14.76","auth-one-dollar")];
    const result=await new CostAutoReviewWorker(db,zovo,log).tick(new Date("2026-09-26T15:10:00.000Z"));
    expect(result).toMatchObject({scanned:1,confirmed:0,review_required:1,pending:0});
    expect(new FinancialLedger(db).get(o.id)).toMatchObject({status:"draft",rebate_usd:"0.85"});
  });

  it("实际扣款与当前基准不一致时只生成异常草稿，等待人工确认",async()=>{
    const o=await order(2,"pro_5x"),card="card-upgrade";
    zovo.snapshots.set(o.upstream,snapshot(o,card));
    zovo.transactions=[transaction(card,"89.33","auth-upgrade")];
    const result=await new CostAutoReviewWorker(db,zovo,log).tick(new Date("2026-09-26T15:10:00.000Z"));
    expect(result).toMatchObject({scanned:1,confirmed:0,review_required:1});
    expect(new FinancialLedger(db).get(o.id)).toMatchObject({status:"draft",standard_usd:"92.98",actual_usd:"89.33"});
    expect(db.getPlatformRebate(o.id)).toBeUndefined();
  });

  it("同卡短时间有多笔扣款时先按上游单号核验，再选择完成时间明确最近的一笔",async()=>{
    const o=await order(5),card="card-busy";
    zovo.snapshots.set(o.upstream,snapshot(o,card));
    zovo.transactions=[
      transaction(card,"15.76","auth-exact"),
      transaction(card,"15.76","auth-next","2026-09-26 22:53:42"),
    ];
    db.recordOrderAudit({orderId:o.id,action:"cost_auto_review_required",fromStatus:"missing",toStatus:"review_required",
      operator:"system",reason:"同一卡片在完成时间附近存在多笔扣款，无法唯一关联"});
    const result=await new CostAutoReviewWorker(db,zovo,log).tick(new Date("2026-09-26T15:10:00.000Z"));
    expect(result).toMatchObject({scanned:1,confirmed:1,review_required:0});
    expect(new FinancialLedger(db).get(o.id)).toMatchObject({status:"confirmed",actual_usd:"15.76",
      transaction_ids:'["auth-exact"]'});
    expect(db.db.prepare("SELECT transaction_id FROM cost_transaction_links WHERE order_id=?").all(o.id))
      .toEqual([{transaction_id:"auth-exact"}]);
  });

  it("两笔扣款与上游完成时间几乎等距时仍转人工，避免错绑流水",async()=>{
    const o=await order(6),card="card-ambiguous";
    zovo.snapshots.set(o.upstream,snapshot(o,card));
    zovo.transactions=[
      transaction(card,"15.76","auth-before","2026-09-26 22:52:40"),
      transaction(card,"15.76","auth-after","2026-09-26 22:52:42"),
    ];
    const result=await new CostAutoReviewWorker(db,zovo,log).tick(new Date("2026-09-26T15:10:00.000Z"));
    expect(result).toMatchObject({scanned:1,confirmed:0,review_required:1});
    expect(new FinancialLedger(db).get(o.id)).toBeUndefined();
    expect(new FinancialLedger(db).list(o.id,1,"").items[0].status).toBe("review_required");
  });

  it("找不到唯一对应流水时进入人工审核；历史已入结算订单不重复核对",async()=>{
    const manual=await order(3),historical=await order(4);
    zovo.snapshots.set(manual.upstream,snapshot(manual,"missing-card"));
    db.db.prepare("UPDATE orders SET created_at='2026-09-20T01:00:00.000Z',updated_at='2026-09-20T01:10:00.000Z' WHERE order_id=?").run(historical.id);
    db.createPlatformSettlement({settlementId:"historical",from:"2020-01-01T00:00:00.000Z",
      to:"2026-09-21T00:00:00.000Z"});
    const result=await new CostAutoReviewWorker(db,zovo,log).tick(new Date("2026-09-26T15:10:00.000Z"));
    expect(result).toMatchObject({scanned:1,review_required:1});
    const ledger=new FinancialLedger(db);
    expect(ledger.list(manual.id,1,"").items[0].status).toBe("review_required");
    expect(ledger.list(historical.id,1,"").items[0].status).toBe("historical");
    expect(ledger.get(historical.id)).toBeUndefined();
  });
});
