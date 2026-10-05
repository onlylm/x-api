import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Table } from '@cloudflare/kumo/components/table'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut } from '@phosphor-icons/react'
import type { Request } from './Recharge'
import { useUnsavedChanges } from './unsaved-changes'
import { isClosedOrder, orderProduct, orderStateText, type OrderRow } from './order-ui'
import { orderFailureDescription } from './order-failures'
import './vouchers-management.css'

type Row = Record<string, unknown>
type Merchant = { id: string; name: string; enabled: number | boolean; available: number; frozen: number }
type OwnAccount = Pick<Merchant, 'id' | 'name' | 'available' | 'frozen'>
type Product = { code: string; name: string; points: number; enabled: number | boolean }
type Batch = { batch_id: string; vouchers: { id: string; code: string; product_code: string; expires_at: number }[] }
type Filters = { status: string; q: string; user_id: string; page: number }
const text = (value: unknown) => value === null || value === undefined ? '—' : String(value)
const time = (value: unknown) => value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—'
const states: [string, string][] = [['', '全部状态'], ['available', '可兑换'], ['redeemed', '已兑换'], ['expired', '已过期'], ['revoked', '已撤销']]
const productName = (code: string) => code === 'x-premium-3m' ? 'Premium · 3 个月' : code === 'x-premium-6m' ? 'Premium · 6 个月' : code
const errorText = (error: unknown) => error instanceof Error ? error.message : '请求未确认，请刷新后核对原记录。'
function readFilters(includeOwner = true): Filters {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const page = Number(params.get('page') ?? 1), status = params.get('status') ?? ''
  return {
    status: states.some(([value]) => value === status) ? status : '',
    q: (params.get('q') ?? '').slice(0, 80), user_id: includeOwner ? (params.get('user_id') ?? '').slice(0, 80) : '',
    page: Number.isSafeInteger(page) && page > 0 && page <= 100000 ? page : 1,
  }
}
function queryString(filters: Filters, includeOwner = true) {
  const params = new URLSearchParams({ page: String(filters.page) })
  if (filters.status) params.set('status', filters.status)
  if (filters.q) params.set('q', filters.q)
  if (includeOwner && filters.user_id) params.set('user_id', filters.user_id)
  return params.toString()
}

export function Vouchers({ rows: initialRows, request, onChanged, onError, refreshVersion = 0, scope = 'admin' }: {
  rows?: Row[]; request: Request; onChanged?: () => void; onError?: (error: unknown) => void; refreshVersion?: number; scope?: 'admin' | 'merchant'
}) {
  const admin = scope === 'admin', base = admin ? '/api/admin/vouchers' : '/api/vouchers'
  const [filters, setFilters] = useState<Filters>(() => readFilters(admin)), [search, setSearch] = useState(() => readFilters(admin).q)
  const [rows, setRows] = useState<Row[]>(initialRows ?? []), [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(''), [listVersion, setListVersion] = useState(0)
  const [merchantSearch, setMerchantSearch] = useState(''), [merchantPage, setMerchantPage] = useState(1)
  const [merchants, setMerchants] = useState<Merchant[]>([]), [merchant, setMerchant] = useState<Merchant | null>(null)
  const [merchantsLoading, setMerchantsLoading] = useState(true), [merchantError, setMerchantError] = useState('')
  const [merchantVersion, setMerchantVersion] = useState(0)
  const [account, setAccount] = useState<OwnAccount | null>(null), [products, setProducts] = useState<Product[]>([])
  const [productCode, setProductCode] = useState(admin ? 'x-premium-3m' : '')
  const [accountLoading, setAccountLoading] = useState(!admin), [accountError, setAccountError] = useState(''), [accountVersion, setAccountVersion] = useState(0)
  const [linkedOrderId, setLinkedOrderId] = useState(''), [linkedOrder, setLinkedOrder] = useState<OrderRow | null>(null)
  const [orderLoading, setOrderLoading] = useState(false), [orderError, setOrderError] = useState(''), [orderVersion, setOrderVersion] = useState(0)
  const orderPanel = useRef<HTMLElement | null>(null)
  const [batch, setBatch] = useState<Batch | null>(null), [copied, setCopied] = useState(false), [saved, setSaved] = useState(false)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [formDirty, setFormDirty] = useState(false)
  const [revoke, setRevoke] = useState<Row | null>(null)
  const lock = useRef(false), mounted = useRef(true)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  function reportAuth(failure: unknown) {
    if (typeof failure === 'object' && failure !== null && 'status' in failure && failure.status === 401) onErrorRef.current?.(failure)
  }
  useUnsavedChanges(busy || (!!batch && !saved) || formDirty)

  useEffect(() => {
    mounted.current = true
    const restore = () => {
      if (window.location.hash.split('?')[0] !== '#vouchers') return
      const next = readFilters(admin); setFilters(next); setSearch(next.q)
    }
    window.addEventListener('hashchange', restore)
    return () => { mounted.current = false; window.removeEventListener('hashchange', restore) }
  }, [admin])
  useEffect(() => {
    let live = true
    setLoading(true); setListError(''); setRows([])
    void request<Row[]>(base + '?' + queryString(filters, admin))
      .then((next) => { if (live) setRows(next) })
      .catch((failure) => { if (live) { setListError(errorText(failure)); reportAuth(failure) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [request, base, admin, filters, listVersion, refreshVersion])
  useEffect(() => {
    if (!admin) return
    let live = true
    setMerchantsLoading(true); setMerchantError(''); setMerchants([])
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(merchantPage), q: merchantSearch.trim() })
      void request<Merchant[]>('/api/admin/users?' + params.toString())
        .then((next) => {
          if (!live) return
          setMerchants(next)
          setMerchant((current) => current ? next.find((item) => item.id === current.id) ?? current : null)
        })
        .catch((failure) => { if (live) { setMerchantError(errorText(failure)); reportAuth(failure) } })
        .finally(() => { if (live) setMerchantsLoading(false) })
    }, merchantSearch.trim() ? 250 : 0)
    return () => { live = false; window.clearTimeout(timer) }
  }, [request, admin, merchantSearch, merchantPage, merchantVersion])
  useEffect(() => {
    if (admin) return
    let live = true
    setAccountLoading(true); setAccountError('')
    void Promise.all([request<OwnAccount>('/api/me'), request<Product[]>('/api/products')])
      .then(([ownAccount, availableProducts]) => {
        if (!live) return
        const enabledProducts = availableProducts.filter((product) => !!product.enabled)
        setAccount(ownAccount); setProducts(enabledProducts)
        setProductCode((current) => enabledProducts.some((product) => product.code === current) ? current : enabledProducts[0]?.code ?? '')
      })
      .catch((failure) => { if (live) { setAccountError(errorText(failure)); reportAuth(failure) } })
      .finally(() => { if (live) setAccountLoading(false) })
    return () => { live = false }
  }, [request, admin, accountVersion, refreshVersion, listVersion])
  useEffect(() => {
    if (admin || !linkedOrderId) return
    let live = true
    setOrderLoading(true); setOrderError(''); setLinkedOrder(null)
    void request<OrderRow>('/api/orders/' + encodeURIComponent(linkedOrderId))
      .then((order) => { if (live) setLinkedOrder(order) })
      .catch((failure) => { if (live) { setOrderError(errorText(failure)); reportAuth(failure) } })
      .finally(() => { if (live) setOrderLoading(false) })
    return () => { live = false }
  }, [request, admin, linkedOrderId, orderVersion])
  useEffect(() => {
    if (!linkedOrderId || admin) return
    orderPanel.current?.focus({ preventScroll: true })
    orderPanel.current?.scrollIntoView({ block: 'nearest' })
  }, [linkedOrderId, admin])

  function changeFilters(next: Filters) {
    const scoped = admin ? next : { ...next, user_id: '' }
    setFilters(scoped); setSearch(scoped.q)
    window.history.replaceState(null, '', '#vouchers?' + queryString(scoped, admin))
  }
  function changed() { setListVersion((value) => value + 1); onChanged?.() }
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lock.current || batch || (admin ? !merchant?.enabled : !account || accountLoading || !!accountError || !products.some((product) => product.code === productCode))) return
    lock.current = true; setBusy(true); setError('')
    const values = Object.fromEntries(new FormData(event.currentTarget))
    try {
      const result = await request<Batch>(base, {
        ...values, ...(admin ? { user_id: merchant!.id } : {}), quantity: Number(values.quantity), expires_in_days: Number(values.expires_in_days),
      })
      if (!mounted.current) return
      setBatch(result); setCopied(false); setSaved(false); setFormDirty(false); changed()
    } catch (failure) {
      if (mounted.current) { setError(errorText(failure) + ' 生成结果未确认时，请先核对批次记录。'); reportAuth(failure) }
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function confirmRevoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!revoke || lock.current) return
    lock.current = true; setBusy(true); setError('')
    const values = Object.fromEntries(new FormData(event.currentTarget))
    try {
      await request(base + '/' + encodeURIComponent(text(revoke.id)) + '/revoke', values)
      if (mounted.current) { setRevoke(null); changed() }
    } catch (failure) {
      if (mounted.current) { setError(errorText(failure)); reportAuth(failure) }
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const output = batch?.vouchers.map((voucher) => voucher.code).join('\n') ?? ''
  async function copyBatch(withInstructions: boolean) {
    if (!batch) return
    const first = batch.vouchers[0]
    const delivery = '兑换地址：' + window.location.origin + '/redeem\n套餐：' + productName(first.product_code) +
      '\n有效期至：' + time(first.expires_at) + '\n只需 X 用户名，无需账号密码。每行一张卡密：\n\n' + output
    try { await navigator.clipboard.writeText(withInstructions ? delivery : output); setCopied(true); setError('') }
    catch { setError('浏览器不允许自动复制，请选中文本手动复制并保存。') }
  }
  function closeBatch() {
    if (!saved) { setError('完整卡密无法再次查看。请先复制保存，并勾选“我已安全保存”。'); return }
    setBatch(null); setError('')
  }
  const ownerOptions = merchant && !merchants.some((item) => item.id === merchant.id) ? [merchant, ...merchants] : merchants
  const selectedProduct = products.find((product) => product.code === productCode)
  const canGenerate = !busy && !batch && (admin ? !!merchant?.enabled : !!account && !accountLoading && !accountError && !!selectedProduct)

  return <section className={'voucher-management' + (admin ? '' : ' voucher-management-own')} aria-label={admin ? '卡密生成与记录' : '我的卡密生成与记录'}>
    <section className="voucher-create" aria-labelledby="voucher-create-title">
      <div className="toolbar">
        <h2 id="voucher-create-title">生成套餐卡密</h2>
        <a href="/redeem" className="text-link" target="_blank" rel="noreferrer">打开兑换页 <ArrowSquareOut size={15} /></a>
      </div>
      <p className="note">{admin ? '生成时不扣点；客户兑换时，按所属商户的套餐价格冻结点数。' : '生成卡密不扣点、不冻结余额。客户兑换时，按你当时的套餐价格冻结点数；兑换时余额不足将无法下单。'}</p>
      {!admin && <div className="voucher-own-account" aria-label="我的点数账户">
        <div><strong>{account?.name ?? '我的账户'}</strong><span>{account ? '可用 ' + Number(account.available).toLocaleString('zh-CN') + ' 点 · 冻结 ' + Number(account.frozen).toLocaleString('zh-CN') + ' 点' : '正在读取账户与套餐…'}</span></div>
        <Button type="button" variant="ghost" disabled={accountLoading || busy || !!batch} onClick={() => setAccountVersion((value) => value + 1)}><ArrowClockwise size={16} />{accountLoading ? '更新中…' : '刷新余额与套餐'}</Button>
      </div>}
      {!admin && accountError && <p className="notice error" role="alert">账户或套餐未能更新：{accountError} 请刷新后重试；已有卡密记录仍可查询。</p>}
      <form onSubmit={generate} className="voucher-generation-form" onChange={(event) => {
        if (event.target.id !== 'voucher-merchant-search') setFormDirty(true)
      }}>
        {admin && <fieldset className="voucher-owner-picker" disabled={busy || !!batch}>
          <legend>所属商户</legend>
          <Input id="voucher-merchant-search" label="搜索商户" value={merchantSearch} maxLength={80} placeholder="输入商户名称或 ID"
            onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }}
            onChange={(event) => { setMerchantSearch(event.target.value); setMerchantPage(1) }} />
          <label className="form-field" htmlFor="voucher-owner">选择商户
            <select id="voucher-owner" value={merchant?.id ?? ''} disabled={busy || !!batch || merchantsLoading} required
              onChange={(event) => { setMerchant(ownerOptions.find((item) => item.id === event.target.value) ?? null); setError('') }}>
              <option value="">{merchantsLoading ? '正在查找商户…' : '选择所属商户'}</option>
              {ownerOptions.map((item) => <option key={item.id} value={item.id} disabled={!item.enabled}>
                {item.name} · {item.id.slice(-8)} · {item.enabled ? '可用 ' + Number(item.available).toLocaleString('zh-CN') + ' 点' : '已停用'}
              </option>)}
            </select>
          </label>
          {merchant && <p className="voucher-owner-summary" role="status"><strong>{merchant.name}</strong>
            <span>ID 尾号 {merchant.id.slice(-8)} · {merchant.enabled ? '可用' : '已停用'} · 可用点数 {Number(merchant.available).toLocaleString('zh-CN')}</span>
          </p>}
          {merchantError && <p className="notice error" role="alert">未能读取商户：{merchantError} <Button type="button" variant="ghost" onClick={() => setMerchantVersion((value) => value + 1)}>重新读取</Button></p>}
          {!merchantsLoading && !merchantError && !merchants.length && <p className="note" role="status">{merchantSearch ? '没有匹配的商户，请调整名称或 ID。' : <>暂无商户，<a className="text-link" href="#users">前往开通商户</a>。</>}</p>}
          <div className="voucher-owner-pager">
            <span>{merchantsLoading ? '正在查询…' : '第 ' + merchantPage + ' 页 · 每页最多 30 位商户'}</span>
            <Button type="button" variant="ghost" aria-label="上一页商户" disabled={merchantsLoading || merchantPage === 1} onClick={() => setMerchantPage((value) => value - 1)}><ArrowLeft size={16} /></Button>
            <Button type="button" variant="ghost" aria-label="下一页商户" disabled={merchantsLoading || !!merchantError || merchants.length < 30} onClick={() => setMerchantPage((value) => value + 1)}><ArrowRight size={16} /></Button>
          </div>
        </fieldset>}
        <div className="voucher-issue-fields">
          <label className="form-field" htmlFor="voucher-product">兑换套餐
            <select id="voucher-product" name="product_code" value={productCode} required disabled={busy || !!batch || (!admin && (accountLoading || !!accountError || !products.length))}
              onChange={(event) => setProductCode(event.target.value)}>
              {admin ? <><option value="x-premium-3m">Premium · 3 个月</option><option value="x-premium-6m">Premium · 6 个月</option></> : <>
                {!products.length && <option value="">{accountLoading ? '正在读取可用套餐…' : '暂无可用套餐'}</option>}
                {products.map((product) => <option key={product.code} value={product.code}>{product.name} · 兑换时 {product.points.toLocaleString('zh-CN')} 点/张</option>)}
              </>}
            </select>
          </label>
          <Input label="批次名称" name="batch_label" placeholder="例如：十月 Premium 3 个月" maxLength={80} disabled={busy || !!batch} required />
          <Input label="数量" name="quantity" type="number" min={1} max={100} step={1} defaultValue={1} disabled={busy || !!batch} required />
          <Input label="有效天数" name="expires_in_days" type="number" min={1} max={365} step={1} defaultValue={30} disabled={busy || !!batch} required />
          {!admin && <p className="note voucher-price-note">{selectedProduct
            ? '当前兑换价 ' + selectedProduct.points.toLocaleString('zh-CN') + ' 点/张，实际按兑换时价格冻结。生成这些卡密不会预扣点数。'
            : accountLoading ? '正在确认当前可用套餐。' : accountError ? '请先重新读取账户与套餐。' : '当前没有开放的套餐，暂时无法生成卡密，请联系管理员。'}</p>}
          <div className="voucher-generate-action"><Button type="submit" variant="primary" disabled={!canGenerate}>{busy && !revoke ? '正在生成…' : '生成卡密'}</Button><span className="note">最多 100 张，有效期 1–365 天</span></div>
        </div>
      </form>
      {error && !revoke && !batch && <p className="notice error" role="alert">{error}</p>}
    </section>

    <section className="voucher-records" aria-labelledby="voucher-records-title">
      <div className="toolbar"><div><h2 id="voucher-records-title">{admin ? '卡密记录' : '我的卡密记录'}</h2><p className="note">完整卡密仅生成时展示；这里保留兑换与交付记录。</p></div>
        <Button type="button" variant="ghost" disabled={loading || busy} onClick={() => setListVersion((value) => value + 1)}><ArrowClockwise size={16} />刷新记录</Button>
      </div>
      <form className="voucher-record-filters" onSubmit={(event) => { event.preventDefault(); changeFilters({ ...filters, q: search.trim(), page: 1 }) }}>
        <Input label={admin ? '查找商户或批次' : '查找批次'} value={search} maxLength={80} placeholder={admin ? '商户名称、商户 ID、批次名称或批次 ID' : '批次名称或批次 ID'} disabled={busy} onChange={(event) => setSearch(event.target.value)} />
        <label className="form-field" htmlFor="voucher-status">卡密状态
          <select id="voucher-status" value={filters.status} disabled={busy} onChange={(event) => changeFilters({ ...filters, status: event.target.value, page: 1 })}>
            {states.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <Button type="submit" variant="secondary" disabled={busy}>查询</Button>
        {(filters.q || filters.status || filters.user_id) && <Button type="button" variant="ghost" disabled={busy} onClick={() => changeFilters({ status: '', q: '', user_id: '', page: 1 })}>清除筛选</Button>}
      </form>
      {admin && filters.user_id && <p className="note">当前仅查看商户 ID 尾号 {filters.user_id.slice(-8)} 的卡密。</p>}
      {listError && <p className="notice error" role="alert">卡密记录未能加载：{listError} 请刷新记录重试。</p>}
      <div className="table-scroll voucher-record-table" aria-busy={loading}>
        <Table><Table.Header><Table.Row>{['卡密 / 批次', admin ? '商户 / 套餐' : '套餐', '状态 / 有效期', '兑换订单', '操作'].map((label) => <Table.Head key={label}>{label}</Table.Head>)}</Table.Row></Table.Header>
          <Table.Body>
            {!rows.length && <Table.Row><Table.Cell colSpan={5}><div className={loading ? 'table-skeleton' : 'empty'} role="status">
              {loading ? '正在读取卡密记录…' : listError ? '暂未取得卡密记录。' : filters.q || filters.status || filters.user_id ? '没有匹配的卡密，请调整或清除筛选。' : admin ? '还没有卡密。选择商户并生成后，可将卡密交付给客户。' : '还没有卡密。选择套餐并生成后，可将卡密与兑换说明一起交付给客户。'}
            </div></Table.Cell></Table.Row>}
            {rows.map((row) => {
              const state = text(row.state ?? (row.status === 'active' && Number(row.expires_at) <= Date.now() ? 'expired' : row.status === 'active' ? 'available' : row.status))
              const label = states.find(([value]) => value === state)?.[1] ?? state
              return <Table.Row key={text(row.id)}>
                <Table.Cell><span className="stack"><code>•••• {text(row.last_four)}</code><span>{text(row.batch_label) || '未命名批次'}</span></span>
                  <details className="voucher-record-detail"><summary>批次详情</summary><dl>
                    <div><dt>批次 ID</dt><dd><code>{text(row.batch_id)}</code></dd></div><div><dt>卡密 ID</dt><dd><code>{text(row.id)}</code></dd></div>
                    {admin && <div><dt>商户 ID</dt><dd><code>{text(row.user_id)}</code></dd></div>}<div><dt>生成时间</dt><dd>{time(row.created_at)}</dd></div>
                    {!!row.revocation_note && <div><dt>撤销原因</dt><dd>{text(row.revocation_note)}</dd></div>}
                  </dl></details>
                </Table.Cell>
                <Table.Cell><span className="stack">{admin && <strong>{text(row.user_name)}</strong>}<span>{text(row.product_name ?? row.product_code)}</span></span></Table.Cell>
                <Table.Cell><span className="stack"><span className={'status status-' + (state === 'available' ? 'active' : state)}>{label}</span><small>至 {time(row.expires_at)}</small></span></Table.Cell>
                <Table.Cell>{row.order_id ? <span className="stack">{admin
                  ? <a className="text-link" href={'#orders?status=&q=' + encodeURIComponent(text(row.order_id)) + '&page=1'}>查看原订单 <ArrowSquareOut size={14} /></a>
                  : <Button type="button" variant="ghost" className="voucher-order-button" aria-controls="voucher-linked-order" disabled={busy} onClick={() => {
                    setLinkedOrderId(text(row.order_id)); setOrderVersion((value) => value + 1)
                  }}>查看原订单</Button>}<small>{({ queued: '排队中', running: '处理中', unknown: '待核对', succeeded: '付款已确认', failed: '已结束' } as Record<string, string>)[text(row.order_status)] ?? text(row.order_status)}</small></span> : <span className="note">尚未兑换</span>}</Table.Cell>
                <Table.Cell>{state === 'available' && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setError(''); setRevoke(row) }}>撤销</Button>}</Table.Cell>
              </Table.Row>
            })}
          </Table.Body>
        </Table>
      </div>
      <div className="pager"><span>第 {filters.page} 页 · 每页最多 30 条 · {admin ? '按全部卡密筛选' : '仅我的卡密'}</span>
        <Button type="button" variant="ghost" aria-label="上一页卡密" disabled={loading || busy || filters.page === 1} onClick={() => changeFilters({ ...filters, page: filters.page - 1 })}><ArrowLeft size={16} /></Button>
        <Button type="button" variant="ghost" aria-label="下一页卡密" disabled={loading || busy || !!listError || rows.length < 30} onClick={() => changeFilters({ ...filters, page: filters.page + 1 })}><ArrowRight size={16} /></Button>
      </div>
    </section>

    {!admin && linkedOrderId && <section ref={orderPanel} id="voucher-linked-order" className="voucher-linked-order" tabIndex={-1} aria-labelledby="voucher-linked-order-title" aria-busy={orderLoading}>
      <div className="toolbar"><h2 id="voucher-linked-order-title">原订单详情</h2><div className="actions">
        <Button type="button" variant="ghost" disabled={orderLoading} onClick={() => setOrderVersion((value) => value + 1)}><ArrowClockwise size={16} />刷新原订单</Button>
        <Button type="button" variant="ghost" onClick={() => { setLinkedOrderId(''); setLinkedOrder(null); setOrderError('') }}>收起详情</Button>
      </div></div>
      {orderLoading && <p role="status">正在读取原订单…</p>}
      {orderError && <p className="notice error" role="alert">原订单未能读取：{orderError} 请刷新重试。</p>}
      {linkedOrder && <>
        <dl className="voucher-order-facts">
          <div><dt>接收账号</dt><dd>@{linkedOrder.recipient}</dd></div>
          <div><dt>套餐</dt><dd>{orderProduct(linkedOrder.product_code)}</dd></div>
          <div><dt>订单状态</dt><dd><span className={'status status-' + (isClosedOrder(linkedOrder) ? 'closed' : linkedOrder.status)}>{orderStateText(linkedOrder)}</span></dd></div>
          <div><dt>订单点数</dt><dd>{linkedOrder.points.toLocaleString('zh-CN')} 点</dd></div>
          <div><dt>订单编号</dt><dd><code>{linkedOrder.id}</code></dd></div>
          <div><dt>更新时间</dt><dd>{time(linkedOrder.updated_at ?? linkedOrder.created_at)}</dd></div>
        </dl>
        <p className="note">{isClosedOrder(linkedOrder) ? '原订单已关闭，冻结点数已释放。卡密保留兑换记录，不会恢复为未使用。'
          : linkedOrder.status === 'succeeded' ? '付款已确认，请客户到 X 核对权益。'
          : linkedOrder.status === 'unknown' ? '付款结果待核对，请联系管理员核对原单，不要重复兑换。'
          : linkedOrder.status === 'failed' ? '订单未完成，请联系管理员核对处理结果。'
          : '订单正在排队或处理，点数保持冻结。请刷新原订单查看进度，无需重复提交。'}</p>
        {linkedOrder.failure_code && orderFailureDescription(linkedOrder.failure_code) && <p className="note">{orderFailureDescription(linkedOrder.failure_code)}</p>}
      </>}
    </section>}

    {batch && <Dialog.Root open onOpenChange={(open) => { if (!open) closeBatch() }}>
      <Dialog size="lg" className="x-modal voucher-batch-dialog">
        <Dialog.Title className="modal-title">已生成 {batch.vouchers.length} 张卡密</Dialog.Title>
        <Dialog.Description className="modal-description">完整卡密仅显示这一次。请复制并安全保存，关闭后无法恢复。</Dialog.Description>
        <p className="note">{admin ? merchant?.name : account?.name} · {productName(batch.vouchers[0].product_code)} · 有效期至 {time(batch.vouchers[0].expires_at)}</p>
        <textarea className="secret-output" aria-label="本批次完整卡密" readOnly value={output} autoComplete="off" spellCheck={false} />
        {error && <p className="notice error" role="alert">{error}</p>}
        <p role="status" className="note">{copied ? '已复制。请确认已粘贴到安全位置，再关闭此窗口。' : '每行一张卡密，请勿公开分享。'}</p>
        <label className="voucher-saved-confirm"><input type="checkbox" checked={saved} onChange={(event) => { setSaved(event.target.checked); setError('') }} />我已安全保存，知道关闭后无法再次查看</label>
        <div className="voucher-copy-actions"><Button type="button" variant="primary" onClick={() => void copyBatch(true)}>复制卡密与兑换说明</Button><Button type="button" variant="ghost" onClick={() => void copyBatch(false)}>仅复制卡密</Button></div>
        <div className="modal-footer"><Button type="button" variant="secondary" disabled={!saved} onClick={closeBatch}>已保存，关闭</Button></div>
      </Dialog>
    </Dialog.Root>}
    {revoke && <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) setRevoke(null) }}>
      <Dialog size="lg" className="x-modal"><form onSubmit={confirmRevoke}>
        <Dialog.Title className="modal-title">撤销卡密 · {text(revoke.last_four)}</Dialog.Title>
        <Dialog.Description className="modal-description">撤销后该卡密不能兑换。仅未兑换的卡密可撤销，已创建订单不受此操作影响。</Dialog.Description>
        <Input label="撤销原因" name="note" maxLength={300} required disabled={busy} />
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="modal-footer"><Button type="button" variant="secondary" onClick={() => setRevoke(null)} disabled={busy}>取消</Button><Button type="submit" variant="primary" disabled={busy}>{busy ? '正在撤销…' : '确认撤销'}</Button></div>
      </form></Dialog>
    </Dialog.Root>}
  </section>
}
