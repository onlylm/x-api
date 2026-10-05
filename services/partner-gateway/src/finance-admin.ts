import Fastify, {type FastifyInstance} from "fastify";
import formbody from "@fastify/formbody";
import {ZodError} from "zod";
import type {AppConfig} from "./config.js";
import {AppDatabase} from "./database.js";
import {RuntimeSettings} from "./runtime-settings.js";
import {RuntimePaymentClient,RuntimeZovoClient} from "./runtime-clients.js";
import type {PaymentClient} from "./clients/payment.js";
import type {ZovoClient} from "./clients/zovo.js";
import {registerAdminRoutes} from "./admin-routes.js";
import {registerLedgerRoutes} from "./ledger-routes.js";
import {RefundService} from "./services/refund-service.js";
import {BusinessError} from "./services/order-service.js";
import {FinancialAmountError} from "./domain.js";
import {LedgerError} from "./services/financial-ledger.js";
import {DailySettlementWorker} from "./services/daily-settlement-worker.js";
import {gateWorkerStartup} from "./services/worker-startup-gate.js";
import {CostAutoReviewWorker} from "./services/cost-auto-review-worker.js";

/** Administrative sidecar only. Never creates checkout, activation or webhook workers. */
export async function buildFinanceAdmin(config:AppConfig, options:{
  db?:AppDatabase; payment?:PaymentClient; zovo?:ZovoClient; startSettlementWorker?:boolean;
}={}):Promise<FastifyInstance> {
  const app=Fastify({trustProxy:config.trustProxy,bodyLimit:256*1024,
    logger:{level:config.nodeEnv==="test"?"silent":"info",
      redact:{paths:["req.headers.x-admin-token","req.headers.authorization","req.headers.cookie",
        "body.password","body.session_data","body.credential"],censor:"[REDACTED]"}}});
  await app.register(formbody);
  const db=options.db??new AppDatabase(config.databasePath,{migrate:false});
  // Production startup must not silently migrate a shared customer database.
  if(!options.db){
    try{
      for(const table of ["order_cost_reviews","platform_rebates","settlement_payments","cost_fees","cost_transactions","cost_transaction_links"])
        if(!db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
          throw new Error("finance_schema_not_prepared");
      const columns=db.db.prepare("PRAGMA table_info(platform_settlements)").all() as Array<{name:string}>;
      if(!["cny_paid","usd_paid","rebate_usd","business_date"].every(name=>columns.some(c=>c.name===name)))
        throw new Error("finance_schema_not_prepared");
    }catch(error){db.close();throw error;}
  }
  const settings=new RuntimeSettings(config,db);
  const payment=options.payment??new RuntimePaymentClient(config,settings);
  const zovo=options.zovo??new RuntimeZovoClient(settings);
  const refunds=new RefundService(db,payment);
  app.addHook("onRequest",async(request,reply)=>{
    const path=request.url.split("?")[0];
    if(path!=="/health"&&path!=="/admin"&&!path.startsWith("/admin/"))
      return reply.code(404).send({success:false,error:"not_found"});
  });
  app.get("/health",async()=>({success:true,service:"merchant-finance-admin"}));
  registerAdminRoutes(app,config,db,settings,refunds);
  const costReviewWorker=new CostAutoReviewWorker(db,zovo,app.log);
  registerLedgerRoutes(app,config,db,zovo,costReviewWorker);
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof FinancialAmountError||error instanceof LedgerError)
      return reply.code(409).send({success:false,detail_zh:error.message});
    if(error instanceof BusinessError)
      return reply.code(error.httpStatus).send({success:false,error:error.code,detail_zh:error.message});
    if(error instanceof ZodError)
      return reply.code(422).send({success:false,error:"invalid_argument",detail_zh:error.issues[0]?.message||"请求参数不合法"});
    const parsers:Record<string,number>={FST_ERR_CTP_INVALID_JSON_BODY:400,FST_ERR_CTP_EMPTY_JSON_BODY:400,
      FST_ERR_CTP_BODY_TOO_LARGE:413,FST_ERR_CTP_INVALID_MEDIA_TYPE:415};
    const status=parsers[(error as {code?:string}).code??""];
    if(status)return reply.code(status).send({success:false,error:"invalid_argument",detail_zh:"请求正文格式或大小不合法"});
    app.log.error({err:error,requestId:request.id},"finance admin request failed");
    return reply.code(500).send({success:false,error:"internal_error",detail_zh:"后台暂时不可用，请稍后重试"});
  });
  const settlementWorker=new DailySettlementWorker(db,app.log);
  const stopGate=options.startSettlementWorker===false?()=>{}:gateWorkerStartup(()=>{
    settlementWorker.start();
    costReviewWorker.start();
  });
  app.addHook("onClose",async()=>{stopGate();settlementWorker.stop();costReviewWorker.stop();db.close();});
  return app;
}
