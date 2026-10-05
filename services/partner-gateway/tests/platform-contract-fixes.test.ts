import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {AppDatabase} from "../src/database.js";
import {buildApp} from "../src/app.js";
import {MockZovoClient} from "../src/clients/zovo.js";
import {MockPaymentClient} from "../src/clients/payment.js";
import {OrderService} from "../src/services/order-service.js";
import {ActivationService} from "../src/services/activation-service.js";
import {ledgerTestConfig} from "./ledger-fixtures.js";
import {mapUpstreamFailure} from "../src/domain.js";

describe("平台规范修复回归（隔离库、模拟支付与充值）",()=>{
  let dir:string,db:AppDatabase,app:Awaited<ReturnType<typeof buildApp>>;
  let config:ReturnType<typeof ledgerTestConfig>,zovo:MockZovoClient,payment:MockPaymentClient,orders:OrderService;
  const admin={"x-admin-token":"local-ledger-preview"};
  const input={product:"chatgpt_plus_1m",quantity:1,sellPrice:"135.00",clientOrderId:"po_contract"};
  const revision="2026-09-27T00:00:00.000Z";
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),"contract-safe-"));config=ledgerTestConfig(join(dir,"test.sqlite"));
    db=new AppDatabase(config.databasePath);zovo=new MockZovoClient();payment=new MockPaymentClient(config.publicBaseUrl);
    app=await buildApp(config,{db,zovo,payment,startWorkers:false});orders=new OrderService(db,payment,zovo);
  });
  afterEach(async()=>{vi.restoreAllMocks();await app.close();rmSync(dir,{recursive:true,force:true});});
  async function paid(){
    const {order}=await orders.createOrder(input);
    db.markOrderPaid(order.order_id,new Date().toISOString(),"mock-trade","135.00");return order.order_id;
  }
  async function reviewTask(withToken=true){
    const id=await paid();
    const a=new ActivationService(config,db).create(id,{user:{email:"buyer@example.com"},accessToken:"local-secret-session"});
    db.db.prepare("UPDATE activations SET worker_state=?,status='running',redemption_token=?,upstream_order_id=? WHERE id=?")
      .run(withToken?"polling":"provisioning",withToken?"private-token":null,withToken?"upstream-test":null,a.id);
    db.db.prepare("INSERT INTO activation_worker_control(activation_id,needs_review,updated_at,last_stage) VALUES (?,1,?,'result')").run(a.id,revision);
    return a;
  }
  function resolve(id:number,extra:Record<string,unknown>={}){
    return app.inject({method:"POST",url:"/admin/api/activation-reviews/"+id+"/resolve",headers:admin,
      payload:{action:"confirmed_failed",expected_updated_at:revision,reason:"已核实原任务与完成凭证",verified:true,failure_code:"account_has_subscription",...extra}});
  }

  it.each(["PRECHECK_REJECTED","GPT_PRECHECK_FAILED","CARD_NOT_AVAILABLE","PAYMENT_STATUS_UNKNOWN","SESSION_LOOKUP_TIMEOUT"])("未知或泛化码 %s 不猜测成账号失败",code=>{
    expect(mapUpstreamFailure(code)).toBe("other");
  });
  it.each([0,2,1.5,"1",null])("数量 %s 返回平台约定 invalid_quantity",async quantity=>{
    const r=await app.inject({method:"POST",url:"/api/v1/checkout/orders",headers:{"x-api-key":config.platformApiKey},
      payload:{product:input.product,quantity,sell_price:"135.00",client_order_id:"po_bad_quantity"}});
    expect(r.statusCode).toBe(422);expect(r.json().error).toBe("invalid_quantity");
  });
  it("破损 JSON 返回 400，响应不回显请求敏感内容",async()=>{
    const r=await app.inject({method:"POST",url:"/api/v1/checkout/orders",headers:{"x-api-key":config.platformApiKey,"content-type":"application/json"},
      payload:'{"private-session":"do-not-echo",'});
    expect(r.statusCode).toBe(400);expect(r.json().error).toBe("invalid_argument");expect(r.body).not.toContain("do-not-echo");
  });
  it.each([
    ["application/octet-stream","not-a-json",415],
    ["application/json"," ".repeat(1_048_577),413],
  ] as const)("正文类型或大小问题保持正确 4xx（%s）",async(contentType,payload,status)=>{
    const r=await app.inject({method:"POST",url:"/api/v1/checkout/orders",headers:{"x-api-key":config.platformApiKey,"content-type":contentType},payload});
    expect(r.statusCode).toBe(status);expect(r.json().error).toBe("invalid_argument");
  });
  it("同进程并发 20 次只生成一次收款码",async()=>{
    const create=vi.spyOn(payment,"createPaymentUrl");
    const results=await Promise.all(Array.from({length:20},()=>orders.createOrder({...input})));
    expect(create).toHaveBeenCalledTimes(1);expect(new Set(results.map(r=>r.order.order_id)).size).toBe(1);
    expect(db.db.prepare("SELECT COUNT(*) n FROM orders").get()).toMatchObject({n:1});
  });
  it("两条数据库连接并发复用同单，不生成孤立收款码",async()=>{
    const otherDb=new AppDatabase(config.databasePath);
    try{
      const other=new OrderService(otherDb,payment,zovo);
      const create=vi.spyOn(payment,"createPaymentUrl").mockImplementation(async order=>{
        await new Promise(resolve=>setTimeout(resolve,60));return "mock://"+order.order_id;
      });
      const [first,second]=await Promise.all([orders.createOrder(input),other.createOrder(input)]);
      expect(create).toHaveBeenCalledTimes(1);expect(second.order).toEqual(first.order);
    }finally{otherDb.close();}
  });
  it("付款响应丢失后重建服务，仍用同一订单号、金额及截止时间",async()=>{
    const create=vi.spyOn(payment,"createPaymentUrl").mockRejectedValueOnce(new Error("mock lost response"));
    await expect(orders.createOrder(input)).rejects.toThrow("mock lost response");
    const first=JSON.parse(String(db.db.prepare("SELECT order_json FROM checkout_intents").get()!.order_json));
    const otherDb=new AppDatabase(config.databasePath);
    try{
      const result=await new OrderService(otherDb,payment,zovo).createOrder(input);
      expect(result.order.order_id).toBe(first.order_id);expect(result.order.amount).toBe(first.amount);
      expect(result.order.expires_at).toBe(first.expires_at);
      expect(create).toHaveBeenCalledTimes(2);
      expect(db.db.prepare("SELECT COUNT(*) n FROM checkout_intents").get()).toMatchObject({n:1});
    }finally{otherDb.close();}
  });
  it("幂等预留后篡改金额被拒绝且不再次调用支付",async()=>{
    const create=vi.spyOn(payment,"createPaymentUrl").mockRejectedValueOnce(new Error("mock timeout"));
    await expect(orders.createOrder(input)).rejects.toThrow();
    await expect(orders.createOrder({...input,sellPrice:"136.00"})).rejects.toMatchObject({httpStatus:409,code:"idempotency_conflict"});
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("付款租约尚未过期不抢占；过期恢复仍用原单号",async()=>{
    const create=vi.spyOn(payment,"createPaymentUrl").mockRejectedValueOnce(new Error("mock crash"));
    await expect(orders.createOrder(input)).rejects.toThrow();
    const original=create.mock.calls[0][0].order_id;
    db.db.prepare("UPDATE checkout_intents SET lease_token='other-process',lease_until=?").run(new Date(Date.now()+60000).toISOString());
    await expect(orders.createOrder(input)).rejects.toMatchObject({httpStatus:503});
    expect(create).toHaveBeenCalledTimes(1);
    db.db.prepare("UPDATE checkout_intents SET lease_until='2000-01-01T00:00:00.000Z'").run();
    expect((await orders.createOrder(input)).order.order_id).toBe(original);
  });
  it("过期付款响应不能覆盖新的租约持有者",async()=>{
    vi.spyOn(payment,"createPaymentUrl").mockImplementation(async order=>{
      db.db.prepare("UPDATE checkout_intents SET lease_token='replacement' WHERE client_order_id=?").run(input.clientOrderId);
      return "mock://"+order.order_id;
    });
    await expect(orders.createOrder(input)).rejects.toMatchObject({httpStatus:503});
    expect(db.getOrderByClientId(input.clientOrderId)).toBeUndefined();
    expect(db.db.prepare("SELECT lease_token FROM checkout_intents").get()).toMatchObject({lease_token:"replacement"});
  });
  it("旧标记按钮不能伪装结束仍在进行的任务",async()=>{
    const a=await reviewTask();
    const r=await app.inject({method:"POST",url:"/admin/api/orders/"+a.order_id+"/actions",headers:admin,
      payload:{action:"mark_delivery_failed",reason:"准备人工结束处理"}});
    expect(r.statusCode).toBe(409);expect(db.listActivations(a.order_id)[0].finished).toBe(0);
  });
  it("人工成功必须有实际邮箱；对平台仅返回打码邮箱和中性文案",async()=>{
    const id=await paid();
    const payload={action:"confirm_manual_delivery",reason:"人工完成凭证 DEMO-001",verified:true};
    const url="/admin/api/orders/"+id+"/actions";
    expect((await app.inject({method:"POST",url,headers:admin,payload})).statusCode).toBe(422);
    const r=await app.inject({method:"POST",url,headers:admin,payload:{...payload,account_email:"buyer@example.com"}});
    expect(r.statusCode).toBe(200);
    const progress=new ActivationService(config,db).list(id);
    expect(progress.items[0]).toMatchObject({status:"success",finished:true,account_email:"b***r@example.com",message_zh:"开通成功"});
    expect(JSON.stringify(db.listActivations(id))).not.toContain("buyer@example.com");
  });
  it("人工失败同步唯一任务事实源、释放次数并清除 Session，不退款或重新充值",async()=>{
    const a=await reviewTask();
    vi.spyOn(zovo,"getResult").mockResolvedValue({status:"cancelled",errorCode:"GPT_PLAN_ALREADY_ACTIVE",orderId:"upstream-test"});
    const redeem=vi.spyOn(zovo,"redeem"),issue=vi.spyOn(zovo,"issueCdk"),refund=vi.spyOn(payment,"refundPayment");
    expect((await resolve(a.id)).statusCode).toBe(200);
    const progress=new ActivationService(config,db).list(a.order_id);
    expect(progress).toMatchObject({activation_used:0,activation_remaining:1});
    expect(progress.items[0]).toMatchObject({status:"failed",finished:true,failure_code:"account_has_subscription"});
    expect(db.listActivations(a.order_id)[0].session_ciphertext).toBeNull();
    expect(db.getOrder(a.order_id)?.delivery_status).toBe("failed");
    expect(redeem).not.toHaveBeenCalled();expect(issue).not.toHaveBeenCalled();expect(refund).not.toHaveBeenCalled();
    expect((await resolve(a.id)).statusCode).toBe(409);
  });
  it.each(["processing","queued","completed"])("原结果 %s 不允许人工改失败",async status=>{
    const a=await reviewTask();vi.spyOn(zovo,"getResult").mockResolvedValue({status});
    expect((await resolve(a.id)).statusCode).toBe(409);
    expect(new ActivationService(config,db).list(a.order_id).activation_remaining).toBe(0);
  });
  it("查询失败以及原因不匹配，均保留人工核查",async()=>{
    const a=await reviewTask(),query=vi.spyOn(zovo,"getResult").mockRejectedValue(new Error("private upstream error"));
    const r=await resolve(a.id);expect(r.statusCode).toBe(409);expect(r.body).not.toContain("private upstream error");
    query.mockResolvedValue({status:"declined"});
    expect((await resolve(a.id)).statusCode).toBe(409);
    expect(db.listActivations(a.order_id)[0].finished).toBe(0);
  });
  it("网络查询期间任务被另一管理员处理，不覆盖新状态",async()=>{
    const a=await reviewTask();
    vi.spyOn(zovo,"getResult").mockImplementation(async()=>{
      db.db.prepare("UPDATE activation_worker_control SET updated_at=? WHERE activation_id=?").run("2026-09-27T00:00:01.000Z",a.id);
      return {status:"cancelled",errorCode:"GPT_PLAN_ALREADY_ACTIVE"};
    });
    expect((await resolve(a.id)).statusCode).toBe(409);expect(db.listActivations(a.order_id)[0].finished).toBe(0);
  });
  it("未发起充值的暂停任务可核实后结束，但不能捏造账号失败",async()=>{
    const a=await reviewTask(false),query=vi.spyOn(zovo,"getResult"),redeem=vi.spyOn(zovo,"redeem");
    expect((await resolve(a.id)).statusCode).toBe(409);
    expect((await resolve(a.id,{failure_code:"other"})).statusCode).toBe(200);
    expect(query).not.toHaveBeenCalled();expect(redeem).not.toHaveBeenCalled();
  });
  it("已退款的核查任务不能被人工改成功或失败",async()=>{
    const a=await reviewTask();
    db.db.prepare("UPDATE orders SET status='refunded',refunded_at=? WHERE order_id=?").run(revision,a.order_id);
    const query=vi.spyOn(zovo,"getResult");
    expect((await resolve(a.id)).statusCode).toBe(409);expect(query).not.toHaveBeenCalled();
  });
  it("核查成功缺少实际账号不会创建不完整成功响应",async()=>{
    const a=await reviewTask();
    expect((await resolve(a.id,{action:"confirmed_success",failure_code:undefined})).statusCode).toBe(409);
    expect(db.listActivations(a.order_id)[0].finished).toBe(0);
  });
  it("数据库拒绝写入缺少邮箱的成功记录，保留原状态",async()=>{
    const a=await reviewTask();
    expect(()=>db.markActivationSuccess(a.id,"",new Date().toISOString())).toThrow("activation_success_account_required");
    expect(db.listActivations(a.order_id)[0].finished).toBe(0);
  });
  it("新增字段有明确标签，失败/成功字段按操作展开，脚本可解析",async()=>{
    const r=await app.inject({url:"/admin"});
    for(const id of ["manualDeliveryAccount","reviewEmail","reviewFailure","reviewAction"]){
      expect(r.body).toContain('id="'+id+'"');
      if(id!=="reviewAction") expect(r.body).toContain('for="'+id+'"');
    }
    expect(r.body).toContain("结果未知或仍在处理时，不允许强制失败");
  });
  it("增量表方案重复执行不改变现有订单和财务快照",async()=>{
    const {order}=await orders.createOrder(input),before=db.getOrder(order.order_id);
    const sql=readFileSync(new URL("../docs/migrations/20260927-checkout-intents.sql",import.meta.url),"utf8");
    db.db.exec(sql);db.db.exec(sql);
    expect(db.getOrder(order.order_id)).toEqual(before);
    expect(db.db.prepare("PRAGMA table_info(checkout_intents)").all().map(r=>r.name)).toEqual(
      ["client_order_id","order_json","lease_token","lease_until","updated_at"]);
  });
});
