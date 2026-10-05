import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { orderFailureDescription } from './order-failures'
import { closedGift, giftOrderPresentation, giftProductName, redeemStage, REDEEM_POLL_FAILURE_LIMIT, REDEEM_POLL_INTERVAL, REDEEM_POLL_LIMIT, sameOriginalOrder, shouldPollRedeem, voucherRequest, type VoucherAttempt } from './redeem-flow'
import './redeem-flow.css'

export type Request = <T>(
  path: string,
  body?: Record<string, unknown>,
) => Promise<T>
type Capabilities = {
  execution_ready: boolean
  accepts_orders: boolean
  modes: string[]
}
type Eligibility = {
  username: string
  recipient_id: string
  eligible: boolean
  reason?: string
}
type Product = {
  code: string
  name: string
  points: number
  enabled: number | boolean
}
type Order = {
  id: string
  merchant_order_no?: string
  recipient: string
  product_code: string
  status: string
  failure_code?: string | null
  created_at: number
  updated_at: number
}
type VoucherView = {
  state: 'available' | 'redeemed' | 'revoked' | 'expired'
  product: { code: string; name: string; months: number }
  expires_at: number
  order?: Order
}
type Attempt = {
  mode: 'direct'
  idempotency_key: string
  merchant_order_no: string
  product_code: string
  recipient: string
  recipient_id: string
  expected_points: number
}
const message = (e: unknown) =>
  e instanceof Error ? e.message : '请求未确认，请查询原订单。'
const time = (value: number) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false })
const normalizeUsername = (value: string) =>
  value.trim().replace(/^@/, '').toLowerCase()
const eligibilityMessage = (reason?: string) =>
  reason === 'user_not_found'
    ? '未找到该 X 账号，请检查用户名。'
    : '该账号当前不能接收赠送，请检查账号后重试。'
const safeRejections = [
  'insufficient_points',
  'not_eligible',
  'recipient_changed',
  'recipient_busy',
  'product_unavailable',
  'execution_disabled',
  'first_order_locked',
  'price_changed',
]

function useCapabilities(request: Request) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    request<Capabilities>('/api/capabilities')
      .then((value) => {
        if (live) {
          setCapabilities(value)
          setError('')
        }
      })
      .catch((e) => {
        if (live) {
          setCapabilities(null)
          setError(message(e))
        }
      })
    return () => {
      live = false
    }
  }, [request, version])
  return { capabilities, error, refresh: () => setVersion((v) => v + 1) }
}

function Availability({
  capabilities,
  error,
  refresh,
}: ReturnType<typeof useCapabilities>) {
  if (capabilities?.accepts_orders && capabilities.execution_ready) return null
  return (
    <div className="notice" role="status">
      {error
        ? '暂时无法确认服务状态。'
        : !capabilities
          ? '正在确认服务状态…'
          : '当前暂停接收新订单，仍可查询原订单。'}
      {(error || capabilities) && (
        <Button type="button" variant="ghost" onClick={refresh}>
          重新检查
        </Button>
      )}
    </div>
  )
}

export function OrderResult({ order, productName, actions, headingRef }: { order: Order; productName?: string; actions?: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) {
  const state = giftOrderPresentation(order)
  return (
    <section
      className="recharge-result"
      aria-label="原订单状态"
    >
      <div className="recharge-result-heading">
        <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>赠送订单</h2>
        <div className="redeem-result-actions"><span className={`status status-${closedGift(order) ? 'closed' : order.status}`} role="status">{state.label}</span>{actions}</div>
      </div>
      <dl className="details recharge-details">
        <div>
          <dt>接收账号</dt>
          <dd>@{order.recipient}</dd>
        </div>
        <div>
          <dt>套餐</dt>
          <dd>{giftProductName(order.product_code, productName)}</dd>
        </div>
        <div>
          <dt>订单编号</dt>
          <dd>
            <code>{order.id}</code>
          </dd>
        </div>
        {order.merchant_order_no && (
          <div>
            <dt>商户订单号</dt>
            <dd>
              <code>{order.merchant_order_no}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>更新时间</dt>
          <dd>{time(order.updated_at)}</dd>
        </div>
      </dl>
      <p className="note">
        {state.description}
        {order.failure_code && <> {orderFailureDescription(order.failure_code)} 原因代码：<code>{order.failure_code}</code></>}
      </p>
    </section>
  )
}

export function Redeem({ request }: { request: Request }) {
  const [code, setCode] = useState(''), [username, setUsername] = useState('')
  const [view, setView] = useState<VoucherView | null>(null)
  const [checked, setChecked] = useState<Eligibility | null>(null)
  const [attempt, setAttempt] = useState<VoucherAttempt | null>(null)
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [lastChecked, setLastChecked] = useState<number | null>(null)
  const [poll, setPoll] = useState({ count: 0, failures: 0 })
  const [focusVersion, setFocusVersion] = useState(0)
  const lock = useRef(false), mounted = useRef(false), generation = useRef(0)
  const heading = useRef<HTMLHeadingElement | null>(null)
  const pollRef = useRef(poll)
  const service = useCapabilities(request)
  const accepts = !!service.capabilities?.execution_ready && !!service.capabilities?.accepts_orders
    && !!service.capabilities?.modes.includes('voucher')
  const stage = redeemStage(view, !!attempt)
  const productName = view ? giftProductName(view.product.code, view.product.name) : 'X 会员套餐'
  const active = !!view?.order && ['queued', 'running', 'unknown'].includes(view.order.status)
  const unresolved = !!attempt && !view?.order
  const pollingStopped = poll.count >= REDEEM_POLL_LIMIT || poll.failures >= REDEEM_POLL_FAILURE_LIMIT
  const queryCode = attempt?.code ?? code.trim()

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])
  // Only deliberate step changes request focus. Polling never updates this key.
  useEffect(() => {
    if (focusVersion > 0) heading.current?.focus({ preventScroll: true })
  }, [focusVersion])

  function updatePoll(next: { count: number; failures: number }) { pollRef.current = next; setPoll(next) }
  async function perform(task: string, work: (current: () => boolean) => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(task); setError('')
    const currentGeneration = generation.current
    const current = () => mounted.current && currentGeneration === generation.current
    try { await work(current) }
    catch (cause) { if (current()) setError(message(cause)) }
    finally { lock.current = false; if (current()) setBusy('') }
  }
  function inspect(event: FormEvent) {
    event.preventDefault()
    const inspectedCode = code.trim()
    if (!inspectedCode) return
    void perform('inspect', async current => {
      const next = await request<VoucherView>('/api/redeem/inspect', { code: inspectedCode })
      if (!current()) return
      setCode(inspectedCode); setView(next); setChecked(null); setLastChecked(Date.now())
      updatePoll({ count: 0, failures: 0 }); setFocusVersion(value => value + 1)
    })
  }
  function check(event: FormEvent) {
    event.preventDefault()
    if (!accepts || view?.state !== 'available' || attempt) return
    void perform('check', async current => {
      const next = await request<Eligibility>('/api/redeem/eligibility', { code: code.trim(), username: normalizeUsername(username) })
      if (!current()) return
      setChecked(next)
      if (!next.eligible) setError(eligibilityMessage(next.reason))
      else setFocusVersion(value => value + 1)
    })
  }
  function redeem() {
    if (!attempt && (!checked?.eligible || !accepts)) return
    const payload = voucherRequest(attempt, code, checked)
    if (!payload) return
    void perform('redeem', async current => {
      // A voucher is its own immutable server-side idempotency identity. Retain
      // this exact request through timeouts; never create another request key.
      setAttempt(payload); setFocusVersion(value => value + 1)
      try {
        const next = await request<VoucherView>('/api/redeem', payload)
        if (!current()) return
        setView(next); setChecked(null); setLastChecked(Date.now())
        updatePoll({ count: 0, failures: 0 }); setFocusVersion(value => value + 1)
      } catch (cause) {
        if (!current()) return
        const failure = (cause as { code?: string })?.code
        if (failure && safeRejections.includes(failure)) {
          setAttempt(null); setChecked(null); service.refresh(); setFocusVersion(value => value + 1)
        } else if (failure === 'voucher_unavailable') {
          setAttempt(null); setChecked(null); setView(null); setFocusVersion(value => value + 1)
        }
        throw cause
      }
    })
  }
  const lookup = useCallback(async (manual = true) => {
    if (lock.current || !queryCode) return
    lock.current = true; setBusy('lookup')
    if (manual) { pollRef.current = { count: 0, failures: 0 }; setError('') }
    const currentGeneration = generation.current
    const current = () => mounted.current && generation.current === currentGeneration
    const nextPoll = { ...pollRef.current, count: pollRef.current.count + (manual ? 0 : 1) }
    pollRef.current = nextPoll; setPoll(nextPoll)
    try {
      // This endpoint is read-only, including when the original submit timed out.
      const next = await request<VoucherView>('/api/redeem/status', { code: queryCode })
      if (!current()) return
      if (!sameOriginalOrder(view?.order?.id, next.order?.id)) throw new Error('原订单信息暂未核对一致，已保留上次结果。请联系商户，勿重新兑换。')
      setView(next); setLastChecked(Date.now()); setError('')
      pollRef.current = { ...nextPoll, failures: 0 }; setPoll(pollRef.current)
    } catch (cause) {
      if (!current()) return
      pollRef.current = { ...nextPoll, failures: nextPoll.failures + 1 }; setPoll(pollRef.current)
      setError('原订单暂未刷新，以下保留上次确认的结果。' + message(cause))
    } finally { lock.current = false; if (current()) setBusy('') }
  }, [request, queryCode, view?.order?.id])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (shouldPollRedeem(view?.order?.status, !!attempt, pollRef.current.count, pollRef.current.failures, document.visibilityState === 'visible')) void lookup(false)
    }, REDEEM_POLL_INTERVAL)
    return () => window.clearInterval(timer)
  }, [lookup, view?.order?.status, !!attempt])

  function editVoucher(clearCode = false) {
    if (lock.current) return
    generation.current++; if (clearCode) setCode('')
    setUsername(''); setView(null); setChecked(null); setAttempt(null); setError(''); setLastChecked(null)
    updatePoll({ count: 0, failures: 0 }); setFocusVersion(value => value + 1)
  }
  function editRecipient() {
    if (lock.current || attempt) return
    setChecked(null); setError(''); setFocusVersion(value => value + 1)
  }
  const refreshButton = <Button type="button" variant="secondary" disabled={!!busy} onClick={() => void lookup()}>{busy === 'lookup' ? '正在查询…' : '刷新原订单'}</Button>

  return <main className="login redeem-page redeem-flow">
    <div className="recharge-topbar">
      <a className="login-brand" href="/"><span className="brand-mark" aria-hidden="true">X</span><span>Bugan.cn <b>/</b> X Premium</span></a>
      <a className="text-link" href="/">商户登录</a>
    </div>
    <div className="redeem-wrap">
      <h1>卡密兑换 X Premium</h1>
      <p className="recharge-intro">输入卡密，确认接收账号，随后查看原订单进度。只需 X 用户名，无需账号密码。</p>
      <ol className="recharge-steps" aria-label="兑换进度">{['核验卡密', '确认账号', '查看订单'].map((label, index) => <li key={label} aria-current={stage === index + 1 ? 'step' : undefined} data-complete={stage > index + 1 || undefined}><span>{index + 1}</span>{label}</li>)}</ol>
      {stage !== 3 && <Availability {...service} />}
      {error && <p className="notice error" role="alert">{error}</p>}

      {stage === 1 && <section className="redeem-stage" aria-labelledby="redeem-stage-heading">
        <h2 id="redeem-stage-heading" ref={heading} tabIndex={-1}>输入你的卡密</h2>
        <p className="note">首次兑换或查询已有订单，都使用商户提供的同一卡密。</p>
        <form onSubmit={inspect} className="recharge-form">
          <Input label="兑换卡密" type="password" autoComplete="off" spellCheck={false} name="voucher-code" value={code}
            onChange={event => { setCode(event.target.value); setView(null); setChecked(null); setError('') }}
            disabled={!!busy} placeholder="粘贴完整卡密" required maxLength={200} />
          <Button type="submit" variant="primary" disabled={!!busy || !code.trim()}>{busy === 'inspect' ? '正在核验卡密…' : '核验卡密 / 查询原单'}</Button>
        </form>
        {view && !view.order && <p className="notice" role="status">{productName} · {view.state === 'expired' ? '卡密已过期' : view.state === 'revoked' ? '卡密已撤销' : '卡密已兑换但暂未取得原订单'}，请联系商户处理。</p>}
      </section>}

      {stage === 2 && view && <>
        <div className="redeem-completed-step" aria-label="已核验卡密摘要">
          <div><span>已核验卡密 · 尾号 {code.trim().slice(-4)}</span><strong>{productName}</strong><small>有效期至 {time(view.expires_at)}</small></div>
          <Button type="button" variant="ghost" disabled={!!busy} onClick={() => editVoucher()}>修改卡密</Button>
        </div>
        {!checked?.eligible ? <section className="redeem-stage" aria-labelledby="redeem-stage-heading">
          <h2 id="redeem-stage-heading" ref={heading} tabIndex={-1}>接收套餐的是哪个账号？</h2>
          <p className="note">填写 X 用户名，不是昵称。核验后还会请你确认一次。</p>
          <form onSubmit={check} className="recharge-form">
            <Input label="接收套餐的 X 用户名" name="username" value={username} onChange={event => { setUsername(event.target.value); setChecked(null); setError('') }}
              disabled={!!busy} placeholder="例如 @username" autoComplete="off" autoCapitalize="none" spellCheck={false} pattern="@?[A-Za-z0-9_]{1,15}" maxLength={16} required />
            <Button type="submit" variant="primary" disabled={!!busy || !accepts || !username.trim()}>{busy === 'check' ? '正在核验账号…' : '核验接收账号'}</Button>
          </form>
        </section> : <section className="redeem-confirmation" aria-labelledby="redeem-stage-heading">
          <div className="redeem-section-heading"><h2 id="redeem-stage-heading" ref={heading} tabIndex={-1}>确认后开始兑换</h2><Button type="button" variant="ghost" disabled={!!busy} onClick={editRecipient}>修改账号</Button></div>
          <dl className="redeem-confirm-details"><div><dt>接收账号</dt><dd>@{checked.username}</dd></div><div><dt>兑换套餐</dt><dd>{productName}</dd></div></dl>
          <p className="note">兑换后卡密将绑定这个账号，不能更换。请再核对一次用户名。</p>
          <Button type="button" variant="primary" disabled={!!busy || !accepts} onClick={redeem}>确认账号并兑换</Button>
        </section>}
      </>}

      {stage === 3 && <div className="redeem-order-stage">
        {view?.order ? <>
          <OrderResult order={view.order} productName={productName} actions={refreshButton} headingRef={heading} />
          <p className="note redeem-binding-note">卡密尾号 {queryCode.slice(-4)} 已绑定此订单，不能重复兑换。请保存订单号，联系商户时提供。</p>
        </> : <section className="recharge-result" aria-label="待确认的原兑换请求">
          <div className="recharge-result-heading"><h2 ref={heading} tabIndex={-1}>{busy === 'redeem' ? '正在提交兑换' : '原兑换请求待确认'}</h2>{refreshButton}</div>
          <dl className="details recharge-details"><div><dt>接收账号</dt><dd>@{attempt?.recipient}</dd></div><div><dt>兑换套餐</dt><dd>{productName}</dd></div></dl>
          <p className="notice" role="status">兑换信息已经锁定。暂未拿到结果不代表失败，请先查询原单；重试只会核对同一卡密、同一接收账号，不会新建另一笔请求。</p>
          <Button type="button" variant="secondary" disabled={!!busy} onClick={redeem}>{busy === 'redeem' ? '正在确认原请求…' : '重试同一兑换请求'}</Button>
        </section>}
        <p className="note redeem-poll-status">{lastChecked ? `最近确认 ${time(lastChecked)}` : '尚未取得原订单状态'}{(active || unresolved) && (pollingStopped ? ' · 自动查询已暂停，请点击“刷新原订单”继续核对。' : ' · 页面可见时每 10 秒更新，最多自动查询 60 次。')}</p>
        {view?.order && <div className="redeem-next"><Button type="button" variant="ghost" disabled={!!busy} onClick={() => editVoucher(true)}>使用其他卡密</Button><p className="note">切换前请自行保存当前卡密和订单号。重新输入同一卡密，可继续查询这笔原单。</p></div>}
      </div>}
      <p className="note redeem-privacy-note">卡密仅用于本次兑换和原单查询，不会写入浏览器存储或网址。刷新或关闭页面后，需要重新输入同一卡密。</p>
    </div>
    <footer>X Premium · 卡密兑换套餐</footer>
  </main>
}

function readAttempt(key: string): Attempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    return value?.mode === 'direct' &&
      typeof value.idempotency_key === 'string' &&
      typeof value.merchant_order_no === 'string' &&
      typeof value.recipient === 'string' &&
      typeof value.recipient_id === 'string' &&
      typeof value.product_code === 'string' &&
      Number.isInteger(value.expected_points)
      ? value
      : null
  } catch {
    return null
  }
}

export function DirectRecharge({
  request,
  userId,
  onCreated,
}: {
  request: Request
  userId: string
  onCreated: () => void
}) {
  const storageKey = `xgift.direct-attempt.${userId}`
  const [attempt, setAttempt] = useState<Attempt | null>(() =>
    readAttempt(storageKey),
  )
  const [products, setProducts] = useState<Product[]>([]),
    [productCode, setProductCode] = useState(attempt?.product_code ?? '')
  const [username, setUsername] = useState(attempt?.recipient ?? ''),
    [checked, setChecked] = useState<Eligibility | null>(null)
  const [order, setOrder] = useState<Order | null>(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('')
  const [productLoad, setProductLoad] = useState(0),
    [productError, setProductError] = useState('')
  const lock = useRef(false)
  const service = useCapabilities(request)
  const product = products.find((p) => p.code === productCode)
  const accepts =
    !!service.capabilities?.execution_ready &&
    !!service.capabilities?.accepts_orders &&
    !!service.capabilities?.modes.includes('direct')
  useEffect(() => {
    let live = true
    request<Product[]>('/api/products')
      .then((rows) => {
        if (!live) return
        setProducts(rows.filter((p) => p.enabled))
        setProductError('')
        setProductCode(
          (current) => current || rows.find((p) => p.enabled)?.code || '',
        )
      })
      .catch((e) => {
        if (live) setProductError(message(e))
      })
    return () => {
      live = false
    }
  }, [request, productLoad])
  function saveAttempt(value: Attempt | null) {
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value))
      else sessionStorage.removeItem(storageKey)
    } catch {
      if (value) throw new Error('无法保存订单重试信息，请允许浏览器会话存储后再下单。')
    }
    setAttempt(value)
  }
  async function perform(task: string, work: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(task)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(message(e))
    } finally {
      lock.current = false
      setBusy('')
    }
  }
  function check(e: FormEvent) {
    e.preventDefault()
    void perform('check', async () => {
      const next = await request<Eligibility>('/api/eligibility', {
        username: normalizeUsername(username),
      })
      setChecked(next)
      if (!next.eligible) setError(eligibilityMessage(next.reason))
    })
  }
  function submit() {
    if (!attempt && (!checked?.eligible || !product)) return
    const payload: Attempt = attempt ?? {
      mode: 'direct',
      idempotency_key: crypto.randomUUID(),
      merchant_order_no: `web_${crypto.randomUUID()}`,
      product_code: product!.code,
      recipient: checked!.username,
      recipient_id: checked!.recipient_id,
      expected_points: product!.points,
    }
    void perform('submit', async () => {
      saveAttempt(payload)
      try {
        const next = await request<Order>('/api/orders', payload)
        setOrder(next)
        onCreated()
        service.refresh()
      } catch (e) {
        // Only explicit pre-creation rejections allow editing; ambiguous failures keep the same key.
        const code = (e as { code?: string })?.code
        if (code && safeRejections.includes(code)) {
          saveAttempt(null)
          setChecked(null)
          setProductLoad((v) => v + 1)
          service.refresh()
        }
        throw e
      }
    })
  }
  function lookup() {
    if (!attempt) return
    void perform('lookup', async () => {
      const response = await request<Order[] | Order>(
        '/api/orders?merchant_order_no=' +
          encodeURIComponent(attempt.merchant_order_no),
      )
      const found = Array.isArray(response) ? response[0] : response
      if (!found?.id)
        throw new Error(
          '暂未查到原订单。请稍后再查，或重试原请求；不要新建订单。',
        )
      setOrder(found)
      onCreated()
    })
  }
  return (
    <section className="direct-recharge" aria-label="点数直充">
      <div className="recharge-result-heading">
        <div>
          <h2>点数直充</h2>
          <p className="note">选择套餐并核验 X 账号，下单后冻结对应点数。</p>
        </div>
        <a className="text-link" href="/redeem">
          使用卡密兑换 →
        </a>
      </div>
      <Availability {...service} />
      {productError && (
        <div className="notice error" role="alert">
          {productError}
          <Button
            type="button"
            variant="ghost"
            onClick={() => setProductLoad((v) => v + 1)}
          >
            重新加载套餐
          </Button>
        </div>
      )}
      {!attempt && (
        <form className="direct-fields" onSubmit={check}>
          <label className="form-field">
            充值套餐
            <select
              value={productCode}
              onChange={(e) => {
                setProductCode(e.target.value)
                setChecked(null)
              }}
              disabled={!!busy || !products.length}
              required
            >
              {!products.length && <option value="">暂无可用套餐</option>}
              {products.map((p) => (
                <option value={p.code} key={p.code}>
                  {p.name} · {p.points.toLocaleString('zh-CN')} 点数
                </option>
              ))}
            </select>
          </label>
          <Input
            label="接收账号"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
              setChecked(null)
            }}
            disabled={!!busy}
            placeholder="@username"
            autoComplete="off"
            pattern="@?[A-Za-z0-9_]{1,15}"
            maxLength={16}
            required
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={!!busy || !accepts || !product || !username.trim()}
          >
            {busy === 'check' ? '正在核验…' : '核验账号'}
          </Button>
        </form>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!order && (checked?.eligible || attempt) && (
        <div className="recharge-confirm">
          <h2>{attempt ? '原提交请求' : '确认直充信息'}</h2>
          <p>
            <strong>@{attempt?.recipient ?? checked?.username}</strong> ·{' '}
            {giftProductName(product?.code ?? attempt?.product_code ?? '', product?.name)} · 冻结{' '}
            <strong>
              {(attempt?.expected_points ?? product?.points)?.toLocaleString(
                'zh-CN',
              )}
            </strong>{' '}
            点数
          </p>
          {attempt && (
            <p className="note">
              商户订单号：<code>{attempt.merchant_order_no}</code>
              <br />
              请求结果未确认时，请查询原单或重试原请求。输入信息和订单号已保留。
            </p>
          )}
          <div className="recharge-actions">
            {attempt && (
              <Button
                type="button"
                variant="secondary"
                onClick={lookup}
                disabled={!!busy}
              >
                {busy === 'lookup' ? '正在查询…' : '查询原订单'}
              </Button>
            )}
            <Button
              type="button"
              variant="primary"
              disabled={!!busy || (!accepts && !attempt)}
              onClick={submit}
            >
              {busy === 'submit'
                ? '正在提交…'
                : attempt
                  ? '重试原请求'
                  : '确认并直充'}
            </Button>
          </div>
        </div>
      )}
      {order && (
        <>
          <OrderResult order={order} />
          <div className="recharge-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={!!busy}
              onClick={lookup}
            >
              {busy === 'lookup' ? '正在查询…' : '刷新原订单'}
            </Button>
            {['succeeded', 'failed'].includes(order.status) && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  saveAttempt(null)
                  setOrder(null)
                  setChecked(null)
                  setUsername('')
                  setError('')
                  service.refresh()
                }}
              >
                新建直充
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
