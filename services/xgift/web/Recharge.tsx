import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'

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

export function OrderResult({ order }: { order: Order }) {
  const status: Record<string, string> = {
    queued: '排队中',
    running: '处理中',
    unknown: '待核对',
    succeeded: '付款已确认',
    failed: '充值失败',
  }
  return (
    <section
      className="recharge-result"
      aria-label="原订单状态"
      aria-live="polite"
    >
      <div className="recharge-result-heading">
        <h2>充值订单</h2>
        <span className={`status status-${order.status}`}>
          {status[order.status] ?? order.status}
        </span>
      </div>
      <dl className="details recharge-details">
        <div>
          <dt>接收账号</dt>
          <dd>@{order.recipient}</dd>
        </div>
        <div>
          <dt>套餐</dt>
          <dd>{order.product_code}</dd>
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
        {order.status === 'succeeded'
          ? '付款已确认，请到 X 核对权益。'
          : order.status === 'unknown'
            ? '付款结果待核对。请保留原订单，不要重复付款或重新兑换。'
            : order.status === 'failed'
              ? '订单未完成，请联系商户核对处理结果。'
              : '正在处理，请通过原订单查看进度，无需再次提交。'}
        {order.failure_code && <> 原因：{order.failure_code}</>}
      </p>
    </section>
  )
}

export function Redeem({ request }: { request: Request }) {
  const [code, setCode] = useState(''),
    [username, setUsername] = useState('')
  const [view, setView] = useState<VoucherView | null>(null)
  const [checked, setChecked] = useState<Eligibility | null>(null)
  const [attempt, setAttempt] = useState<{
    code: string
    recipient: string
    recipient_id: string
  } | null>(null)
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('')
  const lock = useRef(false)
  const service = useCapabilities(request)
  const accepts =
    !!service.capabilities?.execution_ready &&
    !!service.capabilities?.accepts_orders &&
    !!service.capabilities?.modes.includes('voucher')
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
  function inspect(e?: FormEvent) {
    e?.preventDefault()
    void perform('inspect', async () => {
      const next = await request<VoucherView>('/api/redeem/inspect', {
        code: code.trim(),
      })
      setView(next)
      setChecked(null)
    })
  }
  function check(e: FormEvent) {
    e.preventDefault()
    void perform('check', async () => {
      const next = await request<Eligibility>('/api/redeem/eligibility', {
        code: code.trim(),
        username: normalizeUsername(username),
      })
      setChecked(next)
      if (!next.eligible) setError(eligibilityMessage(next.reason))
    })
  }
  function redeem() {
    if (!attempt && !checked?.eligible) return
    const payload = attempt ?? {
      code: code.trim(),
      recipient: checked!.username,
      recipient_id: checked!.recipient_id,
    }
    void perform('redeem', async () => {
      setAttempt(payload)
      try {
        const next = await request<VoucherView>('/api/redeem', payload)
        setView(next)
        setChecked(null)
      } catch (e) {
        const failure = (e as { code?: string })?.code
        if (failure && safeRejections.includes(failure)) {
          setAttempt(null)
          setChecked(null)
          service.refresh()
        } else if (failure === 'voucher_unavailable') {
          setAttempt(null)
          setChecked(null)
          setView(null)
        }
        throw e
      }
    })
  }
  const stage = view?.order ? 3 : checked?.eligible || attempt ? 2 : 1
  return (
    <main className="login redeem-page">
      <div className="recharge-topbar">
        <a className="login-brand" href="/">
          <span className="brand-mark">X</span>
          <span>
            GPTibo <b>/</b> X Premium
          </span>
        </a>
        <a className="text-link" href="/">
          商户登录
        </a>
      </div>
      <div className="redeem-wrap">
        <div className="eyebrow">卡密兑换</div>
        <h1>为你的 X 账号充值</h1>
        <p className="recharge-intro">
          输入卡密兑换对应套餐。只需 X 用户名，无需提供账号密码。
        </p>
        <ol className="recharge-steps" aria-label="兑换进度">
          {['核验卡密', '确认账号', '查看订单'].map((label, i) => (
            <li key={label} aria-current={stage === i + 1 ? 'step' : undefined}>
              <span>{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <Availability {...service} />
        <form onSubmit={inspect} className="recharge-form">
          <Input
            label="兑换卡密"
            type="password"
            autoComplete="off"
            spellCheck={false}
            name="voucher-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value)
              setView(null)
              setChecked(null)
              setError('')
            }}
            disabled={!!busy || !!attempt}
            placeholder="粘贴商户提供的完整卡密"
            required
            maxLength={200}
          />
          <Button
            type="submit"
            variant={view ? 'secondary' : 'primary'}
            disabled={!!busy || !code.trim()}
          >
            {busy === 'inspect'
              ? '正在查询…'
              : view?.order || attempt
                ? '查询原订单'
                : '核验卡密 / 查询订单'}
          </Button>
        </form>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {view && !view.order && (
          <section className="voucher-summary" aria-label="卡密信息">
            <span>{view.product.name}</span>
            <small>
              {view.state === 'available'
                ? `有效期至 ${time(view.expires_at)}`
                : view.state === 'expired'
                  ? '卡密已过期，请联系商户'
                  : view.state === 'revoked'
                    ? '卡密已撤销，请联系商户'
                    : '卡密已兑换，请联系商户核对原订单'}
            </small>
          </section>
        )}
        {view?.state === 'available' && !attempt && (
          <form onSubmit={check} className="recharge-form recipient-form">
            <Input
              label="接收套餐的 X 用户名"
              name="username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
                setChecked(null)
                setError('')
              }}
              disabled={!!busy}
              placeholder="例如 @username"
              autoComplete="off"
              pattern="@?[A-Za-z0-9_]{1,15}"
              maxLength={16}
              required
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={!!busy || !accepts || !username.trim()}
            >
              {busy === 'check' ? '正在核验账号…' : '核验接收账号'}
            </Button>
          </form>
        )}
        {!view?.order && (checked?.eligible || attempt) && (
          <section className="recharge-confirm" aria-label="确认兑换信息">
            <h2>请确认接收账号</h2>
            <strong>@{attempt?.recipient ?? checked?.username}</strong>
            <p>{view?.product.name}。兑换后将绑定此账号，不能更换。</p>
            {attempt && (
              <p className="notice" role="status">
                已发起兑换。若请求结果未确认，请先查询原订单；重试会核对同一张卡密。
              </p>
            )}
            <Button
              type="button"
              variant="primary"
              disabled={!!busy || (!accepts && !attempt)}
              onClick={redeem}
            >
              {busy === 'redeem'
                ? '正在提交…'
                : attempt
                  ? '重试原兑换请求'
                  : '确认账号并兑换'}
            </Button>
          </section>
        )}
        {view?.order && (
          <>
            <OrderResult order={view.order} />
            <p className="note">此卡密已绑定原订单，不能重复兑换。</p>
            <Button
              type="button"
              variant="secondary"
              disabled={!!busy}
              onClick={() => {
                setCode('')
                setUsername('')
                setView(null)
                setChecked(null)
                setAttempt(null)
                setError('')
              }}
            >
              使用其他卡密
            </Button>
          </>
        )}
        <p className="note">
          请妥善保存卡密。刷新或关闭页面后，重新输入同一卡密即可查询原订单；卡密不会保存在浏览器中。
        </p>
      </div>
      <footer>X Premium · 卡密兑换套餐</footer>
    </main>
  )
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
            {product?.name ?? attempt?.product_code} · 冻结{' '}
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
