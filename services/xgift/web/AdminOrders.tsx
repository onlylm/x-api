import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { Table } from '@cloudflare/kumo/components/table'
import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut, CheckCircle, Clock, WarningCircle, X } from '@phosphor-icons/react'
import { AlipayOrders } from './AlipaySettings'
import { AdminDirectGift } from './AdminDirectGift'
import type { Request } from './Recharge'
import { orderFailureDescription } from './order-failures'
import { isClosedOrder, orderActions, orderNextStep, orderProduct, ordersHash, orderStateText, parseOrdersHash, safePaymentPage, type OrderRow, type OrdersView } from './order-ui'
import { useUnsavedChanges } from './unsaved-changes'
import './orders-console.css'

type QueueView = {
  queued_orders: number; executing_orders: number; unknown_orders: number
  queue_blocked: boolean; blocked_order_id: string | null
  accepts_orders: boolean; reason_message: string | null
  used: number; daily_limit: number; remaining: number; execution_ready: boolean
}
type CheckResult = { order_id: string; status: string; failure_code?: string | null; checked: boolean; message: string }
type Action = 'check' | 'payment-page' | 'close'
const filters = [['active', '待办'], ['unknown', '待核对'], ['', '全部']] as const
const detailedFilters = [['queued', '排队中'], ['running', '执行中'], ['succeeded', '付款已确认'], ['failed', '已结束']] as const
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作结果未确认，请刷新原订单核对。'
const time = (value?: number) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
const source = (row: OrderRow) => row.mode === 'voucher' ? '卡密兑换' : row.merchant_order_no.startsWith('alipay:') ? '历史支付宝' : '商户直充'

export function AdminOrders({ request, onError, refreshVersion }: { request: Request; onError: (error: unknown) => void; refreshVersion: number }) {
  const [view, setView] = useState(() => parseOrdersHash(window.location.hash))
  const { status, page, query } = view
  const [search, setSearch] = useState(view.query), [history, setHistory] = useState(false)
  const [giftOpen, setGiftOpen] = useState(false)
  const [rows, setRows] = useState<OrderRow[]>([]), [queue, setQueue] = useState<QueueView | null>(null)
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [queueError, setQueueError] = useState('')
  const [message, setMessage] = useState(''), [actionError, setActionError] = useState(''), [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null), [closing, setClosing] = useState<OrderRow | null>(null)
  const [details, setDetails] = useState<OrderRow | null>(null), [detailError, setDetailError] = useState('')
  const [reason, setReason] = useState(''), [confirmation, setConfirmation] = useState('')
  const [paymentLink, setPaymentLink] = useState<{ id: string; url: string } | null>(null)
  const mounted = useRef(false), sequence = useRef(0), busyRef = useRef(false), onErrorRef = useRef(onError)
  const detailsRef = useRef(details), closingRef = useRef(closing), viewRef = useRef(view)
  onErrorRef.current = onError; detailsRef.current = details; closingRef.current = closing; viewRef.current = view
  useUnsavedChanges(!!busy || (!!closing && (!!reason.trim() || !!confirmation)))
  const reportAuth = useCallback((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 401) onErrorRef.current(error)
  }, [])

  const load = useCallback(async () => {
    if (busyRef.current) return
    const current = ++sequence.current, selected = detailsRef.current?.id
    setLoading(true)
    const results = await Promise.allSettled([
      request<OrderRow[]>(`/api/admin/orders?page=${page}${status ? `&status=${status}` : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`),
      request<QueueView>('/api/admin/admission'),
      selected ? request<OrderRow[]>(`/api/admin/orders?q=${encodeURIComponent(selected)}`) : Promise.resolve(null),
    ])
    if (!mounted.current || current !== sequence.current) return
    const [ordersResult, queueResult, detailResult] = results
    if (ordersResult.status === 'fulfilled') {
      setRows(ordersResult.value); setLoadError(''); setCheckedAt(Date.now())
      setPaymentLink((link) => {
        const original = ordersResult.value.find((row) => row.id === link?.id) ??
          (detailResult.status === 'fulfilled' ? detailResult.value?.find((row) => row.id === link?.id) : undefined)
        return link && original && orderActions(original).payment_page ? link : null
      })
    } else { setLoadError(errorText(ordersResult.reason)); reportAuth(ordersResult.reason); setPaymentLink(null) }
    if (queueResult.status === 'fulfilled') { setQueue(queueResult.value); setQueueError('') }
    else { setQueueError(errorText(queueResult.reason)); reportAuth(queueResult.reason) }
    if (selected && detailsRef.current?.id === selected) {
      if (detailResult.status === 'fulfilled') {
        const fresh = detailResult.value?.find((row) => row.id === selected)
        if (fresh) { setDetails(fresh); setDetailError('') }
        else { setDetailError('未取得这笔订单的最新状态，请刷新后核对。'); setDetails((row) => row ? { ...row, actions: undefined } : row) }
      } else {
        setDetailError(errorText(detailResult.reason)); reportAuth(detailResult.reason)
        setDetails((row) => row ? { ...row, actions: undefined } : row)
      }
    }
    setLoading(false)
  }, [request, page, status, query, reportAuth])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; sequence.current++ }
  }, [])
  useEffect(() => {
    setRows([]); setCheckedAt(null); setPaymentLink(null); setLoadError('')
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 10000)
    return () => { sequence.current++; window.clearInterval(timer) }
  }, [load, refreshVersion])
  useEffect(() => {
    const sync = () => {
      if (window.location.hash.split('?')[0] !== '#orders') return
      if (busyRef.current || closingRef.current) {
        window.history.replaceState(null, '', ordersHash(viewRef.current))
        return
      }
      const next = parseOrdersHash(window.location.hash)
      setView(next); setSearch(next.query)
    }
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  function navigate(next: OrdersView) {
    if (busyRef.current || closingRef.current) return
    setView(next); setSearch(next.query)
    if (window.location.hash !== ordersHash(next)) window.history.pushState(null, '', ordersHash(next))
  }
  function showDetails(row: OrderRow) { setDetails(row); setDetailError(''); setActionError(''); setMessage('') }
  function startClose(row: OrderRow) {
    if (!orderActions(row).close || busyRef.current) return
    setDetails(row); setClosing(row); setReason(''); setConfirmation(''); setActionError('')
  }
  function dismissDetails() {
    if (busyRef.current) return
    if (closing && (reason.trim() || confirmation) && !window.confirm('关闭原因尚未提交，确定放弃这次编辑？')) return
    setClosing(null); setDetails(null); setActionError(''); setPaymentLink(null)
  }

  async function action(row: OrderRow, kind: Action) {
    const allowed = orderActions(row)
    if (busyRef.current || !(kind === 'payment-page' ? allowed.payment_page : allowed[kind]) ||
      (kind === 'close' && (confirmation !== 'CLOSE_ORDER' || !reason.trim()))) return
    busyRef.current = true; sequence.current++; setBusy(`${row.id}:${kind}`); setActionError(''); setMessage(''); setLoading(false)
    try {
      const path = `/api/admin/orders/${encodeURIComponent(row.id)}/${kind}`
      if (kind === 'payment-page') {
        const result = await request<{ url: string }>(path), url = safePaymentPage(result.url)
        if (!url) throw new Error('原付款页面地址未通过检查，未打开任何页面。请核对原订单。')
        if (mounted.current) { setDetails(row); setPaymentLink({ id: row.id, url }) }
      } else if (kind === 'check') {
        const result = await request<CheckResult>(path, {})
        if (mounted.current) {
          setMessage(result.message || '已核对这一笔原订单；没有重新发起付款。')
          setDetails((selected) => selected?.id === row.id ? { ...selected, status: result.status, failure_code: result.failure_code, actions: undefined } : selected)
          setPaymentLink(null)
        }
      } else {
        await request(path, { reason: reason.trim(), confirmation: 'CLOSE_ORDER' })
        if (mounted.current) {
          setClosing(null); setReason(''); setConfirmation(''); setPaymentLink(null)
          setDetails((selected) => selected?.id === row.id ? { ...selected, status: 'failed', failure_code: 'cancelled_before_execution', actions: undefined } : selected)
          setMessage('订单已安全关闭，冻结点数已释放。卡密兑换记录继续保留，不会自动恢复为未使用。')
        }
      }
    } catch (error) {
      if (mounted.current) { setActionError(errorText(error)); setPaymentLink(null); reportAuth(error) }
    } finally {
      busyRef.current = false
      if (mounted.current) { setBusy(null); void load() }
    }
  }
  function submitClose(event: FormEvent) { event.preventDefault(); if (closing) void action(details?.id === closing.id ? details : closing, 'close') }

  const locked = !!busy || !!closing
  const selectedActions = details ? orderActions(details) : null
  const paymentReady = details && paymentLink?.id === details.id && selectedActions?.payment_page
  const blockedTarget = queue?.blocked_order_id ? ordersHash({ status: '', query: queue.blocked_order_id, page: 1 }) : null

  function rowActions(row: OrderRow) {
    const allowed = orderActions(row), needsVerification = allowed.reason_code === 'payment_requires_action'
    return <div className="oc-row-actions">
      {allowed.payment_page && needsVerification
        ? <Button size="sm" variant="secondary" disabled={locked || loading || !!loadError} onClick={() => { showDetails(row); void action(row, 'payment-page') }}>{busy === `${row.id}:payment-page` ? '正在获取…' : '获取原付款页'}</Button>
        : allowed.check && <Button size="sm" variant="secondary" disabled={locked || loading || !!loadError} onClick={() => { showDetails(row); void action(row, 'check') }}>{busy === `${row.id}:check` ? '正在核对…' : '核对原单'}</Button>}
      {!allowed.check && !needsVerification && <span className="oc-action-hint">{row.status === 'queued' ? '等待执行' : allowed.reason_code === 'executing' || row.status === 'running' ? '等待结果' : ['succeeded', 'failed'].includes(row.status) ? '无需操作' : '保留原单'}</span>}
      <Button size="sm" variant="ghost" disabled={locked} aria-label={`查看 @${row.recipient} 的订单详情`} onClick={() => showDetails(row)}>详情</Button>
    </div>
  }

  return <section className="orders-console" aria-label="赠送订单与执行队列">
    <details className="oc-history" onToggle={event => { if (event.currentTarget.open) setGiftOpen(true) }}>
      <summary>直接赠送<span>无需卡密 · 核验账号后扣点并入队</span></summary>
      {giftOpen && <div className="oc-history-content"><AdminDirectGift request={request} onCreated={load} /></div>}
    </details>
    <div className="oc-queue" aria-label="执行队列状态">
      <div className="oc-queue-description"><strong>执行队列</strong><span>{queue ? queue.accepts_orders ? '接受新订单' : '暂停新增接单' : '读取接单状态…'}<span aria-hidden="true"> · </span>今日 {queue ? `${queue.used} / ${queue.daily_limit}` : '—'} 笔</span></div>
      <dl className="oc-counts"><div><dt>排队中</dt><dd>{queue?.queued_orders ?? '—'}</dd></div><div><dt>执行中</dt><dd>{queue?.executing_orders ?? '—'}</dd></div><div><dt>待核对</dt><dd>{queue?.unknown_orders ?? '—'}</dd></div></dl>
    </div>
    {queueError && <p className="oc-notice oc-error" role="alert">队列状态未能刷新：{queueError}</p>}
    {queue?.queue_blocked && <div className="oc-blocked" role="status"><WarningCircle size={20} aria-hidden="true" /><div><strong>{queue.blocked_order_id ? '一笔原单待核对，后续订单正在等待' : '付款条件尚未就绪，队列已暂停执行'}</strong><p>{queue.blocked_order_id ? '从阻塞原单继续处理，队列中的其他订单会保留。' : '检查 X 付款设置后，已有订单将按顺序继续执行。'}</p></div>{blockedTarget ? <a className="oc-text-link" href={blockedTarget} onClick={(event) => { event.preventDefault(); if (!locked) navigate({ status: '', query: queue.blocked_order_id!, page: 1 }) }}>查看阻塞原单<ArrowRight size={16} /></a> : <a className="oc-text-link" href="#payment">检查付款设置<ArrowRight size={16} /></a>}</div>}
    {!queue?.accepts_orders && queue?.reason_message && <p className="oc-note">{queue.reason_message} <a className="oc-text-link" href="#admission">接单设置</a></p>}

    <div className="oc-toolbar">
      <div className="oc-filter-controls"><div className="oc-filters" role="group" aria-label="常用订单筛选">{filters.map(([value, label]) => <button type="button" key={value} disabled={locked} aria-pressed={status === value} onClick={() => navigate({ ...view, status: value, page: 1 })}>{label}</button>)}</div><label className="oc-status-select"><span>细分状态</span><select disabled={locked} value={detailedFilters.some(([value]) => value === status) ? status : ''} onChange={(event) => navigate({ ...view, status: event.target.value, page: 1 })}><option value="" disabled>选择具体状态</option>{detailedFilters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <Button variant="ghost" disabled={loading || locked} onClick={() => void load()}><ArrowClockwise size={16} />{loading ? '刷新中…' : '刷新'}</Button>
    </div>
    <form className="oc-search" onSubmit={(event) => { event.preventDefault(); navigate({ ...view, query: search.trim(), page: 1 }) }}>
      <Input label="查找原订单" placeholder="订单号、商户单号或 X 用户名" value={search} maxLength={128} disabled={locked} onChange={(event) => setSearch(event.target.value)} />
      <Button type="submit" variant="secondary" disabled={locked}>查询</Button>
      {query && <Button type="button" variant="ghost" disabled={locked} onClick={() => navigate({ ...view, query: '', page: 1 })}>清除查询</Button>}
    </form>
    {loadError && <p className="oc-notice oc-error" role="alert">订单未能刷新：{loadError} 下方如有记录，仅为上次确认结果。</p>}
    {message && !details && <p className="oc-notice" role="status">{message}</p>}
    {actionError && !details && <p className="oc-notice oc-error" role="alert">{actionError}</p>}

    <div className="oc-table-wrap" aria-busy={loading}>
      <Table className="oc-table">
        <Table.Header><Table.Row>{['接收账号', '套餐', '状态', '下一步'].map((label) => <Table.Head key={label}>{label}</Table.Head>)}</Table.Row></Table.Header>
        <Table.Body>{rows.map((row) => <Table.Row key={row.id}>
          <Table.Cell><div className="oc-account"><strong>@{row.recipient}</strong><small>{row.user_name || source(row)}</small></div></Table.Cell>
          <Table.Cell><span className="oc-product">{orderProduct(row.product_code)}</span></Table.Cell>
          <Table.Cell><div className="oc-state"><span className={`status status-${isClosedOrder(row) ? 'closed' : row.status}`}>{row.status === 'succeeded' ? <CheckCircle size={13} /> : row.status === 'unknown' ? <WarningCircle size={13} /> : ['queued', 'running'].includes(row.status) ? <Clock size={13} /> : null}{orderStateText(row)}{row.status === 'queued' && row.queue_position ? ` · 第 ${row.queue_position} 位` : ''}</span><small>{orderNextStep(row, queue?.queue_blocked)}</small></div></Table.Cell>
          <Table.Cell>{rowActions(row)}</Table.Cell>
        </Table.Row>)}
        {!rows.length && <Table.Row><Table.Cell colSpan={4}><div className="oc-empty" role="status">{loading ? <><span className="oc-skeleton" /><span className="oc-skeleton" /><span>正在读取订单队列…</span></> : loadError ? '未取得本页订单，请刷新重试。' : query ? <><strong>没有找到匹配的订单</strong><span>请核对订单号或 X 用户名，也可清除查询查看其他记录。</span></> : page > 1 ? <><strong>本页暂无订单</strong><Button variant="secondary" onClick={() => navigate({ ...view, page: 1 })}>返回第一页</Button></> : <><strong>{status === 'active' ? '当前没有待办订单' : status ? '当前没有此状态的订单' : '还没有赠送订单'}</strong><span>{status ? '可切换“全部订单”查看已完成的记录。' : '生成卡密并兑换后，订单会在这里按顺序执行。'}</span>{!status && <a className="oc-text-link" href="#vouchers">前往卡密管理<ArrowRight size={16} /></a>}</>}</div></Table.Cell></Table.Row>}
        </Table.Body>
      </Table>
    </div>
    <div className="oc-pager"><span>第 {page} 页 · 本页 {rows.length} 条{checkedAt && <small>更新于 {time(checkedAt)} · 每 10 秒自动刷新</small>}</span><Button variant="ghost" aria-label="上一页赠送订单" disabled={loading || locked || page === 1} onClick={() => navigate({ ...view, page: page - 1 })}><ArrowLeft size={16} /></Button><Button variant="ghost" aria-label="下一页赠送订单" disabled={loading || locked || !!loadError || rows.length < 30} onClick={() => navigate({ ...view, page: page + 1 })}><ArrowRight size={16} /></Button></div>
    <p className="oc-footnote">逐笔执行付款；同一 X 账号的未结订单会阻止重复下单。具体核对与关闭条件可在订单详情中查看。</p>
    <details className="oc-history" onToggle={(event) => setHistory(event.currentTarget.open)}>
      <summary>历史支付宝记录<span>仅供原单核对</span></summary>
      {history && <div className="oc-history-content"><p className="oc-note">支付宝已停止新购买。这里只保留历史收款与关联赠送记录。</p><AlipayOrders request={request} onError={onError} /></div>}
    </details>

    <Dialog.Root open={!!details} onOpenChange={(open) => { if (!open) dismissDetails() }}>
      <Dialog size="lg" className="x-modal oc-dialog">
        {closing ? <form onSubmit={submitClose}>
          <Dialog.Title className="oc-dialog-title">安全关闭订单</Dialog.Title>
          <Dialog.Description className="oc-dialog-description">@{closing.recipient} · {orderProduct(closing.product_code)}。系统会再次确认未创建付款，再关闭订单并释放冻结点数。关闭不会退款、重新扣款或恢复已兑换卡密。</Dialog.Description>
          <dl className="oc-close-summary"><div><dt>订单号</dt><dd><code>{closing.id}</code></dd></div><div><dt>冻结点数</dt><dd>{closing.points} 点</dd></div></dl>
          <div className="modal-fields"><Input label="关闭原因" value={reason} maxLength={200} required disabled={!!busy} onChange={(event) => setReason(event.target.value)} /><Input label="输入 CLOSE_ORDER 确认" value={confirmation} autoComplete="off" spellCheck={false} required disabled={!!busy} onChange={(event) => setConfirmation(event.target.value)} /></div>
          {selectedActions && !selectedActions.close && <p className="oc-notice" role="status">订单状态已变化，目前不可安全关闭。请返回详情核对。</p>}
          {actionError && <p className="oc-notice oc-error" role="alert">{actionError}</p>}
          <div className="oc-dialog-footer"><Button type="button" variant="secondary" disabled={!!busy} onClick={() => { setClosing(null); setReason(''); setConfirmation(''); setActionError('') }}>取消关闭</Button><Button type="submit" variant="primary" disabled={!!busy || !selectedActions?.close || !reason.trim() || confirmation !== 'CLOSE_ORDER'}>{busy ? '正在安全检查…' : '确认安全关闭'}</Button></div>
        </form> : details && <>
          <div className="oc-dialog-heading"><div><Dialog.Title className="oc-dialog-title">@{details.recipient}</Dialog.Title><Dialog.Description className="oc-dialog-description">{orderProduct(details.product_code)} · {source(details)}</Dialog.Description></div><Button variant="ghost" aria-label="关闭订单详情" disabled={!!busy} onClick={dismissDetails}><X size={18} /></Button></div>
          <div className="oc-detail-state"><span className={`status status-${isClosedOrder(details) ? 'closed' : details.status}`}>{orderStateText(details)}</span><p>{orderNextStep(details, queue?.queue_blocked)}</p></div>
          {detailError && <p className="oc-notice oc-error" role="alert">详情刷新失败：{detailError}</p>}
          {message && <p className="oc-notice" role="status">{message}</p>}
          {actionError && <p className="oc-notice oc-error" role="alert">{actionError}</p>}
          <div className="oc-detail-actions">
            {selectedActions?.check && <Button variant="secondary" disabled={!!busy || !!detailError} onClick={() => void action(details, 'check')}>{busy === `${details.id}:check` ? '正在核对…' : '核对原单'}</Button>}
            {selectedActions?.payment_page && !paymentReady && <Button variant={selectedActions.reason_code === 'payment_requires_action' ? 'primary' : 'secondary'} disabled={!!busy || !!detailError} onClick={() => void action(details, 'payment-page')}>{busy === `${details.id}:payment-page` ? '正在获取原页…' : '获取原付款页'}</Button>}
            {paymentReady && <a className="oc-payment-link" href={paymentLink.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><ArrowSquareOut size={16} />前往原 Stripe 付款页</a>}
          </div>
          {paymentReady && <p className="oc-payment-note" role="status">原付款页已获取。请先查看是否已付款；如需验证，在原页完成后返回核对原单，避免再次支付。</p>}
          <dl className="oc-detail-fields"><div><dt>订单号</dt><dd><code>{details.id}</code></dd></div><div><dt>商户单号</dt><dd><code>{details.merchant_order_no}</code></dd></div><div><dt>所属商户</dt><dd>{details.user_name || '—'}</dd></div><div><dt>点数</dt><dd>{details.points} 点</dd></div><div><dt>创建时间</dt><dd>{time(details.created_at)}</dd></div><div><dt>更新时间</dt><dd>{time(details.updated_at)}</dd></div>{details.queue_position && <div><dt>队列位置</dt><dd>第 {details.queue_position} 位</dd></div>}</dl>
          {(details.failure_code || details.receipt) && <div className="oc-evidence"><h3>执行记录</h3>{details.failure_code && <><p>{orderFailureDescription(details.failure_code) || '原执行端返回以下状态，可据此核对这笔订单。'}</p><dl><div><dt>原始状态码</dt><dd><code>{details.failure_code}</code></dd></div></dl></>}{details.receipt && <dl><div><dt>付款凭证</dt><dd><code>{details.receipt}</code></dd></div></dl>}</div>}
          <div className="oc-close-area">{selectedActions?.close ? <><p>当前证据显示尚未创建付款，可安全关闭并释放冻结点数。已兑换卡密会保留记录。</p><Button variant="ghost" disabled={!!busy || !!detailError} onClick={() => startClose(details)}>安全关闭订单</Button></> : ['running', 'unknown'].includes(details.status) && <p>付款尚在执行或结果待确认，不能关闭并释放点数。请按上方可用步骤处理原单。</p>}</div>
        </>}
      </Dialog>
    </Dialog.Root>
  </section>
}
