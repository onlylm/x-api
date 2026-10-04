import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import QRCode from 'qrcode'
import type { Request } from './Recharge'
import './checkout.css'

type Product = { code: string; name: string; months: number; price_cny: string | number }
type Catalog = { available: boolean; reason?: string | null; products: Product[]; payment_label: string }
type Eligibility = { username: string; recipient_id: string; eligible: boolean; reason?: string }
type CheckoutOrder = {
  id: string
  product_name: string
  months: number
  recipient: string
  amount_cny: string | number
  paid: boolean
  payment_status: 'creating' | 'pending' | 'paid' | 'closed' | 'failed'
  fulfillment_status: 'waiting_payment' | 'waiting_execution' | 'processing' | 'succeeded' | 'attention'
  qr_code: string | null
  expires_at: number
  order_id: string | null
  message: string
}
type Attempt = {
  version: 1
  request_id: string
  access_token: string
  product_code: string
  username: string
  recipient_id: string
  expected_amount_cny: string
  product_name: string
  checkout_id?: string
}

const storageKey = 'xgift.checkout.v1'
const storageWarning = '浏览器无法保存订单查询凭证，已暂停新购买。请允许此网站使用会话存储，再重新检查。'
const money = (value: string | number) => {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : '—'
}
const normalizeUsername = (value: string) => value.trim().replace(/^@/, '').toLowerCase()
const formatTime = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const reasonText = (reason?: string | null) => {
  const reasons: Record<string, string> = {
    user_not_found: '未找到该 X 账号，请检查用户名后重新核验。',
    not_eligible: '该账号当前不能接收赠送，请检查账号后重新核验。',
    recipient_changed: '接收账号信息已变化，请重新核验账号。',
    recipient_busy: '该账号已有订单正在处理，请先核对原订单。',
    product_unavailable: '此套餐暂不可购买，请重新加载套餐。',
    checkout_price_changed: '套餐价格已变化，未创建支付订单。请重新核对套餐价格并核验账号。',
    checkout_unavailable: '当前暂不可新购，未创建支付订单。请重新检查套餐和服务状态。',
    execution_disabled: '赠送服务暂未开放，当前不能发起新购买。',
    checkout_disabled: '商户暂未开放扫码购买。',
    payment_not_configured: '商户尚未完成收款配置，暂不可购买。',
    alipay_not_configured: '商户尚未完成支付宝配置，暂不可购买。',
  }
  return reason ? reasons[reason] ?? (/\p{Script=Han}/u.test(reason) ? reason : `暂不可操作（${reason}）。`) : ''
}

function restoreAttempt(): { attempt: Attempt | null; error: string } {
  let attempt: Attempt | null = null
  try {
    const saved = sessionStorage.getItem(storageKey)
    if (saved) {
      const value = JSON.parse(saved) as Partial<Attempt>
      if (
        value.version !== 1 ||
        !/^[a-f0-9]{32}$/.test(value.request_id ?? '') ||
        !/^[a-f0-9]{64}$/.test(value.access_token ?? '') ||
        typeof value.product_code !== 'string' || !value.product_code ||
        typeof value.username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(value.username) ||
        typeof value.recipient_id !== 'string' || !value.recipient_id ||
        typeof value.expected_amount_cny !== 'string' || money(value.expected_amount_cny) === '—' ||
        typeof value.product_name !== 'string' ||
        (value.checkout_id !== undefined && (typeof value.checkout_id !== 'string' || !value.checkout_id))
      ) return { attempt: null, error: '本页保存的订单凭证无法读取，已阻止新购买。请联系商户核对原订单，勿重复付款。' }
      attempt = value as Attempt
    }
    const probe = `${storageKey}.probe`
    sessionStorage.setItem(probe, '1')
    if (sessionStorage.getItem(probe) !== '1') throw new Error('storage_unavailable')
    sessionStorage.removeItem(probe)
    return { attempt, error: '' }
  } catch { return { attempt, error: storageWarning } }
}

function persistAttempt(attempt: Attempt) {
  const encoded = JSON.stringify(attempt)
  sessionStorage.setItem(storageKey, encoded)
  if (sessionStorage.getItem(storageKey) !== encoded) throw new Error('storage_unavailable')
}

function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) => value.toString(16).padStart(2, '0')).join('')
}

function orderState(order: CheckoutOrder, expired: boolean) {
  if (order.paid) {
    if (order.fulfillment_status === 'succeeded') return { label: '赠送已完成', tone: 'success', description: 'X 赠送订单已完成，请前往 X 核对账号权益。' }
    if (order.fulfillment_status === 'attention') return { label: '已付款，待处理', tone: 'attention', description: '付款已确认，赠送需要商户进一步处理。请保留订单号联系商户，无需重复付款。' }
    if (order.order_id && order.fulfillment_status === 'processing') return { label: '已付款，赠送处理中', tone: 'pending', description: '付款已确认，正在处理 X 赠送订单。请通过本页查看进度，无需重复付款。' }
    return { label: '已付款，等待赠送', tone: 'pending', description: '付款已确认，正在等待赠送安排。请保留此页，无需重复付款。' }
  }
  if (order.fulfillment_status === 'attention') return { label: '付款结果待核对', tone: 'attention', description: '原付款结果需要商户核对，已隐藏付款码。请保留订单号联系商户，勿重复付款。' }
  if (order.payment_status === 'closed') return { label: '支付订单已关闭', tone: 'muted', description: '此二维码已失效。若已在支付宝付款，请继续查询原订单并联系商户核对，勿重复付款。' }
  if (order.payment_status === 'failed') return { label: '支付订单创建失败', tone: 'attention', description: '暂时无法提供付款二维码。请保留原订单号联系商户核对处理结果。' }
  if (expired) return { label: '二维码已过期', tone: 'muted', description: '付款二维码已隐藏，仍会查询原订单。若你已付款，请等待确认或联系商户核对，勿重复付款。' }
  if (order.payment_status === 'paid') return { label: '付款结果待核对', tone: 'attention', description: '正在核对付款确认结果。请保留原订单，勿重复付款。' }
  if (order.payment_status === 'creating') return { label: '正在准备付款码', tone: 'pending', description: '支付订单已保存，正在等待付款二维码。请稍候，无需重新下单。' }
  return { label: '等待支付宝付款', tone: 'pending', description: '请核对账号和金额，再使用支付宝扫码付款。付款后会自动更新进度。' }
}

export function Checkout({ request }: { request: Request }) {
  const [initial] = useState(restoreAttempt)
  const [attempt, setAttempt] = useState<Attempt | null>(initial.attempt)
  const [storageError, setStorageError] = useState(initial.error)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [catalogVersion, setCatalogVersion] = useState(0)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [productCode, setProductCode] = useState(initial.attempt?.product_code ?? '')
  const [username, setUsername] = useState(initial.attempt?.username ?? '')
  const [checked, setChecked] = useState<Eligibility | null>(null)
  const [order, setOrder] = useState<CheckoutOrder | null>(null)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [busy, setBusy] = useState('')
  const [polling, setPolling] = useState(false)
  const [lastChecked, setLastChecked] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now)
  const [qrImage, setQrImage] = useState('')
  const [qrError, setQrError] = useState(false)
  const [qrVersion, setQrVersion] = useState(0)
  const actionLock = useRef(false)
  const statusLock = useRef(false)
  const mounted = useRef(true)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    let live = true
    setCatalogLoading(true)
    request<Catalog>('/api/checkout/catalog').then((value) => {
      if (!live) return
      setCatalog(value)
      setCatalogError('')
      setProductCode((code) => value.products.some((product) => product.code === code) ? code : value.products[0]?.code ?? '')
      setChecked(null)
    }).catch(() => { if (live) setCatalogError('暂时无法加载可购买套餐，请重新加载。') })
      .finally(() => { if (live) setCatalogLoading(false) })
    return () => { live = false }
  }, [request, catalogVersion])

  const product = catalog?.products.find((value) => value.code === productCode)
  const available = !!catalog?.available && !catalogLoading && !catalogError && !storageError
  const expired = !!order && order.expires_at > 0 && now >= order.expires_at
  const amountChanged = !!order && !!attempt && money(order.amount_cny) !== attempt.expected_amount_cny
  const canShowQr = !!order && !order.paid && order.payment_status === 'pending' && order.fulfillment_status === 'waiting_payment' && !expired && order.expires_at > 0 && !statusError && !amountChanged && money(order.amount_cny) !== '—'
  const qrValue = canShowQr ? order.qr_code : null
  const terminal = !!order && ((order.paid && order.fulfillment_status === 'succeeded') || (!order.paid && ['closed', 'failed'].includes(order.payment_status)))

  useEffect(() => {
    if (!order || order.paid || expired) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [order?.id, order?.expires_at, order?.paid, expired])

  useEffect(() => {
    let live = true
    setQrImage('')
    setQrError(false)
    if (qrValue) QRCode.toDataURL(qrValue, { width: 264, margin: 4, errorCorrectionLevel: 'M' })
      .then((image) => { if (live) setQrImage(image) })
      .catch(() => { if (live) setQrError(true) })
    return () => { live = false }
  }, [qrValue, qrVersion])

  async function queryStatus(saved: Attempt) {
    if (!saved.checkout_id || statusLock.current) return
    statusLock.current = true
    setPolling(true)
    try {
      const next = await request<CheckoutOrder>('/api/checkout/status', { checkout_id: saved.checkout_id, access_token: saved.access_token })
      if (!mounted.current) return
      setOrder(next)
      setNow(Date.now())
      setLastChecked(Date.now())
      setStatusError('')
    } catch {
      if (mounted.current) setStatusError('暂时无法确认最新订单状态。请检查网络并查询原订单；若已付款，请勿再次支付。')
    } finally { statusLock.current = false; if (mounted.current) setPolling(false) }
  }

  useEffect(() => {
    if (!attempt?.checkout_id) return
    void queryStatus(attempt)
    if (terminal) return
    const timer = window.setInterval(() => { void queryStatus(attempt) }, 5000)
    return () => window.clearInterval(timer)
  }, [attempt?.checkout_id, attempt?.access_token, request, terminal])

  async function checkRecipient(event: FormEvent) {
    event.preventDefault()
    if (actionLock.current || !product || !available || attempt) return
    actionLock.current = true
    setBusy('check')
    setError('')
    setChecked(null)
    try {
      const next = await request<Eligibility>('/api/checkout/eligibility', { product_code: product.code, username: normalizeUsername(username) })
      if (!mounted.current) return
      setChecked(next)
      if (!next.eligible) setError(reasonText(next.reason) || '该账号当前不能接收赠送，请检查账号后重新核验。')
    } catch (cause) {
      if (!mounted.current) return
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
      setError(typeof code === 'string' ? reasonText(code) : '账号核验未完成。请检查网络后重新核验，尚未创建支付订单。')
    } finally { actionLock.current = false; if (mounted.current) setBusy('') }
  }

  async function createCheckout() {
    if (actionLock.current || attempt?.checkout_id) return
    if (!attempt && (!checked?.eligible || !product || !available || money(product.price_cny) === '—')) return
    actionLock.current = true
    setBusy('create')
    setError('')
    let saved = attempt
    try {
      if (!saved) {
        if (!globalThis.crypto?.getRandomValues) {
          setError('当前浏览器无法生成安全的订单凭证，请使用支持安全连接的浏览器打开本页。尚未创建支付订单。')
          return
        }
        saved = { version: 1, request_id: randomHex(16), access_token: randomHex(32), product_code: product!.code, username: checked!.username, recipient_id: checked!.recipient_id, expected_amount_cny: money(product!.price_cny), product_name: product!.name }
        try { persistAttempt(saved) } catch { setStorageError(storageWarning); return }
        setAttempt(saved)
      }
      const next = await request<CheckoutOrder>('/api/checkout', { request_id: saved.request_id, access_token: saved.access_token, product_code: saved.product_code, username: saved.username, recipient_id: saved.recipient_id, expected_amount_cny: saved.expected_amount_cny })
      if (!mounted.current) return
      const updated = { ...saved, checkout_id: next.id }
      setAttempt(updated)
      setOrder(next)
      setNow(Date.now())
      setLastChecked(Date.now())
      setStatusError('')
      try { persistAttempt(updated) } catch { setStorageError('订单已创建，但浏览器未能更新恢复记录。请保持本页打开；刷新后可用已保存的原请求恢复此订单。') }
    } catch (cause) {
      if (!mounted.current) return
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
      if (typeof code === 'string' && ['checkout_price_changed', 'checkout_unavailable', 'recipient_changed', 'product_unavailable'].includes(code)) {
        try {
          sessionStorage.removeItem(storageKey)
          if (sessionStorage.getItem(storageKey) !== null) throw new Error('storage_unavailable')
          setAttempt(null)
          setChecked(null)
          setCatalogVersion((value) => value + 1)
          setError(reasonText(code))
        } catch { setStorageError(storageWarning) }
      } else setError('未能确认支付订单是否创建。原请求凭证已保留，请重试原请求找回结果；不会生成新的付款请求。若持续失败，请联系商户。')
    } finally { actionLock.current = false; if (mounted.current) setBusy('') }
  }

  function recheckStorage() {
    const restored = restoreAttempt()
    setStorageError(restored.error)
    if (!attempt && restored.attempt) setAttempt(restored.attempt)
  }

  const stage = attempt ? 3 : checked?.eligible ? 2 : 1
  const state = order ? orderState(order, expired) : null

  return (
    <main className="login redeem-page checkout-page">
      <div className="recharge-topbar checkout-topbar">
        <a href="/buy" className="login-brand" aria-label="X Premium 扫码购买首页"><span className="brand-mark" aria-hidden="true">X</span><span>X Premium <b>/</b> 扫码购买</span></a>
        <nav aria-label="其他入口" className="checkout-nav"><a className="text-link" href="/redeem">卡密兑换</a><a className="text-link" href="/">商户登录</a></nav>
      </div>
      <div className="redeem-wrap checkout-wrap">
        <h1>支付宝扫码购买</h1>
        <p className="recharge-intro">选择 X Premium 套餐，核验接收账号后扫码付款。只需 X 用户名，无需提供账号密码。</p>
        <ol className="recharge-steps" aria-label="购买进度">{['选择套餐', '确认账号与金额', '付款与赠送'].map((label, index) => <li key={label} aria-current={stage === index + 1 ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>

        {storageError && <div className="notice error" role="alert">{storageError}{!attempt && <Button type="button" variant="secondary" onClick={recheckStorage}>重新检查存储</Button>}</div>}

        {!attempt && <>
          {catalogLoading ? <p className="checkout-loading" role="status">正在加载可购买套餐…</p> : catalogError ? <div className="notice error" role="alert">{catalogError}<Button type="button" variant="secondary" onClick={() => setCatalogVersion((value) => value + 1)}>重新加载套餐</Button></div> : catalog && (!catalog.available || !catalog.products.length) ? <div className="notice" role="status">{catalog.available ? '当前没有可购买的套餐，请稍后重新查看。' : reasonText(catalog.reason) || '商户暂时关闭了新购买，请稍后重新查看。'}<Button type="button" variant="secondary" onClick={() => setCatalogVersion((value) => value + 1)}>重新检查套餐</Button></div> : null}
          {!!catalog?.products.length && !catalogLoading && !catalogError && <form onSubmit={checkRecipient} className="recharge-form checkout-form">
            <fieldset className="checkout-products" disabled={!!busy || !available}>
              <legend>选择套餐</legend>
              {catalog.products.map((item) => <label className={`checkout-product${productCode === item.code ? ' is-selected' : ''}`} key={item.code}>
                <input type="radio" name="checkout-product" value={item.code} checked={productCode === item.code} onChange={() => { setProductCode(item.code); setChecked(null); setError('') }} disabled={money(item.price_cny) === '—'} />
                <span className="checkout-product-name"><strong>{item.name}</strong><small>{item.months} 个月 · 一次性购买</small></span><span className="checkout-product-price">¥{money(item.price_cny)}</span>
              </label>)}
            </fieldset>
            <Input label="接收套餐的 X 用户名" name="username" value={username} onChange={(event) => { setUsername(event.target.value); setChecked(null); setError('') }} disabled={!!busy || !available} placeholder="例如 @username" autoComplete="off" autoCapitalize="none" spellCheck={false} pattern="@?[A-Za-z0-9_]{1,15}" maxLength={16} required />
            <Button type="submit" variant={checked?.eligible ? 'secondary' : 'primary'} disabled={!!busy || !available || !product || !username.trim() || money(product.price_cny) === '—'}>{busy === 'check' ? '正在核验账号…' : checked?.eligible ? '重新核验接收账号' : '核验接收账号'}</Button>
          </form>}
        </>}

        {error && <p className="notice error" role="alert">{error}</p>}
        {!attempt && checked?.eligible && product && <section className="recharge-confirm checkout-confirm" aria-label="确认购买信息">
          <h2>确认账号与付款金额</h2><strong>@{checked.username}</strong>
          <dl className="details recharge-details"><div><dt>购买套餐</dt><dd>{product.name}</dd></div><div><dt>应付金额</dt><dd className="checkout-confirm-amount">¥{money(product.price_cny)}</dd></div><div><dt>付款方式</dt><dd>{catalog?.payment_label || '支付宝当面付'}</dd></div></dl>
          <p>付款后将为此账号赠送套餐。请确认用户名和金额无误；创建订单后不能更换接收账号。</p>
          <Button type="button" variant="primary" disabled={!!busy || !available} onClick={() => { void createCheckout() }}>确认 ¥{money(product.price_cny)}，创建付款码</Button>
        </section>}

        {attempt && !order && <section className="recharge-result" aria-label="恢复购买订单">
          <h2>{attempt.checkout_id ? '正在恢复原订单' : busy === 'create' ? '正在创建支付订单' : '找回原支付请求'}</h2>
          <dl className="details recharge-details"><div><dt>接收账号</dt><dd>@{attempt.username}</dd></div><div><dt>购买套餐</dt><dd>{attempt.product_name}</dd></div><div><dt>已确认金额</dt><dd>¥{attempt.expected_amount_cny}</dd></div>{attempt.checkout_id && <div><dt>支付订单号</dt><dd><code>{attempt.checkout_id}</code></dd></div>}</dl>
          <p className="note">{attempt.checkout_id ? '已找到此标签页保存的订单凭证，正在查询最新状态。' : '原请求凭证已保存。若创建结果未返回，重试会继续同一个请求并找回原订单。'}</p>
          {!attempt.checkout_id && <Button type="button" variant="primary" disabled={!!busy} onClick={() => { void createCheckout() }}>{busy === 'create' ? '正在确认原请求…' : '重试原请求'}</Button>}
        </section>}

        {order && state && <section className="recharge-result checkout-result" aria-label="购买订单状态">
          <div className="recharge-result-heading"><h2>购买订单</h2><span className={`status checkout-state-${state.tone}`} role="status">{state.label}</span></div>
          <dl className="details recharge-details"><div><dt>接收账号</dt><dd>@{order.recipient}</dd></div><div><dt>购买套餐</dt><dd>{order.product_name} · {order.months} 个月</dd></div><div><dt>{order.paid ? '已付金额' : '订单金额'}</dt><dd className="checkout-confirm-amount">¥{money(order.amount_cny)}</dd></div><div><dt>支付订单号</dt><dd><code>{order.id}</code></dd></div>{order.order_id && <div><dt>赠送订单号</dt><dd><code>{order.order_id}</code></dd></div>}</dl>
          <p className="checkout-state-description" aria-live="polite">{state.description}</p>
          {order.message && (!order.paid || !!order.order_id || order.fulfillment_status === 'attention') && <p className="note checkout-server-message">{order.message}</p>}
          {amountChanged && <div className="notice error" role="alert">订单金额 ¥{money(order.amount_cny)} 与已确认的 ¥{attempt?.expected_amount_cny} 不一致，付款码已隐藏。请联系商户核对原订单，勿重复付款。</div>}
          {canShowQr && <div className="checkout-qr-area">
            {qrError ? <div className="notice error" role="alert">付款码图片未能生成，请重新显示。<Button type="button" variant="secondary" onClick={() => setQrVersion((value) => value + 1)}>重新显示付款码</Button></div> : qrImage ? <img className="checkout-qr" src={qrImage} width={264} height={264} alt={`使用支付宝扫码支付 ¥${money(order.amount_cny)}`} /> : <p className="checkout-qr-placeholder" role="status">{order.qr_code ? '正在生成付款码图片…' : '正在等待支付宝付款码…'}</p>}
            <strong>支付宝扫一扫 · ¥{money(order.amount_cny)}</strong><p>付款码有效期至 {formatTime(order.expires_at)}</p>
          </div>}
        </section>}

        {statusError && <p className="notice error" role="alert">{statusError}</p>}
        {attempt?.checkout_id && <div className="checkout-status-actions"><Button type="button" variant="secondary" disabled={polling} onClick={() => { void queryStatus(attempt) }}>{polling ? '正在查询原订单…' : '查询原订单状态'}</Button><p>{lastChecked ? `最近查询 ${new Date(lastChecked).toLocaleTimeString('zh-CN', { hour12: false })}` : '正在查询订单'}{!terminal && ' · 每 5 秒自动更新'}</p></div>}
        <p className="note checkout-persistence-note">{attempt ? '查询凭证仅保存在当前标签页，刷新可恢复原订单。请保持此页打开，完成前不要清除浏览器数据。需要帮助时，请向商户提供订单号。' : '已有卡密？请前往卡密兑换。扫码购买付款后会自动安排赠送，进度以本页订单状态为准。'}</p>
      </div>
      <footer>X Premium · 支付宝扫码购买</footer>
    </main>
  )
}
