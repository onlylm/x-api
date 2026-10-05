import { ordersHash } from './order-ui.ts'

export const platformPaymentOptions = [
  ['all', '全部付款状态'], ['pending', '待付款'], ['paid', '已付款'],
  ['expired', '已过期'], ['closed', '已关闭'], ['refunded', '已退款'],
] as const
export const platformFulfillmentOptions = [
  ['all', '全部赠送状态'], ['not_started', '未开始'], ['queued', '排队中'],
  ['running', '赠送中'], ['success', '赠送成功'], ['failed', '赠送失败'], ['review', '待核对'],
] as const
export type PlatformPayment = typeof platformPaymentOptions[number][0]
export type PlatformFulfillment = typeof platformFulfillmentOptions[number][0]
export type PlatformOrdersView = { page: number; query: string; payment: PlatformPayment; fulfillment: PlatformFulfillment }
type Timestamp = string | number
export type PlatformOrder = {
  order_id: string; client_order_id: string; recipient: string | null; product: string
  amount: string; supply_price: string | null
  payment_status: Exclude<PlatformPayment, 'all'>; fulfillment_status: Exclude<PlatformFulfillment, 'all'>
  upstream_order_id: string | null; created_at: Timestamp; updated_at: Timestamp; paid_at: Timestamp | null
}
export type PlatformOrdersResult = { items: PlatformOrder[]; page: number; has_next: boolean; updated_at: Timestamp }

export function normalizePlatformOrdersView(view: Partial<PlatformOrdersView>): PlatformOrdersView {
  return {
    page: Number.isSafeInteger(view.page) && view.page! >= 1 && view.page! <= 100000 ? view.page! : 1,
    query: (view.query ?? '').trim().slice(0, 100),
    payment: platformPaymentOptions.some(([value]) => value === view.payment) ? view.payment! : 'all',
    fulfillment: platformFulfillmentOptions.some(([value]) => value === view.fulfillment) ? view.fulfillment! : 'all',
  }
}

export function parsePlatformOrdersHash(hash: string): PlatformOrdersView {
  const separator = hash.indexOf('?')
  if (hash.slice(0, separator < 0 ? hash.length : separator) !== '#platform-orders') return normalizePlatformOrdersView({})
  const params = new URLSearchParams(separator < 0 ? '' : hash.slice(separator + 1))
  const page = params.get('page') ?? '1'
  return normalizePlatformOrdersView({
    page: /^[1-9][0-9]{0,5}$/.test(page) ? Number(page) : 1,
    query: params.get('q') ?? '', payment: params.get('payment') as PlatformPayment,
    fulfillment: params.get('fulfillment') as PlatformFulfillment,
  })
}

function platformOrdersParams(view: PlatformOrdersView) {
  const safe = normalizePlatformOrdersView(view)
  const params = new URLSearchParams({ payment: safe.payment, fulfillment: safe.fulfillment, page: String(safe.page) })
  if (safe.query) params.set('q', safe.query)
  return params.toString()
}
export const platformOrdersHash = (view: PlatformOrdersView) => '#platform-orders?' + platformOrdersParams(view)
export const platformOrdersPath = (view: PlatformOrdersView) => '/api/admin/platform-orders?' + platformOrdersParams(view)

export function platformGiftHref(orderId: string | null): string | null {
  return orderId && /^ord_[A-Za-z0-9_-]{1,124}$/.test(orderId)
    ? ordersHash({ status: '', query: orderId, page: 1 }) : null
}

export function platformOrderProduct(product: string): string {
  return ({ x_premium_3m: 'X Premium · 3 个月', x_premium_6m: 'X Premium · 6 个月',
    'x-premium-3m': 'X Premium · 3 个月', 'x-premium-6m': 'X Premium · 6 个月' } as Record<string, string>)[product] ?? product
}

/** Preserve the provider's decimal string without floating point rounding. */
export function platformMoney(value: string | null): string {
  if (value === null || !/^\d+(?:\.\d{1,2})?$/.test(value)) return '—'
  const [whole, fraction = ''] = value.split('.')
  return `¥${whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`
}

export function platformTime(value: Timestamp | null): string {
  if (value === null || value === '' || (typeof value === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/i.test(value))) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }) : '—'
}

export function platformStatus(kind: 'payment' | 'fulfillment', value: string): { label: string; tone: string } {
  const options = kind === 'payment' ? platformPaymentOptions : platformFulfillmentOptions
  const label = options.find(([key]) => key === value && key !== 'all')?.[1] ?? '状态待核对'
  const tone = (kind === 'payment' && value === 'paid') || (kind === 'fulfillment' && value === 'success') ? 'success'
    : value === 'failed' ? 'failed' : ['pending', 'running', 'review'].includes(value) || label === '状态待核对' ? 'review' : 'neutral'
  return { label, tone }
}

export function platformOrdersError(error: unknown): { status: number | null; message: string } {
  const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : null
  return { status, message: status === 401 ? '登录已过期，请重新登录。'
    : status === 403 ? '仅管理员可查看平台订单。请确认当前登录账户。'
    : status === 429 ? '查询过于频繁，请稍后刷新。原订单不受影响。'
    : status === 503 ? '平台订单服务暂时不可用，请稍后刷新。不会因此重新付款或赠送。'
    : '未取得最新平台订单，请检查连接后刷新。不会因此重新付款或赠送。' }
}
