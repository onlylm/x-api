export type OrderRow = {
  id: string; merchant_order_no: string; recipient: string; user_name?: string
  product_code: string; mode: string; points: number; status: string
  receipt?: string | null; failure_code?: string | null; created_at: number; queue_position?: number | null
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
  return ({ queued: '排队中', running: '执行中', unknown: '待处理', succeeded: '已完成', failed: '已结束' } as Record<string, string>)[order.status] ?? order.status
}

export function legacyPaymentStatus(status: string, paidAt: number | null, failureCode: string | null): string {
  if (status === 'closed') return '已关闭'
  if (status === 'fulfilled') return '赠送已完成'
  if (status === 'failed') return '创建失败'
  if (status === 'attention' || failureCode) return paidAt ? '已付款待处理' : '待核对'
  return ({ creating: '正在创建', pending: '待付款', paid: paidAt ? '已付款' : '付款待核对' } as Record<string, string>)[status] ?? status
}
