export type OrderActions = {
  check: boolean; payment_page: boolean; close: boolean; reason_code: string; message: string
}

export type OrderRow = {
  id: string; merchant_order_no: string; recipient: string; user_name?: string
  product_code: string; mode: string; points: number; status: string
  receipt?: string | null; failure_code?: string | null; created_at: number; updated_at?: number; queue_position?: number | null
  actions?: OrderActions
}

export type OrdersView = { status: string; query: string; page: number }
const statuses = new Set(['active', 'queued', 'running', 'unknown', '', 'succeeded', 'failed'])

export function parseOrdersHash(hash: string): OrdersView {
  const [section, query = ''] = hash.replace(/^#/, '').split('?')
  if (section !== 'orders') return { status: 'active', query: '', page: 1 }
  const params = new URLSearchParams(query), requestedStatus = params.get('status') ?? 'active'
  const requestedPage = Number(params.get('page') ?? 1)
  return {
    status: statuses.has(requestedStatus) ? requestedStatus : 'active',
    query: (params.get('q') ?? '').trim().slice(0, 128),
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 100000 ? requestedPage : 1,
  }
}

export function ordersHash(view: OrdersView): string {
  const params = new URLSearchParams({ status: view.status })
  if (view.query) params.set('q', view.query)
  params.set('page', String(view.page))
  return '#orders?' + params.toString()
}

/** Missing or stale capabilities must never turn a status into payment authority. */
export function orderActions(order: OrderRow): OrderActions {
  if (['succeeded', 'failed'].includes(order.status)) return {
    check: false, payment_page: false, close: false, reason_code: 'ended', message: '订单已结束，无需操作。',
  }
  if (!order.actions) return {
    check: false, payment_page: false, close: false, reason_code: 'unavailable', message: '操作权限尚未确认，请刷新原单。',
  }
  return {
    ...order.actions,
    check: ['running', 'unknown'].includes(order.status) && order.actions.check === true,
    payment_page: ['running', 'unknown'].includes(order.status) && order.actions.payment_page === true,
    close: ['queued', 'running', 'unknown'].includes(order.status) && order.actions.close === true,
  }
}

export function orderNextStep(order: OrderRow, blocked = false): string {
  if (isClosedOrder(order)) return '已关闭，冻结点数已释放'
  if (order.status === 'succeeded') return '付款已确认，请到 X 核对权益'
  if (order.status === 'failed') return '已结束，查看详情了解原因'
  if (order.status === 'queued') return blocked ? '等待前序订单或付款条件就绪' : '按顺序等待执行'
  return orderActions(order).message
}

export function orderProduct(code: string): string {
  return ({ 'x-premium-3m': 'X Premium · 3 个月', 'x-premium-6m': 'X Premium · 6 个月' } as Record<string, string>)[code] ?? code
}

export function safePaymentPage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password || url.port) return null
    if (!/^\/(?:c\/)?pay\/cs_live_[A-Za-z0-9]+$/.test(url.pathname)) return null
    return url.href
  } catch { return null }
}

export function isClosedOrder(order: Pick<OrderRow, 'status' | 'failure_code'>): boolean {
  return order.status === 'failed' && ['cancelled_before_execution', 'cancelled_by_admin'].includes(order.failure_code ?? '')
}

export function orderStateText(order: Pick<OrderRow, 'status' | 'failure_code'>): string {
  if (isClosedOrder(order)) return '已关闭'
  return ({ queued: '排队中', running: '执行中', unknown: '待核对', succeeded: '付款已确认', failed: '已结束' } as Record<string, string>)[order.status] ?? order.status
}

export function legacyPaymentStatus(status: string, paidAt: number | null, failureCode: string | null): string {
  if (status === 'closed') return '已关闭'
  if (status === 'fulfilled') return '赠送付款已确认'
  if (status === 'failed') return '创建失败'
  if (status === 'attention' || failureCode) return paidAt ? '已付款待处理' : '待核对'
  return ({ creating: '正在创建', pending: '待付款', paid: paidAt ? '已付款' : '付款待核对' } as Record<string, string>)[status] ?? status
}
