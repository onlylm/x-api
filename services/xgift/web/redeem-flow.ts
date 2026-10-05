export const REDEEM_POLL_INTERVAL = 10000
export const REDEEM_POLL_LIMIT = 60
export const REDEEM_POLL_FAILURE_LIMIT = 3
export type VoucherAttempt = { code: string; recipient: string; recipient_id: string }

export function voucherRequest(attempt: VoucherAttempt | null, code: string, checked: { eligible: boolean; username: string; recipient_id: string } | null): VoucherAttempt | null {
  if (attempt) return { ...attempt }
  if (!checked?.eligible) return null
  return { code: code.trim(), recipient: checked.username, recipient_id: checked.recipient_id }
}

export function giftProductName(code: string, suppliedName?: string) {
  const name = suppliedName?.trim()
  if (name && name !== code) return name
  return ({ 'x-premium-3m': 'X Premium · 3 个月', 'x-premium-6m': 'X Premium · 6 个月' } as Record<string, string>)[code] ?? 'X 会员套餐'
}

export function redeemStage(view: { state: string; order?: unknown } | null, hasAttempt: boolean): 1 | 2 | 3 {
  if (view?.order || hasAttempt) return 3
  return view?.state === 'available' ? 2 : 1
}

export function closedGift(order: { status: string; failure_code?: string | null }) {
  return order.status === 'failed' && ['cancelled_before_execution', 'cancelled_by_admin'].includes(order.failure_code ?? '')
}

export function giftOrderPresentation(order: { status: string; failure_code?: string | null }) {
  if (closedGift(order)) return { label: '订单已关闭', description: '管理员已安全关闭此订单，不会继续执行。卡密仍保留原兑换记录，请联系商户处理。' }
  const states: Record<string, { label: string; description: string }> = {
    queued: { label: '排队中', description: '订单已接收，正在按顺序等待付款。无需再次兑换，也不要重复下单。' },
    running: { label: '正在处理', description: '正在处理这笔赠送订单。请保留卡密，通过原订单查看进度。' },
    unknown: { label: '等待核对', description: '原付款结果尚未确认，请联系商户核对这笔订单。不要重复付款或再次兑换。' },
    succeeded: { label: '付款已确认', description: '赠送付款已确认。付款完成不等于已独立核实权益到账，请前往 X 核对接收账号权益。' },
    failed: { label: '订单未完成', description: '这笔订单已结束，不会继续执行。请联系商户处理，卡密仍绑定原订单。' },
  }
  return states[order.status] ?? { label: '状态待核对', description: '暂时无法确认原订单状态，请刷新原单或联系商户。不要重新下单。' }
}

export function shouldPollRedeem(status: string | undefined, hasAttempt: boolean, count: number, failures: number, visible: boolean) {
  if (!visible || count >= REDEEM_POLL_LIMIT || failures >= REDEEM_POLL_FAILURE_LIMIT) return false
  if (status === undefined) return hasAttempt
  return ['queued', 'running', 'unknown'].includes(status)
}

export function sameOriginalOrder(previousId: string | undefined, nextId: string | undefined) {
  return !previousId || previousId === nextId
}
