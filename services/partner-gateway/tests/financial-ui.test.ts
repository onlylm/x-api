import { Script, createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { financialUiScript, financialDialogScript, financialUiStyles } from "../src/admin-ui/financial-ui.js";
import { adminPageV2 } from "../src/admin-page-v2.js";
import { adminScript } from "../src/admin-ui/script.js";
import { adminStyles } from "../src/admin-ui/styles.js";
import { ledgerScript } from "../src/admin-ui/ledger-workbench.js";
import { calculateCostReconciliation } from "../src/services/cost-reconciliation.js";
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
function ui(){
 const context=createContext({window:{},esc,money:(v:unknown)=>"¥"+Number(v||0).toFixed(2),
   statusTag:(s:string,t:string)=>'<span class="tag '+t+'">'+esc(s)+'</span>',
   translated:(_kind:string,s:string)=>s,beijingTime:(v:unknown)=>String(v||"-"),
   number:(v:unknown)=>String(v),settlementMethodLabel:(v:unknown)=>String(v||"-"),selectionAttrs:()=>""});
 runInContext(financialUiScript,context);
 return context.window.financeUi;
}
const base={supplyCny:"100.00",standardCostCny:"80.00",platformBaseProfitCny:"20.00",standardUsd:"80.00",actualUsd:"75.00",
 feesUsd:"0.00",retainedUsd:"0.00",fxRate:"1.00"};
const statement={settlement_id:"STMT-DEMO",amount:"20.00",rebate_usd:"5.00",cny_paid:"8.00",usd_paid:"0.00",
 status:"partial",order_count:1,created_at:"2026-09-27T02:00:00Z",period_from:"2026-09-26T14:00:00Z",period_to:"2026-09-27T14:00:00Z"};
describe("统一订单、核查与结算 UI",()=>{
 it("所有内嵌浏览器脚本语法有效",()=>{
   for(const script of [adminScript,ledgerScript,financialUiScript,financialDialogScript])expect(()=>new Script(script)).not.toThrow();
 });
 it("缺汇率时退差与成本下降抵消，直接显示订单冻结的人民币基础毛利",()=>{
   const html=ui().costMarkup(calculateCostReconciliation({...base,fxRate:null}),"confirmed");
   expect(html).toContain("美元成本已确认");expect(html).toContain("人民币基础毛利已核算");
   expect(html).toContain("¥20.00");expect(html).toContain("成本下降与美元退差已经同步抵消");
 });
 it("无美元退差且扣款未变化时直接沿用订单冻结人民币成本",()=>{
   const html=ui().costMarkup(calculateCostReconciliation({...base,actualUsd:"80.00",fxRate:null}),"confirmed");
   expect(html).toContain("¥100.00");expect(html).toContain("人民币基础毛利已核算");
   expect(html).toContain("订单冻结人民币成本");expect(html).toContain("真实总成本 · 折合人民币</dt><dd>¥80.00");
 });
 it("已确认实际口径突出 5 USD / 95 / 20，美元显式标币种",()=>{
   const html=ui().costMarkup(calculateCostReconciliation(base),"confirmed");
   expect(html).toContain("5.00 USD");expect(html).toContain("¥95.00");expect(html).toContain("¥20.00");
   expect(html).toContain("人民币基础毛利已核算");expect(html).toContain("两个币种分别结算");
 });
 it("草稿即使填有汇率也只能显示试算",()=>{
   const html=ui().costMarkup(calculateCostReconciliation(base),"draft");
   expect(html).toContain("异常草稿 · 待确认");expect(html).toContain("试算毛利");
   expect(html).not.toContain("人民币基础毛利已核算");
 });
 it("争议不显示可结算利润",()=>{
   const html=ui().costMarkup(null,"disputed");
   expect(html).toContain("暂停结算");expect(html).not.toContain("¥0.00");
 });
 it("负毛利保留红色，不显示成功绿色",()=>{
   const html=ui().costMarkup(calculateCostReconciliation({...base,actualUsd:"110.00"}),"confirmed");
   expect(html).toContain('fin-metric bad');expect(html).toContain("¥-10.00");
 });
 it("分币种剩余金额按分计算、不混加",()=>{
   expect(ui().remaining(statement,"CNY")).toBe("12.00");
   expect(ui().remaining(statement,"USD")).toBe("5.00");
   expect(ui().remaining({...statement,amount:"0.30",cny_paid:"0.10"},"CNY")).toBe("0.20");
 });
 it("结清单仍有查看按钮，部分结算显示剩余金额",()=>{
   const html=ui().settlementRows([statement,{...statement,status:"paid",cny_paid:"20.00",usd_paid:"5.00"}]);
   expect(html).toContain("部分核销");expect(html).toContain("待核销 ¥12.00");
   expect(html).toContain("查看详情");expect(html).toContain("待核销 0.00 USD");
   expect(html).toContain('data-export-statement-index="0"');expect(html).toContain("导出 CSV");
   expect((html.match(/<th>/g)||[]).length).toBe(6);
 });
 it("结算字段未同步但两币种余额都为零时按已结算展示并可查看",()=>{
   const legacy={...statement,status:"pending",amount:"0.00",rebate_usd:"0.00",cny_paid:"0.00",usd_paid:"0.00"};
   expect(ui().settlementState(legacy)).toBe("paid");
   const html=ui().settlementRows([legacy]);
   expect(html).toContain("已核销");expect(html).toContain("查看详情");expect(html).not.toContain("待人工付款");
 });
 it("结算金额读取真实行 amount，美元退差独立列明",()=>{
   const html=ui().statementMarkup({settlement:statement,payments:[],lines:[{order_id:"O1",amount:"20.00"}],rebates:[{order_id:"O1",rebate_usd:"5.00"}]});
   expect(html).toContain("人民币结算明细");expect(html).toContain("美元退差明细");
   expect(html).toContain("<td>¥20.00</td>");expect(html).toContain("<td>5.00 USD</td>");
 });
 it("付款备注与订单标识按文本转义，不作为 HTML 执行",()=>{
   const html=ui().statementMarkup({settlement:{...statement,settlement_id:'<img src=x>'},payments:[{amount:"1.00",currency:"USD",reference:"<script>x</script>",note:'<img onerror="alert(1)">'}]});
   expect(html).not.toContain("<script>");expect(html).not.toContain("<img");
   expect(html).toContain("&lt;script&gt;");
 });
 it("订单展示时间线、历史退款、人工订单凭证及原有操作区域",()=>{
   const html=ui().orderMarkup({order:{order_id:"O1",client_order_id:"C1",status:"paid",delivery_status:"success",order_source:"manual",amount:"120.00",payment_channel:"cash",manual_payment_reference:"现金凭证",customer_price_refund_amount:"2.00",customer_price_refund_reference:"OLD-REF"},
     cost_review_status:null,refund:null},{receipt:120,supply:100,platformProfit:18});
   expect(html).toContain("订单时间线");expect(html).toContain("尚无记录");
   expect(html).toContain("现金凭证");expect(html).toContain("OLD-REF");
   expect(html).toContain("成本尚未核查");
 });
 it("关键容器唯一，成本核查与结算详情都使用弹窗语义",()=>{
   for(const id of ["orderFacts","ledgerOutcome","ledgerCostForm","settlementEntry","settlementPaymentFacts","orderAction","orderActivations"])
     expect(adminPageV2.split('id="'+id+'"').length-1).toBe(1);
   expect(adminPageV2).toContain('aria-labelledby="settlementTitle"');
   expect(adminPageV2).toContain('aria-labelledby="orderModalTitle"');
   expect(adminPageV2).toContain('id="orderActionPanel" class="fin-details fin-action-details"');
   expect(adminPageV2).not.toContain('id="orderActionPanel" class="fin-details fin-action-details" open');
   expect(adminScript).toContain("$('#orderActionPanel').open = false");
   expect(adminPageV2).toContain('id="ledgerEditor" class="modal hidden"');
   expect(adminPageV2).toContain('aria-labelledby="ledgerEditorTitle"');
   expect(financialUiStyles).toContain("prefers-reduced-motion");
 });
 it("结算核销弹窗只保留一组币种和金额控件，点击后不会把字段集合当作下拉框",()=>{
   const settlementForm=adminPageV2.match(/<form id="settlementPaymentForm"[\s\S]*?<\/form>/)?.[0]??"";
   expect((settlementForm.match(/name="currency"/g)||[]).length).toBe(1);
   expect((settlementForm.match(/name="amount"/g)||[]).length).toBe(1);
   expect(ledgerScript).not.toContain("grid.insertAdjacentHTML('afterbegin'");
   expect(ledgerScript).not.toContain("field(sf,'payment_amount')");
   expect(ledgerScript).toContain("field(sf,'amount')");
   expect(ledgerScript).toContain("field(sf,'currency').querySelector('[value=\"CNY\"]')");
 }); it("成本核查弹窗会在模态管理启动前移到 shell 外，避免被 inert 冻结",()=>{
   expect(ledgerScript).toContain("document.body.appendChild(ledgerEditor)");
   expect(adminPageV2.indexOf(ledgerScript)).toBeLessThan(adminPageV2.indexOf(financialDialogScript));
   expect(financialDialogScript).toContain("document.querySelector('.shell').inert=!!top");
 });
 it("零订单与零异常不画出虚假的进度条",()=>{
   const empty=ui().funnelMarkup({});
   expect((empty.match(/width:0%/g)||[]).length).toBe(4);
   expect(ui().funnelMarkup({total:10,paid:5,awaiting_delivery:0,delivery_failed:0})).toContain("width:50%");
 });
 it("工作台明确财务区间、每日统计口径及三页快捷入口",()=>{
   expect(adminPageV2).toContain('id="dashboardRange"');expect(adminPageV2).toContain('id="dashboardProfitHint"');
   expect(adminPageV2).toContain("默认统计今天（北京时间）");
   expect((adminPageV2.match(/data-days="1"/g)||[]).length).toBe(2);
   expect(adminScript).toContain("setDatePreset(1)");
   expect(adminPageV2).toContain("区间订单预览");
   expect(adminPageV2).toContain("无结果时不展示百分比");
   expect(ledgerScript).toContain("人民币供货价 CNY");expect(ledgerScript).toContain("下单时冻结");
   expect(ledgerScript).toContain("r.gross_profit_cny!=null");expect(ledgerScript).not.toContain("reviewState(r.status,!!r.fx_rate");
   expect(adminPageV2).toContain('role="tablist"');
   for(const tab of ["cost","details","settlements"])expect(adminPageV2).toContain('data-finance-tab="'+tab+'"');
   expect((adminPageV2.match(/data-finance-pane=/g)||[]).length).toBe(3);
   expect(adminScript).toContain("goFinanceTab");expect(adminScript).toContain("/admin/api/platform-settlements?");
   for(const id of ["settlementSearch","settlementFrom","settlementTo","settlementStatus","settlementPageSize","settlementPagination"])
     expect(adminPageV2).toContain('id="'+id+'"');
   expect(adminPageV2).toContain("待核销");expect(adminPageV2).toContain("部分核销");expect(adminPageV2).toContain("已核销");
   expect(adminScript).toContain("/export.csv");expect(adminScript).toContain("syncSettlementPaymentAmount");
   expect(adminStyles).toContain("selected-row > td");expect(financialUiStyles).toContain(".fin-selected>td");
 });
 it("线下退差使用独立弹窗，金额由服务端锁定且明确保留人民币正常结算",()=>{
   for(const id of ["openExternalRebatePayment","externalRebatePaymentModal","externalRebatePaymentForm","externalRebateOrderNumber","externalRebatePaymentFacts","externalRebatePaymentEntry"])
     expect(adminPageV2.split('id="'+id+'"').length-1).toBe(1);
   const form=adminPageV2.match(/<form id="externalRebatePaymentForm"[\s\S]*?<\/form>/)?.[0]??"";
   expect(form).toContain("本次只登记已支付的美元退差");
   expect(form).toContain("人民币基础利润不会被标记为已结算");
   expect(form).not.toContain('name="amount"');
   expect(form).toContain('name="applied_usd"');expect(form).toContain('name="payment_amount"');
   expect(form).toContain('name="fx_rate"');expect(form).toContain('name="funding_amount"');
   expect((form.match(/name="reference"/g)||[]).length).toBe(1);
   expect((form.match(/name="paid_at"/g)||[]).length).toBe(1);
   expect(ledgerScript).toContain("/external-payment-preview");
   expect(ledgerScript).toContain("/external-payment'");
   expect(ledgerScript).toContain("两种币种独立核销，不会整单标记为已结算");
   expect(ledgerScript).toContain("人民币基础利润仍待正常结算");
 }); it("没有履约结果不显示误导性的 0% 成功或失败率",()=>{
   expect(ui().dailyRateMarkup({success_count:0,failed_count:0},"success")).not.toContain("%");
   expect(ui().dailyRateMarkup({success_count:1,failed_count:0,success_rate:100},"success")).toContain("100.0%");
 });
});
