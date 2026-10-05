export const financeWorkbench = String.raw`
<section class="panel ledger-workbench finance-surface" id="ledgerWorkbench"><div class="panel-head"><div><h2>成本核查</h2><p>正常流水自动确认，只有关联或金额异常才需要人工审核</p></div><div class="actions"><button type="button" class="btn" id="ledgerAutoReview">立即自动核对</button><span class="tag">只出单 · 不自动付款</span></div></div><div class="panel-body">
<p class="notice">当前基准：Plus 15.76U、Pro 5x 92.98U、Pro 20x 143.12U、Pro 50x 465.47U。系统按充值单号、卡片和完成时间唯一关联美元流水；服务费、开卡费与充值手续费在独立费用账另算。</p>
<div id="ledgerAutoSummary" class="notice good hidden" role="status"></div>
<form id="ledgerSearch" class="toolbar"><div class="field search"><label for="ledgerQuery">订单号</label><input id="ledgerQuery" placeholder="我方单号 / 平台单号"></div><div class="field"><label for="ledgerStatus">核查状态</label><select id="ledgerStatus"><option value="">全部</option><option value="missing">等待自动核对</option><option value="review_required">需人工审核</option><option value="draft">异常待确认</option><option value="confirmed">系统已确认</option><option value="disputed">有争议</option><option value="historical">历史已结算</option></select></div><button class="btn primary">查询</button></form>
<div id="ledgerList" class="ledger-space" aria-live="polite"></div><div id="ledgerPager" class="actions"></div>
<section id="ledgerEditor" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="ledgerEditorTitle"><div class="modal-card fin-dialog finance-surface cost-review-dialog"><div class="panel-head modal-head fin-dialog-head"><div><h2 id="ledgerEditorTitle" tabindex="-1">订单成本核查</h2><p>核对单笔订单的实际扣款、费用凭证与平台退差</p></div><button id="ledgerEditorClose" type="button" class="btn small">关闭</button></div><div class="fin-dialog-body"><div id="ledgerFacts" class="ledger-pair"></div>
<div id="ledgerOutcome" class="ledger-space" aria-live="polite"></div>
<form id="ledgerCostForm"><fieldset class="fin-form-section"><legend>1 · 核对扣款与换算</legend><div class="form-grid">
<div class="field"><label for="lcStandard">该套餐标准扣款（USD）</label><input id="lcStandard" name="standard_usd" required inputmode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" placeholder="按订单套餐填写"></div>
<div class="field"><label for="lcActual">实际扣款合计（USD）</label><input id="lcActual" name="actual_usd" required inputmode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?"></div>
<div class="field"><label for="lcRetained">差价预留（USD，不是实际费用）</label><input id="lcRetained" name="retained_usd" value="0.15" required inputmode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?"></div>
<div class="field"><label for="lcFx">实际资金核算汇率（CNY / USD，可留空）</label><input id="lcFx" name="fx_rate" inputmode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" placeholder="按实际购汇 / 充值凭证填写"><small>不默认使用市场牌价或 7.00。汇率已包含的费用，不再重复登记；未核实就留空。</small></div>
</div></fieldset><fieldset class="fin-form-section"><legend>2 · 关联订单与凭证</legend><div class="form-grid">
<div class="field"><label for="lcSource">扣款证据来源</label><select id="lcSource" name="source"><option value="manual">人工核验交易凭证</option><option value="card_api">已查询的卡台交易</option></select></div>
<div class="field"><label for="lcReference">标准价格版本 / 核查依据</label><input id="lcReference" name="standard_reference" required minlength="4" maxlength="500" placeholder="套餐 + 价格版本 / 截图时间"></div>
<div class="field span-2"><label for="lcTransactions">实际扣款交易号（多笔用逗号分隔）</label><input id="lcTransactions" name="transaction_ids" required maxlength="2400" placeholder="不能填写卡号或仅凭扣款金额猜订单"></div>
<div class="field span-2"><label for="lcEvidence">关联依据 / 凭证位置</label><textarea id="lcEvidence" name="evidence" required minlength="4" maxlength="500" rows="2" placeholder="说明如何确认充值订单与扣款交易对应；勿填卡号、密钥或 Session"></textarea></div>
</div></fieldset><label class="ledger-check"><input type="checkbox" name="fees_checked">已核查开卡费、充值手续费，并在费用登记中录入本单承担部分；无费用也已确认</label>
<p class="field-hint">0.15U 是退差预留，不是实际费用。充值本金不重复计成本；开卡费只记一次。不会自动换汇付款，也不代表平台已退客户。</p>
<div class="fin-action-bar"><p id="ledgerDraftHint" class="field-hint" role="status">先保存核查依据，再确认成本。</p><div class="actions"><button class="btn" id="lcSave">保存草稿</button><button type="button" class="btn primary" id="lcConfirm" disabled>确认成本 · 生成退差单</button></div></div></form>
<form id="ledgerDisputeForm" class="hidden"><div class="field"><label for="ledgerDisputeReason">发现问题，登记人工复核原因</label><input id="ledgerDisputeReason" required minlength="4" maxlength="500"></div><button class="btn">登记争议并暂停未完成结算</button></form>
</div></div></section>
<details class="ledger-space"><summary>实际费用登记与扣款查询</summary>
<p id="ledgerFeeSummary" class="field-hint"></p>
<form id="ledgerFeeForm" class="form-grid">
<div class="field"><label for="lfReference">费用唯一凭证号</label><input id="lfReference" name="reference" required minlength="3" maxlength="120"></div>
<div class="field"><label for="lfKind">费用类型</label><select id="lfKind" name="kind"><option value="opening">开卡费（只记一次）</option><option value="topup">充值手续费（不含本金）</option><option value="other">其他真实费用</option></select></div>
<div class="field"><label for="lfAmount">真实费用（USD）</label><input id="lfAmount" name="amount_usd" required inputmode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?"></div>
<div class="field"><label for="lfOrder">承担费用的我方订单号（可留空）</label><input id="lfOrder" name="order_id" maxlength="120" placeholder="不能明确归属时，留在未分摊费用池"></div>
<div class="field span-2"><label for="lfEvidence">费用核查依据</label><input id="lfEvidence" name="evidence" required minlength="4" maxlength="500"></div>
<div class="actions span-2"><button class="btn">登记真实费用</button></div></form>
<form id="ledgerSyncForm" class="toolbar ledger-space"><div class="field"><label for="ledgerSyncPage">卡台交易页码（每页 50 条）</label><input id="ledgerSyncPage" type="number" min="1" max="10000" value="1" required></div><button class="btn">只读查询本页扣款</button></form><p class="field-hint">此处只用于查看原始 USD 清算记录。自动核对会独立执行，不会发起充值、付款或退款。</p><div id="ledgerTransactions" aria-live="polite"></div>
</details></div></section>
`;
export const reviewWorkbench = String.raw`
<section class="panel"><div class="panel-head"><div><h2>人工核查队列</h2><p>仅内部可见。核实原任务，不重新充值，不触发退款。</p></div><button class="btn" id="reviewRefresh">刷新</button></div><div class="panel-body"><div id="reviewList" aria-live="polite"></div><div id="reviewPager" class="actions"></div>
<form id="reviewResolveForm" class="hidden ledger-editor"><h3 id="reviewTitle" tabindex="-1">处理待核查任务</h3><div class="form-grid"><div class="field"><label for="reviewAction">处理方式</label><select id="reviewAction" required><option value="">请选择核查结论</option><option value="resume_query">恢复原任务查询（不重新充值）</option><option value="confirmed_success">已有凭证，确认人工充值完成</option><option value="confirmed_failed">核实失败原因并结束原任务</option></select></div><div id="reviewEmailField" class="field hidden"><label for="reviewEmail">实际充值账号（邮箱）</label><input id="reviewEmail" type="email" maxlength="254" autocomplete="off" placeholder="仅保存打码账号"></div><div id="reviewFailureField" class="field hidden"><label for="reviewFailure">已核实的失败原因</label><select id="reviewFailure"><option value="">请选择准确原因</option><option value="session_invalid">登录信息无效</option><option value="account_has_subscription">现有订阅不支持本商品</option><option value="account_not_eligible">其他开通条件不满足</option><option value="region_unsupported">地区不支持</option><option value="payment_blocked">充值扣款失败</option><option value="verification_timeout">安全验证超时</option><option value="other">其他 / 无法准确分类</option></select><p class="field-hint">系统将查询原任务核对原因；结果未知或仍在处理时，不允许强制失败。不重新充值、不退款。</p></div><div class="field span-2"><label for="reviewReason">核实结论 / 完成凭证</label><textarea id="reviewReason" rows="3" required minlength="4" maxlength="500"></textarea></div></div><label class="ledger-check"><input type="checkbox" id="reviewVerified" required>已核实订单与处理结果，确认不会造成重复履约</label><div class="actions"><button class="btn primary">保存人工核查结果</button></div></form></div></section>
`;
export const ledgerStyles = String.raw`
.ledger-space{margin-top:20px}.cost-review-dialog{width:min(1180px,100%)}
.ledger-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:16px 0}
.ledger-pair>div{border:1px solid var(--line);border-radius:10px;padding:16px;background:var(--bg);overflow-wrap:anywhere}
.ledger-pair span{display:block;color:var(--muted);font-size:12px;margin-bottom:8px}.ledger-pair strong{font-size:18px;font-variant-numeric:tabular-nums}
.settlement-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.external-rebate-lookup{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}
.external-rebate-scope{margin-top:16px}.external-rebate-scope .ledger-pair>div:first-child{border-color:#f1c77b;background:#fff9ed}
.external-rebate-scope .ledger-pair>div:last-child{border-color:#9bd8bd;background:#f2fbf7}
.ledger-check{display:flex;align-items:flex-start;gap:8px;margin:16px 0;line-height:1.6}.ledger-check input{width:18px;height:18px;flex:0 0 18px}
.ledger-workbench summary{cursor:pointer;font-weight:600;padding:12px 0}.ledger-workbench .form-grid{margin-top:16px}
.ledger-workbench button:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
.ledger-breakdown{margin:20px 0;padding:16px;background:var(--bg);border:1px solid var(--line);border-radius:10px}
.ledger-breakdown h4{margin:0 0 8px;font-size:16px}.ledger-breakdown p{margin:8px 0;overflow-wrap:anywhere}
.ledger-breakdown dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin:16px 0}
.ledger-breakdown dt{color:var(--muted)}.ledger-breakdown dd{margin:0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.ledger-breakdown .ledger-profit{border-top:1px solid var(--line);padding-top:16px;display:flex;justify-content:space-between;gap:16px;align-items:center}
.ledger-profit strong{font-size:22px;font-variant-numeric:tabular-nums}.ledger-breakdown .field-hint{font-size:12px}
.ledger-profit .good{color:var(--good)}.ledger-profit .bad{color:var(--bad)}
@media(max-width:700px){.ledger-pair{grid-template-columns:1fr}.ledger-workbench .form-grid{grid-template-columns:1fr}.ledger-workbench .span-2{grid-column:auto}.settlement-head-actions{width:100%;justify-content:stretch}.settlement-head-actions .btn{flex:1}.external-rebate-lookup{grid-template-columns:1fr}}
`;
export const ledgerScript = String.raw`
(function(){
  let costPage=1, reviewPage=1, selectedCost=null, selectedReview=null, selectedStatement=null, costRequest=0, statementRequest=0, costDirty=false;
  // The workbench is rendered inside .shell, but modal focus management marks
  // .shell inert. Hoist the dialog before that manager starts so the dialog
  // itself remains interactive while the workspace is correctly locked.
  const ledgerEditor=$('#ledgerEditor');
  if(ledgerEditor&&ledgerEditor.parentElement!==document.body)document.body.appendChild(ledgerEditor);
  const field=(form,name)=>form.elements.namedItem(name);
  const amount=v=>{ if(!/^\d+(\.\d{1,2})?$/.test(v.trim()))throw new Error('金额最多两位小数');return Number(v).toFixed(2); };
  const send=(url,body,method='POST')=>api(url,{method,body:JSON.stringify(body)});
  async function busy(button,fn){button.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{button.disabled=false;}}
  function table(headers,rows){return '<div class="table-wrap"><table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';}
  function pager(target,page,total,change){
    const el=$(target);el.innerHTML='';const previous=document.createElement('button'),next=document.createElement('button'),label=document.createElement('span');
    previous.type=next.type='button';previous.className=next.className='btn small';previous.textContent='上一页';next.textContent='下一页';
    previous.disabled=page<=1;next.disabled=page*20>=total;label.textContent='第 '+page+' 页 · 共 '+total+' 条';
    previous.onclick=()=>change(page-1);next.onclick=()=>change(page+1);el.append(previous,label,next);
  }
  function pendingCostLabel(row){
    if(row.status==='historical')return '历史已结算';
    if(row.status==='review_required'||row.status==='draft')return '待人工核对';
    return '等待自动核对';
  }
  window.costReconciliationMarkup=window.financeUi.costMarkup;
  window.loadLedger=async function(page){
    if(page)costPage=page;
    try{
      const d=await api('/admin/api/cost-reviews?'+new URLSearchParams({page:costPage,q:$('#ledgerQuery').value,status:$('#ledgerStatus').value}));
      $('#ledgerList').innerHTML=d.items.length?table(['订单 / 套餐','人民币供货价 CNY','实际扣款 USD','成本与费用 USD','应退平台 USD','核查状态','操作'],d.items.map((r,i)=>
        '<tr class="'+(selectedCost?.order_id===r.order_id?'fin-selected':'')+'" data-cost-order="'+esc(r.order_id)+'"><td><strong>'+esc(r.client_order_id)+'</strong><span class="sub">'+esc(r.plan)+' · '+esc(r.order_id)+'</span></td><td class="amount">'+money(r.platform_supply_price)+'<span class="sub">下单时冻结</span></td><td class="amount">'+ (r.actual_usd?window.financeUi.dollars(r.actual_usd):pendingCostLabel(r))+'</td><td class="amount">'+(r.total_cost_usd?window.financeUi.dollars(r.total_cost_usd):pendingCostLabel(r))+'</td><td class="amount">'+(r.rebate_usd?window.financeUi.dollars(r.rebate_usd):'—')+'</td><td><div class="fin-statuses">'+window.financeUi.reviewState(r.status,r.gross_profit_cny!=null,r.rebate_usd)+'</div></td><td><button class="btn small" data-cost-index="'+i+'">'+(r.status==='confirmed'||r.status==='historical'?'查看记录':'人工核查')+'</button></td></tr>')):'<div class="empty">当前条件下没有订单，可调整订单号或核查状态后查询。</div>';
      $('#ledgerList').querySelectorAll('[data-cost-index]').forEach(b=>b.onclick=()=>{
        $('#ledgerList').querySelectorAll('[data-cost-order]').forEach(row=>row.classList.toggle('fin-selected',row===b.closest('tr')));
        window.openLedgerCost(d.items[Number(b.dataset.costIndex)].order_id);
      });
      pager('#ledgerPager',costPage,d.total,p=>loadLedger(p));
      $('#ledgerFeeSummary').textContent='未分摊费用 '+d.unallocated_fees.count+' 笔，'+usd((Number(d.unallocated_fees.cents)/100).toFixed(2))+'；单独列示，不擅自分配至订单。';
    }catch(e){$('#ledgerList').textContent=e.message;}
  };
  window.openLedgerCost=async function(id){
    if(costDirty&&!await confirmAction('当前核查修改尚未保存。放弃修改并重新读取订单？',{title:'未保存的核查内容',confirmText:'放弃修改'}))return;
    const request=++costRequest;
    try{
      const d=await api('/admin/api/cost-reviews/'+encodeURIComponent(id));
      if(request!==costRequest)return;
      selectedCost=d;costDirty=false;
      closeOrderModal();$('#costModal').classList.add('hidden');$('#platformRebateModal').classList.add('hidden');goFinanceTab('cost');
      const form=$('#ledgerCostForm'),r=d.review||{};
      form.reset();
      ['standard_usd','actual_usd','retained_usd','fx_rate','standard_reference','evidence','source'].forEach(k=>{if(r[k]!=null)field(form,k).value=r[k];});
      field(form,'transaction_ids').value=r.transaction_ids?JSON.parse(r.transaction_ids).join(', '):'';
      field(form,'fees_checked').checked=r.fees_checked===1;
      const locked=(r.status&&r.status!=='draft')||d.review_state==='historical';
      [...form.elements].forEach(e=>{e.disabled=!!locked;});
      $('#lcConfirm').disabled=locked||!r.revision;
      $('#ledgerEditorTitle').textContent='成本核查 · '+d.client_order_id;
      $('#ledgerFacts').innerHTML='<div><span>实际订单套餐 / 充值单号</span><strong>'+esc(d.plan)+' / '+esc(d.upstream_order_id||'缺失')+'</strong></div><div><span>原供货报价 · 已登记实际费用（不含预留）</span><strong>'+money(d.supply_cny)+' · '+window.financeUi.dollars(d.fees.reduce((s,f)=>s+Number(f.amount_usd),0).toFixed(2))+'</strong></div>';
      $('#ledgerOutcome').innerHTML=r.revision?window.costReconciliationMarkup(d.reconciliation,r.status):
        d.review_state==='historical'?'<p class="notice good">该订单已进入历史结算，保留原记录，不要求重复登记成本。</p>':
        d.review_state==='review_required'?'<p class="notice">自动核对未通过：'+esc(d.auto_review_reason||'关联或金额需要人工确认')+'。</p>':
        '<p class="notice info">正在等待系统自动关联卡台流水；只有异常订单才需要人工填写。</p>';
      $('#ledgerDraftHint').textContent=d.review_state==='historical'?'历史记录只读，不重复核对。':locked?'核查已锁定，不可直接改写；发现问题请登记争议。':r.revision?'异常草稿已保存，请人工核实；确认只出单，不付款。':'仅在自动核对异常时人工登记。';
      $('#ledgerDisputeForm').classList.toggle('hidden',r.status!=='confirmed');
      $('#ledgerEditor').classList.remove('hidden');$('#ledgerEditorTitle').focus();
    }catch(e){toast(e.message);}
  };
  const oldOpenCost=window.openCost;
  window.openCost=function(id,...args){
    const row=(state.finance?.items||[]).find(r=>r.order_id===id);
    if(row?.order_source==='manual')return oldOpenCost(id,...args);
    return window.openLedgerCost(id);
  };
  window.openPlatformRebateModal=function(){if(state.orderDetail)window.openLedgerCost(state.orderDetail.order.order_id);};
  // Replace the previous onclick reference as well as the global function.
  const rebateButton=$('#openPlatformRebate');
  if(rebateButton)rebateButton.onclick=window.openPlatformRebateModal;
  $('#ledgerSearch').onsubmit=e=>{e.preventDefault();loadLedger(1);};
  $('#ledgerAutoReview').onclick=async function(){
    await busy(this,async()=>{
      const d=await send('/admin/api/cost-reviews/auto-reconcile',{limit:20});
      const summary='自动确认 '+d.confirmed+' 笔，需人工审核 '+d.review_required+' 笔，等待流水 '+d.pending+' 笔';
      $('#ledgerAutoSummary').textContent=summary;$('#ledgerAutoSummary').classList.remove('hidden');
      await loadLedger(1);await loadFinance();toast(summary);
    });
  };
  $('#ledgerCostForm').oninput=()=>{
    costDirty=true;$('#lcConfirm').disabled=true;
    $('#ledgerDraftHint').textContent='修改尚未保存，请先保存草稿，再核对最新试算。';
    $('#ledgerOutcome').innerHTML='<p class="notice">核查内容已修改，原试算已隐藏。保存草稿后查看最新金额。</p>';
  };
  async function closeLedgerEditor(){
    if(costDirty&&!await confirmAction('放弃未保存的核查内容？',{title:'未保存的核查内容',confirmText:'放弃并收起'}))return;
    costDirty=false;costRequest++;$('#ledgerEditor').classList.add('hidden');$('#ledgerQuery').focus();
  }
  $('#ledgerEditorClose').onclick=closeLedgerEditor;
  $('#ledgerEditor').onclick=function(event){if(event.target===this)closeLedgerEditor();};
  document.addEventListener('keydown',function(event){if(event.key==='Escape'&&!$('#ledgerEditor').classList.contains('hidden'))closeLedgerEditor();});
  $('#ledgerCostForm').onsubmit=async function(e){
    e.preventDefault();const f=this;if(!selectedCost)return;
    await busy($('#lcSave'),async()=>{
      const d={revision:selectedCost.review?.revision||0,plan:selectedCost.plan,
        standard_usd:amount(field(f,'standard_usd').value),actual_usd:amount(field(f,'actual_usd').value),
        retained_usd:amount(field(f,'retained_usd').value),fx_rate:field(f,'fx_rate').value.trim()||null,
        standard_reference:field(f,'standard_reference').value,evidence:field(f,'evidence').value,
        source:field(f,'source').value,transaction_ids:field(f,'transaction_ids').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean),
        fees_checked:field(f,'fees_checked').checked};
      await send('/admin/api/cost-reviews/'+encodeURIComponent(selectedCost.order_id),d,'PUT');
      costDirty=false;await openLedgerCost(selectedCost.order_id);await loadLedger();toast('已保存待核查，尚未生成退差');
    });
  };
  $('#lcConfirm').onclick=async function(){
    if(!selectedCost?.review)return;
    if(!await confirmAction('确认套餐、扣款对应关系及费用均已核实？将锁定真实成本，并自动生成美元退差；不会发起付款。',{title:'确认成本与退差',confirmText:'确认入账'}))return;
    await busy(this,async()=>{
      await send('/admin/api/cost-reviews/'+encodeURIComponent(selectedCost.order_id)+'/confirm',{revision:selectedCost.review.revision,verified:true});
      await openLedgerCost(selectedCost.order_id);await loadLedger();await loadFinance();toast('成本已确认，退差等待 22:00 入单');
    });if(selectedCost?.review?.status!=='draft')this.disabled=true;
  };
  $('#ledgerDisputeForm').onsubmit=async function(e){
    e.preventDefault();await busy(this.querySelector('button'),async()=>{
      await send('/admin/api/cost-reviews/'+encodeURIComponent(selectedCost.order_id)+'/dispute',{reason:$('#ledgerDisputeReason').value});
      await openLedgerCost(selectedCost.order_id);await loadLedger();toast('已登记争议，相关未完成结算暂停核销');
    });
  };
  $('#ledgerFeeForm').onsubmit=async function(e){
    e.preventDefault();const f=this;await busy(f.querySelector('button'),async()=>{
      await send('/admin/api/cost-fees',{reference:field(f,'reference').value,kind:field(f,'kind').value,
        amount_usd:amount(field(f,'amount_usd').value),order_id:field(f,'order_id').value.trim()||null,evidence:field(f,'evidence').value});
      toast('费用凭证已登记；未触发任何充值');f.reset();await loadLedger();
      if(selectedCost)await openLedgerCost(selectedCost.order_id);
    });
  };
  $('#ledgerSyncForm').onsubmit=async function(e){
    e.preventDefault();await busy(this.querySelector('button'),async()=>{
      const d=await send('/admin/api/cost-transactions/sync',{page:Number($('#ledgerSyncPage').value)});
      $('#ledgerTransactions').innerHTML=d.items.length?table(['交易号','发生时间','USD 清算金额','状态 / 类型'],d.items.map(t=>'<tr><td>'+esc(t.transaction_id)+'</td><td>'+esc(t.occurred_at)+'</td><td>'+usd(t.amount_usd)+'</td><td>'+esc(t.status)+' / '+esc(t.type)+'</td></tr>')):'<p>本页没有可展示的 USD 记录，不能据此判断订单未扣款。</p>';
    });
  };
  window.loadReviewQueue=async function(page){
    if(page)reviewPage=page;
    try{
      const d=await api('/admin/api/activation-reviews?page='+reviewPage);
      $('#reviewList').innerHTML=d.items.length?table(['订单 / 原任务','阻塞阶段 / 原因','已等待','操作'],d.items.map((r,i)=>'<tr><td><strong>'+esc(r.client_order_id)+'</strong><span class="sub">'+esc(r.task_id)+' / '+esc(r.upstream_order_id||'待核实')+'</span></td><td>'+esc(r.last_stage||'未知')+'<span class="sub">'+esc(r.last_error_code||'结果待核查')+'</span></td><td>'+Math.max(0,Math.floor((Date.now()-Date.parse(r.created_at))/60000))+' 分钟</td><td><button class="btn small" data-review-index="'+i+'">人工核查</button></td></tr>')):'<div class="notice good">当前没有需要人工核查的暂停任务</div>';
      $('#reviewList').querySelectorAll('[data-review-index]').forEach(b=>b.onclick=()=>{
        selectedReview=d.items[Number(b.dataset.reviewIndex)];$('#reviewResolveForm').reset();
        $('#reviewAction').querySelector('[value="resume_query"]').disabled=!selectedReview.can_resume;
        $('#reviewAction').value=selectedReview.can_resume?'resume_query':'';
        $('#reviewAction').onchange();
        $('#reviewTitle').textContent='核查 · '+selectedReview.client_order_id;$('#reviewResolveForm').classList.remove('hidden');$('#reviewTitle').focus();
      });
      pager('#reviewPager',reviewPage,d.total,p=>loadReviewQueue(p));
    }catch(e){$('#reviewList').textContent=e.message;}
  };
  $('#reviewRefresh').onclick=()=>loadReviewQueue();
  $('#reviewAction').onchange=function(){
    const success=this.value==='confirmed_success',failed=this.value==='confirmed_failed';
    const xGift=['x_premium_3m','x_premium_6m'].includes(selectedReview?.plan);
    this.querySelector('[value="confirmed_success"]').textContent=xGift
      ?'查询原单并确认蓝V赠送成功':'已有凭证，确认人工充值完成';
    this.querySelector('[value="confirmed_failed"]').textContent=xGift
      ?'查询原单并确认蓝V赠送失败':'核实失败原因并结束原任务';
    $('#reviewEmailField').classList.toggle('hidden',!success||xGift);
    $('#reviewEmail').required=success&&!xGift;$('#reviewEmail').disabled=xGift;
    if(xGift)$('#reviewEmail').value='';
    $('#reviewReason').placeholder=xGift?'填写核对说明；系统将查询付款时绑定的 X 原单，无需填写邮箱':'填写核实结论或完成凭证';
    $('#reviewResolveForm').querySelector('.actions button').textContent=xGift?'核对蓝V原单':'保存人工核查结果';
    $('#reviewFailure').querySelectorAll('option').forEach(option=>{
      const unavailable=xGift&&!['','account_not_eligible','payment_blocked','other'].includes(option.value);
      option.disabled=unavailable;option.hidden=unavailable;
    });
    $('#reviewFailureField').classList.toggle('hidden',!failed);$('#reviewFailure').required=failed;
  };
  $('#reviewResolveForm').onsubmit=async function(e){
    e.preventDefault();if(!selectedReview)return;
    const xGift=['x_premium_3m','x_premium_6m'].includes(selectedReview.plan);
    if(!await confirmAction(xGift?'系统将核对付款时绑定的蓝V原订单，只有原单明确成功或失败才更新结果。'
      :'请确认已核对原任务与实际结果。此操作不重新充值、不退款。',
      {title:xGift?'核对蓝V原单':'保存人工核查结论',confirmText:xGift?'查询原单':'确认保存'}))return;
    await busy(this.querySelector('button'),async()=>{
      await send('/admin/api/activation-reviews/'+selectedReview.id+'/resolve',{action:$('#reviewAction').value,
        expected_updated_at:selectedReview.updated_at,reason:$('#reviewReason').value,verified:$('#reviewVerified').checked,
        account_email:!xGift&&$('#reviewAction').value==='confirmed_success'?$('#reviewEmail').value.trim():undefined,
        failure_code:$('#reviewAction').value==='confirmed_failed'?$('#reviewFailure').value:undefined});
      $('#reviewResolveForm').classList.add('hidden');await loadReviewQueue();toast(xGift?'蓝V原单核查已记录':'人工结论已保存并写入审计');
    });
  };
  let selectedExternalRebate=null;
  const erf=$('#externalRebatePaymentForm');
  const externalRebateModal=$('#externalRebatePaymentModal');
  function externalRebateStatusLabel(status){return ({pending:'待登记付款',included:'已进入结算单',partial:'结算单部分核销',paid:'已核销'})[status]||status||'未知';}
  function syncExternalPaymentCurrency(){
    const cny=field(erf,'payment_currency').value==='CNY';
    field(erf,'fx_rate').disabled=!cny;field(erf,'fx_rate').required=cny;
    field(erf,'funding_amount').disabled=!cny;
    $('#externalRebateFxField').classList.toggle('hidden',!cny);$('#externalRebateFundingField').classList.toggle('hidden',!cny);
    if(!cny&&field(erf,'applied_usd').value)field(erf,'payment_amount').value=Number(field(erf,'applied_usd').value).toFixed(2);
  }
  function closeExternalRebatePayment(){
    selectedExternalRebate=null;externalRebateModal.classList.add('hidden');
    $('#externalRebatePaymentFacts').classList.add('hidden');$('#externalRebatePaymentEntry').classList.add('hidden');
  }
  window.closeExternalRebatePayment=closeExternalRebatePayment;
  function openExternalRebatePayment(){
    selectedExternalRebate=null;erf.reset();erf.dataset.paymentId=crypto.randomUUID();
    field(erf,'paid_at').value=new Date(Date.now()+8*3600000).toISOString().slice(0,16);syncExternalPaymentCurrency();
    $('#externalRebatePaymentFacts').innerHTML='';$('#externalRebatePaymentFacts').classList.add('hidden');
    $('#externalRebatePaymentEntry').classList.add('hidden');externalRebateModal.classList.remove('hidden');
    $('#externalRebatePaymentTitle').focus();
  }
  field(erf,'payment_currency').onchange=syncExternalPaymentCurrency;
  field(erf,'applied_usd').oninput=function(){if(field(erf,'payment_currency').value==='USD'&&this.value)field(erf,'payment_amount').value=Number(this.value).toFixed(2);};
  $('#openExternalRebatePayment').onclick=openExternalRebatePayment;
  $('#closeExternalRebatePayment').onclick=closeExternalRebatePayment;
  $('#cancelExternalRebatePayment').onclick=closeExternalRebatePayment;
  externalRebateModal.onclick=function(event){if(event.target===this)closeExternalRebatePayment();};
  document.addEventListener('keydown',function(event){if(event.key==='Escape'&&!externalRebateModal.classList.contains('hidden'))closeExternalRebatePayment();});
  $('#previewExternalRebatePayment').onclick=async function(){
    const orderNumber=field(erf,'order_number').value.trim();
    if(!orderNumber)return toast('请输入平台订单号或我方订单号');
    await busy(this,async()=>{
      const data=await api('/admin/api/platform-rebates/'+encodeURIComponent(orderNumber)+'/external-payment-preview');
      selectedExternalRebate=data.preview;
      const p=data.preview,canRegister=p.rebate_status==='pending'&&!p.rebate_settlement_id;
      $('#externalRebatePaymentFacts').innerHTML='<section class="external-rebate-scope"><div class="ledger-pair"><div><span>待退平台美元差价</span><strong>'+usd(p.rebate_usd)+'</strong><small>'+esc(externalRebateStatusLabel(p.rebate_status))+'</small></div><div><span>人民币基础利润（本次不处理）</span><strong>'+money(p.base_cny)+'</strong><small>'+esc(externalRebateStatusLabel(p.base_status))+(p.base_settlement_id?' · '+esc(p.base_settlement_id):' · 后续正常结算')+'</small></div></div><p class="field-hint">订单 '+esc(p.client_order_id)+' · '+esc(p.order_id)+'；两种币种独立核销，不会整单标记为已结算。</p></section>';
      $('#externalRebatePaymentFacts').classList.remove('hidden');
      $('#externalRebatePaymentEntry').classList.toggle('hidden',!canRegister);
      if(canRegister){field(erf,'applied_usd').value=p.rebate_usd;syncExternalPaymentCurrency();}
      else toast(p.rebate_status==='paid'?'该美元退差已经登记，无需重复操作':'该美元退差已进入结算单，请在原结算单内核销');
    });
  };
  erf.onsubmit=async function(event){
    event.preventDefault();if(!selectedExternalRebate)return toast('请先核对订单');
    if(!field(erf,'verified').checked)return toast('请确认已经核对真实付款凭证');
    let appliedUsd,paymentAmount,fundingAmount=null;
    try{appliedUsd=amount(field(erf,'applied_usd').value);paymentAmount=amount(field(erf,'payment_amount').value);
      if(field(erf,'funding_amount').value.trim())fundingAmount=amount(field(erf,'funding_amount').value);}catch(error){return toast(error.message);}
    if(Number(appliedUsd)>Number(selectedExternalRebate.rebate_usd))return toast('本次核销美元不能超过待退差额');
    const paymentCurrency=field(erf,'payment_currency').value,fxRate=paymentCurrency==='CNY'?field(erf,'fx_rate').value.trim():null;
    if(paymentCurrency==='CNY'&&!fxRate)return toast('人民币折算付款必须填写换算汇率');
    const paidAt=new Date(field(erf,'paid_at').value+':00+08:00').toISOString();
    const remaining=(Number(selectedExternalRebate.rebate_usd)-Number(appliedUsd)).toFixed(2);
    if(!await confirmAction('本次按凭证登记 '+paymentAmount+' '+paymentCurrency+'，折算核销 '+appliedUsd+' USD；剩余 '+remaining+' USD，人民币基础利润 '+selectedExternalRebate.base_cny+' CNY 继续等待正常结算。',{title:'确认补差部分核销',confirmText:'登记已退平台'}))return;
    await busy(erf.querySelector('.actions .primary'),async()=>{
      await send('/admin/api/platform-rebates/'+encodeURIComponent(selectedExternalRebate.order_id)+'/external-payment',{
        payment_id:erf.dataset.paymentId,method:field(erf,'method').value,reference:field(erf,'reference').value.trim(),
        note:field(erf,'note').value.trim(),paid_at:paidAt,applied_usd:appliedUsd,payment_currency:paymentCurrency,
        payment_amount:paymentAmount,fx_rate:fxRate,funding_amount:fundingAmount,verified:true});
      closeExternalRebatePayment();
      const jobs=[loadFinance(),loadSettlements()];if(window.loadLedger)jobs.push(window.loadLedger());await Promise.all(jobs);
      toast('本次美元退差已登记；剩余 '+remaining+' USD，人民币基础利润仍待正常结算');
    });
  };
  // Independent per-currency recording replaces the old all-or-nothing form.
  const sf=$('#settlementPaymentForm');
  sf.querySelector('.modal-head p').textContent='按实际付款逐笔登记；人民币和美元分开核销，支持部分结算';
  sf.querySelector('.notice').textContent='只记录已经支付给平台的金额，不代表平台已经退款给客户；不会自动转账或退款。';
  sf.querySelector('.actions .primary').textContent='登记本次已付款';
  function balance(){
    if(!selectedStatement)return;
    const s=selectedStatement.settlement,c=field(sf,'currency').value;
    const remaining=window.financeUi.remaining(s,c);
    field(sf,'amount').value=remaining;
    field(sf,'amount').setAttribute('aria-label','本次实际已付款金额，'+c+'，最多 '+remaining);
  }
  field(sf,'currency').onchange=balance;
  window.openSettlementPayment=async function(id){
    const request=++statementRequest;
    try{
      const statement=await api('/admin/api/platform-settlements/'+encodeURIComponent(id));
      if(request!==statementRequest)return;
      selectedStatement=statement;
      sf.reset();sf.dataset.paymentId=crypto.randomUUID();field(sf,'settlement_id').value=id;
      field(sf,'paid_at').value=new Date(Date.now()+8*3600000).toISOString().slice(0,16);
      const s=selectedStatement.settlement;
      $('#settlementPaymentFacts').innerHTML=window.financeUi.statementMarkup(selectedStatement);
      const cnyOpen=Number(window.financeUi.remaining(s,'CNY'))>0,usdOpen=Number(window.financeUi.remaining(s,'USD'))>0;
      field(sf,'currency').querySelector('[value="CNY"]').disabled=!cnyOpen;
      field(sf,'currency').querySelector('[value="USD"]').disabled=!usdOpen;
      field(sf,'currency').value=cnyOpen?'CNY':'USD';
      $('#settlementEntry').classList.toggle('hidden',!cnyOpen&&!usdOpen);
      sf.querySelector('.actions .primary').disabled=!cnyOpen&&!usdOpen;
      balance();$('#settlementModal').classList.remove('hidden');
    }catch(e){toast(e.message);}
  };
  sf.onsubmit=async function(e){
    e.preventDefault();if(!selectedStatement)return;
    if(Number(field(sf,'amount').value)<=0||Number(field(sf,'amount').value)>Number(window.financeUi.remaining(selectedStatement.settlement,field(sf,'currency').value)))return toast('登记金额须大于 0 且不超过本币种待付金额');
    if(!await confirmAction('仅登记已实际付给平台的 '+field(sf,'amount').value+' '+field(sf,'currency').value+'；未付部分继续保留。',{title:'确认登记已付款',confirmText:'登记已付款'}))return;
    await busy(sf.querySelector('.actions .primary'),async()=>{
      await send('/admin/api/platform-settlements/'+encodeURIComponent(field(sf,'settlement_id').value)+'/payment',{
        payment_id:sf.dataset.paymentId,currency:field(sf,'currency').value,amount:amount(field(sf,'amount').value),
        method:field(sf,'method').value,reference:field(sf,'reference').value.trim(),note:field(sf,'note').value.trim(),
        paid_at:new Date(field(sf,'paid_at').value+':00+08:00').toISOString()});
      closeSettlementModal();await loadFinance();toast('本次付款已记录，其他币种及未付金额保持待结算');
    });
  };
})();
`;
