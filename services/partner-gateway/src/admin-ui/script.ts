export const adminScript = String.raw`
const $ = function(selector) { return document.querySelector(selector); };
const $$ = function(selector) { return Array.from(document.querySelectorAll(selector)); };
const state = { config: null, products: [], finance: null, financePage: 1, financeTab: 'cost', settlements: [], settlementSummary: null, settlementPagination: null, settlementPage: 1, activeSettlement: null, dailyMetrics: [], operations: null, customers: [], customerPagination: null, customerPage: 1, customerDetail: null, orders: [], ordersPagination: null, orderPage: 1, fulfillment: [], fulfillmentPagination: null, fulfillmentSummary: null, fulfillmentPage: 1, invoices: [], invoicePagination: null, invoicePage: 1, invoiceOrder: null, orderDetail: null, testOrder: null, testTimer: null, autoRefreshTimer: null, financeLoaded: false, alertKeys: new Set(), selectedRows: {} };
let activeRequests = 0;
let lastActionButton = null;
let lastActionAt = 0;

document.addEventListener('click', function(event) {
  const selectedRow = event.target.closest && event.target.closest('tr[data-selection-group]');
  if (selectedRow) {
    const group = selectedRow.dataset.selectionGroup;
    const key = selectedRow.dataset.selectionKey;
    state.selectedRows[group] = key;
    document.querySelectorAll('tr[data-selection-group="' + group + '"]').forEach(function(row) {
      row.classList.toggle('selected-row', row.dataset.selectionKey === key);
      row.setAttribute('aria-selected', row.dataset.selectionKey === key ? 'true' : 'false');
    });
  }
  const button = event.target.closest && event.target.closest('button');
  if (!button || button.disabled) return;
  lastActionButton = button;
  lastActionAt = Date.now();
  button.classList.add('pressed');
  setTimeout(function() { button.classList.remove('pressed'); }, 160);
}, true);

function beginRequest() {
  activeRequests += 1;
  const progress = $('#requestProgress');
  if (progress) progress.classList.add('active');
  const button = lastActionButton && Date.now() - lastActionAt < 500 ? lastActionButton : null;
  if (button) {
    button._pendingCount = Number(button._pendingCount || 0) + 1;
    button.classList.add('request-pending');
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
  }
  return button;
}
function endRequest(button) {
  activeRequests = Math.max(0, activeRequests - 1);
  const progress = $('#requestProgress');
  if (progress && !activeRequests) progress.classList.remove('active');
  if (!button) return;
  button._pendingCount = Math.max(0, Number(button._pendingCount || 1) - 1);
  if (!button._pendingCount) {
    button.classList.remove('request-pending');
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}
function money(value) { return '¥' + Number(value || 0).toFixed(2); }
function usd(value) { return Number(value || 0).toFixed(2) + 'U'; }
function number(value) { return Number(value || 0).toLocaleString('zh-CN'); }
function beijingTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date).reduce(function(result, item) { result[item.type] = item.value; return result; }, {});
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second;
}
function toast(message) {
  const node = $('#toast');
  const isError = /失败|错误|异常|无效|拒绝|过期|至少|请先|请输入|请填写|不能|没有|不存在|未找到|失效/.test(String(message));
  node.classList.toggle('error', isError);
  $('#toastIcon').textContent = isError ? '!' : '✓';
  $('#toastTitle').textContent = isError ? '操作未完成' : '操作成功';
  $('#toastMessage').textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function() { node.classList.add('hidden'); }, isError ? 4200 : 3200);
}
let confirmResolver = null;
let confirmOriginButton = null;
function resolveConfirm(value) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  $('#confirmModal').classList.add('hidden');
  lastActionButton = confirmOriginButton;
  lastActionAt = Date.now();
  confirmOriginButton = null;
  resolve(Boolean(value));
}
function confirmAction(message, options) {
  if (confirmResolver) resolveConfirm(false);
  const settings = options || {};
  const danger = Boolean(settings.danger);
  confirmOriginButton = lastActionButton && Date.now() - lastActionAt < 1000 ? lastActionButton : null;
  $('#confirmTitle').textContent = settings.title || '请确认操作';
  $('#confirmMessage').textContent = String(message || '确认继续执行当前操作？');
  $('#confirmIcon').textContent = danger ? '!' : '?';
  $('#confirmApprove').textContent = settings.confirmText || '确认';
  $('#confirmApprove').className = 'btn ' + (danger ? 'danger' : 'primary');
  $('.confirm-card').classList.toggle('danger', danger);
  $('#confirmModal').classList.remove('hidden');
  setTimeout(function() { $('#confirmApprove').focus(); }, 0);
  return new Promise(function(resolve) { confirmResolver = resolve; });
}
$('#confirmCancel').onclick = function() { resolveConfirm(false); };
$('#confirmApprove').onclick = function() { resolveConfirm(true); };
$('#confirmModal').onclick = function(event) { if (event.target === this) resolveConfirm(false); };
document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape' && confirmResolver) resolveConfirm(false);
});
async function api(url, options) {
  const config = options || {};
  const background = Boolean(config.background);
  delete config.background;
  config.headers = Object.assign({ 'Content-Type': 'application/json' }, config.headers || {});
  const actionButton = background ? null : beginRequest();
  try {
    const response = await fetch(url, config);
    if (response.status === 401) {
      $('#login').classList.remove('hidden');
      throw new Error('登录已失效，请重新登录');
    }
    const data = await response.json().catch(function() { return {}; });
    if (!response.ok) throw new Error(data.detail_zh || data.error || '请求失败');
    return data;
  } finally {
    if (!background) endRequest(actionButton);
  }
}

const routeMeta = {
  dashboard: ['经营工作台', '关注收入、履约、异常与今日待办'],
  customers: ['客户管理', '按脱敏账号汇总交易、履约和异常记录'],
  orders: ['订单中心', '统一查询平台订单、支付状态与交易金额'],
  fulfillment: ['履约中心', '跟踪充值任务、失败订单与人工处理事项'],
  products: ['商品中心', '维护成本、平台供货价和可售状态'],
  finance: ['财务对账', '核对实收、平台差价、上游成本和我方毛利'],
  invoices: ['发票管理', '按订单核验扣除补差后的开票金额，生成并跟踪开票单'],
  risk: ['风控中心', '集中处理退款、履约和超时异常'],
  integrations: ['渠道配置', '管理支付宝、上游连接和回调地址'],
  sandbox: ['联调沙箱', '隔离执行真实支付和充值链路验证']
};
const financeTabMeta = {
  cost: '按订单关联真实扣款；正常流水自动通过，只有异常需要人工复核',
  details: '按查询区间查看订单收支、平台利润与我方成本口径',
  settlements: '查看所有未结算款项、历史付款记录与原始凭证'
};
try {
  const storedFinanceTab = sessionStorage.getItem('merchant-finance-tab');
  if (financeTabMeta[storedFinanceTab]) state.financeTab = storedFinanceTab;
} catch (error) {}
function setFinanceTab(id, options) {
  if (!financeTabMeta[id]) id = 'cost';
  const settings = options || {};
  state.financeTab = id;
  $$('[data-finance-pane]').forEach(function(pane) { pane.classList.toggle('on', pane.dataset.financePane === id); });
  $$('[data-finance-tab]').forEach(function(button) {
    const selected = button.dataset.financeTab === id;
    button.classList.toggle('on', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  });
  try { sessionStorage.setItem('merchant-finance-tab', id); } catch (error) {}
  if ($('#finance') && $('#finance').classList.contains('on')) $('#pageSubtitle').textContent = financeTabMeta[id];
  if (!settings.skipLoad && state.config && id === 'cost' && window.loadLedger) window.loadLedger();
  if (!settings.skipLoad && state.config && id === 'settlements') loadSettlements(false).catch(function(error) { toast(error.message); });
}
function goFinanceTab(id) {
  state.financeTab = financeTabMeta[id] ? id : 'cost';
  go('finance');
  const selected = $('[data-finance-tab="' + state.financeTab + '"]');
  if (selected) selected.focus({ preventScroll: true });
  const finance = $('#finance');
  if (finance) finance.scrollIntoView({ block: 'start' });
}
window.goFinanceTab = goFinanceTab;
function savedView() {
  const hashView = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (routeMeta[hashView]) return hashView;
  try {
    const storedView = sessionStorage.getItem('merchant-admin-view');
    if (routeMeta[storedView]) return storedView;
  } catch (error) {}
  return 'dashboard';
}
function go(id, options) {
  if (!routeMeta[id]) id = 'dashboard';
  const settings = options || {};
  $$('.view').forEach(function(view) { view.classList.toggle('on', view.id === id); });
  $$('.nav button').forEach(function(button) { button.classList.toggle('on', button.dataset.view === id); });
  $('#pageTitle').textContent = routeMeta[id][0];
  $('#pageSubtitle').textContent = routeMeta[id][1];
  $('#crumbCurrent').textContent = routeMeta[id][0];
  try { sessionStorage.setItem('merchant-admin-view', id); } catch (error) {}
  if (settings.updateHash !== false && location.hash !== '#' + id) {
    history.replaceState(null, '', location.pathname + location.search + '#' + id);
  }
  if (id === 'customers') renderCustomers();
  if (id === 'orders') renderOrders();
  if (id === 'fulfillment') renderFulfillment();
  if (id === 'finance') { setFinanceTab(state.financeTab, { skipLoad: true }); renderFinance(); }
  if (state.config && id === 'customers') loadCustomers(undefined, true).catch(function() {});
  if (state.config && id === 'orders') loadOrders(undefined, true).catch(function() {});
  if (state.config && id === 'fulfillment') loadFulfillment(undefined, true).catch(function() {});
  if (state.config && id === 'invoices') loadInvoices(true).catch(function() {});
  if (state.config && id === 'risk') loadOperations(true).catch(function() {});
  if (state.config && id === 'sandbox') loadTestOrders().catch(function() {});
  if (state.config && id === 'finance' && state.financeTab === 'cost' && window.loadLedger) window.loadLedger();
  if (state.config && id === 'finance' && state.financeTab === 'settlements') loadSettlements(true).catch(function() {});
  if (state.config && id === 'fulfillment' && window.loadReviewQueue) window.loadReviewQueue();
}
window.go = go;
$$('.nav button').forEach(function(button) { button.onclick = function() { go(button.dataset.view); }; });
$$('[data-finance-tab]').forEach(function(button) {
  button.onclick = function() { setFinanceTab(button.dataset.financeTab); };
  button.onkeydown = function(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$('[data-finance-tab]');
    const current = tabs.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setFinanceTab(tabs[next].dataset.financeTab);
    tabs[next].focus();
  };
});
window.addEventListener('hashchange', function() { go(savedView(), { updateHash: false }); });
go(savedView());

function statusTag(label, tone) {
  return '<span class="tag ' + (tone || '') + '"><span class="status-dot"></span>' + esc(label) + '</span>';
}
function paymentTone(status) {
  return status === 'paid' ? 'good' : status === 'pending' ? 'warn' : status === 'refunded' ? 'bad' : '';
}
function deliveryTone(status) {
  return status === 'success' || status === '履约成功'
    ? 'good'
    : status === 'failed' || status === '履约失败'
      ? 'bad'
      : status === 'closed' || status === '已关闭'
        ? ''
        : 'warn';
}
function selectionAttrs(group, key, extraClass) {
  const selected = state.selectedRows[group] === String(key);
  return ' class="selectable-row ' + (extraClass || '') + (selected ? ' selected-row' : '') + '" data-selection-group="' + esc(group) + '" data-selection-key="' + esc(key) + '" aria-selected="' + (selected ? 'true' : 'false') + '"';
}
function renderPagination(targetId, pagination, changeFunctionName) {
  const target = $('#' + targetId);
  if (!target) return;
  const info = pagination || { total: 0, page: 1, page_size: 20, pages: 1 };
  const page = Number(info.page || 1);
  const pages = Math.max(1, Number(info.pages || 1));
  const total = Number(info.total || 0);
  const from = total ? (page - 1) * Number(info.page_size || 20) + 1 : 0;
  const to = Math.min(total, page * Number(info.page_size || 20));
  target.innerHTML = '<span class="pagination-summary">共 ' + number(total) + ' 条 · 当前 ' + number(from) + '–' + number(to) + ' 条</span><div class="pagination-actions">' +
    '<button class="btn small" ' + (page <= 1 ? 'disabled' : '') + ' onclick="' + changeFunctionName + '(1)">首页</button>' +
    '<button class="btn small" ' + (page <= 1 ? 'disabled' : '') + ' onclick="' + changeFunctionName + '(' + (page - 1) + ')">上一页</button>' +
    '<span class="page-current">第 ' + number(page) + ' / ' + number(pages) + ' 页</span>' +
    '<button class="btn small" ' + (page >= pages ? 'disabled' : '') + ' onclick="' + changeFunctionName + '(' + (page + 1) + ')">下一页</button>' +
    '<button class="btn small" ' + (page >= pages ? 'disabled' : '') + ' onclick="' + changeFunctionName + '(' + pages + ')">末页</button></div>';
}

const uiLabels = {
  payment: { pending: '待支付', paid: '已支付', expired: '已过期', refunded: '已退款', closed: '已关闭' },
  delivery: { pending: '待履约', success: '履约成功', failed: '履约失败', closed: '已关闭' },
  refund: { requested: '待人工审核', processing: '退款处理中', succeeded: '退款成功', failed: '退款失败', rejected: '审核已驳回' },
  activation: { submitting: '提交中', queued: '等待处理', running: '充值处理中', success: '充值成功', failed: '充值失败' },
  failure: {
    session_invalid: 'Session 无效',
    account_has_subscription: '现有订阅不支持此商品',
    account_not_eligible: '账号不满足商品开通条件',
    region_unsupported: '账号地区不支持',
    payment_blocked: '支付被风控拦截',
    verification_timeout: '安全验证超时',
    other: '其他原因'
  },
  auditAction: {
    refund_requested: '发起支付宝退款',
    refund_approved: '审核通过退款',
    refund_rejected: '驳回退款申请',
    refund_succeeded: '支付宝退款成功',
    mark_delivery_failed: '标记履约异常',
    restore_delivery_pending: '恢复待履约',
    manual_delivery_confirmed: '人工确认已完成充值（不退款）',
    close_test_order: '关闭内部测试单（不退款）',
    manual_order_created: '人工补录订单',
    manual_cash_order_created: '现金收款并补录订单',
    customer_price_refund_recorded: '登记客户补差退款',
    platform_rebate_recorded: '登记平台美元差价'
  },
  webhook: { 'order.paid': '订单已支付', 'order.activated': '订单已开通', 'order.refunded': '订单已退款' }
};
function translated(group, value, emptyLabel) {
  if (value == null || value === '') return emptyLabel || '-';
  return (uiLabels[group] && uiLabels[group][value]) || String(value);
}
function auditStatusLabel(value) {
  if (!value) return '-';
  const parts = String(value).split(':');
  if (parts.length !== 2) return translated('payment', value, value);
  if (parts[0] === 'price_refund') return '补差退款：' + money(parts[1]);
  if (parts[0] === 'platform_rebate') return '平台差价：' + esc(parts[1]);
  const prefix = { payment: '支付', delivery: '履约', refund: '退款' }[parts[0]] || parts[0];
  const group = parts[0] === 'payment' ? 'payment' : parts[0] === 'delivery' ? 'delivery' : 'refund';
  return prefix + '：' + translated(group, parts[1], parts[1]);
}
function activationReasonHtml(item) {
  const status = item.status || item.latest_activation_status || '';
  const code = item.failure_code || item.latest_failure_code || '';
  const message = item.message_zh || item.latest_activation_message || '';
  if (status === 'failed' || code) {
    const title = code ? translated('failure', code, '履约失败') : '履约失败';
    return '<div class="activation-reason"><strong>' + esc(title) + '</strong><span>' + esc(message || '请查看订单审计记录') + '</span>' + (code ? '<code>' + esc(code) + '</code>' : '') + '</div>';
  }
  return '<span class="activation-message">' + esc(message || (status === 'success' ? '开通成功' : '等待上游处理')) + '</span>';
}

async function loadConfig() {
  const data = await api('/admin/api/config');
  state.config = data;
  const form = $('#configForm');
  form.payment_mode.value = data.payment_mode;
  form.zovo_mode.value = data.zovo_mode;
  $('#notifyUrl').value = data.alipay_notify_url;
  $('#alipayMask').textContent = (data.alipay_app_id_masked || '未配置') + ' · PID ' + (data.alipay_seller_id_masked || '未配置');
  $('#zovoMask').textContent = (data.zovo_app_id_masked || '未配置') + ' · Key ' + (data.zovo_api_key_masked || '未配置');
  setReadiness('#paymentPill', data.payment_mode === 'alipay' && data.alipay_ready, '支付宝');
  setReadiness('#upstreamPill', data.zovo_mode === 'live' && data.zovo_ready, '上游');
  const systemReady = Boolean(data.ready_for_sales);
  $('#systemState').textContent = systemReady ? '系统可交易' : '配置待完善';
  $('#systemState').className = 'tag ' + (systemReady ? 'good' : 'warn');
}
function setReadiness(selector, ready, label) {
  const element = $(selector);
  element.className = 'system-pill ' + (ready ? 'good' : 'warn');
  element.innerHTML = '<span class="status-dot"></span>' + label + '：' + (ready ? '正常' : '待检查');
}

async function loadProducts() {
  const data = await api('/admin/api/products');
  state.products = data.items || [];
  renderProducts();
  renderTestProducts();
  renderManualProducts();
}
async function loadCustomers(page, background) {
  if (Number(page) > 0) state.customerPage = Number(page);
  const query = new URLSearchParams({
    q: ($('#customerSearch') && $('#customerSearch').value || '').trim(),
    page: String(state.customerPage || 1),
    page_size: String($('#customerPageSize') ? $('#customerPageSize').value : 20)
  });
  const data = await api('/admin/api/customers?' + query.toString(), { background: Boolean(background) });
  state.customers = data.items || [];
  state.customerPagination = data.pagination || null;
  renderCustomers();
}
function renderCustomers() {
  const target = $('#customerTable');
  if (!target) return;
  const rows = state.customers || [];
  if (!rows.length) { target.innerHTML = '<div class="empty">暂无符合条件的客户记录</div>'; renderPagination('customerPagination', state.customerPagination, 'changeCustomerPage'); return; }
  target.innerHTML = '<div class="table-wrap"><table><thead><tr><th>客户</th><th>订单数</th><th>累计实收</th><th>履约成功</th><th>履约失败</th><th>最近交易</th><th></th></tr></thead><tbody>' + rows.map(function(row) {
    return '<tr' + selectionAttrs('customers', row.customer_id, 'interactive-row') + ' tabindex="0" role="button" onclick="viewCustomer(\'' + esc(row.customer_id) + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();viewCustomer(\'' + esc(row.customer_id) + '\')}"><td><strong>' + esc(row.email_masked || '***') + '</strong><span class="sub">客户标识 ' + esc(String(row.customer_id || '').slice(0, 12)) + '…</span></td><td>' + number(row.order_count) + '</td><td class="amount">' + money(row.paid_amount) + '</td><td>' + statusTag(number(row.fulfilled_count), 'good') + '</td><td>' + statusTag(number(row.failed_count), Number(row.failed_count) ? 'bad' : '') + '</td><td>' + beijingTime(row.last_order_at) + '</td><td><span class="row-action"><span>详情</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg></span></td></tr>';
  }).join('') + '</tbody></table></div>';
  renderPagination('customerPagination', state.customerPagination, 'changeCustomerPage');
}
function changeCustomerPage(page) { loadCustomers(page).catch(function(error) { toast(error.message); }); }
window.changeCustomerPage = changeCustomerPage;
async function viewCustomer(customerId) {
  try {
    state.selectedRows.customers = String(customerId);
    const data = await api('/admin/api/customers/' + encodeURIComponent(customerId));
    state.customerDetail = data;
    const customer = data.customer;
    $('#customerModalTitle').textContent = '客户详情 · ' + (customer.email_masked || '***');
    $('#customerIdentity').innerHTML = '<span>客户标识</span><strong>' + esc(String(customer.customer_id || '').slice(0, 18)) + '…</strong><span>首次下单</span><strong>' + beijingTime(customer.first_order_at) + '</strong><span>最近交易</span><strong>' + beijingTime(customer.last_order_at) + '</strong>';
    $('#customerMetrics').innerHTML =
      '<div class="metric"><span>关联订单</span><strong>' + number(customer.order_count) + '</strong></div>' +
      '<div class="metric"><span>累计实收</span><strong>' + money(customer.paid_amount) + '</strong></div>' +
      '<div class="metric"><span>履约成功</span><strong class="metric-good">' + number(customer.fulfilled_count) + '</strong></div>' +
      '<div class="metric"><span>履约异常</span><strong class="metric-bad">' + number(customer.failed_count) + '</strong></div>';
    const orders = data.orders || [];
    $('#customerOrders').innerHTML = orders.length ? '<div class="table-wrap"><table><thead><tr><th>订单</th><th>商品</th><th>支付状态</th><th>履约状态</th><th>实收</th><th>下单时间</th><th></th></tr></thead><tbody>' + orders.map(function(row) {
      return '<tr' + selectionAttrs('orders', row.order_id, 'interactive-row') + ' tabindex="0" role="button" onclick="viewOrderFromCustomer(\'' + esc(row.order_id) + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();viewOrderFromCustomer(\'' + esc(row.order_id) + '\')}"><td><strong>' + esc(row.client_order_id) + '</strong><span class="sub">' + esc(row.order_id) + '</span></td><td>' + esc(row.product) + '</td><td>' + statusTag(translated('payment', row.status), paymentTone(row.status)) + '</td><td>' + statusTag(translated('delivery', row.delivery_status || 'pending'), deliveryTone(row.delivery_status)) + '</td><td class="amount">' + money(row.alipay_receipt_amount || (row.status === 'paid' ? row.amount : 0)) + '</td><td>' + beijingTime(row.created_at) + '</td><td><span class="row-action"><span>详情</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg></span></td></tr>';
    }).join('') + '</tbody></table></div>' : '<div class="empty">暂无关联订单</div>';
    $('#customerModal').classList.remove('hidden');
  } catch (error) { toast(error.message); }
}
function closeCustomerModal() { $('#customerModal').classList.add('hidden'); }
function viewOrderFromCustomer(orderId) { closeCustomerModal(); viewOrder(orderId); }
window.viewCustomer = viewCustomer;
window.closeCustomerModal = closeCustomerModal;
window.viewOrderFromCustomer = viewOrderFromCustomer;

async function loadInvoices(background, page) {
  if (Number(page) > 0) state.invoicePage = Number(page);
  const dates = dateRangeFromFields('invoiceFrom', 'invoiceTo');
  const query = new URLSearchParams({
    q: ($('#invoiceSearch') && $('#invoiceSearch').value || '').trim(),
    status: $('#invoiceStatus') ? $('#invoiceStatus').value : '',
    from: dates.from,
    to: dates.to,
    page: String(state.invoicePage || 1),
    page_size: String($('#invoicePageSize') ? $('#invoicePageSize').value : 20)
  });
  const data = await api('/admin/api/invoices?' + query.toString(), { background: Boolean(background) });
  state.invoices = data.items || [];
  state.invoicePagination = data.pagination || null;
  renderInvoices();
}
function maskEmail(value) {
  const text = String(value || '');
  const parts = text.split('@');
  if (parts.length !== 2) return text || '-';
  return (parts[0].slice(0, 1) || '*') + '***@' + parts[1];
}
function renderInvoices() {
  const target = $('#invoiceTable');
  if (!target) return;
  const rows = state.invoices || [];
  if (!rows.length) { target.innerHTML = '<div class="empty compact">暂无符合条件的开票单</div>'; renderPagination('invoicePagination', state.invoicePagination, 'changeInvoicePage'); return; }
  target.innerHTML = '<div class="table-wrap"><table><thead><tr><th>开票单</th><th>关联订单</th><th>抬头</th><th>开票金额</th><th>状态</th><th>接收邮箱</th><th>申请时间</th><th>开票结果</th><th>操作</th></tr></thead><tbody>' + rows.map(function(item) {
    const issued = item.status === 'issued';
    const result = issued ? '<strong>' + esc(item.invoice_number || '-') + '</strong><span class="sub">' + esc(item.invoice_date || '-') + (item.invoice_url ? ' · <a href="' + esc(item.invoice_url) + '" target="_blank" rel="noopener">查看电子发票</a>' : '') + '</span>' : '-';
    return '<tr' + selectionAttrs('invoices', item.invoice_id, '') + '><td><strong>' + esc(item.invoice_id) + '</strong></td><td><strong>' + esc(item.client_order_id) + '</strong><span class="sub">' + esc(item.order_id) + '</span></td><td>' + esc(item.title) + '<span class="sub">' + (item.title_type === 'company' ? '企业' : '个人') + (item.tax_id ? ' · ' + esc(item.tax_id) : '') + '</span></td><td class="amount">' + money(item.amount) + '</td><td>' + statusTag(issued ? '已开票' : '待开票', issued ? 'good' : 'warn') + '</td><td>' + esc(maskEmail(item.recipient_email)) + '</td><td>' + beijingTime(item.created_at) + '</td><td>' + result + '</td><td>' + (issued ? '<span class="sub">已完成</span>' : '<button class="btn small primary" onclick="openInvoiceIssue(\'' + esc(item.invoice_id) + '\')">登记开票</button>') + '</td></tr>';
  }).join('') + '</tbody></table></div>';
  renderPagination('invoicePagination', state.invoicePagination, 'changeInvoicePage');
}
function changeInvoicePage(page) { loadInvoices(false, page).catch(function(error) { toast(error.message); }); }
window.changeInvoicePage = changeInvoicePage;
async function lookupInvoiceOrder() {
  const orderNumber = $('#invoiceOrderNumber').value.trim();
  if (!orderNumber) return toast('请输入平台订单号或我方订单号');
  try {
    const data = await api('/admin/api/invoices/order-lookup?order_number=' + encodeURIComponent(orderNumber));
    state.invoiceOrder = data.order;
    const order = data.order;
    $('#invoiceLookupResult').classList.remove('hidden');
    $('#invoiceLookupResult').innerHTML = '<div class="invoice-order-head"><div><span>平台 / 人工订单</span><strong>' + esc(order.client_order_id) + '</strong></div><div><span>我方订单</span><strong>' + esc(order.order_id) + '</strong></div><div><span>支付状态</span><strong>' + esc(translated('payment', order.status)) + '</strong></div><div><span>可开票金额</span><strong>' + money(order.receipt_amount) + '</strong></div></div>' + (data.eligible ? '<div class="notice good">订单已付款且未全额退款，可以生成开票单。</div>' : '<div class="notice warn">' + esc(data.reason || '当前订单不能开票') + '</div>');
    $('#invoiceRequestPanel').classList.toggle('hidden', !data.eligible);
    if (data.eligible) {
      const form = $('#invoiceRequestForm');
      form.order_number.value = order.order_id;
      $('#invoiceAmountTag').textContent = money(order.receipt_amount);
      form.title.focus();
    }
  } catch (error) {
    state.invoiceOrder = null;
    $('#invoiceLookupResult').classList.add('hidden');
    $('#invoiceRequestPanel').classList.add('hidden');
    toast(error.message);
  }
}
function resetInvoiceLookup() {
  state.invoiceOrder = null;
  $('#invoiceOrderNumber').value = '';
  $('#invoiceLookupResult').classList.add('hidden');
  $('#invoiceRequestPanel').classList.add('hidden');
  const form = $('#invoiceRequestForm');
  form.reset();
  form.tax_id.required = false;
  form.tax_id.placeholder = '个人抬头可不填';
  $$('.company-invoice-field').forEach(function(field) { field.classList.add('hidden'); });
}
function openInvoiceIssue(id) {
  const item = (state.invoices || []).find(function(invoice) { return invoice.invoice_id === id; });
  if (!item) return toast('没有找到开票单，请刷新后重试');
  const form = $('#invoiceIssueForm');
  form.invoice_id.value = id;
  form.invoice_number.value = '';
  form.invoice_date.value = beijingDateString(0);
  form.invoice_url.value = '';
  form.issue_note.value = '';
  $('#invoiceIssueFacts').innerHTML =
    '<div class="invoice-facts-primary"><div class="invoice-identity"><span>名称</span><strong>' + esc(item.title) + '</strong><small>税号&nbsp;&nbsp;' + esc(item.tax_id || '—') + '</small></div><div class="invoice-total"><span>开票金额</span><strong>' + money(item.amount) + '</strong></div></div>' +
    '<div class="invoice-facts-secondary"><div class="wide"><span>单位地址</span><strong>' + esc(item.unit_address || '—') + '</strong></div><div><span>电话</span><strong>' + esc(item.phone || '—') + '</strong></div><div><span>开户银行</span><strong>' + esc(item.bank_name || '—') + '</strong></div><div class="wide"><span>银行账户</span><strong>' + esc(item.bank_account || '—') + '</strong></div></div>' +
    '<div class="invoice-facts-meta"><span>开票单号</span><strong>' + esc(id) + '</strong></div>';
  $('#invoiceIssueModal').classList.remove('hidden');
}
function closeInvoiceIssueModal() { $('#invoiceIssueModal').classList.add('hidden'); }
window.resetInvoiceLookup = resetInvoiceLookup;
window.openInvoiceIssue = openInvoiceIssue;
window.closeInvoiceIssueModal = closeInvoiceIssueModal;
function renderProducts() {
  const target = $('#productTable');
  if (!state.products.length) {
    target.innerHTML = '<div class="empty">暂无商品</div>';
    return;
  }
  let html = '<div class="table-wrap"><table class="product-table"><thead><tr><th>商品</th><th>默认成本价</th><th>平台供货价</th><th>预计毛利</th><th>状态</th><th>操作</th></tr></thead><tbody>';
  html += state.products.map(function(product) {
    const margin = Number(product.cost_price) - Number(product.internal_cost_cny);
    const xGift = product.plan === 'x_premium_3m' || product.plan === 'x_premium_6m';
    const costPending = xGift && Number(product.internal_cost_cny || 0) === 0;
    return '<tr data-product="' + esc(product.product) + '">' +
      '<td><strong>' + esc(product.name_zh) + '</strong><span class="sub">' + esc(product.product) + ' · ' + esc(product.plan) + '</span>' + (xGift ? '<span class="sub">填写 X 用户名 · 付款后自动赠送</span>' : '') + '</td>' +
      '<td><input data-field="internal" type="number" min="0" step="0.01" value="' + esc(product.internal_cost_cny || '0.00') + '"></td>' +
      '<td><input data-field="supply" type="number" min="0" step="0.01" value="' + esc(product.cost_price) + '"></td>' +
      '<td>' + (costPending ? '<span class="sub">实际成本待核实</span>' : '<span class="amount ' + (margin < 0 ? 'bad' : 'good') + '">' + money(margin) + '</span>') + '</td>' +
      '<td><label class="switch"><input data-field="enabled" type="checkbox" ' + (product.enabled ? 'checked' : '') + '><span></span></label></td>' +
      '<td><button class="btn small primary" onclick="saveProduct(\'' + esc(product.product) + '\')">保存</button></td></tr>';
  }).join('');
  target.innerHTML = html + '</tbody></table></div>';
}
async function saveProduct(productCode) {
  const row = document.querySelector('tr[data-product="' + productCode + '"]');
  const internal = Number(row.querySelector('[data-field="internal"]').value).toFixed(2);
  const supply = Number(row.querySelector('[data-field="supply"]').value).toFixed(2);
  const enabled = row.querySelector('[data-field="enabled"]').checked;
  try {
    await api('/admin/api/products/' + encodeURIComponent(productCode), {
      method: 'PUT', body: JSON.stringify({ internal_cost_cny: internal, cost_price: supply, enabled: enabled })
    });
    toast('商品配置已保存');
    await loadProducts();
  } catch (error) { toast(error.message); }
}
window.saveProduct = saveProduct;

function beijingDateString(offsetDays) {
  return new Date(Date.now() + 8 * 3600000 + Number(offsetDays || 0) * 86400000).toISOString().slice(0, 10);
}
function setDatePreset(days) {
  const totalDays = Number(days || 1);
  const toDate = beijingDateString(0);
  const fromDate = beijingDateString(-(totalDays - 1));
  $('#from').value = fromDate;
  $('#to').value = toDate;
  $$('.date-preset').forEach(function(button) { button.classList.toggle('active', Number(button.dataset.days) === totalDays); });
  $('#financeRangeLabel').textContent = totalDays === 1 ? '今天' : '近 ' + totalDays + ' 天';
}
function markCustomDateRange() {
  $$('.date-preset').forEach(function(button) { button.classList.remove('active'); });
  $('#financeRangeLabel').textContent = '自定义区间';
}
function normalizeReportDate(value, label) {
  let normalized = String(value || '').trim().replace(/[./]/g, '-').replace(/\s+/g, '');
  if (/^\d{8}$/.test(normalized)) {
    normalized = normalized.slice(0, 4) + '-' + normalized.slice(4, 6) + '-' + normalized.slice(6, 8);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw new Error((label || '日期') + '格式应为 YYYY-MM-DD，例如 2026-09-25');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const checked = new Date(Date.UTC(year, month - 1, day));
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) {
    throw new Error((label || '日期') + '不是有效日期');
  }
  return normalized;
}
function normalizeReportDateField(id, quiet) {
  const input = $('#' + id);
  const label = input.dataset.dateLabel || (id.toLowerCase().endsWith('from') || id === 'from' ? '开始日期' : '结束日期');
  try {
    input.value = normalizeReportDate(input.value, label);
    input.removeAttribute('aria-invalid');
    return input.value;
  } catch (error) {
    input.setAttribute('aria-invalid', 'true');
    if (!quiet) toast(error.message);
    return null;
  }
}
function showReportDatePicker(id) {
  const picker = $('#' + id + 'Picker');
  const typed = normalizeReportDateField(id, true);
  picker.value = typed || beijingDateString(0);
  if (typeof picker.showPicker === 'function') picker.showPicker();
  else picker.click();
}
window.showReportDatePicker = showReportDatePicker;
function dateRangeFromFields(fromId, toId) {
  const fromInput = $('#' + fromId);
  const toInput = $('#' + toId);
  const fromDate = normalizeReportDate(fromInput.value, fromInput.dataset.dateLabel || '开始日期');
  const toDate = normalizeReportDate(toInput.value, toInput.dataset.dateLabel || '结束日期');
  fromInput.value = fromDate;
  toInput.value = toDate;
  fromInput.removeAttribute('aria-invalid');
  toInput.removeAttribute('aria-invalid');
  const fromTime = new Date(fromDate + 'T00:00:00+08:00');
  const toStart = new Date(toDate + 'T00:00:00+08:00');
  if (fromTime.getTime() > toStart.getTime()) throw new Error('开始日期不能晚于结束日期');
  return { from: fromTime.toISOString(), to: new Date(toStart.getTime() + 86400000).toISOString() };
}
function setListDateRange(prefix, days) {
  $('#' + prefix + 'From').value = beijingDateString(-(Number(days || 30) - 1));
  $('#' + prefix + 'To').value = beijingDateString(0);
}
function reportDates() {
  const defaultDate = beijingDateString(0);
  if (!$('#from').value) $('#from').value = defaultDate;
  if (!$('#to').value) $('#to').value = defaultDate;
  return dateRangeFromFields('from', 'to');
}
async function loadFinance(background, page) {
  if (Number(page) > 0) state.financePage = Number(page);
  const dates = reportDates();
  const previousIds = new Set((state.finance && state.finance.items || []).map(function(item) { return item.order_id; }));
  const query = new URLSearchParams({
    from: dates.from,
    to: dates.to,
    page: String(state.financePage || 1),
    page_size: String($('#financePageSize') ? $('#financePageSize').value : 20)
  });
  const data = await api('/admin/api/finance?' + query.toString(), { background: Boolean(background) });
  data.display_range = beijingTime(dates.from).slice(0,10) + ' 至 ' + beijingTime(new Date(new Date(dates.to).getTime()-1).toISOString()).slice(0,10);
  const newOrders = state.financeLoaded ? (data.items || []).filter(function(item) { return !previousIds.has(item.order_id); }) : [];
  state.finance = data;
  state.financeLoaded = true;
  renderDashboard();
  renderOrders();
  renderFulfillment();
  renderFinance();
  const refresh = $('#lastRefresh');
  if (refresh) refresh.textContent = '自动刷新 · ' + beijingTime(new Date().toISOString()).slice(11);
  if (newOrders.length) toast('发现 ' + newOrders.length + ' 笔新订单，列表已自动更新');
}
function settlementDateRange() {
  if (!$('#settlementFrom').value) $('#settlementFrom').value = beijingDateString(-29);
  if (!$('#settlementTo').value) $('#settlementTo').value = beijingDateString(0);
  dateRangeFromFields('settlementFrom', 'settlementTo');
  return { from: $('#settlementFrom').value, to: $('#settlementTo').value };
}
async function loadSettlements(background, page) {
  if (Number(page) > 0) state.settlementPage = Number(page);
  const dates = settlementDateRange();
  const query = new URLSearchParams({
    q: ($('#settlementSearch').value || '').trim(),
    status: $('#settlementStatus').value || '',
    from: dates.from,
    to: dates.to,
    page: String(state.settlementPage || 1),
    page_size: String($('#settlementPageSize').value || 20)
  });
  const data = await api('/admin/api/platform-settlements?' + query.toString(), { background: Boolean(background) });
  state.settlements = data.items || [];
  state.settlementSummary = data.summary || null;
  state.settlementPagination = data.pagination || null;
  renderSettlementSummary();
  renderSettlementTable();
}
async function loadDailyMetrics(background) {
  const data = await api('/admin/api/analytics/daily', { background: Boolean(background) });
  state.dailyMetrics = data.items || [];
  renderDailyMetrics();
}
function renderDailyMetrics() {
  const target = $('#dailyMetrics');
  if (!target) return;
  const rows = state.dailyMetrics || [];
  if (!rows.length) { target.innerHTML = '<div class="empty compact">暂无每日数据</div>'; return; }
  target.innerHTML = '<div class="table-wrap"><table><thead><tr><th>日期</th><th>订单数</th><th>支付成功</th><th>履约成功</th><th>履约失败</th><th>成功率</th><th>失败率</th></tr></thead><tbody>' + rows.map(function(row) {
    return '<tr><td><strong>' + esc(row.day) + '</strong></td><td>' + number(row.order_count) + '</td><td>' + number(row.paid_count) + '</td><td class="good"><strong>' + number(row.success_count) + '</strong></td><td class="bad"><strong>' + number(row.failed_count) + '</strong></td><td>' + window.financeUi.dailyRateMarkup(row, 'success') + '</td><td>' + window.financeUi.dailyRateMarkup(row, 'failure') + '</td></tr>';
  }).join('') + '</tbody></table></div>';
}
function renderDashboard() {
  if (!state.finance) return;
  const summary = state.finance.summary;
  $('#kpiOrders').textContent = number(summary.settlement_orders);
  $('#kpiReceipt').textContent = money(summary.receipts);
  $('#kpiPlatform').textContent = money(summary.platform_margin);
  $('#kpiProfit').textContent = summary.gross_profit === null ? '待核算' : money(summary.gross_profit);
  $('#dashboardRange').textContent = '统计区间：' + (state.finance.display_range || '以财务查询区间为准') + '（北京时间，与财务对账一致）';
  const actionRequired = Number(summary.profit_action_required_count || 0);
  $('#dashboardProfitHint').textContent = summary.gross_profit === null ? (actionRequired ? '有 ' + number(actionRequired) + ' 笔超扣、额外费用或争议需要核查' : '存在尚未确认的异常成本') : summary.profit_estimated_count ? '基础毛利已显示；含 ' + number(summary.profit_estimated_count) + ' 笔按订单冻结成本计算' : '供货价 − 冻结成本；退差与成本下降同步抵消';
  $('#dashboardCostTodo').classList.toggle('hidden', !actionRequired);
  $('#dashboardCostTodoCount').textContent = number(actionRequired);
  $('#kpiProfit').className = 'kpi-value ' + (summary.gross_profit === null || summary.profit_estimated_count ? 'fin-muted' : Number(summary.gross_profit) < 0 ? 'bad' : 'good');
  $('#kpiPlatform').className = 'kpi-value ' + (Number(summary.platform_margin) < 0 ? 'bad' : '');
  const rows = state.finance.items || [];
  const latest = rows.slice(0, 6);
  $('#recentOrders').innerHTML = latest.length ? '<div class="table-wrap"><table><thead><tr><th>订单</th><th>商品</th><th>支付</th><th>履约</th><th>金额</th></tr></thead><tbody>' + latest.map(function(row) {
    return '<tr' + selectionAttrs('orders', row.order_id, 'interactive-row') + ' role="button" tabindex="0" aria-label="查看订单 ' + esc(row.client_order_id) + '" onclick="viewOrder(\'' + esc(row.order_id) + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();viewOrder(\'' + esc(row.order_id) + '\')}"><td><strong>' + esc(row.client_order_id) + '</strong><span class="sub">' + beijingTime(row.created_at) + '</span></td><td>' + esc(row.product) + '</td><td>' + statusTag(row.status_zh, paymentTone(row.status)) + '</td><td>' + statusTag(row.delivery_zh, deliveryTone(row.delivery_zh)) + '</td><td class="amount">' + money(row.receipt_amount) + '</td></tr>';
  }).join('') + '</tbody></table></div>' : '<div class="empty">暂无交易数据</div>';
  renderDashboardOperations();
}
function renderDashboardOperations() {
  if (!state.operations) return;
  const orders = state.operations.orders || {};
  $('#orderFunnel').innerHTML = window.financeUi.funnelMarkup(orders);
  const alerts = state.operations.alerts || [];
  $('#dashboardTasks').innerHTML = alerts.length ? alerts.slice(0, 5).map(renderAlert).join('') : '<div class="notice good">当前没有履约运营告警；成本与汇率核查单独列示。</div>';
  $('#riskNavBadge').textContent = alerts.length;
  $('#riskNavBadge').classList.toggle('hidden', !alerts.length);
}

async function loadOrders(page, background) {
  if (Number(page) > 0) state.orderPage = Number(page);
  const dates = dateRangeFromFields('orderFrom', 'orderTo');
  const query = new URLSearchParams({
    q: ($('#orderSearch') && $('#orderSearch').value || '').trim(),
    status: $('#orderStatus') ? $('#orderStatus').value : '',
    from: dates.from,
    to: dates.to,
    page: String(state.orderPage || 1),
    page_size: String($('#orderPageSize') ? $('#orderPageSize').value : 20)
  });
  const data = await api('/admin/api/orders?' + query.toString(), { background: Boolean(background) });
  state.orders = data.items || [];
  state.ordersPagination = data.pagination || null;
  renderOrders();
}
function renderOrders() {
  const target = $('#ordersTable');
  if (!target) return;
  const rows = state.orders || [];
  if (!rows.length) { target.innerHTML = '<div class="empty">没有符合条件的订单</div>'; renderPagination('ordersPagination', state.ordersPagination, 'changeOrderPage'); return; }
  target.innerHTML = '<div class="table-wrap"><table><thead><tr><th>平台订单 / 我方订单</th><th>商品</th><th>支付状态</th><th>履约状态</th><th>用户付款</th><th>服务商收款</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' + rows.map(function(row) {
    const source = row.order_source === 'manual' ? '<span class="tag info order-source">人工补录</span>' : '';
    return '<tr' + selectionAttrs('orders', row.order_id, 'interactive-row') + ' tabindex="0" role="button" onclick="viewOrder(\'' + esc(row.order_id) + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();viewOrder(\'' + esc(row.order_id) + '\')}"><td><div class="order-title"><strong>' + esc(row.client_order_id) + '</strong>' + source + '</div><span class="sub">' + esc(row.order_id) + '</span></td><td>' + esc(row.product) + '</td><td>' + statusTag(row.status_zh, paymentTone(row.status)) + '</td><td>' + statusTag(row.delivery_zh, deliveryTone(row.delivery_zh)) + '</td><td class="amount">' + money(row.sell_price) + '</td><td class="amount">' + money(row.receipt_amount) + '</td><td>' + beijingTime(row.created_at) + '</td><td><span class="row-action"><span>详情</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg></span></td></tr>';
  }).join('') + '</tbody></table></div>';
  renderPagination('ordersPagination', state.ordersPagination, 'changeOrderPage');
}
function changeOrderPage(page) { loadOrders(page).catch(function(error) { toast(error.message); }); }
window.changeOrderPage = changeOrderPage;
async function loadFulfillment(page, background) {
  if (Number(page) > 0) state.fulfillmentPage = Number(page);
  const dates = dateRangeFromFields('fulfillmentFrom', 'fulfillmentTo');
  const query = new URLSearchParams({
    q: ($('#fulfillmentSearch') && $('#fulfillmentSearch').value || '').trim(),
    delivery_status: $('#fulfillmentStatus') ? $('#fulfillmentStatus').value : '',
    from: dates.from,
    to: dates.to,
    page: String(state.fulfillmentPage || 1),
    page_size: String($('#fulfillmentPageSize') ? $('#fulfillmentPageSize').value : 20)
  });
  const data = await api('/admin/api/fulfillment?' + query.toString(), { background: Boolean(background) });
  state.fulfillment = data.items || [];
  state.fulfillmentPagination = data.pagination || null;
  state.fulfillmentSummary = data.summary || { waiting: 0, failed: 0, success: 0 };
  renderFulfillment();
}
function renderFulfillment() {
  const target = $('#fulfillmentTable');
  if (!target) return;
  const rows = state.fulfillment || [];
  const summary = state.fulfillmentSummary || { waiting: 0, failed: 0, success: 0 };
  $('#fulfillmentWaiting').textContent = number(summary.waiting);
  $('#fulfillmentFailed').textContent = number(summary.failed);
  $('#fulfillmentSuccess').textContent = number(summary.success);
  if (!rows.length) { target.innerHTML = '<div class="empty">当前条件下暂无已支付订单</div>'; renderPagination('fulfillmentPagination', state.fulfillmentPagination, 'changeFulfillmentPage'); return; }
  target.innerHTML = '<div class="table-wrap"><table><thead><tr><th>订单</th><th>商品</th><th>履约状态</th><th>支付时间</th><th>结算资格</th><th>履约结果</th><th>操作</th></tr></thead><tbody>' + rows.map(function(row) {
    const result = row.delivery_status === 'failed' ? activationReasonHtml(row) : row.delivery_status === 'success' ? '<span class="activation-message success">开通成功</span>' : '<span class="activation-message">等待用户提交或上游处理</span>';
    return '<tr' + selectionAttrs('orders', row.order_id, 'interactive-row') + ' tabindex="0" role="button" onclick="viewOrder(\'' + esc(row.order_id) + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();viewOrder(\'' + esc(row.order_id) + '\')}"><td><strong>' + esc(row.client_order_id) + '</strong><span class="sub">' + esc(row.order_id) + '</span></td><td>' + esc(row.product) + '</td><td>' + statusTag(row.delivery_zh, deliveryTone(row.delivery_zh)) + '</td><td>' + beijingTime(row.paid_at) + '</td><td>' + statusTag(row.settlement_eligible ? '可结算' : '暂不可结算', row.settlement_eligible ? 'good' : 'warn') + '</td><td>' + result + '</td><td><span class="row-action"><span>详情</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg></span></td></tr>';
  }).join('') + '</tbody></table></div>';
  renderPagination('fulfillmentPagination', state.fulfillmentPagination, 'changeFulfillmentPage');
}
function changeFulfillmentPage(page) { loadFulfillment(page).catch(function(error) { toast(error.message); }); }
window.changeFulfillmentPage = changeFulfillmentPage;
function renderFinance() {
  if (!state.finance) return;
  const summary = state.finance.summary;
  $('#financeReceipt').textContent = money(summary.receipts);
  $('#financePlatform').textContent = money(summary.platform_payable);
  $('#financeProfit').textContent = summary.gross_profit === null ? '待核算' : money(summary.gross_profit);
  $('#financeProfit').nextElementSibling.textContent = summary.gross_profit === null ? '存在超扣、额外费用或争议尚未核清的订单' : summary.profit_estimated_count ? '包含 ' + summary.profit_estimated_count + ' 笔按冻结人民币成本计算' : '供货价 − 冻结成本；退差与成本下降同步抵消';
  renderSettlementSummary();
  renderSettlementTable();
  const target = $('#financeTable');
  const rows = state.finance.items || [];
  if (!rows.length) { target.innerHTML = '<div class="empty">所选时间内暂无财务数据</div>'; renderPagination('financePagination', state.finance.pagination, 'changeFinancePage'); return; }
  target.innerHTML = '<div class="table-wrap"><table><thead><tr><th>订单</th><th>业务结算</th><th>用户付款</th><th>服务商收款</th><th>原供货报价</th><th>历史客户补差</th><th>平台基础利润</th><th>平台美元差价</th><th>平台核销</th><th>成本口径</th><th>我方净结算收入</th><th>我方毛利</th><th>付款时间</th><th>操作</th></tr></thead><tbody>' + rows.map(function(row) {
    const settlementTone = row.platform_settlement_status === 'paid' ? 'good' : row.platform_settlement_status === 'pending' || row.platform_settlement_zh === '未生成' ? 'warn' : '';
    const settlementCell = statusTag(row.platform_settlement_zh, settlementTone) + (row.platform_settlement_id ? '<span class="sub">' + esc(row.platform_settlement_id) + '</span>' : '');
    const rebateLabel = row.platform_rebate_usd ? usd(row.platform_rebate_usd) : '-';
    const rebateState = row.platform_rebate_status === 'paid' ? '已结算' : row.platform_rebate_status === 'included' ? '已入结算单' : row.platform_rebate_status === 'pending' ? '待结算' : '';
    return '<tr' + selectionAttrs('orders', row.order_id, '') + '><td><strong>' + esc(row.client_order_id) + '</strong><span class="sub">' + esc(row.order_id) + '</span></td><td>' + statusTag(row.settlement_eligible ? '可结算' : '不计结算', row.settlement_eligible ? 'good' : '') + '</td><td class="amount">' + money(row.customer_payment_amount) + '</td><td class="amount">' + money(row.receipt_amount) + '</td><td class="amount">' + money(row.supply_price) + '</td><td class="amount ' + (Number(row.customer_price_refund_amount) > 0 ? 'bad' : '') + '">' + money(row.customer_price_refund_amount) + '</td><td class="amount good">' + money(row.platform_margin) + '</td><td class="amount">' + rebateLabel + (rebateState ? '<span class="sub">' + esc(rebateState) + '</span>' : '') + '</td><td>' + settlementCell + '</td><td>' + statusTag(row.profit_basis === 'pending' ? '待核算' : row.cost_is_estimate ? '预估' : '已核实', row.profit_basis === 'pending' || row.cost_is_estimate ? 'warn' : 'good') + '<span class="sub">' + (row.verified_cost_usd ? usd(row.verified_cost_usd) : money(row.cost_basis_cny)) + '</span></td><td class="amount">' + (row.supplier_net_income_cny === null ? '待核算' : money(row.supplier_net_income_cny)) + '</td><td class="amount ' + (Number(row.gross_profit) < 0 ? 'bad' : 'good') + '">' + (row.gross_profit === null ? '待核算' : money(row.gross_profit)) + '</td><td>' + beijingTime(row.paid_at) + '</td><td><div class="table-actions"><button class="btn small" onclick="viewOrder(\'' + esc(row.order_id) + '\')">详情</button><button class="btn small" onclick="openCost(\'' + esc(row.order_id) + '\',\'' + esc(row.upstream_actual_cost_amount || '') + '\',\'' + esc(row.upstream_actual_cost_currency || 'USD') + '\',\'' + esc(row.upstream_actual_cost_cny || '') + '\')">登记成本</button></div></td></tr>';
  }).join('') + '</tbody></table></div>';
  renderPagination('financePagination', state.finance.pagination, 'changeFinancePage');
}
function renderSettlementSummary() {
  const target = $('#settlementSummary');
  if (!target) return;
  const summary = state.settlementSummary || { count: 0, amount: '0.00', cny_paid: '0.00', rebate_usd: '0.00', usd_paid: '0.00' };
  const cnyRemaining = (Math.max(0, Math.round(Number(summary.amount || 0) * 100) - Math.round(Number(summary.cny_paid || 0) * 100)) / 100).toFixed(2);
  const usdRemaining = (Math.max(0, Math.round(Number(summary.rebate_usd || 0) * 100) - Math.round(Number(summary.usd_paid || 0) * 100)) / 100).toFixed(2);
  target.innerHTML =
    '<div><span>当前筛选结算单</span><strong>' + number(summary.count) + ' 张</strong></div>' +
    '<div><span>人民币应结算</span><strong>' + money(summary.amount) + '</strong></div>' +
    '<div><span>人民币未核销</span><strong class="' + (Number(cnyRemaining) > 0 ? 'metric-bad' : 'metric-good') + '">' + money(cnyRemaining) + '</strong></div>' +
    '<div><span>美元应结算</span><strong>' + usd(summary.rebate_usd) + '</strong></div>' +
    '<div><span>美元未核销</span><strong class="' + (Number(usdRemaining) > 0 ? 'metric-bad' : 'metric-good') + '">' + usd(usdRemaining) + '</strong></div>';
}
function renderSettlementTable() {
  const target = $('#settlementTable');
  if (!target) return;
  const settlements = state.settlements || [];
  if (!settlements.length) {
    const status = $('#settlementStatus') ? $('#settlementStatus').value : '';
    target.innerHTML = '<div class="fin-empty">' + (status === 'paid' ? '当前条件下没有已核销结算单。' : status === 'partial' ? '当前条件下没有部分核销结算单。' : status === 'pending' ? '当前条件下没有待核销结算单。' : '当前条件下没有结算单。') + '</div>';
    renderPagination('settlementPagination', state.settlementPagination, 'changeSettlementPage');
    return;
  }
  target.innerHTML = window.financeUi.settlementRows(settlements);
  target.querySelectorAll('[data-statement-index]').forEach(function(button) {
    button.onclick = function() { window.openSettlementPayment(settlements[Number(button.dataset.statementIndex)].settlement_id); };
  });
  target.querySelectorAll('[data-export-statement-index]').forEach(function(button) {
    button.onclick = function() {
      const statement = settlements[Number(button.dataset.exportStatementIndex)];
      toast('正在导出结算单 ' + statement.settlement_id);
      location.href = '/admin/api/platform-settlements/' + encodeURIComponent(statement.settlement_id) + '/export.csv';
    };
  });
  renderPagination('settlementPagination', state.settlementPagination, 'changeSettlementPage');
}
function changeSettlementPage(page) { loadSettlements(false, page).catch(function(error) { toast(error.message); }); }
window.changeSettlementPage = changeSettlementPage;
function changeFinancePage(page) { loadFinance(false, page).catch(function(error) { toast(error.message); }); }
window.changeFinancePage = changeFinancePage;
function settlementMethodLabel(method) {
  return ({ bank_transfer: '银行转账', alipay: '支付宝转账', other: '其他方式' })[method] || '-';
}
async function createSettlement() {
  let dates;
  try { dates = dateRangeFromFields('settlementFrom', 'settlementTo'); } catch (error) { return toast(error.message); }
  if (!await confirmAction('系统只归集履约成功、未退款、尚未进入其他结算单且平台利润大于 0 的订单。', { title: '生成平台结算单？', confirmText: '确认生成' })) return;
  try {
    const data = await api('/admin/api/platform-settlements', { method: 'POST', body: JSON.stringify(dates) });
    toast('结算单 ' + data.settlement.settlement_id + ' 已生成，等待实际打款');
    await Promise.all([loadFinance(), loadSettlements(), loadOrders(), loadFulfillment()]);
  } catch (error) { toast(error.message); }
}
function syncSettlementPaymentAmount() {
  const settlement = state.activeSettlement;
  if (!settlement) return;
  const currency = $('#settlementCurrency').value;
  const remaining = window.financeUi.remaining(settlement, currency);
  $('#settlementAmount').value = Number(remaining) > 0 ? remaining : '';
  $('#settlementAmount').max = remaining;
}
async function openSettlementPayment(id) {
  try {
    const data = await api('/admin/api/platform-settlements/' + encodeURIComponent(id));
    const form = $('#settlementPaymentForm');
    const fields = form.elements;
    const settlement = data.settlement;
    state.activeSettlement = settlement;
    fields.namedItem('settlement_id').value = id;
    fields.namedItem('method').value = 'bank_transfer';
    fields.namedItem('reference').value = '';
    fields.namedItem('note').value = '';
    fields.namedItem('paid_at').value = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
    $('#settlementPaymentFacts').innerHTML = window.financeUi.statementMarkup(data);
    const paid = window.financeUi.settlementState(settlement) === 'paid';
    $('#settlementEntry').classList.toggle('hidden', paid);
    if (!paid) {
      fields.namedItem('currency').value = Number(window.financeUi.remaining(settlement, 'CNY')) > 0 ? 'CNY' : 'USD';
      syncSettlementPaymentAmount();
    }
    $('#settlementModal').classList.remove('hidden');
  } catch (error) { toast(error.message); }
}
function closeSettlementModal() { $('#settlementModal').classList.add('hidden'); state.activeSettlement = null; }
window.openSettlementPayment = openSettlementPayment;
window.closeSettlementModal = closeSettlementModal;

async function viewOrder(orderId) {
  try {
    state.selectedRows.orders = String(orderId);
    const data = await api('/admin/api/orders/' + encodeURIComponent(orderId));
    state.orderDetail = data;
    $('#orderActionPanel').open = false;
    const order = data.order;
    const xGiftOrder = ['x_premium_3m', 'x_premium_6m'].includes(order.plan);
    const activations = data.activations || [];
    const orderedActivations = activations.slice().sort(function(left, right) {
      return String(left.created_at || '').localeCompare(String(right.created_at || ''));
    });
    const finishedActivations = activations.filter(function(item) { return item.finished; }).sort(function(left, right) {
      return String(left.updated_at || '').localeCompare(String(right.updated_at || ''));
    });
    const fulfillmentSubmittedAt = orderedActivations.length ? orderedActivations[0].created_at : null;
    const fulfillmentResultAt = finishedActivations.length ? finishedActivations[finishedActivations.length - 1].updated_at : null;
    const refundRequestedAt = data.refund ? data.refund.created_at : null;
    const refundCompletedAt = data.refund && data.refund.refunded_at ? data.refund.refunded_at : order.refunded_at;
    const serviceReceipt = Number(order.alipay_receipt_amount || (order.status === 'paid' ? order.amount : 0));
    const supplyCost = Number(order.platform_supply_price || 0);
    const priceRefund = Number(order.customer_price_refund_amount || 0);
    const platformRebate = data.platform_rebate || null;
    const platformProfit = order.status === 'paid' && order.delivery_status === 'success' && !order.refunded_at
      ? serviceReceipt - supplyCost - priceRefund
      : 0;
    $('#orderModalTitle').textContent = '订单详情';
    $('#orderFacts').innerHTML = window.financeUi.orderMarkup(data,{
      receipt:serviceReceipt,supply:supplyCost,platformProfit,
      submitted:fulfillmentSubmittedAt,finished:fulfillmentResultAt
    });
    $('#orderActivations').innerHTML = activations.length ? '<div class="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>客户</th><th>上游单号</th><th>结果说明</th><th>更新时间</th></tr></thead><tbody>' + activations.map(function(item) {
      return '<tr><td><strong>' + esc(item.task_id) + '</strong><span class="sub">尝试 #' + esc(item.activation_id) + '</span></td><td>' + statusTag(translated('activation', item.status), item.status === 'success' ? 'good' : item.status === 'failed' ? 'bad' : 'warn') + '</td><td>' + esc(item.account_email_masked || '-') + '</td><td>' + esc(item.upstream_order_id || '-') + '</td><td>' + activationReasonHtml(item) + '</td><td>' + beijingTime(item.updated_at) + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<div class="empty">尚未提交履约任务</div>';
    if (xGiftOrder) {
      $('#orderActivations').innerHTML += '<div class="notice info" style="margin-top:12px">蓝V按付款时绑定的 X 用户名赠送。结果待核对时，请在“待核查任务”中查询原单；成功状态以原赠送订单为准。</div>';
    }
    const takeover = data.manual_takeover || null;
    const takeoverActive = takeover && ['claimed', 'review_required'].includes(takeover.status);
    if (takeoverActive) {
      const message = order.status === 'refunded'
        ? '支付宝已确认退款：立即停止人工开通。接管锁继续保留，待人工复核资金与履约事实。'
        : takeover.status === 'review_required'
          ? '人工开通结果待核实：接管锁持续生效。核实已开通可显式登记成功；明确未开通才可解除。未知结果不得重提或退款。'
          : '人工接管中：原自动任务已失败，或已确认从未领取并在提交前安全终止。人工成功账号必须与原任务一致；此期间系统禁止自动重提和发起退款。Session 不要填写到原因或备注中。';
      $('#orderActivations').innerHTML += '<div class="notice warn" style="margin-top:12px">' + message + '</div>';
    }
    const manualSuccessWithoutUpstream = activations.some(function(item) {
      return item.status === 'success' && !item.upstream_order_id;
    });
    if (manualSuccessWithoutUpstream) {
      $('#orderActivations').innerHTML += '<div class="notice warn" style="margin-top:12px">人工开通已登记，但没有可核查的上游单号。真实成本仍待人工凭证核实，不能按原失败任务的 CDK 核算。</div>';
    }
    const audit = data.audit || [];
    $('#orderAudit').innerHTML = audit.length ? audit.map(function(item) {
      return '<div class="task"><div class="task-icon">记</div><div class="task-main"><b>' + esc(translated('auditAction', item.action)) + ' · ' + esc(auditStatusLabel(item.from_status)) + ' → ' + esc(auditStatusLabel(item.to_status)) + '</b><span>' + esc(item.reason) + ' · ' + beijingTime(item.created_at) + '</span></div></div>';
    }).join('') : '<div class="notice info">暂无人工状态变更记录。</div>';
    const options = [];
    const refundBlockedByActivation = activations.some(function(item) { return !item.finished || item.status === 'success'; });
    const refund = data.refund;
    const isCashOrder = order.payment_channel === 'cash';
    if (!takeoverActive && !isCashOrder && order.status === 'paid' && order.delivery_status !== 'success' && !refundBlockedByActivation && (!refund || ['requested', 'failed'].includes(refund.status))) {
      const label = !refund ? '人工发起支付宝原路退款' : refund.status === 'requested' ? '审核通过并原路退款' : '重新核查并重试支付宝退款';
      options.push('<option value="refund_via_alipay">' + label + '</option>');
    }
    if (!isCashOrder && order.status === 'paid' && order.delivery_status !== 'success' && !refundBlockedByActivation && (!refund || ['requested', 'processing', 'failed'].includes(refund.status))) {
      options.push('<option value="confirm_external_refund">核验支付宝已退款并同步平台</option>');
    }
    if (refund && refund.status === 'requested') options.push('<option value="reject_refund">驳回退款申请</option>');
    if (!takeoverActive && order.status === 'paid' && !order.delivery_status && !activations.some(item => !item.finished)) options.push('<option value="mark_delivery_failed">仅标记内部异常（不改变平台任务）</option>');
    if (!takeoverActive && order.status === 'paid' && order.delivery_status === 'failed' && !activations.some(item => !item.finished)) options.push('<option value="restore_delivery_pending">清除内部异常标记（不重试充值）</option>');
    const canBeginTakeover = !xGiftOrder && order.order_source !== 'manual' && order.status === 'paid' && !refund &&
      (!takeover || takeover.status === 'released') &&
      activations.length > 0 && (activations.every(function(item) { return item.finished && item.status === 'failed'; }) ||
        data.can_begin_unsubmitted_takeover === true);
    if (canBeginTakeover) options.unshift('<option value="begin_manual_takeover">' +
      (data.can_begin_unsubmitted_takeover === true ? '安全终止未领取任务并人工接管' : '开始人工接管（锁定重提与退款）') + '</option>');
    if (!xGiftOrder && takeover && takeover.status === 'claimed' && order.status === 'paid') {
      options.push('<option value="report_manual_takeover_issue">人工操作失败或结果未知（保持锁定）</option>');
      options.push('<option value="release_manual_takeover_not_started">确认人工操作尚未开始，解除接管</option>');
    }
    if (!xGiftOrder && takeover && takeover.status === 'review_required' && order.status === 'paid' && !refund) {
      options.push('<option value="release_manual_takeover_confirmed_failed">已核实人工未开通，解除接管</option>');
    }
    const canConfirmManualDelivery = !xGiftOrder && order.status === 'paid' && order.delivery_status !== 'success' &&
      !activations.some(function(item) { return !item.finished || item.status === 'success'; }) &&
      (!refund || ['failed', 'rejected'].includes(refund.status)) &&
      (order.order_source === 'manual' || !activations.length || takeoverActive);
    if (canConfirmManualDelivery) {
      const manualOption = '<option value="confirm_manual_delivery">人工已完成充值（不退款）</option>';
      if (takeover?.status === 'claimed') options.unshift(manualOption);
      else options.push(manualOption);
    }
    if (!takeoverActive && order.status === 'paid' && String(order.client_order_id || '').startsWith('ADMINTEST-') && !refundBlockedByActivation && (!refund || ['failed', 'rejected'].includes(refund.status))) {
      options.push('<option value="close_test_order">无需退款，关闭内部测试单</option>');
    }
    if (takeover?.status === 'review_required' && options.length) {
      options.unshift('<option value="">人工结果待核查，默认保持锁定</option>');
    }
    $('#orderAction').innerHTML = options.length ? options.join('') : '<option value="">当前状态无可执行人工动作</option>';
    $('#submitOrderAction').disabled = !options.length || !$('#orderAction').value;
    $('#orderActionReason').value = '';
    $('#manualDeliveryAccount').value = '';
    $('#orderAction').onchange = function() {
      const manual = this.value === 'confirm_manual_delivery';
      const takeoverAction = ['begin_manual_takeover', 'report_manual_takeover_issue',
        'release_manual_takeover_not_started', 'release_manual_takeover_confirmed_failed'].includes(this.value) ||
        (manual && takeoverActive);
      $('#manualDeliveryAccountField').classList.toggle('hidden', !manual);
      $('#manualDeliveryAccount').required = manual;
      $('#orderActionReason').placeholder = takeoverAction
        ? '工单号已自动填写；不要填写 Session 或自由文本'
        : '请核查上游订单与履约状态后填写，记录将进入审计日志';
      $('#orderActionReason').maxLength = takeoverAction ? 21 : 500;
      if (takeoverAction && !$('#orderActionReason').value) {
        $('#orderActionReason').value = takeover && /^MT-[0-9]{8}-[0-9]{9}$/.test(takeover.reason)
          ? takeover.reason : newManualTakeoverTicket();
      }
      $('#submitOrderAction').disabled = !this.value;
    };
    $('#orderAction').onchange();
    $('#refreshOrderPayment').classList.toggle('hidden', order.status !== 'pending');
    const canRecordPriceRefund = order.order_source !== 'manual' && order.status === 'paid' && order.delivery_status === 'success' && !order.refunded_at && !order.platform_settlement_id && !order.invoice_id && !data.cost_review_status && !platformRebate;
    $('#openCustomerPriceRefund').classList.toggle('hidden', !canRecordPriceRefund);
    const canRecordPlatformRebate = order.order_source !== 'manual' && order.status === 'paid' &&
      order.delivery_status === 'success' && !order.refunded_at && !manualSuccessWithoutUpstream;
    $('#openPlatformRebate').classList.toggle('hidden', !canRecordPlatformRebate);
    $('#openPlatformRebate').textContent = data.cost_review_status ? '查看成本核查' : '核查真实成本与退差';
    const showManualActivation = order.order_source === 'manual' && order.status === 'paid' && order.delivery_status !== 'success' && !activations.some(function(item) { return !item.finished; });
    $('#manualActivationPanel').classList.toggle('hidden', !showManualActivation);
    $('#manualSession').value = '';
    $('#manualEmail').textContent = '';
    $('#manualEmailBox').classList.add('hidden');
    $('#submitManualActivation').disabled = true;
    $('#orderModal').classList.remove('hidden');
  } catch (error) { toast(error.message); }
}
function closeOrderModal() { $('#orderModal').classList.add('hidden'); }
function newManualTakeoverTicket() {
  const beijing = new Date(Date.now() + 8 * 3600000).toISOString();
  return 'MT-' + beijing.slice(0, 10).replace(/-/g, '') + '-' +
    beijing.slice(11, 23).replace(/[:.]/g, '');
}
function openCustomerPriceRefundModal() {
  if (!state.orderDetail) return;
  const order = state.orderDetail.order;
  const form = $('#customerPriceRefundForm');
  const receipt = Number(order.alipay_receipt_amount || order.amount || 0);
  const supply = Number(order.platform_supply_price || 0);
  const current = Number(order.customer_price_refund_amount || 0);
  form.order_id.value = order.order_id;
  form.amount.value = current > 0 ? current.toFixed(2) : '';
  form.amount.max = Math.max(0, receipt - supply).toFixed(2);
  form.reference.value = order.customer_price_refund_reference || '';
  form.reason.value = order.customer_price_refund_reason || '';
  const refundedAt = order.customer_price_refunded_at ? new Date(order.customer_price_refunded_at) : new Date();
  form.refunded_at.value = new Date(refundedAt.getTime() + 8 * 3600000).toISOString().slice(0, 16);
  $('#customerPriceRefundFacts').innerHTML = '<div class="result-row"><span>订单号</span><strong>' + esc(order.client_order_id) + '</strong></div><div class="result-row"><span>服务商收款</span><strong>' + money(receipt) + '</strong></div><div class="result-row"><span>原供货报价</span><strong>' + money(supply) + '</strong></div><div class="result-row"><span>最多可补差</span><strong>' + money(Math.max(0, receipt - supply)) + '</strong></div>';
  $('#customerPriceRefundModal').classList.remove('hidden');
}
function closeCustomerPriceRefundModal() { $('#customerPriceRefundModal').classList.add('hidden'); }
window.closeCustomerPriceRefundModal = closeCustomerPriceRefundModal;
function openPlatformRebateModal() {
  if (!state.orderDetail) return;
  const order = state.orderDetail.order;
  const activation = (state.orderDetail.activations || []).filter(function(item) {
    return item.status === 'success' && item.upstream_order_id;
  }).slice(-1)[0];
  const standardPrices = {
    chatgpt_plus_1m: '15.76',
    chatgpt_pro_5x_1m: '92.98',
    chatgpt_pro_20x_1m: '143.12',
    chatgpt_pro_50x_1m: '465.47'
  };
  const form = $('#platformRebateForm');
  form.reset();
  form.order_id.value = order.order_id;
  form.standard_usd.value = standardPrices[order.product] || '';
  form.actual_usd.value = '';
  form.fee_usd.value = '0.15';
  form.card_transaction_id.value = '';
  form.reason.value = '卡台实际扣款低于商品标准扣款，差额返还平台';
  $('#platformRebateFacts').innerHTML =
    '<div class="result-row"><span>平台订单号</span><strong>' + esc(order.client_order_id) + '</strong></div>' +
    '<div class="result-row"><span>我方订单号</span><strong>' + esc(order.order_id) + '</strong></div>' +
    '<div class="result-row"><span>上游订单号</span><strong>' + esc(activation ? activation.upstream_order_id : '-') + '</strong></div>' +
    '<div class="result-row"><span>结算规则</span><strong>每天 22:00 自动归集</strong></div>';
  $('#platformRebateModal').classList.remove('hidden');
}
function closePlatformRebateModal() { $('#platformRebateModal').classList.add('hidden'); }
window.closePlatformRebateModal = closePlatformRebateModal;
async function refreshOrderPayment() {
  if (!state.orderDetail) return;
  try {
    await api('/admin/api/orders/' + encodeURIComponent(state.orderDetail.order.order_id) + '/refresh-payment', { method: 'POST' });
    toast('已按支付宝主动查单结果刷新');
    await loadFinance();
    await viewOrder(state.orderDetail.order.order_id);
  } catch (error) { toast(error.message); }
}
async function submitOrderAction() {
  if (!state.orderDetail || !$('#orderAction').value) return;
  const payload = {
    action: $('#orderAction').value,
    reason: $('#orderActionReason').value.trim()
  };
  if (['x_premium_3m', 'x_premium_6m'].includes(state.orderDetail.order.plan) &&
      ['begin_manual_takeover', 'report_manual_takeover_issue', 'release_manual_takeover_not_started',
        'release_manual_takeover_confirmed_failed', 'confirm_manual_delivery'].includes(payload.action)) {
    return toast('蓝V请在待核查任务中查询原赠送订单结果');
  }
  if (payload.reason.length < 4) return toast('请填写至少 4 个字的变更原因');
  const refundAction = payload.action === 'refund_via_alipay';
  const externalRefundAction = payload.action === 'confirm_external_refund';
  const rejectAction = payload.action === 'reject_refund';
  const manualDeliveryAction = payload.action === 'confirm_manual_delivery';
  const beginTakeoverAction = payload.action === 'begin_manual_takeover';
  const preSubmitTakeoverAction = beginTakeoverAction && state.orderDetail.can_begin_unsubmitted_takeover === true;
  if (beginTakeoverAction) {
    const activations = state.orderDetail.activations || [];
    payload.expected_task_id = activations[activations.length - 1]?.task_id;
  }
  const takeoverIssueAction = payload.action === 'report_manual_takeover_issue';
  const releaseTakeoverAction = ['release_manual_takeover_not_started',
    'release_manual_takeover_confirmed_failed'].includes(payload.action);
  const takeoverConfirmation = manualDeliveryAction && state.orderDetail.manual_takeover &&
    ['claimed', 'review_required'].includes(state.orderDetail.manual_takeover.status);
  if ((beginTakeoverAction || takeoverIssueAction || releaseTakeoverAction || takeoverConfirmation) &&
      !/^MT-[0-9]{8}-[0-9]{9}$/.test(payload.reason)) {
    return toast('人工接管工单号应为 MT-日期-编号；不要填写 Session 或自由文本');
  }
  if (manualDeliveryAction) {
    const account = $('#manualDeliveryAccount');
    if (!account.reportValidity()) return;
    payload.account_email = account.value.trim();
    payload.verified = true;
  }
  const closeTestAction = payload.action === 'close_test_order';
  const prompt = refundAction
    ? '已核查订单及上游履约情况，确认执行支付宝原路全额退款？\n\n这是实际资金操作，成功后不可撤销。'
    : externalRefundAction
      ? '确认这笔订单已在支付宝后台手动全额退款？\n\n系统会先主动查询支付宝；只有确认交易因全额退款关闭，才会标记已退款并通知平台。'
      : rejectAction
      ? '确认驳回该退款申请？\n\n请确保操作原因已经说明核查结论。'
      : manualDeliveryAction
        ? '请确认已经通过人工方式为用户完成充值。\n\n系统将新增一条“人工完成”履约记录并把订单标为履约成功；不会调用支付宝退款，也不会再次向上游下单。人工接管订单的操作原因只能填写短工单号，不得粘贴 Session。'
      : beginTakeoverAction
        ? preSubmitTakeoverAction
          ? '确认只终止当前这条尚未被 worker 领取、也未触达上游的自动任务，并开始人工接管？\n\n服务器会在同一事务中再次核对任务号与全部证据；任务若已开始将拒绝，不会强制中断。接管后禁止自动重提与退款。不要把 Session 写入原因。'
          : '确认原自动开通任务已明确失败，并开始人工接管？\n\n接管后系统会阻止这张订单自动重提与发起退款，且不会自动解除。请先锁定订单，再使用邮件中的 Session 人工开通；不要把 Session 写入操作原因。'
      : takeoverIssueAction
        ? '人工开通失败或结果未知？\n\n系统会保持接管锁并标记待核查，不会重新开通或发起退款。'
      : releaseTakeoverAction
        ? '请再次核实：原自动任务已失败或在未提交前安全终止，且人工开通明确没有发生。\n\n解除接管后，自动重提或退款会重新变为可申请；如果结果仍未知，请取消并保持锁定。'
      : closeTestAction
        ? '确认不退款并关闭这笔内部测试单？\n\n该操作不会调用支付宝，仅用于关闭 ADMINTEST 联调单并停止告警。'
      : '确认执行该订单状态动作？\n\n操作会写入审计日志，并可能影响结算口径。';
  if (!await confirmAction(prompt, { title: '确认执行订单动作？', confirmText: refundAction ? '确认退款' : manualDeliveryAction ? '确认已充值' : '确认执行', danger: refundAction || externalRefundAction || manualDeliveryAction || closeTestAction })) return;
  if (releaseTakeoverAction) payload.verified = true;
  try {
    const result = await api('/admin/api/orders/' + encodeURIComponent(state.orderDetail.order.order_id) + '/actions', { method: 'POST', body: JSON.stringify(payload) });
    toast(refundAction ? (result.refund.status === 'succeeded' ? '支付宝退款成功' : '退款已受理，等待支付宝确认') : externalRefundAction ? '已核验支付宝全额退款，并同步平台' : rejectAction ? '退款申请已驳回并记录审核原因' : manualDeliveryAction ? '已登记人工完成充值，订单已履约成功，未执行退款' : beginTakeoverAction ? (preSubmitTakeoverAction ? '未领取任务已安全终止，人工接管锁已生效' : '已开始人工接管；自动重提与退款已锁定') : takeoverIssueAction ? '已转人工核查，接管锁保持生效' : releaseTakeoverAction ? '人工复核已记录，接管锁已解除' : closeTestAction ? '内部测试单已关闭，未执行退款' : '订单状态已更新并记录审计日志');
    await Promise.all([loadFinance(), loadOperations(), loadCustomers(), loadOrders(), loadFulfillment()]);
    await viewOrder(state.orderDetail.order.order_id);
  } catch (error) { toast(error.message); }
}
window.viewOrder = viewOrder;
window.closeOrderModal = closeOrderModal;

async function loadOperations(background) {
  const data = await api('/admin/api/operations', { background: Boolean(background) });
  const nextKeys = new Set((data.alerts || []).map(function(item) { return [item.type, item.ref, item.occurred_at].join(':'); }));
  const newAlerts = state.operations ? (data.alerts || []).filter(function(item) { return !state.alertKeys.has([item.type, item.ref, item.occurred_at].join(':')); }) : [];
  state.alertKeys = nextKeys;
  state.operations = data;
  renderDashboardOperations();
  renderRisk();
  if (newAlerts.length) toast('新增 ' + newAlerts.length + ' 项运营待办，请及时处理');
}
function renderAlert(alert) {
  const orderId = String(alert.ref || '').split(':')[0];
  const canOpen = /^UP[A-Z0-9]+$/i.test(orderId);
  const action = canOpen ? '<span class="task-action"><span>处理</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg></span>' : '<span class="tag bad">待处理</span>';
  const content = '<div class="task-icon">!</div><div class="task-main"><b>' + esc(alert.title || alert.type) + '</b><span>' + esc(alert.message || '') + '</span><small>' + beijingTime(alert.occurred_at) + '</small></div>' + action;
  return canOpen
    ? '<button type="button" class="task task-link" onclick="openAlertOrder(\'' + encodeURIComponent(orderId) + '\')">' + content + '</button>'
    : '<div class="task">' + content + '</div>';
}
function openAlertOrder(encodedOrderId) {
  go('orders');
  viewOrder(decodeURIComponent(encodedOrderId));
}
window.openAlertOrder = openAlertOrder;
function renderRisk() {
  if (!state.operations) return;
  const data = state.operations;
  $('#riskAlertTotal').textContent = number((data.alerts || []).length);
  $('#riskStale').textContent = number(data.activations.stale);
  $('#riskRefund').textContent = number(Number(data.refunds.requested || 0) + Number(data.refunds.processing || 0) + Number(data.refunds.failed || 0));
  $('#riskAlerts').innerHTML = data.alerts.length ? data.alerts.map(renderAlert).join('') : '<div class="notice good">当前没有履约失败、超时任务或回调耗尽告警。</div>';
  const hooks = data.recentWebhooks || [];
  $('#webhookTable').innerHTML = hooks.length ? '<div class="table-wrap"><table><thead><tr><th>事件</th><th>事件唯一键</th><th>投递状态</th><th>尝试次数</th><th>最近错误</th><th>创建时间</th></tr></thead><tbody>' + hooks.map(function(row) {
    const label = row.delivered_at ? '已送达' : row.exhausted_at ? '已耗尽' : '等待/重试';
    const tone = row.delivered_at ? 'good' : row.exhausted_at ? 'bad' : 'warn';
    return '<tr><td><strong>' + esc(translated('webhook', row.event)) + '</strong></td><td>' + esc(row.event_key) + '</td><td>' + statusTag(label, tone) + '</td><td>' + number(row.attempt_count) + '</td><td>' + esc(row.last_error || '-') + '</td><td>' + beijingTime(row.created_at) + '</td></tr>';
  }).join('') + '</tbody></table></div>' : '<div class="empty">暂无回调记录</div>';
}

function renderTestProducts() {
  const select = $('#testProduct');
  if (!select) return;
  const available = state.products.filter(function(product) { return product.enabled && product.plan !== 'x_premium_3m' && product.plan !== 'x_premium_6m'; });
  select.innerHTML = available.length ? available.map(function(product) {
    return '<option value="' + esc(product.product) + '" data-price="' + esc(product.cost_price) + '">' + esc(product.name_zh) + '（最低 ' + money(product.cost_price) + '）</option>';
  }).join('') : '<option value="">暂无启用商品</option>';
  select.disabled = !available.length;
  $('#createTestOrder').disabled = !available.length;
  syncTestPrice();
}
function syncTestPrice() {
  const option = $('#testProduct') && $('#testProduct').selectedOptions[0];
  if (option && option.dataset.price) $('#testPrice').value = option.dataset.price;
}
function renderManualProducts() {
  const select = $('#manualProduct');
  if (!select) return;
  const available = state.products.filter(function(product) { return product.enabled && product.plan !== 'x_premium_3m' && product.plan !== 'x_premium_6m'; });
  select.innerHTML = available.length ? available.map(function(product) {
    return '<option value="' + esc(product.product) + '" data-price="' + esc(product.cost_price) + '">' + esc(product.name_zh) + '（最低 ' + money(product.cost_price) + '）</option>';
  }).join('') : '<option value="">暂无启用商品</option>';
  select.disabled = !available.length;
  syncManualPrice();
}
function syncManualPrice() {
  const option = $('#manualProduct') && $('#manualProduct').selectedOptions[0];
  if (option && option.dataset.price) $('#manualPrice').value = option.dataset.price;
}
function openManualOrderModal() {
  const form = $('#manualOrderForm');
  form.reset();
  renderManualProducts();
  form.received_at.value = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
  form.classList.remove('hidden');
  $('#manualOrderResult').classList.add('hidden');
  $('#manualOrderModal').classList.remove('hidden');
}
function closeManualOrderModal() { $('#manualOrderModal').classList.add('hidden'); }
window.closeManualOrderModal = closeManualOrderModal;
async function loadTestOrders() {
  try {
    const data = await api('/admin/api/test/orders');
    const select = $('#existingTestOrder');
    const previous = select.value;
    select.innerHTML = data.items.length ? '<option value="">请选择已付款测试单</option>' + data.items.map(function(order) {
      return '<option value="' + esc(order.order_id) + '">' + esc(order.client_order_id) + ' · ' + esc(order.product) + ' · ' + money(order.amount) + ' · ' + beijingTime(order.paid_at) + '</option>';
    }).join('') : '<option value="">暂无已付款测试单</option>';
    if (data.items.some(function(order) { return order.order_id === previous; })) select.value = previous;
    $('#loadExistingTestOrder').disabled = !data.items.length;
  } catch (error) {
    $('#existingTestOrder').innerHTML = '<option value="">读取失败，请刷新</option>';
    $('#loadExistingTestOrder').disabled = true;
  }
}
async function selectExistingTestOrder() {
  const id = $('#existingTestOrder').value;
  if (!id) return toast('请先选择已付款测试单');
  try {
    const data = await api('/admin/api/test/orders/' + encodeURIComponent(id));
    showTestOrder(data);
    toast('已载入测试订单');
  } catch (error) { toast(error.message); }
}
function showTestOrder(data) {
  state.testOrder = data;
  $('#testOrderPanel').classList.remove('hidden');
  $('#testOrderId').textContent = data.order_id;
  $('#testOrderAmount').textContent = money(data.amount);
  $('#testOrderExpiry').textContent = beijingTime(data.expires_at);
  $('#testPayLink').href = data.qr || '#';
  $('#testQrImage').src = data.qr_image_url || '';
  $('#testQrImage').classList.toggle('hidden', !data.qr_image_url);
  $('#testSessionPanel').classList.add('hidden');
  $('#testActivationPanel').classList.add('hidden');
  renderTestOrderStatus(data.status);
  startTestPolling();
}
function renderTestOrderStatus(status) {
  const names = { pending: '待支付', paid: '已支付', expired: '已过期', refunded: '已退款' };
  const tag = $('#testStatusTag');
  tag.textContent = names[status] || status;
  tag.className = 'tag ' + (status === 'paid' ? 'good' : status === 'pending' ? 'warn' : 'bad');
  if (status === 'paid') { $('#testSessionPanel').classList.remove('hidden'); setTestSteps(2); }
}
function setTestSteps(active) {
  [1, 2, 3].forEach(function(step) {
    const element = $('#testStep' + step);
    element.className = 'test-step ' + (step < active ? 'done' : step === active ? 'on' : '');
  });
}
function startTestPolling() {
  if (state.testTimer) clearInterval(state.testTimer);
  state.testTimer = setInterval(pollTestOrder, 3500);
  pollTestOrder();
}
async function pollTestOrder() {
  if (!state.testOrder) return;
  try {
    const data = await api('/admin/api/test/orders/' + encodeURIComponent(state.testOrder.order_id));
    renderTestOrderStatus(data.status);
    const items = data.activation && data.activation.items || [];
    const item = items[items.length - 1];
    if (item) {
      $('#testActivationPanel').classList.remove('hidden');
      const retry = item.status === 'failed' && data.activation.activation_remaining > 0;
      setTestSteps(retry ? 2 : 3);
      $('#testActivationTag').textContent = item.status === 'success' ? '充值成功' : retry ? '可重新提交' : item.status === 'failed' ? '充值失败' : '处理中';
      $('#testActivationTag').className = 'tag ' + (item.status === 'success' ? 'good' : item.status === 'failed' ? 'bad' : 'warn');
      $('#testActivationMessage').textContent = item.message_zh || '任务正在处理';
      if (retry) $('#testSessionPanel').classList.remove('hidden');
      if (item.finished && state.testTimer) { clearInterval(state.testTimer); state.testTimer = null; loadFinance(); loadOperations(); loadOrders(); loadFulfillment(); }
    }
    if (data.status === 'expired' && state.testTimer) { clearInterval(state.testTimer); state.testTimer = null; }
  } catch (error) {}
}

function openCost(id, amount, currency, cny) {
  const form = $('#costForm');
  form.order_id.value = id;
  form.amount.value = amount;
  form.currency.value = currency;
  form.cny.value = cny;
  $('#costModal').classList.remove('hidden');
}
function closeCost() { $('#costModal').classList.add('hidden'); }
window.openCost = openCost;
window.closeCost = closeCost;

$('#loginForm').onsubmit = async function(event) {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#login').classList.add('hidden');
    $('#password').value = '';
    await loadAll();
    startAutoRefresh();
  } catch (error) { $('#loginError').textContent = error.message; }
};
$('#logout').onclick = async function() { await api('/admin/api/logout', { method: 'POST' }); location.reload(); };
$('#configForm').onsubmit = async function(event) {
  event.preventDefault();
  const form = event.target;
  const payload = {
    payment_mode: form.payment_mode.value,
    alipay_app_id: form.alipay_app_id.value.trim(),
    alipay_seller_id: form.alipay_seller_id.value.trim(),
    alipay_private_key: form.alipay_private_key.value.trim(),
    alipay_public_key: form.alipay_public_key.value.trim(),
    zovo_mode: form.zovo_mode.value,
    zovo_app_id: form.zovo_app_id.value.trim(),
    zovo_api_key: form.zovo_api_key.value.trim()
  };
  if (!await confirmAction('正式模式下修改密钥会立即影响新订单，请确保内容准确。', { title: '保存渠道配置？', confirmText: '确认保存', danger: true })) return;
  try {
    await api('/admin/api/config', { method: 'PUT', body: JSON.stringify(payload) });
    form.alipay_private_key.value = '';
    form.alipay_public_key.value = '';
    form.zovo_api_key.value = '';
    toast('渠道配置已保存');
    await loadConfig();
    await loadProducts();
  } catch (error) { toast(error.message); }
};
async function runOrderQuery() {
  state.orderPage = 1;
  try { await loadOrders(); toast('订单列表已刷新'); } catch (error) { toast(error.message); }
}
async function runFulfillmentQuery() {
  state.fulfillmentPage = 1;
  try { await loadFulfillment(); toast('履约列表已刷新'); } catch (error) { toast(error.message); }
}
async function runCustomerQuery() {
  state.customerPage = 1;
  try { await loadCustomers(); toast('客户列表已刷新'); } catch (error) { toast(error.message); }
}
async function runInvoiceQuery() {
  state.invoicePage = 1;
  try { await loadInvoices(); toast('开票单记录已刷新'); } catch (error) { toast(error.message); }
}
$('#orderQuery').onclick = runOrderQuery;
$('#orderSearch').onkeydown = function(event) { if (event.key === 'Enter') { event.preventDefault(); runOrderQuery(); } };
$('#orderStatus').onchange = runOrderQuery;
$('#orderPageSize').onchange = runOrderQuery;
$('#fulfillmentQuery').onclick = runFulfillmentQuery;
$('#fulfillmentSearch').onkeydown = function(event) { if (event.key === 'Enter') { event.preventDefault(); runFulfillmentQuery(); } };
$('#fulfillmentStatus').onchange = runFulfillmentQuery;
$('#fulfillmentPageSize').onchange = runFulfillmentQuery;
$('#openManualOrder').onclick = openManualOrderModal;
$('#manualProduct').onchange = syncManualPrice;
$('#manualOrderForm').onsubmit = async function(event) {
  event.preventDefault();
  const form = event.target;
  if (!form.product.value) return toast('请先选择可售商品');
  if (!await confirmAction('请确认现金已经实际收取。系统会按当前金额与时间创建已付款订单，并写入财务及审计记录。', { title: '确认现金收款？', confirmText: '已收款，创建订单', danger: true })) return;
  try {
    const data = await api('/admin/api/manual-orders', {
      method: 'POST',
      body: JSON.stringify({
        product: form.product.value,
        sell_price: Number(form.sell_price.value).toFixed(2),
        collection_method: form.collection_method.value,
        received_at: new Date(form.received_at.value + ':00+08:00').toISOString(),
        payment_reference: form.payment_reference.value.trim(),
        customer_ref: form.customer_ref.value.trim(),
        note: form.note.value.trim()
      })
    });
    form.classList.add('hidden');
    $('#manualOrderResult').classList.remove('hidden');
    $('#manualOrderAmount').textContent = money(data.amount);
    $('#manualOrderFacts').innerHTML = '<div class="result-row"><span>人工订单号</span><strong>' + esc(data.client_order_id) + '</strong></div><div class="result-row"><span>我方订单号</span><strong>' + esc(data.order_id) + '</strong></div><div class="result-row"><span>客户标识</span><strong>' + esc(data.customer_ref) + '</strong></div><div class="result-row"><span>收款方式</span><strong>现金收款</strong></div><div class="result-row"><span>收款凭证号</span><strong>' + esc(data.payment_reference) + '</strong></div><div class="result-row"><span>收款时间</span><strong>' + beijingTime(data.paid_at) + '</strong></div>';
    toast('现金收款订单已补录并记为已付款');
    await Promise.all([loadFinance(), loadOrders(), loadFulfillment()]);
  } catch (error) { toast(error.message); }
};
$('#customerQuery').onclick = runCustomerQuery;
$('#customerSearch').onkeydown = function(event) { if (event.key === 'Enter') { event.preventDefault(); runCustomerQuery(); } };
$('#customerPageSize').onchange = runCustomerQuery;
$('#lookupInvoiceOrder').onclick = lookupInvoiceOrder;
$('#invoiceOrderNumber').onkeydown = function(event) { if (event.key === 'Enter') { event.preventDefault(); lookupInvoiceOrder(); } };
$('#invoiceQuery').onclick = runInvoiceQuery;
$('#invoiceSearch').onkeydown = function(event) { if (event.key === 'Enter') { event.preventDefault(); runInvoiceQuery(); } };
$('#invoiceStatus').onchange = runInvoiceQuery;
$('#invoicePageSize').onchange = runInvoiceQuery;
$('#invoiceRequestForm').title_type.onchange = function() {
  const company = this.value === 'company';
  $('#invoiceRequestForm').tax_id.required = company;
  $('#invoiceRequestForm').tax_id.placeholder = company ? '企业抬头必填' : '个人抬头可不填';
  $$('.company-invoice-field').forEach(function(field) { field.classList.toggle('hidden', !company); });
};
$('#invoiceRequestForm').onsubmit = async function(event) {
  event.preventDefault();
  const form = event.target;
  if (!state.invoiceOrder) return toast('请先查询并核对订单');
  if (!await confirmAction('本次开票金额为 ' + money(state.invoiceOrder.receipt_amount) + '，生成后将进入财务待办。', { title: '生成开票单？', confirmText: '确认生成' })) return;
  try {
    const data = await api('/admin/api/invoices', {
      method: 'POST',
      body: JSON.stringify({
        order_number: form.order_number.value,
        title_type: form.title_type.value,
        title: form.title.value.trim(),
        tax_id: form.tax_id.value.trim(),
        unit_address: form.unit_address.value.trim(),
        phone: form.phone.value.trim(),
        bank_name: form.bank_name.value.trim(),
        bank_account: form.bank_account.value.trim(),
        recipient_email: form.recipient_email.value.trim(),
        request_note: form.request_note.value.trim()
      })
    });
    resetInvoiceLookup();
    toast('开票单 ' + data.invoice.invoice_id + ' 已生成，等待财务开票');
    await loadInvoices();
  } catch (error) { toast(error.message); }
};
$('#invoiceIssueForm').onsubmit = async function(event) {
  event.preventDefault();
  const form = event.target;
  if (!await confirmAction('请确认电子发票已经真实开具，发票号码、日期和接收信息均已核对无误。', { title: '登记已开票？', confirmText: '确认登记' })) return;
  try {
    await api('/admin/api/invoices/' + encodeURIComponent(form.invoice_id.value) + '/issue', {
      method: 'POST',
      body: JSON.stringify({
        invoice_number: form.invoice_number.value.trim(),
        invoice_date: form.invoice_date.value,
        invoice_url: form.invoice_url.value.trim(),
        issue_note: form.issue_note.value.trim()
      })
    });
    closeInvoiceIssueModal();
    toast('开票结果已登记');
    await loadInvoices();
  } catch (error) { toast(error.message); }
};
$$('.date-preset').forEach(function(button) {
  button.onclick = async function() {
    setDatePreset(button.dataset.days);
    state.financePage = 1;
    try {
      await loadFinance();
      toast('统计区间已切换为' + $('#financeRangeLabel').textContent);
    } catch (error) { toast(error.message); }
  };
});
['from', 'to', 'orderFrom', 'orderTo', 'fulfillmentFrom', 'fulfillmentTo', 'invoiceFrom', 'invoiceTo', 'settlementFrom', 'settlementTo'].forEach(function(id) {
  const input = $('#' + id);
  const picker = $('#' + id + 'Picker');
  input.oninput = function() { input.removeAttribute('aria-invalid'); if (id === 'from' || id === 'to') markCustomDateRange(); };
  input.onblur = function() { normalizeReportDateField(id, true); };
  picker.onchange = function() {
    if (!picker.value) return;
    input.value = picker.value;
    input.removeAttribute('aria-invalid');
    if (id === 'from' || id === 'to') markCustomDateRange();
  };
});
$('#query').onclick = async function() {
  try {
    state.financePage = 1;
    await loadFinance();
    toast('财务数据已刷新');
  } catch (error) { toast(error.message); }
};
$('#financePageSize').onchange = function() { state.financePage = 1; loadFinance().catch(function(error) { toast(error.message); }); };
$('#export').onclick = function() {
  try {
    const dates = reportDates();
    toast('正在生成 CSV 文件');
    location.href = '/admin/api/finance.csv?from=' + encodeURIComponent(dates.from) + '&to=' + encodeURIComponent(dates.to);
  } catch (error) { toast(error.message); }
};
async function runSettlementQuery() {
  try {
    state.settlementPage = 1;
    await loadSettlements();
    toast('结算单已按当前条件刷新');
  } catch (error) { toast(error.message); }
}
$('#settlementQuery').onclick = runSettlementQuery;
$('#settlementStatus').onchange = runSettlementQuery;
$('#settlementPageSize').onchange = runSettlementQuery;
$('#settlementSearch').onkeydown = function(event) { if (event.key === 'Enter') { event.preventDefault(); runSettlementQuery(); } };
$('#settlementCurrency').onchange = syncSettlementPaymentAmount;
$('#createSettlement').onclick = createSettlement;
$('#settlementPaymentForm').onsubmit = async function(event) {
  event.preventDefault();
  const form = event.target;
  const fields = form.elements;
  const currency = fields.namedItem('currency').value;
  const amountNumber = Number(fields.namedItem('amount').value);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) return toast('请输入本次实际付款金额');
  const amount = amountNumber.toFixed(2);
  if (!await confirmAction('请确认已实际向平台支付 ' + amount + ' ' + currency + '。系统只登记本次付款，不会自动转账或退款。', { title: '确认登记付款？', confirmText: '确认已付款', danger: true })) return;
  try {
    const paidAt = new Date(fields.namedItem('paid_at').value + ':00+08:00').toISOString();
    await api('/admin/api/platform-settlements/' + encodeURIComponent(fields.namedItem('settlement_id').value) + '/payment', {
      method: 'POST',
      body: JSON.stringify({ currency: currency, amount: amount, method: fields.namedItem('method').value, reference: fields.namedItem('reference').value.trim(), note: fields.namedItem('note').value.trim(), paid_at: paidAt })
    });
    closeSettlementModal();
    toast('本次平台付款已登记，结算单核销状态已更新');
    await Promise.all([loadFinance(), loadSettlements()]);
  } catch (error) { toast(error.message); }
};
$('#testProduct').onchange = syncTestPrice;
$('#loadExistingTestOrder').onclick = selectExistingTestOrder;
$('#testOrderForm').onsubmit = async function(event) {
  event.preventDefault();
  try {
    const data = await api('/admin/api/test/orders', {
      method: 'POST',
      body: JSON.stringify({ product: $('#testProduct').value, sell_price: Number($('#testPrice').value).toFixed(2) })
    });
    showTestOrder(data);
    setTestSteps(1);
    toast('测试订单已创建，尚未扣款');
  } catch (error) { toast(error.message); }
};
$('#refreshTestPayment').onclick = async function() {
  if (!state.testOrder) return;
  try {
    await api('/admin/api/test/orders/' + encodeURIComponent(state.testOrder.order_id) + '/refresh-payment', { method: 'POST' });
    await pollTestOrder();
    toast('支付宝订单状态已查询');
  } catch (error) { toast(error.message); }
};
$('#testSession').oninput = function() { $('#testEmailBox').classList.add('hidden'); $('#submitTestActivation').disabled = true; };
$('#inspectTestSession').onclick = async function() {
  if (!state.testOrder) return;
  const session = $('#testSession').value.trim();
  if (!session) return toast('请先粘贴 Session JSON');
  try {
    const data = await api('/admin/api/test/orders/' + encodeURIComponent(state.testOrder.order_id) + '/inspect-session', {
      method: 'POST', body: JSON.stringify({ session_data: session })
    });
    $('#testEmail').textContent = data.email;
    $('#testEmailBox').classList.remove('hidden');
    $('#submitTestActivation').disabled = false;
    toast('Session 格式校验通过，请核对邮箱');
  } catch (error) { toast(error.message); }
};
$('#submitTestActivation').onclick = async function() {
  if (!state.testOrder || this.disabled) return;
  const email = $('#testEmail').textContent;
  if (!await confirmAction('充值账号：' + email + '\n提交后会真实购买充值码并扣除上游余额，且不会自动退款。', { title: '确认提交充值？', confirmText: '确认充值', danger: true })) return;
  try {
    const data = await api('/admin/api/test/orders/' + encodeURIComponent(state.testOrder.order_id) + '/activate', {
      method: 'POST', body: JSON.stringify({ session_data: $('#testSession').value })
    });
    $('#testSession').value = '';
    $('#submitTestActivation').disabled = true;
    $('#testActivationPanel').classList.remove('hidden');
    $('#testActivationMessage').textContent = data.message_zh;
    setTestSteps(3);
    startTestPolling();
    toast('充值任务已提交');
  } catch (error) { toast(error.message); }
};
$('#costForm').onsubmit = async function(event) {
  event.preventDefault();
  const form = event.target;
  try {
    await api('/admin/api/orders/' + encodeURIComponent(form.order_id.value) + '/cost', {
      method: 'PUT', body: JSON.stringify({ amount: form.amount.value || null, currency: form.currency.value || null, cny: form.cny.value })
    });
    closeCost();
    toast('实际成本已登记');
    await loadFinance();
  } catch (error) { toast(error.message); }
};
$('#refreshOrderPayment').onclick = refreshOrderPayment;
$('#submitOrderAction').onclick = submitOrderAction;
$('#openPlatformRebate').onclick = openPlatformRebateModal;
$('#platformRebateForm').onsubmit = async function(event) {
  event.preventDefault();
  const form = event.target;
  const standard = Number(form.standard_usd.value || 0).toFixed(2);
  const actual = Number(form.actual_usd.value || 0).toFixed(2);
  const fee = Number(form.fee_usd.value || 0).toFixed(2);
  const rebate = Number(standard) - Number(actual) - Number(fee);
  if (rebate <= 0) return toast('扣除手续费后没有应返平台的美元差价');
  if (!await confirmAction('本次登记平台美元差价 ' + usd(rebate) + '。\n\n记录会在每天 22:00 自动进入平台结算单；现在不会自动转账或退款。', { title: '确认登记平台美元差价？', confirmText: '确认登记' })) return;
  const orderId = form.order_id.value;
  try {
    await api('/admin/api/orders/' + encodeURIComponent(orderId) + '/platform-rebate', {
      method: 'PUT',
      body: JSON.stringify({
        standard_usd: standard,
        actual_usd: actual,
        fee_usd: fee,
        card_transaction_id: form.card_transaction_id.value.trim(),
        reason: form.reason.value.trim()
      })
    });
    closePlatformRebateModal();
    toast('平台美元差价已登记，将在 22:00 自动进入结算单');
    await Promise.all([loadFinance(), loadOrders(), loadFulfillment()]);
    await viewOrder(orderId);
  } catch (error) { toast(error.message); }
};
$('#openCustomerPriceRefund').onclick = openCustomerPriceRefundModal;
$('#customerPriceRefundForm').onsubmit = async function(event) {
  event.preventDefault();
  const form = event.target;
  const amount = Number(form.amount.value || 0).toFixed(2);
  if (!await confirmAction('请确认已经实际向用户退还 ' + money(amount) + '。\n\n这里只登记财务结果，不会自动发起退款；保存后将减少同额平台利润。', { title: '确认登记补差退款？', confirmText: '已退款，确认登记', danger: true })) return;
  try {
    await api('/admin/api/orders/' + encodeURIComponent(form.order_id.value) + '/customer-price-refund', {
      method: 'PUT',
      body: JSON.stringify({
        amount: amount,
        reference: form.reference.value.trim(),
        reason: form.reason.value.trim(),
        refunded_at: new Date(form.refunded_at.value + ':00+08:00').toISOString()
      })
    });
    closeCustomerPriceRefundModal();
    toast('补差退款已登记，平台利润已重新计算');
    await Promise.all([loadFinance(), loadDailyMetrics(), loadOrders(), loadFulfillment()]);
    await viewOrder(form.order_id.value);
  } catch (error) { toast(error.message); }
};
$('#manualSession').oninput = function() {
  $('#manualEmail').textContent = '';
  $('#manualEmailBox').classList.add('hidden');
  $('#submitManualActivation').disabled = true;
};
$('#inspectManualSession').onclick = async function() {
  if (!state.orderDetail || state.orderDetail.order.order_source !== 'manual') return;
  const session = $('#manualSession').value.trim();
  if (!session) return toast('请先粘贴 Session JSON');
  try {
    const data = await api('/admin/api/manual-orders/' + encodeURIComponent(state.orderDetail.order.order_id) + '/inspect-session', {
      method: 'POST', body: JSON.stringify({ session_data: session })
    });
    $('#manualEmail').textContent = data.email;
    $('#manualEmailBox').classList.remove('hidden');
    $('#submitManualActivation').disabled = false;
    toast('Session 格式校验通过，请核对邮箱');
  } catch (error) { toast(error.message); }
};
$('#submitManualActivation').onclick = async function() {
  if (!state.orderDetail || this.disabled) return;
  const orderId = state.orderDetail.order.order_id;
  const email = $('#manualEmail').textContent;
  if (!await confirmAction('充值账号：' + email + '\n该订单为现金收款，提交后会真实消耗上游资源，操作会写入审计链路。', { title: '确认提交现金订单履约？', confirmText: '确认充值', danger: true })) return;
  try {
    const data = await api('/admin/api/manual-orders/' + encodeURIComponent(orderId) + '/activate', {
      method: 'POST', body: JSON.stringify({ session_data: $('#manualSession').value })
    });
    $('#manualSession').value = '';
    $('#submitManualActivation').disabled = true;
    toast(data.message_zh || '充值任务已提交');
    await Promise.all([loadFinance(), loadOperations(), loadCustomers(), loadOrders(), loadFulfillment()]);
    await viewOrder(orderId);
  } catch (error) { toast(error.message); }
};

async function loadAll() {
  setDatePreset(1);
  setListDateRange('order', 30);
  setListDateRange('fulfillment', 30);
  setListDateRange('invoice', 30);
  setListDateRange('settlement', 30);
  await Promise.all([loadConfig(), loadProducts(), loadFinance(), loadSettlements(), loadDailyMetrics(), loadOperations(), loadCustomers(), loadOrders(), loadFulfillment(), loadInvoices()]);
  await loadTestOrders();
  if (window.loadLedger) await window.loadLedger();
  if (window.loadReviewQueue) await window.loadReviewQueue();
}
async function autoRefresh() {
  if (document.hidden || activeRequests || state.testTimer) return;
  if (!$('#login').classList.contains('hidden')) return;
  if (!$('#orderModal').classList.contains('hidden') || !$('#customerModal').classList.contains('hidden') || !$('#costModal').classList.contains('hidden') || !$('#ledgerEditor').classList.contains('hidden') || !$('#customerPriceRefundModal').classList.contains('hidden') || !$('#platformRebateModal').classList.contains('hidden') || !$('#settlementModal').classList.contains('hidden') || !$('#invoiceIssueModal').classList.contains('hidden') || !$('#manualOrderModal').classList.contains('hidden')) return;
  try {
    const activeView = $('.view.on') ? $('.view.on').id : 'dashboard';
    const jobs = [loadFinance(true), loadDailyMetrics(true), loadOperations(true)];
    if (activeView === 'orders') jobs.push(loadOrders(undefined, true));
    if (activeView === 'fulfillment') jobs.push(loadFulfillment(undefined, true));
    if (activeView === 'customers') jobs.push(loadCustomers(undefined, true));
    if (activeView === 'invoices') jobs.push(loadInvoices(true));
    if (activeView === 'finance' && state.financeTab === 'settlements') jobs.push(loadSettlements(true));
    await Promise.all(jobs);
  } catch (error) {}
}
function startAutoRefresh() {
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = setInterval(autoRefresh, 10000);
}
document.addEventListener('visibilitychange', function() { if (!document.hidden) autoRefresh(); });
(async function() {
  try {
    await api('/admin/api/session');
    $('#login').classList.add('hidden');
    await loadAll();
    startAutoRefresh();
  } catch (error) {}
})();
`;
