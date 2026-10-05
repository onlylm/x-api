type Row = Record<string, unknown>
const count = (value: unknown) => Number(value ?? 0)

export function OperationsHome({ summary }: { summary: Row }) {
  const admission = (summary.admission ?? {}) as Row
  const unknown = count(admission.unknown_orders)
  const queued = count(admission.queued_orders)
  const executing = count(admission.executing_orders)
  const failedCallbacks = count(summary.failed_webhooks)
  const blockedId = typeof admission.blocked_order_id === 'string' ? admission.blocked_order_id : ''
  const actionHref = blockedId ? `#orders?status=unknown&q=${encodeURIComponent(blockedId)}` : '#orders?status=unknown'
  return <section className="operations-home" aria-label="日常业务工作台">
    <div className="operations-status">
      <div>
        <span className={`status ${admission.accepts_orders ? 'status-ACTIVE' : 'status-unknown'}`}>{admission.accepts_orders ? '正在接单' : '暂停接收新订单'}</span>
        <h2>{unknown ? `${unknown} 笔原单需要核对` : executing ? '订单正在逐笔付款' : queued ? '订单已进入执行队列' : '当前没有待处理订单'}</h2>
        <p>{unknown ? '付款结果尚未确认，后续订单继续保留在队列中。先处理原单，不要重复付款。' : String(admission.reason_message || '卡密兑换后的订单会进入队列；无需逐笔手动启动。')}</p>
      </div>
      <a className="workspace-action-link" href={unknown ? actionHref : '#orders'}>{unknown ? '处理待核对原单' : '查看订单队列'}</a>
    </div>
    <dl className="operations-numbers">
      <div><dt>排队等待</dt><dd><a href="#orders?status=queued">{queued} <small>笔</small></a></dd></div>
      <div><dt>正在执行</dt><dd><a href="#orders?status=running">{executing} <small>笔</small></a></dd></div>
      <div><dt>今日接单额度</dt><dd><a href="#admission">{count(admission.used)} <small>/ {count(admission.daily_limit)} 笔</small></a></dd></div>
    </dl>
    <section className="operations-tasks" aria-labelledby="daily-actions-title">
      <h2 id="daily-actions-title">常用操作</h2>
      <div className="operations-links">
        <a href="#vouchers"><strong>生成与管理卡密</strong><span>选商户、发卡、追踪兑换</span></a>
        <a href="/redeem" target="_blank" rel="noopener noreferrer"><strong>打开客户兑换入口</strong><span>客户仅需卡密和 X 用户名</span></a>
        <a href="#payment"><strong>查看付款配置</strong><span>主卡、备用卡与付款状态</span></a>
      </div>
    </section>
    {!admission.execution_ready && <p className="notice">X 付款尚未就绪或已停用。<a className="text-link" href="#payment">检查付款设置</a></p>}
    {failedCallbacks > 0 && <p className="notice">有 {failedCallbacks} 条回调未送达，不代表订单付款失败。<a className="text-link" href="#webhooks">查看回调记录</a></p>}
    <details className="settings-checks operations-account">
      <summary>账户与服务详情</summary>
      <dl className="details">
        <div><dt>商户账户</dt><dd>{count(summary.users)}</dd></div>
        <div><dt>可用点数</dt><dd>{count(summary.available)}</dd></div>
        <div><dt>冻结点数</dt><dd>{count(summary.frozen)}</dd></div>
        <div><dt>代理出口能力</dt><dd>{summary.proxy_gateway_ready ? '已配置' : '未配置'}</dd></div>
      </dl>
      <p className="note">点数账本与卡台美元余额分别管理。今日额度按北京时间 00:00 重置，不会清除待核对订单。</p>
    </details>
  </section>
}
