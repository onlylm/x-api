import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {AppDatabase} from "../src/database.js";
import {buildApp} from "../src/app.js";
import {MockZovoClient} from "../src/clients/zovo.js";
import {MockPaymentClient} from "../src/clients/payment.js";
import {OrderService} from "../src/services/order-service.js";
import {RefundService} from "../src/services/refund-service.js";
import {ledgerTestConfig} from "./ledger-fixtures.js";
import {calculateFinancialAmounts,financialConsistencyErrors,moneyToCents,centsToMoney,signedMoneyToCents,sumMoney} from "../src/domain.js";

describe("P0-4 整数分与统一金额口径",()=>{
  it.each([
    ["0.00",0],["0.01",1],["0.29",29],["9999999.99",999999999],
    ["90071992547409.90",Number.MAX_SAFE_INTEGER-1],["90071992547409.91",Number.MAX_SAFE_INTEGER],
  ] as const)("精确往返 %s", (money,cents)=>{
    expect(moneyToCents(money)).toBe(cents);expect(centsToMoney(cents)).toBe(money);
  });
  it.each(["-0.01","1","1.0","1.001","1e2","NaN","Infinity","90071992547409.92"," 1.00"])("拒绝非法收付款 %s",value=>{
    expect(()=>moneyToCents(value)).toThrow();
  });
  it("只有利润允许负数，汇总不用浮点相加",()=>{
    expect(signedMoneyToCents("-9.38")).toBe(-938);expect(centsToMoney(-1)).toBe("-0.01");
    expect(sumMoney(Array(1000).fill("0.01"))).toBe("10.00");
    expect(sumMoney(["90071992547409.91","-90071992547409.90"])).toBe("0.01");
    expect(()=>sumMoney(["90071992547409.91","0.01"])).toThrow();
    expect(()=>centsToMoney(1.5)).toThrow();expect(()=>centsToMoney(Number.POSITIVE_INFINITY)).toThrow();
  });
  it.each([
    ["135.00","135.00","110.00","0.00","25.00","135.00"],
    ["135.00","120.00","110.00","0.00","10.00","120.00"],
    ["135.00","135.00","110.00","9.38","15.62","125.62"],
    ["135.00","135.00","110.00","25.00","0.00","110.00"],
    ["135.00","100.00","110.00","0.00","-10.00","100.00"],
    ["0.00","0.00","0.00","0.00","0.00","0.00"],
  ])("统一计算 付款%s 实收%s 供货%s 补差%s", (customerPayment,serviceReceipt,supplyCost,customerPriceRefund,profit,invoice)=>{
    const result=calculateFinancialAmounts({customerPayment,serviceReceipt,supplyCost,customerPriceRefund});
    expect(result.platformProfit).toBe(profit);expect(result.invoiceableAmount).toBe(invoice);
    expect(financialConsistencyErrors(result)).toEqual([]);
  });
  it("分别识别收款超额、补差超实收和补差超平台利润",()=>{
    const compute=(serviceReceipt:string,customerPriceRefund:string)=>financialConsistencyErrors(
      calculateFinancialAmounts({customerPayment:"135.00",serviceReceipt,supplyCost:"110.00",customerPriceRefund}));
    expect(compute("135.01","0.00")).toContain("service_receipt_exceeds_customer_payment");
    expect(compute("135.00","135.01")).toContain("customer_price_refund_exceeds_receipt");
    expect(compute("135.00","25.01")).toContain("customer_price_refund_exceeds_platform_margin");
  });
});

describe("P0-4 资金状态与报表（仅模拟接口）",()=>{
  let dir:string,db:AppDatabase,app:Awaited<ReturnType<typeof buildApp>>,orders:OrderService,refunds:RefundService;
  let config:ReturnType<typeof ledgerTestConfig>,payment:MockPaymentClient,zovo:MockZovoClient,serial:number;
  const admin={"x-admin-token":"local-ledger-preview"};
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),"p04-amount-safe-"));config=ledgerTestConfig(join(dir,"test.sqlite"));serial=0;
    db=new AppDatabase(config.databasePath);payment=new MockPaymentClient(config.publicBaseUrl);zovo=new MockZovoClient();
    app=await buildApp(config,{db,payment,zovo,startWorkers:false});
    orders=new OrderService(db,payment,zovo);refunds=new RefundService(db,payment);
  });
  afterEach(async()=>{vi.restoreAllMocks();await app.close();rmSync(dir,{recursive:true,force:true});});
  async function paid(receipt="135.00"){
    const {order}=await orders.createOrder({product:"chatgpt_plus_1m",quantity:1,sellPrice:"135.00",clientOrderId:"po_p04_"+(++serial)});
    db.markOrderPaid(order.order_id,new Date().toISOString(),"mock-trade-"+serial,receipt);return order.order_id;
  }
  async function request(id:string){
    return (await refunds.request({orderId:id,clientRefundId:"p04-refund-"+id,reason:"测试核查退款",requestedBy:"admin"})).refund;
  }
  function invoiceInput(id:string,amount="135.00"){
    return {invoiceId:"p04-invoice-"+id,orderId:id,titleType:"personal",title:"本地模拟",
      taxId:null,unitAddress:"",phone:"",bankName:"",bankAccount:"",recipientEmail:"test@example.com",amount,requestNote:"模拟开票记录"};
  }
  function issue(invoiceId:string){return db.markInvoiceIssued({invoiceId,invoiceNumber:"TEST-INVOICE",invoiceDate:"2026-09-27",invoiceUrl:null,issueNote:"仅模拟登记"});}
  function succeeded(id:string){db.db.prepare("UPDATE orders SET delivery_status='success' WHERE order_id=?").run(id);}
  function refundedEventCount(id:string){return Number(db.db.prepare("SELECT COUNT(*) n FROM webhook_outbox WHERE event_key=?").get(id+":order.refunded")!.n);}
  async function finance(){return app.inject({url:"/admin/api/finance?from=2020-01-01&to=2099-01-01",headers:admin});}
  function settle(id="p04-settlement"){
    return db.createPlatformSettlement({settlementId:id,from:"2020-01-01T00:00:00.000Z",to:"2099-01-01T00:00:00.000Z",allowEmpty:true});
  }
  it("到账超过用户付款时不入账、不发支付成功通知",async()=>{
    const {order}=await orders.createOrder({product:"chatgpt_plus_1m",quantity:1,sellPrice:"135.00",clientOrderId:"po_receipt_invalid"});
    expect(()=>db.markOrderPaid(order.order_id,new Date().toISOString(),"mock","135.01")).toThrow("payment_amount_inconsistent");
    expect(db.getOrder(order.order_id)?.status).toBe("pending");
    expect(db.db.prepare("SELECT COUNT(*) n FROM webhook_outbox").get()).toMatchObject({n:0});
  });
  it.each(["134.99","135.01","0.00","-1.00","135.001"])("退款申请金额 %s 必须匹配实收",async amount=>{
    const id=await paid();
    expect(()=>db.createRefund({refundId:"bad-refund",orderId:id,clientRefundId:"bad-refund",amount,reason:"模拟金额不符",requestedBy:"admin",now:new Date().toISOString()})).toThrow("不一致");
    expect(db.getRefundByOrderId(id)).toBeUndefined();expect(refundedEventCount(id)).toBe(0);
  });
  it.each([null,"134.99","135.01","0.00","-1.00","135.001"])("成功回执金额 %s 不符时不确认退款、不通知平台",async fee=>{
    const id=await paid(),r=await request(id);
    db.approveRefund({refundId:r.refund_id,reason:"模拟批准",now:new Date().toISOString()});
    expect(()=>db.completeRefund({refundId:r.refund_id,refundFee:fee,tradeNo:"mock-trade-1",refundedAt:new Date().toISOString()})).toThrow("回执");
    expect(db.getRefundByOrderId(id)?.status).toBe("processing");expect(db.getOrder(id)?.status).toBe("paid");
    expect(refundedEventCount(id)).toBe(0);
  });
  it("不匹配的支付宝交易号不能完成退款",async()=>{
    const id=await paid(),r=await request(id);
    db.approveRefund({refundId:r.refund_id,reason:"模拟批准",now:new Date().toISOString()});
    expect(()=>db.completeRefund({refundId:r.refund_id,refundFee:"135.00",tradeNo:"another-trade",refundedAt:new Date().toISOString()})).toThrow("交易号");
    expect(refundedEventCount(id)).toBe(0);
  });
  it("少退回执进入待核查；再次操作只查询，不再次发起退款",async()=>{
    const id=await paid();
    const pay=vi.spyOn(payment,"refundPayment").mockResolvedValue({status:"succeeded",tradeNo:"mock-trade-1",refundFee:"1.00",refundedAt:new Date().toISOString()});
    const query=vi.spyOn(payment,"queryRefund").mockResolvedValue({status:"succeeded",tradeNo:"mock-trade-1",refundFee:"135.00",refundedAt:new Date().toISOString()});
    const first=await refunds.execute({orderId:id,clientRefundId:"p04-refund",reason:"仅模拟退款"});
    expect(first.refund).toMatchObject({status:"processing",failure_code:"financial_refund_confirmation_mismatch"});
    expect(db.getOrder(id)?.status).toBe("paid");expect(refundedEventCount(id)).toBe(0);
    db.db.prepare("UPDATE refunds SET created_at=?,updated_at=? WHERE order_id=?")
      .run(new Date(Date.now()-60000).toISOString(),new Date(Date.now()-60000).toISOString(),id);
    const second=await refunds.execute({orderId:id,clientRefundId:"p04-refund",reason:"只读核实金额"});
    expect(second.refund.status).toBe("succeeded");expect(pay).toHaveBeenCalledTimes(1);expect(query).toHaveBeenCalledTimes(1);
    await refunds.execute({orderId:id,clientRefundId:"p04-refund",reason:"重复操作核对"});
    expect(pay).toHaveBeenCalledTimes(1);expect(refundedEventCount(id)).toBe(1);
  });
  it("退款申请后实收被改动，执行前阻断且不调用付款接口",async()=>{
    const id=await paid();await request(id);
    db.db.prepare("UPDATE orders SET alipay_receipt_amount='134.00' WHERE order_id=?").run(id);
    const pay=vi.spyOn(payment,"refundPayment");
    await expect(refunds.execute({orderId:id,clientRefundId:"p04-refund-"+id,reason:"模拟异常核查"})).rejects.toThrow("不一致");
    expect(pay).not.toHaveBeenCalled();expect(db.getRefundByOrderId(id)?.status).toBe("requested");
  });
  it("已登记补差不能再按原实收全额退款",async()=>{
    const id=await paid();
    db.db.prepare("UPDATE orders SET customer_price_refund_amount='1.00' WHERE order_id=?").run(id);
    await expect(request(id)).rejects.toThrow("不一致");
    expect(db.getRefundByOrderId(id)).toBeUndefined();
  });
  it("重复入账、重复退款完成不改变金额或多发通知",async()=>{
    const id=await paid("120.00");
    db.markOrderPaid(id,new Date().toISOString(),"mock-trade-1","120.00");
    const r=await request(id);
    db.approveRefund({refundId:r.refund_id,reason:"模拟批准",now:new Date().toISOString()});
    const result={refundId:r.refund_id,refundFee:"120.00",tradeNo:"mock-trade-1",refundedAt:new Date().toISOString()};
    db.completeRefund(result);db.completeRefund(result);
    expect(db.getOrder(id)?.alipay_receipt_amount).toBe("120.00");expect(refundedEventCount(id)).toBe(1);
    expect(db.db.prepare("SELECT COUNT(*) n FROM webhook_outbox WHERE event_key=?").get(id+":order.paid")).toMatchObject({n:1});
  });
  it("负平台利润能查询报表、原值保留且不计入应付结算",async()=>{
    const id=await paid("100.00");succeeded(id);
    const r=await finance();expect(r.statusCode).toBe(200);
    expect(r.json().items[0]).toMatchObject({platform_margin:"-10.00",platform_paid_cny:"0.00",platform_settlement_zh:"无需核销"});
    expect(r.json().summary).toMatchObject({platform_margin:"-10.00",platform_payable:"0.00"});
    expect(settle().settlement.amount).toBe("0.00");expect(db.invoiceableAmount(id)).toBe("100.00");
  });
  it("补差上限、重复登记和超额补差保持一致",async()=>{
    const id=await paid();succeeded(id);
    const input={orderId:id,amount:"25.00",reference:"p04-proof",reason:"已核实模拟补差",refundedAt:new Date().toISOString()};
    db.recordCustomerPriceRefund(input);db.recordCustomerPriceRefund(input);
    expect(db.getOrder(id)?.customer_price_refund_amount).toBe("25.00");
    expect(()=>db.recordCustomerPriceRefund({...input,amount:"25.01"})).toThrow("already_recorded");
    expect(db.invoiceableAmount(id)).toBe("110.00");
    const r=await finance();expect(r.statusCode).toBe(200);
    expect(r.json().items[0].platform_margin).toBe("0.00");
    const other=await paid();succeeded(other);
    expect(()=>db.recordCustomerPriceRefund({...input,orderId:other,amount:"25.01"})).toThrow("exceeds_platform_margin");
    expect(db.getOrder(other)?.customer_price_refund_amount).toBe("0.00");
  });
  it("非法实收或补差无法进入结算，也不会留下半张结算单",async()=>{
    const id=await paid();succeeded(id);
    db.db.prepare("UPDATE orders SET customer_price_refund_amount='135.01' WHERE order_id=?").run(id);
    expect(()=>settle()).toThrow("financial_amount_inconsistent");
    expect(db.getPlatformSettlement("p04-settlement")).toBeUndefined();
    expect(db.db.prepare("SELECT COUNT(*) n FROM platform_settlement_lines").get()).toMatchObject({n:0});
  });
  it("开票必须等于当前实收减已登记补差，零元不生成工单",async()=>{
    const id=await paid();succeeded(id);
    db.recordCustomerPriceRefund({orderId:id,amount:"9.38",reference:"invoice-proof",reason:"已核实模拟补差",refundedAt:new Date().toISOString()});
    expect(()=>db.createInvoice(invoiceInput(id))).toThrow("开票金额");
    expect(db.createInvoice(invoiceInput(id,"125.62")).amount).toBe("125.62");
    const zero=await paid("0.00");
    expect(()=>db.createInvoice(invoiceInput(zero,"0.00"))).toThrow("为零");
  });
  it("开票登记完成前再次核对金额，变化后保留待处理",async()=>{
    const id=await paid(),invoice=db.createInvoice(invoiceInput(id));
    db.db.prepare("UPDATE orders SET alipay_receipt_amount='120.00' WHERE order_id=?").run(id);
    expect(()=>issue(String(invoice.invoice_id))).toThrow("已变化");
    expect(db.findOrderForInvoice(id)?.invoice_status).toBe("requested");
  });
  it("退款待核查或已退款时，不能新增开票或登记完成",async()=>{
    const id=await paid(),invoice=db.createInvoice(invoiceInput(id));await request(id);
    expect(()=>issue(String(invoice.invoice_id))).toThrow("退款");
    const r=await app.inject({url:"/admin/api/invoices/order-lookup?order_number="+id,headers:admin});
    expect(r.statusCode).toBe(200);expect(r.json().eligible).toBe(false);
    const other=await paid();await request(other);
    expect(()=>db.createInvoice(invoiceInput(other))).toThrow("退款");
  });
  it("不一致开票数据通过后台返回核查提示，不当作成功或服务器崩溃",async()=>{
    const id=await paid();
    db.db.prepare("UPDATE orders SET alipay_receipt_amount='136.00' WHERE order_id=?").run(id);
    const r=await app.inject({url:"/admin/api/invoices/order-lookup?order_number="+id,headers:admin});
    expect(r.statusCode).toBe(409);expect(r.json().detail_zh).toContain("不一致");
  });
  it("旧成本入口拒绝币种缺失、负数和人民币原币折算不等",async()=>{
    const id=await paid();
    for(const values of [{amount:"1.00",currency:null,cny:"7.00"},{amount:"-1.00",currency:"USD",cny:"7.00"},
      {amount:"7.00",currency:"CNY",cny:"8.00"}]){
      expect(()=>db.setOrderUpstreamCost({orderId:id,...values})).toThrow("成本");
    }
    expect(db.getOrder(id)?.upstream_actual_cost_cny).toBeNull();
    db.setOrderUpstreamCost({orderId:id,amount:"7.00",currency:"CNY",cny:"7.00"});
    expect(db.getOrder(id)?.upstream_actual_cost_cny).toBe("7.00");
  });
});
