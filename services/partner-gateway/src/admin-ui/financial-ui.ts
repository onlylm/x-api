/** Shared presentation for internal finance screens. No payment or pricing logic. */
export const financialUiStyles = String.raw`
.finance-surface{--finance-label:#526174;--finance-copy:#38465c;font-size:14px;line-height:1.6}
.finance-surface h2{font-size:20px}.finance-surface h3{font-size:18px;margin:0 0 16px}.finance-surface h4{font-size:16px}
.finance-surface .sub,.finance-surface .field-hint,.finance-surface small,.finance-surface .panel-head p{font-size:13px;color:var(--finance-label)}
.finance-surface .field label{font-size:14px;color:var(--finance-copy)}.finance-surface input,.finance-surface select,.finance-surface textarea{font-size:15px;min-height:44px}
.finance-surface .field{align-content:start}
.finance-surface input[type=checkbox]{min-height:20px}.finance-surface .btn{min-height:44px;font-size:14px}
.finance-surface :is(button,input,select,textarea,summary):focus-visible{outline:3px solid var(--primary);outline-offset:3px}
.finance-surface .tag{font-size:13px;padding:4px 8px}.finance-surface .notice{font-size:14px;line-height:1.6}
.finance-surface .table-wrap{max-width:100%;overflow:auto}.finance-surface th{font-size:13px;color:var(--finance-label)}
.finance-surface td{font-size:14px;padding:16px 12px}.finance-surface td:first-child{white-space:normal;overflow-wrap:anywhere;min-width:160px}
.finance-surface .good{color:var(--good)}.finance-surface .bad{color:var(--bad)}.finance-surface .warn{color:var(--warn)}
.finance-surface .fin-muted{color:var(--finance-label)}
.finance-subnav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:20px;padding:6px;border:1px solid var(--line);border-radius:13px;background:var(--panel)}
.finance-tab{display:flex;min-width:0;min-height:64px;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;padding:10px 14px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--finance-copy);text-align:left;cursor:pointer}
.finance-tab strong{font-size:15px}.finance-tab span{font-size:12px;color:var(--finance-label)}
.finance-tab:hover{background:var(--bg)}.finance-tab.on{border-color:var(--primary);background:var(--primary-soft);color:var(--primary)}
.finance-pane{display:none}.finance-pane.on{display:block;animation:enter .16s ease-out}.finance-pane>.panel:first-child{margin-top:0}
.settlement-query{padding-bottom:8px}.settlement-query+.field-hint{margin:4px 0 0}
.fin-dialog{width:min(1100px,100%);max-height:94vh;overflow:auto;padding:0;scroll-padding-top:100px}
.fin-dialog-head{position:sticky;top:0;z-index:3;background:var(--panel);padding:20px 24px;border-bottom:1px solid var(--line)}
.fin-dialog-head h2{overflow-wrap:anywhere}.fin-dialog-head .btn{flex:none}.fin-dialog-body{padding:24px}
.fin-section{margin-top:24px;padding-top:24px;border-top:1px solid var(--line)}
.fin-section:first-child{margin-top:0;padding-top:0;border-top:0}
.fin-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.fin-head h3,.fin-head h4{margin:0}.fin-statuses{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fin-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel);margin:16px 0}
.fin-metric{min-width:0;padding:20px;border-right:1px solid var(--line)}.fin-metric:last-child{border-right:0}
.fin-metric span,.fin-metric small{display:block}.fin-metric>span{font-size:14px;color:var(--finance-label)}
.fin-metric strong{display:block;margin:8px 0;font-size:28px;line-height:1.25;letter-spacing:-.5px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.fin-metric.focus{background:var(--primary-soft)}.fin-metric.focus strong{color:var(--primary)}
.fin-details{border:1px solid #cbd8f1;border-radius:12px;margin-top:16px;padding:0 16px;background:var(--panel);transition:border-color .15s ease,background-color .15s ease,box-shadow .15s ease}
.fin-details>summary{display:flex;min-height:52px;align-items:center;gap:10px;padding:12px 0;cursor:pointer;list-style:none;color:#1749bd;font-size:14px;font-weight:700}
.fin-details>summary::-webkit-details-marker{display:none}.fin-details>summary::before{content:'›';display:grid;width:26px;height:26px;flex:0 0 26px;place-items:center;border:1px solid #9eb7eb;border-radius:50%;background:var(--primary-soft);color:var(--primary);font-size:20px;line-height:1;transition:transform .15s ease,background-color .15s ease,color .15s ease}
.fin-details:hover{border-color:#7899ed;background:#fbfdff;box-shadow:0 0 0 2px rgba(36,87,214,.05)}.fin-details:hover>summary::before{background:var(--primary);color:#fff}
.fin-details[open]{border-color:#7899ed}.fin-details[open]>summary{margin-bottom:8px;border-bottom:1px solid #dbe5f8}.fin-details[open]>summary::before{transform:rotate(90deg);background:var(--primary);color:#fff}.fin-details>div{padding-bottom:20px}
.fin-facts{display:grid;grid-template-columns:minmax(130px,1fr) minmax(0,2fr);gap:12px 20px;margin:0}
.fin-facts dt{color:var(--finance-label)}.fin-facts dd{margin:0;font-weight:600;overflow-wrap:anywhere}
.fin-timeline{list-style:none;padding:0;margin:16px 0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.fin-timeline li{padding:12px 16px;border-left:3px solid var(--line-strong);background:var(--bg)}
.fin-timeline li.done{border-color:var(--good)}.fin-timeline span,.fin-timeline time{display:block}
.fin-timeline time{margin-top:6px;font-size:13px;font-variant-numeric:tabular-nums;color:var(--finance-label)}
.fin-money-rows{margin:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px 20px}
.fin-money-rows dt{color:var(--finance-label)}.fin-money-rows dd{margin:0;text-align:right;font-size:16px;font-weight:650;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.finance-surface .ledger-breakdown{padding:20px;margin:20px 0;background:var(--bg);border-color:var(--line)}
.fin-flow-note{margin:16px 0 0;color:var(--finance-copy);line-height:1.7}
.fin-currency-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:20px 0}
.fin-currency{padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}
.fin-currency h3{font-size:16px;margin:0}.fin-currency>strong{display:block;font-size:32px;font-variant-numeric:tabular-nums;margin:8px 0}
.fin-currency dl{display:flex;gap:8px;flex-wrap:wrap;margin:0;color:var(--finance-label)}.fin-currency dd{margin:0 12px 0 0;font-weight:600}
.fin-form-section{margin:20px 0;padding:20px;border:1px solid var(--line);border-radius:12px;min-width:0}
.fin-form-section legend{padding:0 8px;font-size:16px;font-weight:700}.fin-form-section .form-grid{margin-top:0}
.fin-form-section p{margin:0 0 12px}.fin-action-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px 0;margin-top:16px;border-top:1px solid var(--line)}
.fin-action-bar .actions{margin:0}.fin-action-bar .field-hint{margin:0;flex:1;min-width:180px}
.finance-surface .ledger-pair span{font-size:13px;color:var(--finance-label)}.finance-surface .ledger-pair strong{font-size:17px}
.finance-surface .ledger-editor{scroll-margin-top:24px}.finance-surface .ledger-check{padding:12px;background:var(--bg);border-radius:8px}
.fin-empty{padding:24px;color:var(--finance-label);background:var(--bg);border-radius:10px}
.fin-payment-history{display:grid;gap:12px}.fin-payment-record{padding:16px;background:var(--bg);border:1px solid var(--line);border-radius:10px;overflow-wrap:anywhere}
.fin-payment-record strong{font-size:18px;font-variant-numeric:tabular-nums}.fin-payment-record p{margin:4px 0;color:var(--finance-label)}
.fin-selected>td{background:#dce8ff!important;border-color:#aec4f5}.fin-selected td:first-child{box-shadow:inset 5px 0 var(--primary)}.fin-selected td:first-child strong{color:#123fa7}.fin-selected .btn{border-color:#7899ed;background:#fff;color:#1749bd}
.finance-surface .settlement-summary span{font-size:13px}.finance-surface .settlement-summary strong{font-size:22px}
.fin-order-actions{background:var(--bg);border-radius:12px;padding:20px}.fin-order-actions .actions{flex-wrap:wrap}.fin-action-details>.fin-order-actions{margin-top:4px}
@media(max-width:760px){
.finance-subnav{display:flex;overflow-x:auto}.finance-tab{flex:0 0 170px}
.fin-dialog-head,.fin-dialog-body{padding:16px}.fin-dialog-head h2{font-size:18px}.fin-dialog{max-height:96vh}
.fin-metrics,.fin-currency-grid{grid-template-columns:1fr}.fin-metric{border-right:0;border-bottom:1px solid var(--line);padding:16px}.fin-metric:last-child{border-bottom:0}
.fin-metric strong{font-size:26px}.fin-timeline{grid-template-columns:repeat(2,minmax(0,1fr))}
.fin-facts{grid-template-columns:1fr;gap:4px}.fin-facts dd{margin-bottom:12px}
.fin-money-rows{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:12px}.fin-money-rows dd{font-size:15px}
.fin-form-section,.fin-details{padding:0 16px}.fin-form-section{padding:16px}.fin-action-bar{align-items:stretch}
.fin-action-bar .actions{width:100%;flex-wrap:wrap}.fin-action-bar .btn{flex:1}
.finance-surface .panel-head{align-items:flex-start;flex-wrap:wrap}.finance-surface .table-actions{flex-wrap:wrap}
.finance-surface .ledger-breakdown{padding:16px}
}
.shell[inert]{overflow:clip}
.dashboard-surface .dashboard-links{display:flex;gap:8px;flex-wrap:wrap}
.dashboard-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap}.dashboard-date-presets{margin:0}.dashboard-date-presets .btn{min-height:40px}
.dashboard-surface>.fin-head h2{margin:0}
.dashboard-surface .kpi-grid{gap:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel)}
.dashboard-surface .kpi{border:0;border-right:1px solid var(--line);border-radius:0;box-shadow:none;padding:24px 20px}
.dashboard-surface .kpi:first-child{background:var(--primary-soft)}.dashboard-surface .kpi:first-child .kpi-value{color:var(--primary)}
.dashboard-surface .kpi:last-child{border-right:0}.dashboard-surface .kpi::before{display:none}
.dashboard-surface .kpi-top{font-size:14px;color:var(--finance-label)}.dashboard-surface .kpi-value{font-size:28px;font-variant-numeric:tabular-nums}
.dashboard-surface .kpi-foot{font-size:13px;color:var(--finance-label)}
.dashboard-operations{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:24px}
.dashboard-surface .funnel-line{grid-template-columns:100px minmax(0,1fr) 48px;font-size:14px}
.dashboard-surface .funnel-line strong{text-align:right}.dashboard-surface .task-main b{font-size:14px}
.dashboard-surface .task-main span,.dashboard-surface .task-main small{font-size:13px}
.dashboard-cost-todo{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:16px 20px 0;padding:16px;background:var(--warn-soft);border-radius:8px}
.dashboard-cost-todo p{margin:0}.dashboard-cost-todo strong{color:var(--warn)}
.finance-surface#settlementPanel{scroll-margin-top:84px}
@media(max-width:820px){.dashboard-operations{grid-template-columns:1fr}.dashboard-surface .kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dashboard-surface .kpi{padding:16px;border-bottom:1px solid var(--line)}.dashboard-surface .kpi-value{font-size:24px}.dashboard-surface .kpi:nth-child(2n){border-right:0}}
.finance-surface .ledger-editor{scroll-margin-top:84px}
.fin-dialog-head>div:first-child{min-width:0;flex:1}
@media(max-width:760px){
.finance-surface .fin-dialog-head{flex-wrap:nowrap;align-items:flex-start}
.fin-metric{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:center}
.fin-metric strong{margin:0;text-align:right;font-size:24px}.fin-metric small{grid-column:1/-1}
.finance-surface .ledger-editor{scroll-margin-top:16px}
}
@media(prefers-reduced-motion:reduce){.finance-surface *{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
`;
export const financialUiScript = String.raw`
(function(){
  const dollars=v=>Number(v||0).toFixed(2)+' USD';
  const pending=v=>v==null?'待核算':money(v);
  const metric=(label,value,hint,tone='')=>'<div class="fin-metric '+tone+'"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong><small>'+esc(hint)+'</small></div>';
  const pair=(label,value)=>'<dt>'+esc(label)+'</dt><dd>'+esc(value==null?'—':value)+'</dd>';
  const details=(label,body)=>'<details class="fin-details"><summary>'+esc(label)+'</summary><div>'+body+'</div></details>';
  function reviewState(status,profitKnown,rebateUsd){
    if(status==='confirmed'){
      const hasRebate=Number(rebateUsd||0)>0;
      const cnyState=profitKnown?'人民币基础毛利已核算':hasRebate?'额外费用待换算':'人民币成本待核算';
      return statusTag('美元成本已确认','good')+statusTag(cnyState,profitKnown?'good':'warn');
    }
    if(status==='disputed')return statusTag('存在争议 · 暂停结算','bad');
    if(status==='historical')return statusTag('历史已结算','good');
    if(status==='review_required')return statusTag('自动核对异常 · 人工审核','bad');
    if(status==='draft')return statusTag('异常草稿 · 待确认','warn');
    return statusTag('等待自动核对','');
  }
  function costMarkup(s,status){
    if(!s)return '<div class="fin-empty">'+reviewState(status,false)+'<p>成本尚未确认或存在争议，净收入与毛利待核算。请核对扣款和费用凭证。</p></div>';
    const confirmed=status==='confirmed',profitKnown=confirmed&&s.gross_profit_cny!=null;
    const profitTone=!confirmed||s.gross_profit_cny==null?'fin-muted':Number(s.gross_profit_cny)<0?'bad':'good';
    return '<section class="ledger-breakdown" aria-label="退差结算明细"><div class="fin-head"><h3>成本与退差</h3><div class="fin-statuses">'+reviewState(status,profitKnown,s.rebate_usd)+'</div></div>'+
      '<div class="fin-metrics">'+metric(confirmed?'应退平台差价':'试算退平台差价',dollars(s.rebate_usd),'由平台退客户；本系统不付款','focus')+
      metric(confirmed?'我方净结算收入':'试算净结算收入',pending(s.supplier_net_income_cny),'原供货报价 − 退差折合金额；无退差直接带入供货价')+
      metric(confirmed?'我方毛利':'试算毛利',pending(s.gross_profit_cny),'供货价 − 冻结成本；退差与成本下降同步抵消',profitTone)+'</div>'+
      '<details class="fin-details"><summary>核算过程与费用明细</summary><div><dl class="fin-money-rows">'+pair('原供货报价（保留原价）',money(s.original_supply_cny))+
      pair('订单冻结人民币成本',money(s.standard_cost_cny))+pair('基础毛利',money(s.base_gross_profit_cny))+
      pair('实际扣款',dollars(s.actual_usd))+pair('另行登记费用',dollars(s.fees_usd))+
      pair('扣款＋内置手续费＋额外费用',dollars(s.total_cost_usd))+pair('真实总成本 · 折合人民币',pending(s.actual_cost_cny))+
      pair('扣款节省 / 实际预留',dollars(s.saving_usd)+' / '+dollars(s.retained_applied_usd))+
      pair('退平台差价 / 毛利调整',dollars(s.rebate_usd)+' / '+dollars(s.profit_adjustment_usd))+'</dl></div></details>'+
      '<p class="fin-flow-note">平台基础利润 <strong>'+money(s.platform_base_profit_cny)+'</strong> 保持独立；另付代退客户差价 <strong>'+dollars(s.rebate_usd)+'</strong>。两个币种分别结算，不相加打款。</p>'+
      '<p class="field-hint">'+(s.fx_rate?'凭证核算汇率 '+esc(s.fx_rate)+' CNY / USD；仅供核算。':
        s.gross_profit_cny!=null?'成本下降与美元退差已经同步抵消，基础毛利按订单冻结的人民币成本计算；美元退差独立出单。':
        '存在超扣或额外费用且汇率未核实，只有这部分毛利调整暂待换算。')+
      ' 默认预留作为内置手续费；另行登记费用单独影响毛利。系统只出单与登记，不代表平台已退客户。</p></section>';
  }
  function orderMarkup(data,info){
    const o=data.order,r=data.refund,a=data.platform_rebate;
    const payTone=o.status==='paid'?'good':o.status==='refunded'?'':'warn';
    let identity=pair('平台订单号',o.client_order_id)+pair('我方订单号',o.order_id)+pair('商品',o.product)+
      pair('订单来源',o.order_source==='manual'?'人工补录':'平台订单')+pair('支付宝交易号',o.alipay_trade_no||'—');
    if(o.order_source==='manual')identity+=pair('收款方式',o.payment_channel==='cash'?'现金':'支付宝')+pair('收款凭证',o.manual_payment_reference||'—')+pair('客户标识',o.manual_customer_ref||'—')+pair('补录说明',o.manual_note||'—');
    const times=[['下单',o.created_at],['付款',o.paid_at],['提交履约',info.submitted],['履约结果',info.finished]];
    let refunds='';
    if(r||o.refunded_at||Number(o.customer_price_refund_amount)>0){
      refunds=details('历史退款与凭证（与平台退差分开）','<dl class="fin-facts">'+pair('退款状态',r?translated('refund',r.status):o.refunded_at?'已退款':'无全额退款')+
        pair('退款请求号',r?.client_refund_id||'—')+pair('退款申请时间',beijingTime(r?.created_at))+pair('退款完成时间',beijingTime(r?.refunded_at||o.refunded_at))+
        pair('处理说明',r?.failure_message||'—')+pair('历史直接退客户金额',money(o.customer_price_refund_amount))+
      pair('客户补差时间',beijingTime(o.customer_price_refunded_at))+pair('客户补差凭证',o.customer_price_refund_reference||'—')+pair('客户补差原因',o.customer_price_refund_reason||'—')+'</dl>');
    }
    const rebate=a?'<p class="field-hint">平台退差进度：'+esc(({paid:'已登记付给平台',included:'已进入结算单',pending:'待入结算单'})[a.status]||a.status)+' · '+dollars(a.rebate_usd)+'；不代表平台已退款给客户。</p>':'';
    return '<section aria-label="订单概览"><div class="fin-head"><div class="fin-statuses">'+
      statusTag(translated('payment',o.status),payTone)+statusTag(translated('delivery',o.delivery_status||'pending'),o.delivery_status==='success'?'good':o.delivery_status==='failed'?'bad':'warn')+
      '</div><span class="fin-muted">'+esc(o.client_order_id)+'</span></div><div class="fin-metrics">'+
      metric('服务商实收',money(info.receipt),'用户下单金额 '+money(o.amount),'focus')+
      metric('原供货报价',money(info.supply),'原价保留，退差单独列示')+
      metric('平台基础利润',money(info.platformProfit),'不包含新增美元退差',Number(info.platformProfit)<0?'bad':'')+'</div></section>'+
      '<section class="fin-section"><h3>订单时间线 <small>北京时间</small></h3><ol class="fin-timeline">'+times.map(t=>'<li class="'+(t[1]?'done':'')+'"><span>'+t[0]+'</span><time>'+esc(t[1]?beijingTime(t[1]):'尚无记录')+'</time></li>').join('')+'</ol></section>'+
      (data.cost_review_status?costMarkup(data.cost_reconciliation,data.cost_review_status):'<div class="fin-empty">成本尚未核查。原供货报价不是上游实际成本，不能据此认定真实毛利。</div>')+
      rebate+details('订单标识与收款凭证','<dl class="fin-facts">'+identity+'</dl>')+refunds;
  }
  function remaining(s,currency){
    const total=currency==='CNY'?s.amount:s.rebate_usd;
    const paid=currency==='CNY'?s.cny_paid:s.usd_paid;
    return ((Math.round(Number(total||0)*100)-Math.round(Number(paid||0)*100))/100).toFixed(2);
  }
  function settlementState(s){
    const cnyRest=Number(remaining(s,'CNY')),usdRest=Number(remaining(s,'USD'));
    if(cnyRest<=0&&usdRest<=0)return 'paid';
    if(Number(s.cny_paid||0)>0||Number(s.usd_paid||0)>0)return 'partial';
    return 'pending';
  }
  function settlementStatus(s){const state=settlementState(s);return statusTag(state==='paid'?'已核销':state==='partial'?'部分核销':'待核销',state==='paid'?'good':'warn');}
  function statementMarkup(d){
    const s=d.settlement;
    const currencies=[['CNY','平台基础利润',money],['USD','代退客户差价',dollars]];
    const cards=currencies.map(([c,label,fmt])=>{
      const total=c==='CNY'?s.amount:s.rebate_usd,paid=c==='CNY'?s.cny_paid:s.usd_paid,rest=remaining(s,c);
      return '<section class="fin-currency"><div class="fin-head"><h3>'+label+' · '+c+'</h3>'+statusTag(Number(rest)===0?'本币种已结清':'本币种待付',Number(rest)===0?'good':'warn')+'</div><span class="fin-muted">剩余待付</span><strong>'+fmt(rest)+'</strong><dl><dt>应付</dt><dd>'+fmt(total)+'</dd><dt>已付</dt><dd>'+fmt(paid)+'</dd></dl></section>';
    }).join('');
    const payments=d.payments||[];
    const history=payments.length?payments.map(p=>'<article class="fin-payment-record"><strong>'+esc(p.amount)+' '+esc(p.currency)+'</strong><p>'+esc(settlementMethodLabel(p.method))+' · '+esc(beijingTime(p.paid_at))+'</p><p>凭证：'+esc(p.reference)+'</p>'+(p.note?'<p>'+esc(p.note)+'</p>':'')+'</article>').join(''):
      '<p class="fin-empty">'+(settlementState(s)==='paid'?'此为历史已结算单，暂无逐笔记录；原结算凭证见下方。':'尚未登记付款。生成结算单不代表已经付款。')+'</p>';
    const lines=d.lines||[];
    return '<div class="fin-head">'+settlementStatus(s)+'<span class="fin-muted">'+esc(s.settlement_id)+'</span></div><div class="fin-currency-grid">'+cards+'</div>'+
      '<details class="fin-details"><summary>已登记付款 · '+payments.length+' 笔</summary><div class="fin-payment-history">'+history+'</div></details>'+
      details('结算范围与原始凭证','<dl class="fin-facts">'+pair('生成方式',s.generation_mode==='scheduled'?'每日 22:00 自动出单':'人工生成')+
      pair('生成时间',beijingTime(s.created_at))+pair('区间起点（包含）',beijingTime(s.period_from))+pair('区间终点（不包含）',beijingTime(s.period_to))+
      pair('包含订单',String(s.order_count||0)+' 笔')+pair('原结算凭证',s.payment_reference||'—')+'</dl>')+
      (lines.length?details('查看人民币结算明细 · '+lines.length+' 笔','<div class="table-wrap"><table><thead><tr><th>订单</th><th>平台利润</th></tr></thead><tbody>'+
      lines.map(l=>'<tr><td>'+esc(l.client_order_id||l.order_id)+'</td><td>'+money(l.amount)+'</td></tr>').join('')+'</tbody></table></div>'):'')+
      ((d.rebates||[]).length?details('查看美元退差明细 · '+d.rebates.length+' 笔','<div class="table-wrap"><table><thead><tr><th>订单</th><th>应退平台差价 USD</th></tr></thead><tbody>'+
      d.rebates.map(r=>'<tr><td>'+esc(r.client_order_id||r.order_id)+'</td><td>'+dollars(r.rebate_usd)+'</td></tr>').join('')+'</tbody></table></div>'):'');
  }
  function settlementRows(items){
    if(!items.length)return '<div class="fin-empty">当前没有结算单。有可结算的平台利润或美元退差时，每晚 22:00 自动出单；不会自动付款。</div>';
    return '<div class="table-wrap"><table><thead><tr><th>结算单 / 日期</th><th>订单数</th><th>人民币基础利润</th><th>美元退差</th><th>状态</th><th>操作</th></tr></thead><tbody>'+
      items.map((s,i)=>{const state=settlementState(s);return '<tr'+selectionAttrs('settlements',s.settlement_id,'')+'><td><strong>'+esc(s.settlement_id)+'</strong><span class="sub">'+esc(s.business_date||beijingTime(s.created_at).slice(0,10))+' · '+(s.generation_mode==='scheduled'?'22:00 自动出单':'人工生成')+'</span></td><td>'+number(s.order_count)+'</td>'+
      '<td class="amount">'+money(s.amount)+'<span class="sub">待核销 '+money(remaining(s,'CNY'))+'</span></td><td class="amount">'+dollars(s.rebate_usd)+'<span class="sub">待核销 '+dollars(remaining(s,'USD'))+'</span></td><td>'+settlementStatus(s)+'</td><td><div class="table-actions"><button type="button" class="btn small" data-statement-index="'+i+'">'+(state==='paid'?'查看详情':'查看 / 核销')+'</button><button type="button" class="btn small" data-export-statement-index="'+i+'">导出 CSV</button></div></td></tr>';}).join('')+'</tbody></table></div>';
  }
  function funnelMarkup(orders){
    const total=Number(orders.total||0);
    return [['创建订单',total,'primary'],['支付成功',orders.paid,'good'],['等待履约',orders.awaiting_delivery,'warn'],['履约异常',orders.delivery_failed,'bad']]
      .map(([label,value,tone])=>{
        const count=Number(value||0),width=total>0?Math.min(100,Math.max(0,Math.round(count/total*100))):0;
        return '<div class="funnel-line"><span>'+label+'</span><div class="progress"><span style="width:'+width+'%;background:var(--'+tone+')"></span></div><strong>'+number(count)+'</strong></div>';
      }).join('');
  }
  function dailyRateMarkup(row,kind){
    if(Number(row.success_count||0)+Number(row.failed_count||0)===0)return '<span class="fin-muted">—</span>';
    const value=Number(kind==='success'?row.success_rate:row.failure_rate);
    const tone=kind==='success'?(value>=90?'good':value>0?'warn':''):(value>0?'bad':'good');
    return statusTag(value.toFixed(1)+'%',tone);
  }
  window.financeUi={dollars,reviewState,costMarkup,orderMarkup,remaining,settlementState,statementMarkup,settlementRows,funnelMarkup,dailyRateMarkup};
})();
`;

// Add keyboard containment and focus return to the existing modal implementation.
export const financialDialogScript = String.raw`
(function(){
  const dialogs=Array.from(document.querySelectorAll('.modal'));
  const origins=new Map();
  let visible=[],previousOverflow='';
  function current(){
    return dialogs.filter(d=>!d.classList.contains('hidden')).sort((a,b)=>Number(getComputedStyle(a).zIndex||0)-Number(getComputedStyle(b).zIndex||0)).at(-1);
  }
  function sync(){
    const now=dialogs.filter(d=>!d.classList.contains('hidden'));
    if(now.length&&!visible.length){previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}
    if(!now.length&&visible.length)document.body.style.overflow=previousOverflow;
    const top=current();
    document.querySelector('.shell').inert=!!top;
    dialogs.forEach(d=>{d.inert=now.includes(d)&&d!==top;});
    const opened=now.filter(d=>!visible.includes(d));
    const closed=visible.filter(d=>!now.includes(d));
    opened.forEach(d=>{
      origins.set(d,document.activeElement);
      if(d===top&&['orderModal','settlementModal'].includes(d.id)){
        const title=d.querySelector('h2');title.tabIndex=-1;title.focus({preventScroll:true});
      }
    });
    if(!opened.length&&closed.length){
      const origin=origins.get(closed.at(-1));
      if(origin?.isConnected&&!origin.closest('[inert]'))origin.focus({preventScroll:true});
    }
    closed.forEach(d=>origins.delete(d));visible=now;
  }
  const observer=new MutationObserver(sync);
  dialogs.forEach(d=>observer.observe(d,{attributes:true,attributeFilter:['class']}));
  document.addEventListener('keydown',event=>{
    const top=current();if(!top)return;
    if(event.key==='Escape'){
      if(top.id==='orderModal'){event.preventDefault();event.stopImmediatePropagation();closeOrderModal();}
      if(top.id==='settlementModal'){event.preventDefault();event.stopImmediatePropagation();closeSettlementModal();}
      return;
    }
    if(event.key!=='Tab')return;
    const focusable=Array.from(top.querySelectorAll('button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"],a[href]')).filter(e=>e.getClientRects().length&&!e.closest('[inert]'));
    const first=focusable[0],last=focusable.at(-1);
    if(!first){event.preventDefault();return;}
    if(event.shiftKey&&(!focusable.includes(document.activeElement)||document.activeElement===first)){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(!focusable.includes(document.activeElement)||document.activeElement===last)){event.preventDefault();first.focus();}
  },true);
  document.querySelectorAll('#settlementEntry .field').forEach((f,i)=>{
    const input=f.querySelector('input,select,textarea'),label=f.querySelector('label');
    if(input&&label){if(!input.id)input.id='settlementField'+i;label.htmlFor=input.id;}
  });
})();
`;
