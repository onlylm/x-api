import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./database.js";
import { adminGuard } from "./admin-routes.js";
import type { ZovoClient } from "./clients/zovo.js";
import { FinancialLedger, LedgerError } from "./services/financial-ledger.js";
import { resolveActivationReview } from "./services/activation-review.js";
import { CostAutoReviewWorker } from "./services/cost-auto-review-worker.js";

const cash = z.string().regex(/^\d{1,7}\.\d{2}$/);
const proof = z.string().trim().min(4).max(500);
const revision = z.number().int().min(0);
const draft = z.object({
  revision, plan:z.enum(["plus","pro_5x","pro_20x","pro_50x","x_premium_3m","x_premium_6m"]),standard_usd:cash,actual_usd:cash,
  retained_usd:cash.default("0.15"),fx_rate:z.string().regex(/^\d{1,3}(\.\d{1,6})?$/).nullable().optional(),
  standard_reference:proof,evidence:proof,source:z.enum(["manual","card_api"]),
  transaction_ids:z.array(z.string().trim().min(1).max(120)).min(1).max(20),fees_checked:z.boolean(),
});
const query = z.object({q:z.string().max(120).default(""),page:z.coerce.number().int().min(1).max(100000).default(1),
  status:z.enum(["","missing","review_required","draft","confirmed","disputed","historical"]).default("")});
const settlementQuery = z.object({q:z.string().max(120).default(""),page:z.coerce.number().int().min(1).max(100000).default(1),
  page_size:z.coerce.number().int().min(10).max(100).default(20),status:z.enum(["","pending","partial","paid"]).default(""),
  from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()});
const externalRebatePayment=z.object({payment_id:z.string().min(8).max(100),method:z.enum(["bank_transfer","alipay","other"]),
  reference:z.string().trim().min(3).max(120),note:z.string().trim().max(500).default(""),paid_at:z.string().datetime(),
  applied_usd:cash,payment_currency:z.enum(["CNY","USD"]),payment_amount:cash,fx_rate:z.string().regex(/^\d{1,3}(\.\d{1,6})?$/).nullable().optional(),
  funding_amount:cash.nullable().optional(),verified:z.literal(true)});const csvCell=(value:unknown)=>{const text=String(value??"");return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;};
const beijingCsvTime=(value:unknown)=>{const date=new Date(String(value??""));return Number.isNaN(date.getTime())?"":new Date(date.getTime()+8*3600000).toISOString().replace("T"," ").slice(0,19);};
export function registerLedgerRoutes(app:FastifyInstance,config:AppConfig,db:AppDatabase,zovo:ZovoClient,
  automaticReviewer=new CostAutoReviewWorker(db,zovo,app.log)):void {
  const guard={preHandler:adminGuard(config)}, ledger=new FinancialLedger(db);
  app.get("/admin/api/cost-reviews",guard,async request=>{
    const q=query.parse(request.query);return {success:true,...ledger.list(q.q,q.page,q.status)};
  });
  app.get<{Params:{id:string}}>("/admin/api/cost-reviews/:id",guard,async request=>({success:true,...ledger.detail(request.params.id)}));
  app.put<{Params:{id:string}}>("/admin/api/cost-reviews/:id",guard,async request=>({
    success:true,review:ledger.save(request.params.id,draft.parse(request.body))}));
  app.post<{Params:{id:string}}>("/admin/api/cost-reviews/:id/confirm",guard,async request=>{
    const input=z.object({revision,verified:z.literal(true)}).parse(request.body);
    return {success:true,review:ledger.confirm(request.params.id,input.revision),rebate:db.getPlatformRebate(request.params.id)??null};
  });
  app.post<{Params:{id:string}}>("/admin/api/cost-reviews/:id/dispute",guard,async request=>{
    ledger.dispute(request.params.id,z.object({reason:proof}).parse(request.body).reason);
    return {success:true};
  });
  app.post("/admin/api/cost-fees",guard,async request=>({success:true,fee:ledger.addFee(z.object({
    reference:z.string().trim().min(3).max(120),kind:z.enum(["opening","topup","other"]),
    amount_usd:cash,order_id:z.string().max(120).nullable().optional(),evidence:proof,
  }).parse(request.body))}));
  app.get("/admin/api/cost-fees",guard,async request=>{
    const {page}=query.parse(request.query);
    const count=db.db.prepare("SELECT COUNT(*) n FROM cost_fees").get() as {n:number};
    return {success:true,items:db.db.prepare("SELECT * FROM cost_fees ORDER BY created_at DESC,fee_id LIMIT 20 OFFSET ?").all((page-1)*20),total:count.n,page};
  });
  app.post("/admin/api/cost-transactions/sync",guard,async(request,reply)=>{
    const {page}=z.object({page:z.number().int().min(1).max(10000).default(1)}).parse(request.body);
    if (!zovo.listCardTransactions) return reply.code(409).send({success:false,detail_zh:"当前连接不支持交易查询；可使用人工凭证核查"});
    try {
      const items=await zovo.listCardTransactions(page);
      ledger.importTransactions(items);
      return {success:true,items,page,detail_zh:"仅同步当前页 USD 清算记录；不自动关联订单，不执行充值"};
    } catch (error) {
      if(error instanceof LedgerError) throw error;
      return reply.code(502).send({success:false,detail_zh:"交易查询未成功：请核实卡台权限或稍后重试；未发起充值或扣款"});
    }
  });
  app.post("/admin/api/cost-reviews/auto-reconcile",guard,async(request,reply)=>{
    if(!zovo.listCardTransactions||!zovo.getCdkOrderCost)
      return reply.code(409).send({success:false,detail_zh:"当前连接不支持自动核对；未修改任何成本记录"});
    const {limit}=z.object({limit:z.number().int().min(1).max(50).default(20)}).parse(request.body);
    try{
      const summary=await automaticReviewer.tick(new Date(),limit);
      return {success:true,...summary,detail_zh:"正常流水已自动确认；只有金额或关联异常的订单进入人工审核。未执行付款或退款"};
    }catch{
      return reply.code(502).send({success:false,detail_zh:"卡台流水暂时无法读取，本次未确认或生成任何资金操作，请稍后重试"});
    }
  });
  app.get<{Params:{orderNumber:string}}>("/admin/api/platform-rebates/:orderNumber/external-payment-preview",guard,async request=>{
    const orderNumber=z.string().trim().min(5).max(120).parse(request.params.orderNumber);
    return {success:true,preview:ledger.externalRebatePaymentPreview(orderNumber)};
  });
  app.post<{Params:{orderNumber:string}}>("/admin/api/platform-rebates/:orderNumber/external-payment",guard,async request=>{
    const input=externalRebatePayment.parse(request.body);
    const orderNumber=z.string().trim().min(5).max(120).parse(request.params.orderNumber);
    return {success:true,...ledger.recordExternalRebatePayment({orderNumber,paymentId:input.payment_id,
      method:input.method,reference:input.reference,note:input.note,paidAt:input.paid_at,appliedUsd:input.applied_usd,
      paymentCurrency:input.payment_currency,paymentAmount:input.payment_amount,fxRate:input.fx_rate,fundingAmount:input.funding_amount})};
  });
  app.get("/admin/api/platform-settlements",guard,async request=>{
    const input=settlementQuery.parse(request.query);
    if(input.from&&input.to&&input.from>input.to)throw new LedgerError("开始日期不能晚于结束日期");
    const result=db.listPlatformSettlementsPage({page:input.page,pageSize:input.page_size,status:input.status,q:input.q,from:input.from,to:input.to});
    return {success:true,items:result.items,summary:result.summary,pagination:{total:result.total,page:input.page,page_size:input.page_size,
      pages:Math.max(1,Math.ceil(result.total/input.page_size))}};
  });
  app.get<{Params:{id:string}}>("/admin/api/platform-settlements/:id/export.csv",guard,async(request,reply)=>{
    const statement=db.getPlatformSettlement(request.params.id);
    if(!statement)throw new LedgerError("结算单不存在");
    const payments=db.db.prepare("SELECT * FROM settlement_payments WHERE settlement_id=? ORDER BY created_at,payment_id").all(request.params.id) as Array<Record<string,unknown>>;
    const s=statement.settlement as Record<string,unknown>;
    const status=({pending:"待核销",partial:"部分核销",paid:"已核销"} as Record<string,string>)[String(s.status)]??String(s.status);
    const common=[s.settlement_id,s.business_date??"",status,beijingCsvTime(s.period_from),beijingCsvTime(s.period_to),beijingCsvTime(s.created_at)];
    const rows:Array<unknown[]>=[
      ...statement.lines.map(line=>[...common,"人民币平台利润",line.client_order_id,line.order_id,line.product,line.amount,"","","","","",""]),
      ...statement.rebates.map(rebate=>[...common,"美元退差",rebate.client_order_id,rebate.order_id,rebate.product,"",rebate.rebate_usd,"","","","",""]),
      ...payments.map(payment=>[...common,"付款核销凭证","","","","","",payment.currency,payment.amount,payment.method,payment.reference,beijingCsvTime(payment.paid_at),payment.note]),
    ];
    const header=["结算单号","业务日期","核销状态","结算周期开始","结算周期结束","生成时间","明细类型","平台订单号","我方订单号","商品","人民币平台利润","美元退差","付款币种","已付金额","付款方式","付款凭证","付款时间","备注"];
    const csv=[header,...rows].map(row=>row.map(csvCell).join(",")).join("\r\n");
    const filename=String(s.settlement_id).replace(/[^A-Za-z0-9_-]/g,"_");
    return reply.header("Content-Disposition",`attachment; filename="settlement-${filename}.csv"`).type("text/csv; charset=utf-8").send(`\uFEFF${csv}`);
  });
  app.get<{Params:{id:string}}>("/admin/api/platform-settlements/:id",guard,async request=>{
    const statement=db.getPlatformSettlement(request.params.id);
    if(!statement) throw new LedgerError("结算单不存在");
    return {success:true,...statement,payments:db.db.prepare("SELECT * FROM settlement_payments WHERE settlement_id=? ORDER BY created_at,payment_id").all(request.params.id)};
  });
  app.get("/admin/api/activation-reviews",guard,async request=>{
    const {page,q}=query.parse(request.query);
    const search="%"+q.replace(/[\\%_]/g,"\\$&")+"%";
    const where="c.needs_review=1 AND (a.order_id LIKE ? ESCAPE '\\' OR o.client_order_id LIKE ? ESCAPE '\\')";
    const total=db.db.prepare(`SELECT COUNT(*) n FROM activation_worker_control c JOIN activations a ON a.id=c.activation_id
      JOIN orders o ON o.order_id=a.order_id WHERE ${where}`).get(search,search) as {n:number};
    // Never expose session, CDK code, API key or redemption token.
    const items=db.db.prepare(`SELECT a.id,a.order_id,o.client_order_id,o.plan,a.task_id,a.upstream_order_id,a.created_at,
      c.updated_at,c.last_stage,c.last_error_code,c.stage_duration_ms,c.attempts,
      CASE WHEN o.plan IN ('x_premium_3m','x_premium_6m') THEN
        CASE WHEN EXISTS(SELECT 1 FROM x_gift_submissions x WHERE x.activation_id=a.id AND x.submit_started_at IS NOT NULL) THEN 1 ELSE 0 END
        WHEN a.redemption_token IS NOT NULL AND a.cdk_id IS NOT NULL THEN 1 ELSE 0 END can_resume
      FROM activation_worker_control c JOIN activations a ON a.id=c.activation_id
      JOIN orders o ON o.order_id=a.order_id WHERE ${where} ORDER BY c.updated_at,a.id LIMIT 20 OFFSET ?`)
      .all(search,search,(page-1)*20);
    return {success:true,items,total:total.n,page};
  });
  app.post<{Params:{id:string}}>("/admin/api/activation-reviews/:id/resolve",guard,async request=>{
    const id=z.coerce.number().int().positive().parse(request.params.id);
    const input=z.object({action:z.enum(["resume_query","confirmed_success","confirmed_failed"]),expected_updated_at:z.string().datetime(),
      reason:proof,verified:z.literal(true),account_email:z.string().trim().email().max(254).optional(),
      failure_code:z.enum(["session_invalid","account_has_subscription","account_not_eligible","region_unsupported","payment_blocked","verification_timeout","other"]).optional(),
    }).parse(request.body);
    return resolveActivationReview(db,config,zovo,id,input);
  });
}
