/* oxlint-disable react/jsx-key -- Grid puts each cell value inside a keyed Table.Cell; render arrays are not rendered directly. */
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { Table } from '@cloudflare/kumo/components/table'
import { DirectRecharge, Redeem } from './Recharge'
import { Vouchers } from './Vouchers'
import { PaymentSettings } from './PaymentSettings'
import { AdmissionSettings } from './AdmissionSettings'
import { AlipaySettings } from './AlipaySettings'
import { Checkout } from './Checkout'
import {
  ArrowClockwise,
  ArrowSquareOut,
  CreditCard,
  Key,
  Users,
  ListChecks,
  ChartBar,
  Receipt,
  SlidersHorizontal,
  Plugs,
  ClockCounterClockwise,
  BookOpen,
  SignOut,
  Plus,
  ArrowLeft,
  ArrowRight,
} from '@phosphor-icons/react'

type Row = Record<string, unknown>
type Principal = { authenticated: boolean; role?: string; userId?: string }
type Field = {
  name: string
  label: string
  type?: string
  value?: string | number
  optional?: boolean
  options?: [string, string][]
}
type Modal = {
  title: string
  description?: string
  fields?: Field[]
  content?: ReactNode
  submit?: string
  action?: (values: Row) => Promise<Modal | void>
  sensitive?: boolean
}
const s = (v: unknown) => (v === null || v === undefined ? '—' : String(v))
const n = (v: unknown) => Number(v ?? 0)
const date = (v: unknown) =>
  v
    ? new Date(typeof v === 'number' ? v : String(v)).toLocaleString('zh-CN', {
        hour12: false,
      })
    : '—'
const labels: Record<string, string> = {
  queued: '排队中',
  running: '处理中',
  unknown: '待核对',
  submitting: '提交中',
  succeeded: '成功',
  failed: '失败',
  pending: '待投递',
  sent: '已投递',
  dead: '投递失败',
  ACTIVE: '可用',
  FROZEN: '冻结',
  DELETED: '已删除',
  CANCELLED: '已取消',
  credit: '充值入账',
  reserve: '冻结',
  consume: '消费',
  release: '退回',
}
const sections = {
  overview: ['概览', '账户余额与服务状态', ChartBar],
  users: ['用户管理', '开通账户、入账点数及设置用户价格', Users],
  orders: ['充值订单', '查询进度与核对原订单', ListChecks],
  vouchers: ['卡密管理', '生成套餐卡密、查看兑换记录及撤销未用卡密', Key],
  ledger: ['点数流水', '充值、冻结、消费与退回记录', Receipt],
  products: ['商品配置', '点数售价与预期支付金额', SlidersHorizontal],
  cards: ['卡台与卡池', '支付宝收款、X 付款与卡台资产管理', CreditCard],
  secrets: ['账号与出口', '管理 X 赠送账号和代理连接', Plugs],
  keys: ['接口密钥', '生成或撤销签名密钥', Key],
  docs: ['接口文档', '通过签名接口创建和查询订单', BookOpen],
  webhooks: ['回调记录', '订单通知的投递情况', ArrowSquareOut],
  audit: ['操作记录', '管理员与用户的关键操作记录', ClockCounterClockwise],
} as const
type Section = keyof typeof sections
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message)
  }
}
async function api<T = Row>(path: string, body?: Row): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const data = await response.json()
  if (!response.ok)
    throw new ApiError(
      data.error?.message ?? '请求未确认，请刷新后核对原记录。',
      response.status,
      data.error?.code,
    )
  return data.data as T
}
function Status({ value }: { value: unknown }) {
  const key = s(value)
  return <span className={`status status-${key}`}>{labels[key] ?? key}</span>
}
function Stack({ top, bottom }: { top: unknown; bottom?: unknown }) {
  return (
    <span className="stack">
      <span>{s(top)}</span>
      {bottom !== undefined && <small>{s(bottom)}</small>}
    </span>
  )
}
function Grid({
  headers,
  rows,
  render,
}: {
  headers: string[]
  rows: Row[]
  render: (r: Row) => ReactNode[]
}) {
  return (
    <div className="table-scroll">
      <Table>
        <Table.Header>
          <Table.Row>
            {headers.map((h) => (
              <Table.Head key={h}>{h}</Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.length ? (
            rows.map((r, i) => (
              <Table.Row
                key={s(r.id ?? r.event_id ?? r.code ?? r.auth_id ?? i)}
              >
                {render(r).map((cell, j) => (
                  <Table.Cell key={j}>{cell}</Table.Cell>
                ))}
              </Table.Row>
            ))
          ) : (
            <Table.Row>
              <Table.Cell colSpan={headers.length}>
                <div className="empty">暂无记录</div>
              </Table.Cell>
            </Table.Row>
          )}
        </Table.Body>
      </Table>
    </div>
  )
}
function Metrics({ items }: { items: [string, unknown][] }) {
  return (
    <div className="metrics">
      {items.map(([name, value]) => (
        <div key={name}>
          <span>{name}</span>
          <strong>
            {typeof value === 'number'
              ? value.toLocaleString('zh-CN')
              : s(value)}
          </strong>
        </div>
      ))}
    </div>
  )
}
function FieldInput({ field }: { field: Field }) {
  if (field.type === 'select')
    return (
      <label className="form-field">
        {field.label}
        <select
          name={field.name}
          defaultValue={field.value ?? ''}
          required={!field.optional}
        >
          {field.options?.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    )
  return (
    <Input
      label={field.label}
      name={field.name}
      type={field.type ?? 'text'}
      defaultValue={field.value ?? ''}
      required={!field.optional}
      min={field.type === 'number' ? 1 : undefined}
      step={field.type === 'number' ? 1 : undefined}
      autoComplete={field.type === 'password' ? 'new-password' : 'off'}
    />
  )
}
function ModalView({
  modal,
  close,
  complete,
  onError,
}: {
  modal: Modal
  close: () => void
  complete: (next?: Modal) => Promise<void>
  onError: (error: unknown) => void
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const values: Row = Object.fromEntries(new FormData(e.currentTarget))
    modal.fields
      ?.filter((f) => f.type === 'number')
      .forEach((f) => (values[f.name] = Number(values[f.name])))
    try {
      const next = await modal.action!(values)
      await complete(next ?? undefined)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onError(err)
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <Dialog size="lg" className="x-modal">
        <form onSubmit={submit}>
          <Dialog.Title className="modal-title">{modal.title}</Dialog.Title>
          <Dialog.Description className="modal-description">
            {modal.description ??
              (modal.sensitive
                ? '请立即复制保存；关闭后无法再次查看。'
                : '保存前请核对输入内容。')}
          </Dialog.Description>
          <div className="modal-fields">
            {modal.fields?.map((f) => (
              <FieldInput key={f.name} field={f} />
            ))}
            {modal.content}
          </div>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <div className="modal-footer">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={close}
            >
              {modal.action ? '取消' : '关闭'}
            </Button>
            {modal.action && (
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? '正在提交…' : (modal.submit ?? '保存')}
              </Button>
            )}
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
function secretModal(title: string, value: string): Modal {
  return {
    title,
    sensitive: true,
    content: (
      <textarea
        className="secret-output"
        aria-label={title}
        readOnly
        value={value}
        autoComplete="off"
        spellCheck={false}
      />
    ),
  }
}
const field = (
  name: string,
  label: string,
  type = 'text',
  value: string | number = '',
  optional = false,
): Field => ({ name, label, type, value, optional })
const choices = (
  name: string,
  label: string,
  value: string,
  options: [string, string][],
  optional = false,
): Field => ({ name, label, type: 'select', value, options, optional })
const enabled = (value: unknown): Field =>
  choices('enabled', '状态', String(!!value), [
    ['false', '停用'],
    ['true', '启用'],
  ])
const productOptions: [string, string][] = [
  ['x-premium-3m', 'Premium · 3 个月'],
  ['x-premium-6m', 'Premium · 6 个月'],
]

export default function App() {
  if (/^\/buy\/?$/.test(window.location.pathname)) return <Checkout request={api} />
  return /^\/redeem\/?$/.test(window.location.pathname) ? (
    <Redeem request={api} />
  ) : (
    <Workspace />
  )
}

function Workspace() {
  const [principal, setPrincipal] = useState<Principal | null>(null),
    [section, setSection] = useState<Section>('overview'),
    [page, setPage] = useState(1)
  const [data, setData] = useState<Row>({}),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState(''),
    [modal, setModal] = useState<Modal | null>(null),
    [refresh, setRefresh] = useState(0)
  const [loginBusy, setLoginBusy] = useState(false)
  const generation = useRef(0),
    principalRef = useRef(principal)
  useEffect(() => {
    principalRef.current = principal
  }, [principal])
  const admin = principal?.role === 'admin',
    base = admin ? '/api/admin' : '/api'
  function onError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      setPrincipal({ authenticated: false })
      setModal(null)
      setData({})
      generation.current++
    }
    setNotice(error instanceof Error ? error.message : '服务暂时不可用')
  }
  useEffect(() => {
    api<Principal>('/api/session')
      .then((p) => {
        setPrincipal(p)
        if (!p.authenticated) setLoading(false)
      })
      .catch((e) => {
        onError(e)
        setPrincipal({ authenticated: false })
        setLoading(false)
      })
  }, [])
  useEffect(() => {
    if (!principal?.authenticated) return
    let live = true
    const seq = ++generation.current
    async function load() {
      let result: Row
      if (section === 'overview')
        result = admin
          ? await api(base + '/overview')
          : {
              me: await api('/api/me'),
              products: await api<Row[]>('/api/products'),
            }
      else if (section === 'cards') {
        const config = await api('/api/admin/card-provider')
        result = { config, giftProfile: await api('/api/admin/gift-profile') }
        if (config.configured) {
          const outcomes = await Promise.allSettled([
            api('/api/admin/card-provider/balance'),
            api('/api/admin/card-provider/cards?page=' + page),
            api<Row[]>('/api/admin/card-provider/products'),
            api<Row[]>('/api/admin/card-provider/operations?page=' + page),
          ])
          const keys = ['balance', 'cards', 'products', 'operations']
          outcomes.forEach((outcome, i) => {
            if (outcome.status === 'fulfilled') result[keys[i]] = outcome.value
            else {
              if (
                outcome.reason instanceof ApiError &&
                outcome.reason.status === 401
              )
                throw outcome.reason
              result[keys[i] + '_error'] = outcome.reason.message
            }
          })
        }
      } else if (section === 'docs') result = {}
      else
        result = {
          rows: await api<Row[]>(
            base +
              '/' +
              section +
              (['products', 'secrets', 'keys'].includes(section)
                ? ''
                : '?page=' + page),
          ),
        }
      if (live && seq === generation.current) setData(result)
    }
    load()
      .catch((e) => {
        if (live) onError(e)
      })
      .finally(() => {
        if (live && seq === generation.current) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [principal, section, page, refresh, admin, base])
  async function act(action: () => Promise<unknown>) {
    try {
      await action()
    } catch (e) {
      onError(e)
    }
  }
  async function mutate(path: string, body: Row) {
    await api(path, body)
    reload()
  }
  function reload() {
    setLoading(true)
    setNotice('')
    setRefresh((v) => v + 1)
  }
  const rows = (data.rows ?? []) as Row[]
  function actionButton(
    label: string,
    action: () => Promise<unknown> | void,
    primary = false,
  ) {
    return (
      <Action
        key={label}
        label={label}
        primary={primary}
        action={() => act(async () => action())}
      />
    )
  }
  function form(
    title: string,
    fields: Field[],
    path: string,
    extra: Row = {},
    description?: string,
  ) {
    setModal({
      title,
      fields,
      description,
      action: async (values) => {
        await api(path, { ...values, ...extra })
      },
    })
  }
  function newKey(path = '/api/keys') {
    setModal({
      title: '生成接口密钥',
      fields: [field('label', '密钥名称')],
      action: async (values) => {
        const key = await api(path, values)
        return secretModal(
          '接口密钥',
          `User ID: ${s(key.user_id)}\nKey ID: ${s(key.key_id)}\nSecret: ${s(key.secret)}`,
        )
      },
    })
  }
  function revoke(key: Row, adminKey = false) {
    setModal({
      title: '撤销 ' + s(key.label),
      fields: [field('confirmation', '输入 REVOKE 确认')],
      action: async (values) => {
        if (values.confirmation !== 'REVOKE') throw new Error('请输入 REVOKE')
        await api(
          `${adminKey ? '/api/admin' : '/api'}/keys/${s(key.id)}/revoke`,
          {},
        )
      },
    })
  }
  async function userKeys(user: Row) {
    const keys = await api<Row[]>(`/api/admin/users/${s(user.id)}/keys`)
    setModal({
      title: s(user.name) + ' 的接口密钥',
      content: (
        <Grid
          headers={['名称', 'Key ID', '状态', '操作']}
          rows={keys}
          render={(key) => [
            s(key.label),
            <code>{s(key.id)}</code>,
            <Status value={key.revoked ? '已撤销' : '有效'} />,
            !key.revoked && actionButton('撤销', () => revoke(key, true)),
          ]}
        />
      ),
    })
  }
  function toolbar(title: string, actions?: ReactNode) {
    return (
      <div className="toolbar">
        <h2>{title}</h2>
        <div className="actions">{actions}</div>
      </div>
    )
  }
  const pager = (hasNext: boolean) => (
    <div className="pager">
      <span>第 {page} 页 · 每页最多 30 条</span>
      <Button
        variant="ghost"
        aria-label="上一页"
        disabled={page === 1}
        onClick={() => {
          setLoading(true)
          setPage((p) => p - 1)
        }}
      >
        <ArrowLeft size={16} />
      </Button>
      <Button
        variant="ghost"
        aria-label="下一页"
        disabled={!hasNext}
        onClick={() => {
          setLoading(true)
          setPage((p) => p + 1)
        }}
      >
        <ArrowRight size={16} />
      </Button>
    </div>
  )
  function content(): ReactNode {
    if (section === 'overview') {
      if (admin)
        return (
          <>
            <Metrics
              items={[
                ['用户数量', n(data.users)],
                ['可用点数', n(data.available)],
                ['冻结点数', n(data.frozen)],
              ]}
            />
            <div className="section-label">运行状态</div>
            <dl className="details">
              {[
                [
                  '自动赠送',
                  data.execution_ready ? '已开放' : '未配置或已暂停',
                ],
                [
                  '代理出口能力',
                  data.proxy_gateway_ready ? '已配置' : '未配置',
                ],
                ['处理中的订单', n(data.pending)],
                ['结果待核对', n(data.unknown)],
                ['回调投递失败', n(data.failed_webhooks)],
              ].map(([label, value]) => (
                <div key={s(label)}>
                  <dt>{s(label)}</dt>
                  <dd>{s(value)}</dd>
                </div>
              ))}
            </dl>
            <p className="note">
              新增接单受后台每日额度与付款状态控制；指定卡的限额以卡台设置为准，已有订单持续核对。
            </p>
          </>
        )
      const me = (data.me ?? {}) as Row
      return (
        <>
          <Metrics
            items={[
              ['可用点数', n(me.available)],
              ['冻结点数', n(me.frozen)],
              ['点数合计', n(me.available) + n(me.frozen)],
            ]}
          />
          {toolbar('可用商品')}
          <Grid
            headers={['套餐', '点数价格', '状态']}
            rows={(data.products ?? []) as Row[]}
            render={(r) => [
              s(r.name),
              s(r.points),
              <Status value={r.enabled ? '已开放' : '未开放'} />,
            ]}
          />
          {toolbar(
            '订单回调',
            actionButton('配置回调', () =>
              setModal({
                title: '配置订单回调',
                fields: [
                  field(
                    'url',
                    'HTTPS 回调地址（留空关闭）',
                    'text',
                    String(me.webhook_url ?? ''),
                    true,
                  ),
                ],
                action: async (v) => {
                  const r = await api('/api/webhook', v)
                  if (r.secret) return secretModal('回调密钥', s(r.secret))
                },
              }),
            ),
          )}
          <p className="note">
            {me.webhook_url
              ? s(me.webhook_url)
              : '未配置回调，可通过查询接口获取订单结果。'}
          </p>
        </>
      )
    }
    if (section === 'users')
      return (
        <>
          {toolbar(
            '用户账户',
            actionButton(
              '开通用户',
              () =>
                form(
                  '开通用户',
                  [
                    field('name', '名称'),
                    field('email', '邮箱', 'email'),
                    field('password', '初始密码（至少 12 位）', 'password'),
                  ],
                  base + '/users',
                ),
              true,
            ),
          )}
          <Grid
            headers={['用户 / 商户 ID', '可用 / 冻结', '状态', '操作']}
            rows={rows}
            render={(r) => [
              <span className="stack">
                <span>{s(r.name)}</span>
                <small>{s(r.email)}</small>
                <code>{s(r.id)}</code>
              </span>,
              `${s(r.available)} / ${s(r.frozen)}`,
              <Status value={r.enabled ? '正常' : '停用'} />,
              <div className="row-actions">
                {actionButton('入账', () =>
                  form(
                    '为 ' + s(r.name) + ' 入账点数',
                    [
                      field('points', '点数', 'number'),
                      field('reference', '入账凭证号'),
                      field('note', '入账说明'),
                    ],
                    `${base}/users/${s(r.id)}/credit`,
                  ),
                )}
                {actionButton('用户价格', () =>
                  setModal({
                    title: '用户商品价格',
                    fields: [
                      choices(
                        'product_code',
                        '商品',
                        'x-premium-3m',
                        productOptions,
                      ),
                      field('points', '点数价格', 'number'),
                    ],
                    action: async (v) => {
                      await api(`${base}/users/${s(r.id)}/price`, v)
                    },
                  }),
                )}
                {actionButton('恢复默认价', () =>
                  setModal({
                    title: '恢复默认价格',
                    fields: [
                      choices(
                        'product_code',
                        '商品',
                        'x-premium-3m',
                        productOptions,
                      ),
                    ],
                    action: async (v) => {
                      await api(`${base}/users/${s(r.id)}/price`, {
                        ...v,
                        points: null,
                      })
                    },
                  }),
                )}
                {actionButton('生成密钥', () =>
                  newKey(`${base}/users/${s(r.id)}/keys`),
                )}
                {actionButton('管理密钥', () => userKeys(r))}
                {actionButton('重置密码', () =>
                  form(
                    '重置密码',
                    [field('password', '新密码（至少 12 位）', 'password')],
                    `${base}/users/${s(r.id)}/password`,
                  ),
                )}
                {actionButton(r.enabled ? '停用' : '启用', () =>
                  mutate(`${base}/users/${s(r.id)}/enabled`, {
                    enabled: !r.enabled,
                  }),
                )}
              </div>,
            ]}
          />
          {pager(rows.length === 30)}
        </>
      )
    if (section === 'orders')
      return (
        <>
          {!admin && (
            <DirectRecharge
              request={api}
              userId={principal?.userId ?? ''}
              onCreated={() => setRefresh((v) => v + 1)}
            />
          )}
          {toolbar(
            '订单记录',
            admin &&
              actionButton('核对原订单', () => mutate(base + '/reconcile', {})),
          )}
          <Grid
            headers={[
              '订单 / 时间',
              '接收账号',
              '套餐',
              '模式',
              '点数',
              '状态',
              '结果',
            ]}
            rows={rows}
            render={(r) => [
              <Stack top={r.merchant_order_no} bottom={date(r.created_at)} />,
              <Stack top={'@' + s(r.recipient)} bottom={r.user_name ?? ''} />,
              s(r.product_code),
              r.mode === 'voucher' ? '卡密兑换' : '直充',
              s(r.points),
              <Status value={r.status} />,
              <>
                <Stack top={r.receipt ?? r.failure_code} bottom={r.id} />
                {admin &&
                  r.status === 'queued' &&
                  actionButton('取消并退点', () =>
                    form(
                      '取消未执行订单',
                      [field('note', '取消说明')],
                      `${base}/orders/${s(r.id)}/cancel`,
                    ),
                  )}
              </>,
            ]}
          />
          {pager(rows.length === 30)}
          <p className="note">
            待核对订单的点数继续冻结，请查询原订单，勿重复提交。
          </p>
        </>
      )
    if (section === 'vouchers')
      return (
        <>
          <Vouchers
            rows={rows}
            request={api}
            onChanged={() => setRefresh((v) => v + 1)}
          />
          {pager(rows.length === 30)}
        </>
      )
    if (section === 'ledger')
      return (
        <>
          <Grid
            headers={['时间', '类型', '可用变动', '冻结变动', '说明 / 凭证']}
            rows={rows}
            render={(r) => [
              date(r.created_at),
              labels[s(r.kind)] ?? s(r.kind),
              s(r.available_delta),
              s(r.frozen_delta),
              <Stack top={r.note} bottom={r.reference} />,
            ]}
          />
          {pager(rows.length === 30)}
        </>
      )
    if (section === 'products')
      return (
        <>
          <Grid
            headers={['套餐', '点数售价', '预期支付金额', '状态', '操作']}
            rows={rows}
            render={(r) => [
              <Stack top={r.name} bottom={r.code} />,
              s(r.points),
              `${n(r.amount_minor) / 100} ${s(r.currency).toUpperCase()}`,
              <Status value={r.enabled ? '已开放' : '未开放'} />,
              actionButton('编辑', () =>
                setModal({
                  title: '编辑 ' + s(r.name),
                  fields: [
                    field('points', '点数售价', 'number', n(r.points)),
                    field('currency', '预期支付币种', 'text', s(r.currency)),
                    field(
                      'amount_minor',
                      '预期金额（最小单位；300 BDT 填 30000）',
                      'number',
                      n(r.amount_minor),
                    ),
                    enabled(r.enabled),
                  ],
                  action: async (v) => {
                    await api(base + '/products', {
                      ...v,
                      code: r.code,
                      enabled: v.enabled === 'true',
                    })
                  },
                }),
              ),
            ]}
          />
          <p className="note">
            赠送账单必须匹配预期套餐、币种和金额，报价不匹配时停止支付。
          </p>
        </>
      )
    if (section === 'secrets') {
      const proxyOptions: [string, string][] = [
        ['', '直连'],
        ...rows
          .filter((r) => r.kind === 'proxy' && r.enabled)
          .map((r) => [s(r.id), s(r.name)] as [string, string]),
      ]
      const proxyFields = [
        field('name', '名称'),
        choices('protocol', '协议', 'http', [
          ['http', 'HTTP CONNECT'],
          ['socks5', 'SOCKS5'],
        ]),
        field('host', '主机 / IP'),
        field('port', '端口', 'number'),
        field('username', '用户名', 'text', '', true),
        field('password', '代理密码', 'password', '', true),
      ]
      const accountFields = (r?: Row) => [
        field('name', '名称', 'text', r ? s(r.name) : ''),
        field('auth_token', 'auth_token', 'password'),
        field('ct0', 'ct0', 'password'),
        choices(
          'proxy_id',
          'X 请求出口',
          String(r?.proxy_id ?? ''),
          proxyOptions,
          true,
        ),
        field(
          'daily_limit',
          '每日上限（1–300）',
          'number',
          n(r?.daily_limit ?? 300),
        ),
      ]
      return (
        <>
          {toolbar(
            '赠送账号与代理',
            <>
              {actionButton('添加代理', () =>
                form('添加出口代理', proxyFields, base + '/secrets', {
                  kind: 'proxy',
                }),
              )}
              {actionButton(
                '添加 X 账号',
                () =>
                  form('添加 X 赠送账号', accountFields(), base + '/secrets', {
                    kind: 'account',
                  }),
                true,
              )}
            </>,
          )}
          <Grid
            headers={['名称', '类型', '配置', '状态', '操作']}
            rows={rows}
            render={(r) => [
              <Stack top={r.name} bottom={r.id} />,
              r.kind === 'proxy' ? '出口代理' : 'X 账号',
              r.kind === 'proxy'
                ? `${s(r.protocol)}://${s(r.host)}:${s(r.port)}`
                : `每日 ${s(r.daily_limit)} 次 · ${s(rows.find((p) => p.id === r.proxy_id)?.name ?? '直连')}`,
              <Status value={r.enabled ? '启用' : '停用'} />,
              <div className="row-actions">
                {actionButton(r.enabled ? '停用' : '启用', () =>
                  mutate(`${base}/secrets/${s(r.id)}/enabled`, {
                    enabled: !r.enabled,
                  }),
                )}
                {r.kind === 'account' ? (
                  <>
                    {actionButton('修改每日上限', () =>
                      form(
                        '修改 ' + s(r.name) + ' 的每日上限',
                        [
                          field(
                            'daily_limit',
                            '每日上限（1–300）',
                            'number',
                            n(r.daily_limit),
                          ),
                        ],
                        `${base}/secrets/${s(r.id)}/limit`,
                      ),
                    )}
                    {actionButton('更新 Cookie', () =>
                      form(
                        '更新 ' + s(r.name),
                        accountFields(r),
                        `${base}/secrets/${s(r.id)}/replace`,
                      ),
                    )}
                    {actionButton('查询报价', () =>
                      setModal({
                        title: '查询报价',
                        description: '只读查询，不创建赠送订单。',
                        fields: [
                          choices(
                            'product_code',
                            '套餐',
                            'x-premium-3m',
                            productOptions,
                          ),
                        ],
                        submit: '查询',
                        action: async (v) => {
                          const q = await api(
                            `${base}/secrets/${s(r.id)}/quote`,
                            v,
                          )
                          return {
                            title: 'X 报价',
                            content: (
                              <p>{`${s(q.amount)} ${s(q.currency).toUpperCase()} · ${q.matches_expected ? '匹配预期' : '不匹配预期'} · ${q.uses_proxy ? '代理出口' : '直连'}`}</p>
                            ),
                          }
                        },
                      }),
                    )}
                  </>
                ) : (
                  actionButton('检测出口', async () => {
                    const q = await api(`${base}/secrets/${s(r.id)}/test`, {})
                    setNotice(
                      `出口 ${s(q.ip)} · 地理识别 ${s(q.country)} ${s(q.region ?? '')}`,
                    )
                  })
                )}
              </div>,
            ]}
          />
          <p className="note">
            Cookie
            与代理密码加密保存；服务器支持指定代理出口，不会自动回退直连。
            每日上限是本服务的调度额度，按 UTC 日期计数；X 实际限制仍以平台返回为准。
          </p>
        </>
      )
    }
    if (section === 'keys')
      return (
        <>
          {toolbar(
            '接口密钥',
            actionButton('生成密钥', () => newKey(), true),
          )}
          <Grid
            headers={['名称', 'Key ID', '创建时间', '状态', '操作']}
            rows={rows}
            render={(r) => [
              s(r.label),
              <code>{s(r.id)}</code>,
              date(r.created_at),
              <Status value={r.revoked ? '已撤销' : '有效'} />,
              !r.revoked && actionButton('撤销', () => revoke(r)),
            ]}
          />
          <p className="note">
            最多 5 个有效密钥。Secret 仅在生成时显示，丢失后请撤销并重新生成。
          </p>
        </>
      )
    if (section === 'cards')
      return (
        <Cards
          data={data}
          page={page}
          pager={pager}
          form={setModal}
          actionButton={actionButton}
          toolbar={toolbar}
        />
      )
    if (section === 'webhooks')
      return (
        <>
          <Grid
            headers={[
              '订单 / 事件',
              '回调地址',
              '尝试次数',
              '下次投递',
              '状态',
            ]}
            rows={rows}
            render={(r) => [
              <Stack top={r.order_id} bottom={r.event_id} />,
              s(r.url),
              s(r.attempts),
              date(r.next_at),
              <Status value={r.status} />,
            ]}
          />
          {pager(rows.length === 30)}
        </>
      )
    if (section === 'audit')
      return (
        <>
          <Grid
            headers={['时间', '操作者', '操作', '目标', '说明']}
            rows={rows}
            render={(r) => [
              date(r.created_at),
              s(r.actor),
              s(r.action),
              s(r.target),
              s(r.note),
            ]}
          />
          {pager(rows.length === 30)}
        </>
      )
    return <Docs />
  }
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoginBusy(true)
    setNotice('')
    const body = Object.fromEntries(new FormData(e.currentTarget))
    try {
      await api('/api/login', body)
      setSection('overview')
      setPage(1)
      setLoading(true)
      setPrincipal(await api<Principal>('/api/session'))
    } catch (err) {
      onError(err)
    } finally {
      setLoginBusy(false)
    }
  }
  if (!principal)
    return (
      <div className="boot" role="status">
        正在连接 X API…
      </div>
    )
  if (!principal.authenticated)
    return (
      <main className="login">
        <div className="login-brand">
          <span className="brand-mark">X</span>
          <span>
            Bugan.cn <b>/</b> X API
          </span>
        </div>
        <div className="login-form-wrap">
          <div className="eyebrow">独立充值服务</div>
          <h1>登录工作区</h1>
          <p>管理点数、赠送订单与接口密钥。</p>
          <form onSubmit={login}>
            <Input
              name="email"
              label="账户"
              placeholder="用户邮箱 / admin"
              autoComplete="username"
              required
            />
            <Input
              name="password"
              label="密码"
              type="password"
              autoComplete="current-password"
              required
            />
            {notice && (
              <div className="notice error" role="alert">
                {notice}
              </div>
            )}
            <Button variant="primary" type="submit" disabled={loginBusy}>
              {loginBusy ? '登录中…' : '登录'}
              <ArrowRight size={17} />
            </Button>
          </form>
          <div className="login-purchase-links">
            <a className="login-redeem-link text-link" href="/buy">
              支付宝扫码购买套餐 <ArrowRight size={16} />
            </a>
            <a className="login-redeem-link text-link" href="/redeem">
              持有卡密？前往兑换套餐 <ArrowRight size={16} />
            </a>
          </div>
        </div>
        <footer>用户账户由管理员开通 · {window.location.host}</footer>
      </main>
    )
  const nav: Section[] = admin
    ? [
        'overview',
        'users',
        'orders',
        'vouchers',
        'ledger',
        'products',
        'cards',
        'secrets',
        'webhooks',
        'audit',
      ]
    : ['overview', 'orders', 'keys', 'ledger', 'docs']
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">X</span>
          <span>
            X API<small>Bugan.cn</small>
          </span>
        </a>
        <div className="nav-group-label">
          {admin ? '平台管理' : '用户工作区'}
        </div>
        <nav aria-label="主导航">
          {nav.map((key) => {
            const Icon = sections[key][2]
            return (
              <button
                key={key}
                aria-current={section === key ? 'page' : undefined}
                onClick={() => {
                  setSection(key)
                  setPage(1)
                  setModal(null)
                  if (section !== key || page !== 1) {
                    setLoading(true)
                    setNotice('')
                  }
                }}
              >
                <Icon size={19} />
                {sections[key][0]}
              </button>
            )
          })}
        </nav>
        <div className="sidebar-bottom">
          <a href="/buy">
            扫码购买
            <ArrowSquareOut size={15} />
          </a>
          <a href="/redeem">
            卡密兑换
            <ArrowSquareOut size={15} />
          </a>
          <span className="account-name">
            {admin ? '管理员' : principal.userId}
          </span>
          <Button
            variant="ghost"
            onClick={() =>
              act(async () => {
                await api('/api/logout', {})
                setPrincipal({ authenticated: false })
                setModal(null)
                setData({})
                generation.current++
              })
            }
          >
            <SignOut size={17} />
            退出登录
          </Button>
        </div>
      </aside>
      <main className="main">
        <header className="page-header">
          <div>
            <div className="eyebrow">
              X API <span>/</span> {admin ? '平台管理' : '用户工作区'}
            </div>
            <h1>{sections[section][0]}</h1>
            <p>{sections[section][1]}</p>
          </div>
          <Button
            variant="secondary"
            aria-label="刷新当前页面"
            disabled={loading}
            onClick={reload}
          >
            <ArrowClockwise size={17} />
            刷新
          </Button>
        </header>
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        <div className="page-content" key={section}>
          {admin && section === 'cards' && <>
            <AdmissionSettings request={api} onError={onError} />
            <PaymentSettings request={api} onError={onError} />
            <AlipaySettings request={api} onError={onError} />
          </>}
          {loading ? (
            <div className="loading" role="status">
              正在加载…
            </div>
          ) : (
            content()
          )}
        </div>
        <footer className="workspace-footer">
          X API · 独立服务<span>点数账本与卡台美元余额分别管理</span>
        </footer>
      </main>
      {modal && (
        <ModalView
          key={modal.title}
          modal={modal}
          close={() => setModal(null)}
          onError={onError}
          complete={async (next) => {
            setModal(null)
            reload()
            if (principalRef.current?.authenticated && next) setModal(next)
          }}
        />
      )}
    </div>
  )
}

function Action({
  label,
  primary,
  action,
}: {
  label: string
  primary: boolean
  action: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant={primary ? 'primary' : 'ghost'}
      size={primary ? 'base' : 'sm'}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await action()
        } finally {
          setBusy(false)
        }
      }}
    >
      {primary && <Plus size={15} />}
      {busy ? '处理中…' : label}
    </Button>
  )
}
type CardsProps = {
  data: Row
  page: number
  pager: (next: boolean) => ReactNode
  form: (modal: Modal) => void
  actionButton: (
    label: string,
    action: () => Promise<unknown> | void,
    primary?: boolean,
  ) => ReactNode
  toolbar: (title: string, actions?: ReactNode) => ReactNode
}
function Cards({ data, pager, form, actionButton, toolbar }: CardsProps) {
  const config = (data.config ?? {}) as Row,
    balance = (data.balance ?? {}) as Row,
    cards = (data.cards ?? { list: [] }) as { list: Row[]; total?: number },
    products = (data.products ?? []) as Row[],
    operations = (data.operations ?? []) as Row[]
  const base = '/api/admin/card-provider'
  const giftProfile = (data.giftProfile ?? {}) as Row
  function configureGift() {
    form({
      title: '持卡人账单资料',
      description: '国家使用两位代码（例如 CN、HK）。赠送接收用户名由每笔商城订单提供，无需在这里填写。保存只记录资料，不会开卡或支付。',
      fields: [
        field('first_name', '持卡人英文名 / 拼音', 'text', String(giftProfile.first_name ?? '')),
        field('last_name', '持卡人英文姓 / 拼音', 'text', String(giftProfile.last_name ?? '')),
        field('billing_email', '账单邮箱', 'email', String(giftProfile.billing_email ?? '')),
        field('billing_country', '真实账单国家（两位代码）', 'text', String(giftProfile.billing_country ?? '')),
        field('billing_line1', '账单地址', 'text', String(giftProfile.billing_line1 ?? ''), true),
        field('billing_line2', '地址补充', 'text', String(giftProfile.billing_line2 ?? ''), true),
        field('billing_city', '城市', 'text', String(giftProfile.billing_city ?? ''), true),
        field('billing_state', '地区 / 州', 'text', String(giftProfile.billing_state ?? ''), true),
        field('billing_postal_code', '邮政编码（按账单资料填写）', 'text', String(giftProfile.billing_postal_code ?? ''), true),
      ],
      action: async (v) => { await api('/api/admin/gift-profile', v) },
    })
  }
  function configure() {
    form({
      title: '配置 ZovoCard',
      description:
        'API 密钥加密保存。切换环境须重新填写密钥；正式环境操作会消耗卡台美元余额。',
      fields: [
        choices(
          'environment',
          '环境',
          String(config.environment ?? 'sandbox'),
          [
            ['sandbox', '沙盒（模拟资金）'],
            ['production', '正式环境'],
          ],
        ),
        field(
          'api_key',
          config.configured ? 'API Secret（同环境留空保留）' : 'API Secret',
          'password',
          '',
          !!config.configured,
        ),
        field(
          'app_id',
          'App ID（可选）',
          'text',
          String(config.app_id ?? ''),
          true,
        ),
        choices(
          'transport',
          '卡台出口',
          String(config.transport ?? 'gateway'),
          [
            ['gateway', '固定出口网关（IP 白名单）'],
            ['direct', '服务直连（固定服务器出口）'],
          ],
        ),
        choices(
          'writes_enabled',
          '开卡／充值',
          String(!!config.writes_enabled),
          [
            ['false', '关闭 · 只读'],
            ['true', '开启 · 允许扣款'],
          ],
        ),
      ],
      action: async (v) => {
        await api(base, { ...v, writes_enabled: v.writes_enabled === 'true' })
      },
    })
  }
  function write(kind: 'open' | 'recharge', card?: Row) {
    const reference = 'card-' + crypto.randomUUID()
    form({
      title: kind === 'open' ? '开卡并注资' : '为卡片充值',
      description: `${config.environment === 'production' ? '正式环境：会实际扣除卡台余额及手续费。' : '沙盒：模拟资金。'} 凭证号请保存，待核对时勿新建操作。`,
      submit: '确认卡台扣款',
      fields: [
        ...(kind === 'open'
          ? [
              choices(
                'product_code',
                '卡产品',
                String(products[0]?.product_code ?? ''),
                products.map((p) => [
                  s(p.product_code),
                  `${s(p.product_code)} · ${s(p.issuing_area)} · 开卡费 ${s(p.open_fee)} USD`,
                ]),
              ),
              field('first_name', '持卡人名'),
              field('last_name', '持卡人姓'),
            ]
          : [field('card_id', '卡 ID', 'number', n(card?.id))]),
        field('amount_minor', '注资金额（美元分；20 USD 填 2000）', 'number'),
        field('reference', '操作凭证号', 'text', reference),
        field('confirmation', '输入 CHARGE 确认扣款'),
      ],
      action: async (v) => {
        const result = await api(base + '/' + kind, v)
        return {
          title: '卡台操作结果',
          description: '这表示卡台资金操作结果，不表示 X 赠送完成。',
          content: (
            <div className="operation-result">
              <Status value={result.status} />
              <p>凭证号：{s(result.reference)}</p>
              <p>操作 ID：{s(result.id)}</p>
              {result.failure_code ? (
                <p>代码：{s(result.failure_code)}</p>
              ) : null}
              {['unknown', 'submitting'].includes(s(result.status)) && (
                <p>请先在卡台核对本次操作。系统不会自动重新扣款。</p>
              )}
            </div>
          ),
        }
      },
    })
  }
  async function detail(card: Row, resource: 'transactions' | 'recharges') {
    const result = await api<Row[]>(`${base}/cards/${s(card.id)}/${resource}`)
    form({
      title: `卡 ${s(card.id)} · ${resource === 'transactions' ? '消费记录' : '充值记录'}`,
      description: '最近 30 条；查询不会充值或支付。',
      content: (
        <Grid
          headers={
            resource === 'transactions'
              ? ['时间', '类型', '商户', '金额', '状态']
              : ['时间', '金额 USD', '手续费', '状态']
          }
          rows={result}
          render={(r) =>
            resource === 'transactions'
              ? [
                  date(r.auth_time),
                  s(r.type),
                  s(r.merchant_name),
                  `${s(r.auth_amount)} ${s(r.auth_currency)}`,
                  <Status value={r.status} />,
                ]
              : [
                  date(r.created_at),
                  s(r.amount),
                  s(r.fee),
                  <Status value={r.status} />,
                ]
          }
        />
      ),
    })
  }
  return (
    <>
      {toolbar(
        '卡台连接',
        actionButton(
          config.configured ? '修改配置' : '接入卡台',
          configure,
          !config.configured,
        ),
      )}
      <div className="connection-line">
        <Status value={config.configured ? '已配置' : '未配置'} />
        <span>
          {config.environment === 'production' ? '正式环境' : '沙盒环境'}
        </span>
        <span>
          {config.writes_enabled ? '开卡／充值已开启' : '只读 · 扣款操作关闭'}
        </span>
        <span>
          {config.transport === 'direct' ? '服务直连' : '固定出口网关'}
        </span>
      </div>
      {toolbar('持卡人账单资料', actionButton(giftProfile.configured ? '修改账单资料' : '填写账单资料', configureGift))}
      <p className="note">
        {giftProfile.configured ? '账单资料已保存，接收用户名由每笔商城订单提供。' : '请补齐持卡人姓名、账单邮箱与国家；接收用户名在商城下单时填写。'}
        {' '}X 付款使用上方选定的已有卡，不会自动开卡、充值或换卡。新增接单受后台每日额度控制；保存账单资料不会启用付款。
      </p>
      {!config.configured ? (
        <div className="setup-empty">
          <CreditCard size={34} />
          <h3>连接你的卡台账户</h3>
          <p>在 ZovoCard 开发者页面获取 API Secret，然后填写连接配置。</p>
          <p>卡台负责开卡与卡资金管理，X 赠送由独立执行流程完成。</p>
        </div>
      ) : (
        <>
          {!!data.balance_error && (
            <div className="notice error">
              余额查询：{s(data.balance_error)}
            </div>
          )}
          {!!data.balance && (
            <Metrics
              items={[
                ['卡台可消费余额 · USD', n(balance.spendable_balance)],
                ['账面余额 · USD', n(balance.balance)],
                ['保留保证金 · USD', n(balance.account_reserve_amount)],
              ]}
            />
          )}
          {toolbar(
            '卡池',
            !!config.writes_enabled &&
              products.length > 0 &&
              actionButton('开卡并注资', () => write('open'), true),
          )}
          {!!data.cards_error && (
            <p role="alert" className="notice error">
              {s(data.cards_error)}
            </p>
          )}
          <Grid
            headers={[
              '卡片',
              '产品 / 渠道',
              '发行地区',
              '卡内余额 USD',
              '状态',
              '操作',
            ]}
            rows={cards.list ?? []}
            render={(r) => [
              <Stack
                top={'•••• ' + s(r.last_four || '未知')}
                bottom={'卡 ID ' + s(r.id)}
              />,
              <Stack top={r.product_code} bottom={r.issuer} />,
              s(r.issuing_area),
              s(r.available_amount),
              <Status value={r.status} />,
              <div className="row-actions">
                {actionButton('消费记录', () => detail(r, 'transactions'))}
                {actionButton('充值记录', () => detail(r, 'recharges'))}
                {!!config.writes_enabled &&
                  r.status === 'ACTIVE' &&
                  actionButton('充值', () => write('recharge', r))}
              </div>,
            ]}
          />
          {pager((cards.list ?? []).length === 30 || operations.length === 30)}
          {toolbar('卡产品')}{' '}
          {!!data.products_error && (
            <p className="notice error">{s(data.products_error)}</p>
          )}
          <Grid
            headers={[
              '产品',
              '地区 / 渠道',
              '开卡费 USD',
              '充值费率',
              '最低注资 USD',
              '限制商户',
            ]}
            rows={products}
            render={(r) => [
              s(r.product_code),
              `${s(r.issuing_area)} / ${s(r.issuer)}`,
              s(r.open_fee),
              s(r.recharge_fee),
              s(r.min_amount),
              Array.isArray(r.restricted_merchants) &&
              r.restricted_merchants.length
                ? r.restricted_merchants.map(s).join('、')
                : '未返回限制',
            ]}
          />
          {toolbar('卡台操作记录')}
          {!!data.operations_error && (
            <p className="notice error">{s(data.operations_error)}</p>
          )}
          <Grid
            headers={[
              '凭证 / 时间',
              '操作',
              '金额 USD',
              '环境',
              '状态',
              '结果',
            ]}
            rows={operations}
            render={(r) => [
              <Stack top={r.reference} bottom={date(r.created_at)} />,
              r.kind === 'open' ? '开卡' : '充值 · 卡 ' + s(r.card_id),
              (n(r.amount_minor) / 100).toFixed(2),
              r.environment === 'production' ? '正式' : '沙盒',
              <Status value={r.status} />,
              <>
                <Stack top={r.failure_code ?? r.card_id} bottom={r.id} />
                {['unknown', 'submitting'].includes(s(r.status)) &&
                  actionButton('人工核对', () =>
                    form({
                      title: '核对卡台原操作',
                      description:
                        '先到卡台核实真实资金记录。成功填写实际卡 ID；失败仅限确认未扣款。此操作不发送支付请求。',
                      fields: [
                        choices('status', '卡台核对结果', 'succeeded', [
                          ['succeeded', '已完成'],
                          ['failed', '明确未扣款'],
                        ]),
                        ...(r.kind === 'open'
                          ? [
                              field(
                                'card_id',
                                '实际生成的卡 ID（成功时必填）',
                                'number',
                                '',
                                true,
                              ),
                            ]
                          : []),
                        field('note', '卡台资金记录凭证与核对说明'),
                        field('confirmation', '输入 RESOLVE 确认已核对'),
                      ],
                      action: async (v) => {
                        await api(
                          base + '/operations/' + s(r.id) + '/resolve',
                          v,
                        )
                      },
                    }),
                  )}
              </>,
            ]}
          />
          <p className="note">
            卡号只展示后四位，CVV
            不存储。余额默认缓存值；待核对操作不会自动重提。
          </p>
          <p className="note">
            文档的 X 直充为本人订阅，当前没有 BDT
            赠送接口。接入卡池不会自动开放赠送。
          </p>
        </>
      )}
    </>
  )
}
function Docs() {
  return (
    <>
      <div className="section-label">签名接口</div>
      <p className="note">
        基地址：{window.location.origin + '/v1'}。每次请求使用新的随机数；重试保留原商户订单号和幂等键。
      </p>
      <Grid
        headers={['方法', '路径', '用途']}
        rows={[
          { method: 'GET', path: '/products', use: '查询套餐' },
          { method: 'GET', path: '/balance', use: '可用和冻结点数' },
          { method: 'POST', path: '/eligibility', use: '下单前检测用户名赠送资格' },
          { method: 'GET', path: '/capabilities', use: '当前是否接受新订单' },
          { method: 'POST', path: '/orders', use: '创建赠送订单' },
          { method: 'GET', path: '/orders/:id', use: '查询原订单' },
          {
            method: 'GET',
            path: '/orders?merchant_order_no=…',
            use: '按商户单号查询',
          },
        ]}
        render={(r) => [s(r.method), <code>{s(r.path)}</code>, s(r.use)]}
      />
      <h2 className="section-label">请求签名</h2>
      <pre>{`请求头\nX-Partner-Id: 用户 ID\nX-Key-Id: Key ID\nX-Timestamp: Unix 秒级时间戳\nX-Nonce: 16–128 位唯一随机数\nX-Signature: HMAC-SHA256 十六进制签名\nIdempotency-Key: POST 使用稳定的幂等键\n\n签名原文（以换行分隔）\nHTTP 方法\nURL pathname\n排序且按 RFC3986 编码的查询字符串\n时间戳\n随机数\nKey ID\n幂等键（GET 为空）\n原始请求体的 SHA256（GET 是空字符串的摘要）`}</pre>
      <h2 className="section-label">创建订单</h2>
      <pre>
        {JSON.stringify(
          {
            merchant_order_no: 'your-order-001',
            recipient: 'username',
            product_code: 'x-premium-3m',
            recipient_id: '使用资格检测返回的数字 ID',
            expected_points: 1700,
          },
          null,
          2,
        )}
      </pre>
      <p className="note">
        当前 1 点 = ¥0.01，3 个月 1700 点、6 个月 3400 点。资格检查不会扣点或支付。
        订单成功后扣除冻结点数；明确失败时退回；结果待核对时保持冻结。回调使用
        X-Event-Id 去重，X-Timestamp 与原始 body 以英文句点连接后计算
        HMAC-SHA256，与 X-Signature 比对。
      </p>
    </>
  )
}
