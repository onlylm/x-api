import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import type { Request } from './Recharge'
import './checkout.css'

type CheckoutOrder = {
  id: string; product_name: string; months: number; recipient: string
  amount_cny: string | number; paid: boolean; payment_status: string
  fulfillment_status: string; order_id: string | null; message: string
}
type Attempt = {
  version: 1; request_id: string; access_token: string; product_code: string
  username: string; recipient_id: string; expected_amount_cny: string
  product_name: string; checkout_id?: string
}
const storageKey = 'xgift.checkout.v1'
const money = (value: string | number) => {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : '—'
}
function restoreAttempt(): { attempt: Attempt | null; error: string } {
  try {
    const saved = sessionStorage.getItem(storageKey)
    if (!saved) return { attempt: null, error: '' }
    const value = JSON.parse(saved) as Partial<Attempt>
    if (value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.request_id ?? '') ||
      !/^[a-f0-9]{64}$/.test(value.access_token ?? '') || typeof value.product_code !== 'string' || !value.product_code ||
      typeof value.username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(value.username) ||
      typeof value.recipient_id !== 'string' || !value.recipient_id || typeof value.expected_amount_cny !== 'string' ||
      money(value.expected_amount_cny) === '—' || typeof value.product_name !== 'string' ||
      (value.checkout_id !== undefined && (typeof value.checkout_id !== 'string' || !value.checkout_id)))
      return { attempt: null, error: '本页保存的原订单凭证无法读取。请联系商户核对原订单，不要重复付款。' }
    return { attempt: value as Attempt, error: '' }
  } catch { return { attempt: null, error: '无法读取此标签页的订单凭证，请检查浏览器会话存储设置，或联系商户核对原订单。' } }
}
function statusText(order: CheckoutOrder) {
  if (order.paid) return order.fulfillment_status === 'succeeded' ? '赠送已完成' : order.fulfillment_status === 'attention' ? '已付款，待处理' : '已付款，等待赠送结果'
  if (order.payment_status === 'closed') return '原支付订单已关闭'
  if (order.payment_status === 'failed') return '原支付订单创建失败'
  return '原付款结果待核对'
}

export function Checkout({ request }: { request: Request }) {
  const [initial] = useState(restoreAttempt)
  const [attempt, setAttempt] = useState<Attempt | null>(initial.attempt)
  const [order, setOrder] = useState<CheckoutOrder | null>(null)
  const [error, setError] = useState(initial.error), [busy, setBusy] = useState(false)
  const [lastChecked, setLastChecked] = useState<number | null>(null)
  const mounted = useRef(false), locked = useRef(false)
  const terminal = !!order && ((order.paid && order.fulfillment_status === 'succeeded') || (!order.paid && ['closed', 'failed'].includes(order.payment_status)))
  const query = useCallback(async (saved: Attempt) => {
    if (!saved.checkout_id || locked.current) return
    locked.current = true; setBusy(true)
    try {
      const next = await request<CheckoutOrder>('/api/checkout/status', { checkout_id: saved.checkout_id, access_token: saved.access_token })
      if (mounted.current) { setOrder(next); setError(''); setLastChecked(Date.now()) }
    } catch {
      if (mounted.current) setError('暂时无法确认原订单状态。请稍后重新查询；若已付款，请勿再次支付。')
    } finally { locked.current = false; if (mounted.current) setBusy(false) }
  }, [request])
  useEffect(() => {
    mounted.current = true
    if (attempt?.checkout_id) void query(attempt)
    const timer = window.setInterval(() => { if (attempt?.checkout_id && !terminal && document.visibilityState === 'visible') void query(attempt) }, 5000)
    return () => { mounted.current = false; window.clearInterval(timer) }
  }, [attempt, terminal, query])

  async function recoverOriginal() {
    if (!attempt || attempt.checkout_id || locked.current) return
    locked.current = true; setBusy(true); setError('')
    try {
      // Same stored credentials only. The retired server path can return an existing order, never create one.
      const next = await request<CheckoutOrder>('/api/checkout', {
        request_id: attempt.request_id, access_token: attempt.access_token, product_code: attempt.product_code,
        username: attempt.username, recipient_id: attempt.recipient_id, expected_amount_cny: attempt.expected_amount_cny,
      })
      if (!mounted.current) return
      const restored = { ...attempt, checkout_id: next.id }
      setAttempt(restored); setOrder(next); setLastChecked(Date.now())
      try { sessionStorage.setItem(storageKey, JSON.stringify(restored)) }
      catch { setError('已找回原订单，但浏览器未能保存更新后的凭证。请保持此页打开并保存订单号。') }
    } catch {
      if (mounted.current) setError('尚未找回原订单。本站已停止新收款，不会用此请求创建新付款单；请联系商户核对。')
    } finally { locked.current = false; if (mounted.current) setBusy(false) }
  }

  return <main className="login redeem-page checkout-page">
    <div className="recharge-topbar checkout-topbar">
      <a href="/redeem" className="login-brand"><span className="brand-mark" aria-hidden="true">X</span><span>X Premium <b>/</b> 卡密兑换</span></a>
      <nav aria-label="其他入口" className="checkout-nav"><a className="text-link" href="/redeem">卡密兑换</a><a className="text-link" href="/">商户登录</a></nav>
    </div>
    <div className="redeem-wrap checkout-wrap">
      <h1>{attempt ? '历史订单查询' : '请使用卡密兑换'}</h1>
      <p className="recharge-intro">本站已停止支付宝扫码购买。已有订单仍保留查询和付款核对，不会重复创建收款单。</p>
      {!attempt && <a href="/redeem" className="retired-redeem-link text-link">前往卡密兑换</a>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {attempt && <section className="recharge-result checkout-result" aria-label="历史购买订单状态">
        <div className="recharge-result-heading"><h2>原购买订单</h2><span className={`status ${order?.paid ? 'status-ACTIVE' : ''}`} role="status">{order ? statusText(order) : busy ? '正在读取原单…' : '原单待查询'}</span></div>
        <dl className="details recharge-details">
          <div><dt>接收账号</dt><dd>@{order?.recipient ?? attempt.username}</dd></div>
          <div><dt>购买套餐</dt><dd>{order?.product_name ?? attempt.product_name}</dd></div>
          <div><dt>{order?.paid ? '已付金额' : '原订单金额'}</dt><dd>¥{money(order?.amount_cny ?? attempt.expected_amount_cny)}</dd></div>
          {(order?.id ?? attempt.checkout_id) && <div><dt>支付订单号</dt><dd><code>{order?.id ?? attempt.checkout_id}</code></dd></div>}
          {order?.order_id && <div><dt>赠送订单号</dt><dd><code>{order.order_id}</code></dd></div>}
        </dl>
        <p className="note">{order?.paid ? '收款已确认，请通过本页核对赠送进度；无需重复付款。' : '此页不再提供付款二维码。若你已付款，请保留原订单并联系商户核对，勿再次付款。'}</p>
        {order?.message && <p className="note">{order.message}</p>}
        <Button type="button" variant="secondary" disabled={busy} onClick={() => attempt.checkout_id ? void query(attempt) : void recoverOriginal()}>{busy ? '正在核对原单…' : attempt.checkout_id ? '查询原订单状态' : '找回原请求'}</Button>
        <p className="note">{lastChecked && `最近查询 ${new Date(lastChecked).toLocaleTimeString('zh-CN', { hour12: false })}`}{attempt.checkout_id && !terminal && ' · 页面可见时每 5 秒更新'}</p>
      </section>}
      <p className="note checkout-persistence-note">{attempt ? '原订单查询凭证仅保存在当前标签页。请保持此页打开，处理完成前不要清除浏览器数据。需要帮助时，请向商户提供订单号。' : '未在当前标签页找到历史订单凭证。如需查询以前的付款，请向商户提供原订单号。'}</p>
    </div>
    <footer>X Premium · 历史订单查询</footer>
  </main>
}
