import type { FastifyBaseLogger } from "fastify";
import type { CardCostTransaction, CdkOrderCostSnapshot, ZovoClient } from "../clients/zovo.js";
import type { AppDatabase } from "../database.js";
import { CURRENT_STANDARD_COST_USD, FinancialLedger } from "./financial-ledger.js";
import { isIgnorableCostVariance } from "./cost-reconciliation.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const TRANSACTION_MATCH_WINDOW_MS = 2 * 60 * 1000;
const DIRECT_ORDER_MATCH_MAX_DISTANCE_MS = 15 * 1000;
const MIN_UNAMBIGUOUS_LEAD_MS = 30 * 1000;
const WAIT_FOR_SETTLEMENT_MS = 15 * 60 * 1000;

export interface AutomaticCostReviewSummary {
  scanned: number;
  confirmed: number;
  review_required: number;
  pending: number;
  transactions_imported: number;
}

function transactionTimes(value: string): number[] {
  const normalized=value.trim().replace(" ","T");
  const values=[Date.parse(normalized),Date.parse(normalized+"Z"),Date.parse(normalized+"+08:00")];
  return [...new Set(values.filter(Number.isFinite))];
}

function distanceFromCompleted(transaction: CardCostTransaction, completedAt: string): number {
  const completed=Date.parse(completedAt);
  if(!Number.isFinite(completed))return Number.POSITIVE_INFINITY;
  return Math.min(...transactionTimes(transaction.occurred_at).map(time=>Math.abs(time-completed)));
}

export class CostAutoReviewWorker {
  private timer:NodeJS.Timeout|null=null;
  private running=false;
  private readonly ledger:FinancialLedger;

  constructor(
    private readonly db:AppDatabase,
    private readonly zovo:ZovoClient,
    private readonly log:FastifyBaseLogger,
    private readonly options:{intervalMs?:number;transactionPages?:number}={},
  ){
    this.ledger=new FinancialLedger(db);
  }

  start():void {
    if(this.timer)return;
    const run=()=>void this.tick().catch(error=>
      this.log.warn({err:error},"automatic cost review cycle failed; no financial action executed"));
    this.timer=setInterval(run,this.options.intervalMs??DEFAULT_INTERVAL_MS);
    this.timer.unref();
    run();
  }

  stop():void {
    if(this.timer)clearInterval(this.timer);
    this.timer=null;
  }

  async tick(now=new Date(),limit=20):Promise<AutomaticCostReviewSummary> {
    const summary:AutomaticCostReviewSummary={scanned:0,confirmed:0,review_required:0,pending:0,transactions_imported:0};
    if(this.running)return summary;
    if(!this.zovo.listCardTransactions||!this.zovo.getCdkOrderCost)return summary;
    this.running=true;
    try{
      const pages=Math.max(1,Math.min(10,this.options.transactionPages??3));
      for(let page=1;page<=pages;page++){
        const transactions=await this.zovo.listCardTransactions(page);
        this.ledger.importTransactions(transactions);
        summary.transactions_imported+=transactions.length;
      }
      for(const draft of this.ledger.automaticIgnorableVarianceDrafts(limit)){
        summary.scanned+=1;
        try{
          this.ledger.confirm(String(draft.order_id),Number(draft.revision));
          summary.confirmed+=1;
        }catch(error){
          summary.pending+=1;
          this.log.warn({orderId:draft.order_id,err:error},"automatic cost variance draft confirmation deferred");
        }
      }
      const remaining=Math.max(0,limit-summary.scanned);
      for(const candidate of remaining ? this.ledger.automaticCandidates(remaining) : []){
        summary.scanned+=1;
        try{
          const snapshot=await this.zovo.getCdkOrderCost(String(candidate.upstream_order_id));
          const outcome=this.reviewCandidate(candidate,snapshot,now);
          summary[outcome]+=1;
        }catch(error){
          summary.pending+=1;
          this.log.warn({orderId:candidate.order_id,err:error},"automatic cost review deferred");
        }
      }
      if(summary.scanned||summary.transactions_imported)this.log.info(summary,"automatic cost review completed");
      return summary;
    }finally{
      this.running=false;
    }
  }

  private reviewCandidate(candidate:Record<string,any>,snapshot:CdkOrderCostSnapshot,now:Date):
    "confirmed"|"review_required"|"pending" {
    const id=String(candidate.order_id);
    if(snapshot.status!=="completed"||!snapshot.completed_at)return "pending";
    if(snapshot.order_id!==String(candidate.upstream_order_id)||snapshot.client_request_id!==String(candidate.task_id)){
      this.ledger.markAutomaticReviewRequired(id,"卡台订单号或任务号与本订单不一致，需人工核对关联关系");
      return "review_required";
    }
    if(snapshot.plan!==candidate.plan){
      this.ledger.markAutomaticReviewRequired(id,`卡台套餐 ${snapshot.plan} 与订单套餐 ${candidate.plan} 不一致`);
      return "review_required";
    }
    const completed=Date.parse(snapshot.completed_at);
    if(!Number.isFinite(completed)){
      this.ledger.markAutomaticReviewRequired(id,"卡台完成时间格式异常，无法唯一关联扣款流水");
      return "review_required";
    }
    const transactions=(this.db.db.prepare(`SELECT transaction_id,card_id,amount_usd,status,type,occurred_at,merchant
      FROM cost_transactions WHERE card_id=? AND status='COMPLETE' AND amount_usd<>'0.00'`)
      .all(snapshot.card_id) as unknown as CardCostTransaction[])
      .filter(row=>["Authorization","Settlement"].includes(row.type)&&/OPENAI/i.test(row.merchant));
    const authorization=transactions.filter(row=>row.type==="Authorization");
    const pool=authorization.length?authorization:transactions;
    const matches=pool.map(row=>({row,distance:distanceFromCompleted(row,snapshot.completed_at!)}))
      .filter(item=>item.distance<=TRANSACTION_MATCH_WINDOW_MS)
      .sort((left,right)=>left.distance-right.distance);
    const closest=matches[0], runnerUp=matches[1];
    const uniquelyMatched=matches.length===1 || Boolean(closest&&runnerUp&&
      closest.distance<=DIRECT_ORDER_MATCH_MAX_DISTANCE_MS &&
      runnerUp.distance-closest.distance>=MIN_UNAMBIGUOUS_LEAD_MS);
    if(!uniquelyMatched){
      if(now.getTime()-completed<WAIT_FOR_SETTLEMENT_MS)return "pending";
      this.ledger.markAutomaticReviewRequired(id,matches.length
        ?"已核实上游单号、任务号与套餐，但最接近完成时间的多笔扣款仍无法唯一关联"
        :"完成后仍未找到同一卡片、同一时间窗口的美元扣款流水");
      return "review_required";
    }
    const standard=CURRENT_STANDARD_COST_USD[candidate.plan as keyof typeof CURRENT_STANDARD_COST_USD];
    const actual=closest!.row.amount_usd;
    const evidence=`系统先核实上游单号 ${snapshot.order_id}、任务号和套餐，再按卡片及精确完成时间唯一关联卡台流水 ${closest!.row.transaction_id}；服务费另账`;
    const draft=this.ledger.save(id,{revision:0,plan:candidate.plan,standard_usd:standard,actual_usd:actual,
      retained_usd:"0.15",fx_rate:null,standard_reference:"当前成本基准 2026-09-27",
      evidence,source:"card_api",transaction_ids:[closest!.row.transaction_id],fees_checked:true});
    if(!isIgnorableCostVariance(standard,actual))return "review_required";
    this.ledger.confirm(id,draft.revision);
    return "confirmed";
  }
}
