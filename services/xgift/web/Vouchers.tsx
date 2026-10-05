import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Table } from '@cloudflare/kumo/components/table'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut } from '@phosphor-icons/react'
import type { Request } from './Recharge'
import { useUnsavedChanges } from './unsaved-changes'
import './vouchers-management.css'

type Row = Record<string, unknown>
type Merchant = { id: string; name: string; enabled: number | boolean; available: number; frozen: number }
type Batch = { batch_id: string; vouchers: { id: string; code: string; product_code: string; expires_at: number }[] }
type Filters = { status: string; q: string; user_id: string; page: number }
const text = (value: unknown) => value === null || value === undefined ? '—' : String(value)
const time = (value: unknown) => value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—'
const states: [string, string][] = [['', '全部状态'], ['available', '可兑换'], ['redeemed', '已兑换'], ['expired', '已过期'], ['revoked', '已撤销']]
const productName = (code: string) => code === 'x-premium-3m' ? 'Premium · 3 个月' : code === 'x-premium-6m' ? 'Premium · 6 个月' : code
const errorText = (error: unknown) => error instanceof Error ? error.message : '请求未确认，请刷新后核对原记录。'
function readFilters(): Filters {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const page = Number(params.get('page') ?? 1), status = params.get('status') ?? ''
  return {
    status: states.some(([value]) => value === status) ? status : '',
    q: (params.get('q') ?? '').slice(0, 80), user_id: (params.get('user_id') ?? '').slice(0, 80),
    page: Number.isSafeInteger(page) && page > 0 && page <= 100000 ? page : 1,
  }
}
function queryString(filters: Filters) {
  const params = new URLSearchParams({ page: String(filters.page) })
  if (filters.status) params.set('status', filters.status)
  if (filters.q) params.set('q', filters.q)
  if (filters.user_id) params.set('user_id', filters.user_id)
  return params.toString()
}

export function Vouchers({ rows: initialRows, request, onChanged, onError, refreshVersion = 0 }: {
  rows?: Row[]; request: Request; onChanged?: () => void; onError?: (error: unknown) => void; refreshVersion?: number
}) {
  const [filters, setFilters] = useState<Filters>(readFilters), [search, setSearch] = useState(() => readFilters().q)
  const [rows, setRows] = useState<Row[]>(initialRows ?? []), [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(''), [listVersion, setListVersion] = useState(0)
  const [merchantSearch, setMerchantSearch] = useState(''), [merchantPage, setMerchantPage] = useState(1)
  const [merchants, setMerchants] = useState<Merchant[]>([]), [merchant, setMerchant] = useState<Merchant | null>(null)
  const [merchantsLoading, setMerchantsLoading] = useState(true), [merchantError, setMerchantError] = useState('')
  const [merchantVersion, setMerchantVersion] = useState(0)
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
      const next = readFilters(); setFilters(next); setSearch(next.q)
    }
    window.addEventListener('hashchange', restore)
    return () => { mounted.current = false; window.removeEventListener('hashchange', restore) }
  }, [])
  useEffect(() => {
    let live = true
    setLoading(true); setListError(''); setRows([])
    void request<Row[]>('/api/admin/vouchers?' + queryString(filters))
      .then((next) => { if (live) setRows(next) })
      .catch((failure) => { if (live) { setListError(errorText(failure)); reportAuth(failure) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [request, filters, listVersion, refreshVersion])
  useEffect(() => {
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
  }, [request, merchantSearch, merchantPage, merchantVersion])

  function changeFilters(next: Filters) {
    setFilters(next); setSearch(next.q)
    window.history.replaceState(null, '', '#vouchers?' + queryString(next))
  }
  function changed() { setListVersion((value) => value + 1); onChanged?.() }
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lock.current || !merchant || !merchant.enabled || batch) return
    lock.current = true; setBusy(true); setError('')
    const values = Object.fromEntries(new FormData(event.currentTarget))
    try {
      const result = await request<Batch>('/api/admin/vouchers', {
        ...values, user_id: merchant.id, quantity: Number(values.quantity), expires_in_days: Number(values.expires_in_days),
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
      await request('/api/admin/vouchers/' + encodeURIComponent(text(revoke.id)) + '/revoke', values)
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

  return <section className="voucher-management" aria-label="卡密生成与记录">
    <section className="voucher-create" aria-labelledby="voucher-create-title">
      <div className="toolbar">
        <h2 id="voucher-create-title">生成套餐卡密</h2>
        <a href="/redeem" className="text-link" target="_blank" rel="noreferrer">打开兑换页 <ArrowSquareOut size={15} /></a>
      </div>
      <p className="note">生成时不扣点；客户兑换时，按所属商户的套餐价格冻结点数。</p>
      <form onSubmit={generate} className="voucher-generation-form" onChange={(event) => {
        if (event.target.id !== 'voucher-merchant-search') setFormDirty(true)
      }}>
        <fieldset className="voucher-owner-picker" disabled={busy || !!batch}>
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
        </fieldset>
        <div className="voucher-issue-fields">
          <label className="form-field" htmlFor="voucher-product">兑换套餐
            <select id="voucher-product" name="product_code" disabled={busy || !!batch} defaultValue="x-premium-3m">
              <option value="x-premium-3m">Premium · 3 个月</option><option value="x-premium-6m">Premium · 6 个月</option>
            </select>
          </label>
          <Input label="批次名称" name="batch_label" placeholder="例如：十月 Premium 3 个月" maxLength={80} disabled={busy || !!batch} required />
          <Input label="数量" name="quantity" type="number" min={1} max={100} step={1} defaultValue={1} disabled={busy || !!batch} required />
          <Input label="有效天数" name="expires_in_days" type="number" min={1} max={365} step={1} defaultValue={30} disabled={busy || !!batch} required />
          <div className="voucher-generate-action"><Button type="submit" variant="primary" disabled={busy || !!batch || !merchant?.enabled}>{busy && !revoke ? '正在生成…' : '生成卡密'}</Button><span className="note">最多 100 张，有效期 1–365 天</span></div>
        </div>
      </form>
      {error && !revoke && !batch && <p className="notice error" role="alert">{error}</p>}
    </section>

    <section className="voucher-records" aria-labelledby="voucher-records-title">
      <div className="toolbar"><div><h2 id="voucher-records-title">卡密记录</h2><p className="note">完整卡密仅生成时展示；这里保留兑换与交付记录。</p></div>
        <Button type="button" variant="ghost" disabled={loading || busy} onClick={() => setListVersion((value) => value + 1)}><ArrowClockwise size={16} />刷新记录</Button>
      </div>
      <form className="voucher-record-filters" onSubmit={(event) => { event.preventDefault(); changeFilters({ ...filters, q: search.trim(), page: 1 }) }}>
        <Input label="查找商户或批次" value={search} maxLength={80} placeholder="商户名称、商户 ID、批次名称或批次 ID" disabled={busy} onChange={(event) => setSearch(event.target.value)} />
        <label className="form-field" htmlFor="voucher-status">卡密状态
          <select id="voucher-status" value={filters.status} disabled={busy} onChange={(event) => changeFilters({ ...filters, status: event.target.value, page: 1 })}>
            {states.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <Button type="submit" variant="secondary" disabled={busy}>查询</Button>
        {(filters.q || filters.status || filters.user_id) && <Button type="button" variant="ghost" disabled={busy} onClick={() => changeFilters({ status: '', q: '', user_id: '', page: 1 })}>清除筛选</Button>}
      </form>
      {filters.user_id && <p className="note">当前仅查看商户 ID 尾号 {filters.user_id.slice(-8)} 的卡密。</p>}
      {listError && <p className="notice error" role="alert">卡密记录未能加载：{listError} 请刷新记录重试。</p>}
      <div className="table-scroll voucher-record-table" aria-busy={loading}>
        <Table><Table.Header><Table.Row>{['卡密 / 批次', '商户 / 套餐', '状态 / 有效期', '兑换订单', '操作'].map((label) => <Table.Head key={label}>{label}</Table.Head>)}</Table.Row></Table.Header>
          <Table.Body>
            {!rows.length && <Table.Row><Table.Cell colSpan={5}><div className={loading ? 'table-skeleton' : 'empty'} role="status">
              {loading ? '正在读取卡密记录…' : listError ? '暂未取得卡密记录。' : filters.q || filters.status || filters.user_id ? '没有匹配的卡密，请调整或清除筛选。' : '还没有卡密。选择商户并生成后，可将卡密交付给客户。'}
            </div></Table.Cell></Table.Row>}
            {rows.map((row) => {
              const state = text(row.state ?? (row.status === 'active' && Number(row.expires_at) <= Date.now() ? 'expired' : row.status === 'active' ? 'available' : row.status))
              const label = states.find(([value]) => value === state)?.[1] ?? state
              return <Table.Row key={text(row.id)}>
                <Table.Cell><span className="stack"><code>•••• {text(row.last_four)}</code><span>{text(row.batch_label) || '未命名批次'}</span></span>
                  <details className="voucher-record-detail"><summary>批次详情</summary><dl>
                    <div><dt>批次 ID</dt><dd><code>{text(row.batch_id)}</code></dd></div><div><dt>卡密 ID</dt><dd><code>{text(row.id)}</code></dd></div>
                    <div><dt>商户 ID</dt><dd><code>{text(row.user_id)}</code></dd></div><div><dt>生成时间</dt><dd>{time(row.created_at)}</dd></div>
                    {!!row.revocation_note && <div><dt>撤销原因</dt><dd>{text(row.revocation_note)}</dd></div>}
                  </dl></details>
                </Table.Cell>
                <Table.Cell><span className="stack"><strong>{text(row.user_name)}</strong><span>{text(row.product_name ?? row.product_code)}</span></span></Table.Cell>
                <Table.Cell><span className="stack"><span className={'status status-' + (state === 'available' ? 'active' : state)}>{label}</span><small>至 {time(row.expires_at)}</small></span></Table.Cell>
                <Table.Cell>{row.order_id ? <span className="stack"><a className="text-link" href={'#orders?status=&q=' + encodeURIComponent(text(row.order_id)) + '&page=1'}>查看原订单 <ArrowSquareOut size={14} /></a><small>{({ queued: '排队中', running: '处理中', unknown: '待核对', succeeded: '付款已确认', failed: '已结束' } as Record<string, string>)[text(row.order_status)] ?? text(row.order_status)}</small></span> : <span className="note">尚未兑换</span>}</Table.Cell>
                <Table.Cell>{state === 'available' && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setError(''); setRevoke(row) }}>撤销</Button>}</Table.Cell>
              </Table.Row>
            })}
          </Table.Body>
        </Table>
      </div>
      <div className="pager"><span>第 {filters.page} 页 · 每页最多 30 条 · 按全部卡密筛选</span>
        <Button type="button" variant="ghost" aria-label="上一页卡密" disabled={loading || busy || filters.page === 1} onClick={() => changeFilters({ ...filters, page: filters.page - 1 })}><ArrowLeft size={16} /></Button>
        <Button type="button" variant="ghost" aria-label="下一页卡密" disabled={loading || busy || !!listError || rows.length < 30} onClick={() => changeFilters({ ...filters, page: filters.page + 1 })}><ArrowRight size={16} /></Button>
      </div>
    </section>

    {batch && <Dialog.Root open onOpenChange={(open) => { if (!open) closeBatch() }}>
      <Dialog size="lg" className="x-modal voucher-batch-dialog">
        <Dialog.Title className="modal-title">已生成 {batch.vouchers.length} 张卡密</Dialog.Title>
        <Dialog.Description className="modal-description">完整卡密仅显示这一次。请复制并安全保存，关闭后无法恢复。</Dialog.Description>
        <p className="note">{merchant?.name} · {productName(batch.vouchers[0].product_code)} · 有效期至 {time(batch.vouchers[0].expires_at)}</p>
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
