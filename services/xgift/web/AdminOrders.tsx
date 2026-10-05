import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { Table } from '@cloudflare/kumo/components/table'
import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut } from '@phosphor-icons/react'
import { AlipayOrders } from './AlipaySettings'
import type { Request } from './Recharge'
import { orderFailureDescription } from './order-failures'
import { isClosedOrder, orderStateText, safePaymentPage, type OrderRow } from './order-ui'

type QueueView = {
  queued_orders: number; executing_orders: number; unknown_orders: number
  queue_blocked: boolean; blocked_order_id: string | null
  accepts_orders: boolean; reason_message: string | null
  used: number; daily_limit: number; remaining: number; execution_ready: boolean
}
type CheckResult = { order_id: string; status: string; failure_code?: string | null; checked: boolean; message: string }
const filters = [['active', '待办'], ['queued', '排队中'], ['running', '执行中'], ['unknown', '待处理'], ['', '全部订单'], ['succeeded', '已完成'], ['failed', '已结束']] as const
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作结果未确认，请刷新原订单核对。'
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export function AdminOrders({ request, onError, refreshVersion }: { request: Request; onError: (error: unknown) => void; refreshVersion: number }) {
  const [history, setHistory] = useState(false)
  const [status, setStatus] = useState('active'), [page, setPage] = useState(1)
  const [search, setSearch] = useState(''), [query, setQuery] = useState('')
  const [rows, setRows] = useState<OrderRow[]>([]), [queue, setQueue] = useState<QueueView | null>(null)
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [queueError, setQueueError] = useState('')
  const [message, setMessage] = useState(''), [actionError, setActionError] = useState(''), [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null), [closing, setClosing] = useState<OrderRow | null>(null)
  const [reason, setReason] = useState(''), [confirmation, setConfirmation] = useState('')
  const [paymentLink, setPaymentLink] = useState<{ id: string; url: string } | null>(null)
  const mounted = useRef(false), sequence = useRef(0), busyRef = useRef(false), onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const reportAuth = useCallback((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 401) onErrorRef.current(error)
  }, [])
  const load = useCallback(async () => {
    if (busyRef.current) return
    const current = ++sequence.current
    setLoading(true)
    const results = await Promise.allSettled([
      request<OrderRow[]>(`/api/admin/orders?page=${page}${status ? `&status=${status}` : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`),
      request<QueueView>('/api/admin/admission'),
    ])
    if (!mounted.current || current !== sequence.current) return
    const [ordersResult, queueResult] = results
    if (ordersResult.status === 'fulfilled') {
      setRows(ordersResult.value); setLoadError(''); setCheckedAt(Date.now())
      setPaymentLink((link) => link && ordersResult.value.some((row) => row.id === link.id && ['running', 'unknown'].includes(row.status)) ? link : null)
    } else { setLoadError(errorText(ordersResult.reason)); reportAuth(ordersResult.reason) }
    if (queueResult.status === 'fulfilled') { setQueue(queueResult.value); setQueueError('') }
    else { setQueueError(errorText(queueResult.reason)); reportAuth(queueResult.reason) }
    setLoading(false)
  }, [request, page, status, query, reportAuth])
  useEffect(() => {
    mounted.current = true; setRows([]); setCheckedAt(null); setPaymentLink(null)
    if (!history) void load()
    const timer = window.setInterval(() => { if (!history && document.visibilityState === 'visible') void load() }, 10000)
    return () => { mounted.current = false; sequence.current++; window.clearInterval(timer) }
  }, [load, history, refreshVersion])

  async function action(row: OrderRow, kind: 'check' | 'payment-page' | 'close') {
    if (busyRef.current || (kind === 'close' && (confirmation !== 'CLOSE_ORDER' || !reason.trim()))) return
    busyRef.current = true; sequence.current++; setBusy(`${row.id}:${kind}`); setActionError(''); setMessage(''); setLoading(false)
    try {
      const path = `/api/admin/orders/${encodeURIComponent(row.id)}/${kind}`
      if (kind === 'payment-page') {
        const result = await request<{ url: string }>(path)
        const url = safePaymentPage(result.url)
        if (!url) throw new Error('原付款页面地址未通过检查，未打开任何页面。请核对原订单。')
        if (mounted.current) setPaymentLink({ id: row.id, url })
      } else if (kind === 'check') {
        const result = await request<CheckResult>(path, {})
        if (mounted.current) setMessage(result.message || '已核对这一笔原订单；没有重新发起付款。')
      } else {
        await request(path, { reason: reason.trim(), confirmation: 'CLOSE_ORDER' })
        if (mounted.current) { setClosing(null); setMessage('订单已安全关闭，冻结点数已释放。原卡密仍保留兑换记录，不会自动变成未使用卡密。') }
      }
    } catch (error) {
      if (mounted.current) { setActionError(errorText(error)); reportAuth(error) }
    } finally {
      busyRef.current = false
      if (mounted.current) { setBusy(null); void load() }
    }
  }
  function closeOrder(row: OrderRow) { setClosing(row); setReason(''); setConfirmation(''); setActionError('') }
  function submitClose(event: FormEvent) { event.preventDefault(); if (closing) void action(closing, 'close') }

  return <section className="orders-workspace" aria-label="赠送订单与执行队列">
    <div className="orders-view-switch" aria-label="订单记录类型">
      <Button variant={history ? 'ghost' : 'secondary'} disabled={!!busy} onClick={() => setHistory(false)} aria-pressed={!history}>赠送订单与队列</Button>
      <Button variant={history ? 'secondary' : 'ghost'} disabled={!!busy} onClick={() => setHistory(true)} aria-pressed={history}>历史支付宝记录</Button>
    </div>
    {history ? <>
      <p className="notice">支付宝已停止新购买。这里只保留历史收款与关联赠送记录，已有付款仍按原单核对。</p>
      <AlipayOrders request={request} onError={onError} />
    </> : <>
      <div className="queue-summary" aria-label="执行队列状态">
        <div className="queue-summary-main"><strong>多单排队，逐笔付款</strong><span>{queue ? queue.accepts_orders ? '当前接受新订单' : '当前暂停新增接单' : '正在读取接单状态'} · 今日 {queue ? `${queue.used} / ${queue.daily_limit}` : '—'} 笔</span></div>
        <dl className="queue-counts"><div><dt>排队中</dt><dd>{queue?.queued_orders ?? '—'}</dd></div><div><dt>执行中</dt><dd>{queue?.executing_orders ?? '—'}</dd></div><div><dt>待处理</dt><dd>{queue?.unknown_orders ?? '—'}</dd></div></dl>
      </div>
      {queueError && <p className="notice error" role="alert">队列状态未能刷新：{queueError}</p>}
      {queue?.queue_blocked && <p className="notice" role="status">{queue.unknown_orders > 0 ? '原单付款结果仍待核对，后面的订单会保留在队列中。请先核对原单、打开付款页面完成验证，或尝试安全关闭。' : 'X 付款条件尚未就绪，已接收的订单会保留在队列中，请检查“X 付款设置”。'}{queue.blocked_order_id && <><br />待处理原单：<code>{queue.blocked_order_id}</code></>}</p>}
      {!queue?.accepts_orders && queue?.reason_message && <p className="note">{queue.reason_message}</p>}
      <div className="toolbar orders-toolbar">
        <div className="order-filter" role="group" aria-label="按订单状态筛选">{filters.map(([value, label]) => <button type="button" key={value} disabled={!!busy} aria-pressed={status === value} onClick={() => { setStatus(value); setPage(1) }}>{label}</button>)}</div>
        <Button variant="ghost" disabled={loading || !!busy} onClick={() => void load()}><ArrowClockwise size={16} />{loading ? '刷新中…' : '刷新队列'}</Button>
      </div>
      <form className="order-search" onSubmit={(event) => { event.preventDefault(); if (busyRef.current) return; setQuery(search.trim()); setPage(1) }}>
        <Input label="查找原订单" placeholder="订单号、商户单号或 X 用户名" value={search} maxLength={128} disabled={!!busy} onChange={(event) => setSearch(event.target.value)} />
        <Button type="submit" variant="secondary" disabled={!!busy}>查询</Button>
        {query && <Button type="button" variant="ghost" disabled={!!busy} onClick={() => { if (busyRef.current) return; setSearch(''); setQuery(''); setPage(1) }}>清除查询</Button>}
      </form>
      {loadError && <p className="notice error" role="alert">订单未能刷新：{loadError} 下方如有记录，仅为上次确认结果。</p>}
      {message && <p className="notice" role="status">{message}</p>}
      {actionError && !closing && <p className="notice error" role="alert">{actionError}</p>}
      <div className="table-scroll orders-table" aria-busy={loading}>
        <Table>
          <Table.Header><Table.Row>{['订单 / 创建时间', '接收账号 / 套餐', '状态与进度', '操作'].map((label) => <Table.Head key={label}>{label}</Table.Head>)}</Table.Row></Table.Header>
          <Table.Body>{rows.map((row) => <Table.Row key={row.id}>
            <Table.Cell><span className="stack"><code>{row.id}</code><span>{time(row.created_at)}</span><small>{row.mode === 'voucher' ? '卡密兑换' : row.merchant_order_no.startsWith('alipay:') ? '历史支付宝' : '商户直充'} · {row.points} 点数</small></span></Table.Cell>
            <Table.Cell><span className="stack"><strong>@{row.recipient}</strong><span>{row.product_code === 'x-premium-3m' ? 'X Premium · 3 个月' : row.product_code === 'x-premium-6m' ? 'X Premium · 6 个月' : row.product_code}</span>{row.user_name && <small>所属商户：{row.user_name}</small>}</span></Table.Cell>
            <Table.Cell><span className="stack"><span className={`status status-${isClosedOrder(row) ? 'closed' : row.status}`}>{orderStateText(row)}{row.status === 'queued' && row.queue_position ? ` · 第 ${row.queue_position} 位` : ''}</span><span className="order-progress">{row.status === 'queued' ? queue?.queue_blocked ? '等待前序订单核对或付款条件就绪' : '按接收顺序等待付款，尚未执行' : row.status === 'succeeded' ? '赠送付款已完成，请核对 X 账号权益' : isClosedOrder(row) ? '管理员已关闭，冻结点数已释放' : orderFailureDescription(row.failure_code) || (row.status === 'running' ? '正在处理这一笔订单，请勿重复付款' : row.status === 'unknown' ? '原单结果尚未确认，请核对后处理' : '订单已结束，不会再次执行')}</span>{row.failure_code && <small>原因：{row.failure_code}</small>}{row.receipt && <small>凭证：{row.receipt}</small>}</span></Table.Cell>
            <Table.Cell><div className="order-row-actions">
              {['running', 'unknown'].includes(row.status) && <>
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void action(row, 'check')}>{busy === `${row.id}:check` ? '核对中…' : '核对原单'}</Button>
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void action(row, 'payment-page')}>{busy === `${row.id}:payment-page` ? '读取中…' : '打开付款界面'}</Button>
              </>}
              {['queued', 'running', 'unknown'].includes(row.status) && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => closeOrder(row)}>关闭订单</Button>}
              {paymentLink?.id === row.id && <a className="payment-page-link text-link" href={paymentLink.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><ArrowSquareOut size={16} />前往原 Stripe 付款页</a>}
              {paymentLink?.id === row.id && <small>仅用于已提交原单的验证与核对。先检查页面是否已付款；已付款不要再次支付，返回后核对原单。</small>}
              {['succeeded', 'failed'].includes(row.status) && <span className="note">无需操作</span>}
            </div></Table.Cell>
          </Table.Row>)}
          {!rows.length && <Table.Row><Table.Cell colSpan={4}><div className={loading ? 'table-skeleton' : 'empty'} role="status">{loading ? '正在读取订单队列…' : loadError ? '未取得本页订单，请刷新重试。' : status ? '当前没有此状态的订单，可切换“全部订单”查看其他记录。' : '还没有赠送订单。生成卡密并兑换后，订单会在这里排队。'}</div></Table.Cell></Table.Row>}
          </Table.Body>
        </Table>
      </div>
      <div className="pager"><span>第 {page} 页 · 每页最多 30 条{checkedAt && ` · 更新于 ${time(checkedAt)}`} · 页面可见时每 10 秒刷新</span><Button variant="ghost" aria-label="上一页赠送订单" disabled={loading || !!busy || page === 1} onClick={() => setPage(page - 1)}><ArrowLeft size={16} /></Button><Button variant="ghost" aria-label="下一页赠送订单" disabled={loading || !!busy || !!loadError || rows.length < 30} onClick={() => setPage(page + 1)}><ArrowRight size={16} /></Button></div>
      <p className="note">同一 X 账号有未结订单时，不接受重复下单。关闭只在服务端确认没有扣款风险时执行；已提交或结果未知的付款，不会通过本地关闭来跳过核对。</p>
    </>}
    <Dialog.Root open={!!closing} onOpenChange={(open) => { if (!open && !busy) setClosing(null) }}>
      <Dialog size="lg" className="x-modal"><form onSubmit={submitClose}>
        <Dialog.Title className="modal-title">关闭这笔订单？</Dialog.Title>
        <Dialog.Description className="modal-description">接收账号 @{closing?.recipient}，订单 {closing?.id}。尚未执行的排队订单可直接关闭并释放冻结点数；如果已产生付款页面，系统会拒绝不安全的关闭。关闭不会退款、重新发起扣款或恢复已兑换的卡密。</Dialog.Description>
        <div className="modal-fields"><Input label="关闭原因" value={reason} maxLength={200} required disabled={!!busy} onChange={(event) => setReason(event.target.value)} /><Input label="输入 CLOSE_ORDER 确认" value={confirmation} autoComplete="off" spellCheck={false} required disabled={!!busy} onChange={(event) => setConfirmation(event.target.value)} /></div>
        {actionError && <p className="notice error" role="alert">{actionError}</p>}
        <div className="modal-footer"><Button type="button" variant="secondary" disabled={!!busy} onClick={() => setClosing(null)}>返回订单</Button><Button type="submit" variant="primary" disabled={!!busy || !reason.trim() || confirmation !== 'CLOSE_ORDER'}>{busy ? '正在安全检查…' : '确认安全关闭'}</Button></div>
      </form></Dialog>
    </Dialog.Root>
  </section>
}
