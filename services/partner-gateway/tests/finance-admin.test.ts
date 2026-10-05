import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {buildFinanceAdmin} from "../src/finance-admin.js";
import {AppDatabase} from "../src/database.js";
import {MockPaymentClient} from "../src/clients/payment.js";
import {MockZovoClient} from "../src/clients/zovo.js";
import {ledgerTestConfig} from "./ledger-fixtures.js";

describe("后台独立发布边界",()=>{
  let dir:string,db:AppDatabase,app:Awaited<ReturnType<typeof buildFinanceAdmin>>;
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),"finance-admin-boundary-"));
    const config=ledgerTestConfig(join(dir,"test.sqlite"));
    db=new AppDatabase(config.databasePath);
    vi.stubGlobal("fetch",vi.fn(()=>{throw new Error("unexpected external request");}));
    app=await buildFinanceAdmin(config,{db,payment:new MockPaymentClient(config.publicBaseUrl),
      zovo:new MockZovoClient(),startSettlementWorker:false});
  });
  afterEach(async()=>{await app.close();vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});});
  it("只提供后台，不注册客户开单、支付、充值、回调或幂等新表",async()=>{
    for(const url of ["/api/v1/checkout/orders","/api/v1/orders/any/activate","/webhooks/alipay","/dev/pay/any"]){
      expect((await app.inject({method:"POST",url,payload:{}})).statusCode).toBe(404);
    }
    expect(db.db.prepare("SELECT 1 FROM sqlite_master WHERE name='checkout_intents'").get()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(db.db.prepare("SELECT count(*) n FROM orders").get()).toMatchObject({n:0});
  });
  it("后台健康、新界面和成本核查接口可用，未授权查询继续被拦截",async()=>{
    expect((await app.inject({url:"/health"})).json()).toEqual({success:true,service:"merchant-finance-admin"});
    const page=await app.inject({url:"/admin"});
    expect(page.statusCode).toBe(200);expect(page.body).toContain("window.financeUi");
    expect((await app.inject({url:"/admin/api/cost-reviews"})).statusCode).toBe(401);
    const list=await app.inject({url:"/admin/api/cost-reviews",headers:{"x-admin-token":"local-ledger-preview"}});
    expect(list.statusCode).toBe(200);expect(list.json().items).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("启动和只读查询不自动出结算单或触发资金动作",async()=>{
    for(const url of ["/admin/api/finance","/admin/api/orders","/admin/api/cost-fees"]){
      expect((await app.inject({url,headers:{"x-admin-token":"local-ledger-preview"}})).statusCode).toBe(200);
    }
    expect(db.db.prepare("SELECT count(*) n FROM platform_settlements").get()).toMatchObject({n:0});
    expect(db.db.prepare("SELECT count(*) n FROM refunds").get()).toMatchObject({n:0});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("旧结构未显式升级时拒绝启动，不偷偷创建财务表",async()=>{
    const oldPath=join(dir,"old.sqlite"),old=new DatabaseSync(oldPath);
    old.exec("CREATE TABLE orders(order_id TEXT PRIMARY KEY)");old.close();
    await expect(buildFinanceAdmin(ledgerTestConfig(oldPath),{startSettlementWorker:false})).rejects.toThrow("finance_schema_not_prepared");
    const check=new DatabaseSync(oldPath,{readOnly:true});
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{name:"orders"}]);
    check.close();
  });
});
