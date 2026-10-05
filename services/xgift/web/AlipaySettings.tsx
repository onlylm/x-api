import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { Table } from '@cloudflare/kumo/components/table'
import { ArrowClockwise, ArrowSquareOut, ArrowLeft, ArrowRight } from '@phosphor-icons/react'
import type { Request } from './Recharge'
import { legacyPaymentStatus } from './order-ui'

type Price = { product_code: string; name: string; months: number; amount_cny: string; enabled: boolean }
type AlipayView = {
  configured: boolean
  enabled: boolean
  revision: string | null
  environment: 'production' | 'sandbox'
  app_id: string
  seller_id: string
  has_app_private_key: boolean
  has_alipay_public_key: boolean
  notify_url: string
  prices: Price[]
  ready: boolean
  checks: { code: string; label: string; ok: boolean }[]
  unsettled_count: number
}
type ConfigDraft = Pick<AlipayView, 'revision' | 'environment' | 'app_id' | 'seller_id' | 'prices'>
const base = '/api/admin/alipay'
const toDraft = (view: AlipayView): ConfigDraft => ({
  revision: view.revision, environment: view.environment,
  app_id: view.app_id || '', seller_id: view.seller_id || '',
  prices: view.prices.map((price) => ({ ...price, amount_cny: price.amount_cny || '' })),
})
const validPrice = (value: string, allowZero = false) =>
  /^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(value)
  && Number(value) >= (allowZero ? 0 : 0.01) && Number(value) <= 10000
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未确认，请刷新状态后核对。'

export function AlipaySettings({ request, onError }: { request: Request; onError: (error: unknown) => void }) {
  const [view, setView] = useState<AlipayView | null>(null)
  const [draft, setDraft] = useState<ConfigDraft | null>(null)
  const [original, setOriginal] = useState('')
  const [privateKey, setPrivateKey] = useState(''), [publicKey, setPublicKey] = useState('')
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('')
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'save' | 'enable' | 'disable' | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false), [confirmation, setConfirmation] = useState('')
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const mounted = useRef(false), busyRef = useRef(false), sequence = useRef(0)
  const draftLoaded = useRef(false), onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const reportAuth = useCallback((cause: unknown) => {
    if (typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 401) onErrorRef.current(cause)
  }, [])
  const replaceDraft = useCallback((next: AlipayView) => {
    const value = toDraft(next)
    setDraft(value); setOriginal(JSON.stringify(value)); draftLoaded.current = true
    setPrivateKey(''); setPublicKey(''); setConfirmation(''); setConfirmOpen(false)
  }, [])
  const refresh = useCallback(async (replace = false) => {
    if (busyRef.current) return
    const current = ++sequence.current
    setLoading(true)
    try {
      const next = await request<AlipayView>(base)
      if (!mounted.current || current !== sequence.current) return
      setView(next); setLoadError(''); setCheckedAt(Date.now())
      if (!draftLoaded.current || replace) replaceDraft(next)
      if (replace) { setError(''); setMessage('已载入最新收款配置。') }
    } catch (cause) {
      if (!mounted.current || current !== sequence.current) return
      setLoadError(errorText(cause)); reportAuth(cause)
    } finally {
      if (mounted.current && current === sequence.current) setLoading(false)
    }
  }, [request, replaceDraft, reportAuth])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 30000)
    return () => { mounted.current = false; sequence.current++; window.clearInterval(timer) }
  }, [refresh])

  const dirty = !!draft && (JSON.stringify(draft) !== original || !!privateKey.trim() || !!publicKey.trim())
  const conflict = !!view && !!draft && view.revision !== draft.revision
  const locked = !!busy || !!loadError || conflict || !!view?.enabled || !!view?.unsettled_count
  const requiresNewKeys = !!draft && (!view?.configured || draft.app_id.trim() !== view.app_id || draft.environment !== view.environment)
  const invalidPrice = draft?.prices.some((price) =>
    price.enabled ? !validPrice(price.amount_cny.trim()) : !!price.amount_cny.trim() && !validPrice(price.amount_cny.trim(), true),
  )
  const canSave = !!draft && !!view && !locked && !loading && !invalidPrice && /^\d{16}$/.test(draft.app_id.trim())
    && /^\d{16}$/.test(draft.seller_id.trim()) && ((!requiresNewKeys && view.has_app_private_key) || !!privateKey.trim())
    && ((!requiresNewKeys && view.has_alipay_public_key) || !!publicKey.trim()) && (dirty || !view.configured)
  const canEnable = !!view?.configured && view.ready && !view.enabled && !dirty && !conflict && !loadError && !loading && !busy

  async function mutate(action: 'save' | 'enable' | 'disable') {
    if (!draft || !view || busyRef.current) return
    if (action === 'save' && !canSave) return
    if (action === 'enable' && (!canEnable || confirmation !== 'ENABLE_ALIPAY')) return
    busyRef.current = true; sequence.current++
    setBusy(action); setLoading(false); setError(''); setMessage('')
    try {
      if (action === 'save') {
        await request(base + '/config', {
          revision: draft.revision, environment: draft.environment,
          app_id: draft.app_id.trim(), seller_id: draft.seller_id.trim(),
          app_private_key: privateKey.trim(), alipay_public_key: publicKey.trim(),
          prices: draft.prices.map((price) => ({
            product_code: price.product_code, enabled: price.enabled,
            amount_cny: price.amount_cny.trim() ? Number(price.amount_cny).toFixed(2) : '',
          })),
        })
        // Keys are kept only in this form and cleared as soon as saving succeeds.
        if (mounted.current) { setPrivateKey(''); setPublicKey('') }
      } else {
        await request(base + '/enabled', {
          enabled: action === 'enable', revision: view.revision,
          ...(action === 'enable' ? { confirmation: 'ENABLE_ALIPAY' } : {}),
        })
      }
      const next = await request<AlipayView>(base)
      if (!mounted.current) return
      setView(next); replaceDraft(next); setLoadError(''); setCheckedAt(Date.now())
      setMessage(action === 'save' ? '支付宝配置已保存，收款仍关闭。确认检查结果后可单独启用。'
        : action === 'disable' ? '支付宝收款已停用。已付款订单仍需继续处理和核对。'
        : '支付宝收款已启用。请在客户扫码购买入口核对已开放套餐与当前可用状态。')
    } catch (cause) {
      if (!mounted.current) return
      setError(errorText(cause)); setLoadError('本次操作结果尚未核对，请刷新状态。'); reportAuth(cause)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(null)
    }
  }

  return (
    <section className="payment-settings alipay-settings" aria-labelledby="alipay-settings-title">
      <div className="toolbar payment-heading">
        <h2 id="alipay-settings-title">支付宝收款配置</h2>
        <div className="actions">
          {view?.enabled && <Button variant="secondary" disabled={!!busy} onClick={() => void mutate('disable')}>{busy === 'disable' ? '正在停用…' : '停用支付宝收款'}</Button>}
          <Button variant="ghost" disabled={!!busy || loading} onClick={() => void refresh()}><ArrowClockwise size={16} />{loading ? '刷新中…' : '刷新状态'}</Button>
        </div>
      </div>
      <p className="note">客户使用支付宝当面付购买 X 套餐，付款确认后由服务端自动创建赠送订单。</p>
      <a href="/buy" className="text-link alipay-shop-link">打开客户扫码购买入口 <ArrowSquareOut size={15} /></a>
      {loadError && <p className="notice error" role="alert">收款状态未确认：{loadError}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {message && <p className="notice" role="status">{message}</p>}
      {!view || !draft ? <div className="payment-loading" role="status">{loading ? '正在读取支付宝收款配置…' : '未能取得配置，请刷新状态重试。'}</div> : <>
        <div className="payment-status" aria-live="polite">
          <span className={`status ${view.enabled ? 'status-ACTIVE' : ''}`}>{view.enabled ? '支付宝收款已启用' : '支付宝收款已关闭'}</span>
          <span>{view.environment === 'production' ? '正式环境' : '沙盒环境'}</span>
          <span>{view.ready ? '启用条件已就绪' : '启用条件未就绪'}</span>
          <span>未结收款单 {view.unsettled_count} 笔</span>
        </div>
        <ul className="payment-checks" aria-label="支付宝收款条件检查">
          {view.checks.map((check) => <li key={check.code}><span className={`status ${check.ok ? 'status-ACTIVE' : 'status-unknown'}`}>{check.ok ? '已通过' : '待处理'}</span><span>{check.label}</span></li>)}
        </ul>
        {checkedAt && <p className="note payment-meta">状态更新于 {new Date(checkedAt).toLocaleString('zh-CN', { hour12: false })} · 页面可见时每 30 秒刷新</p>}
        {conflict && <div className="notice error" role="alert">支付宝配置已变化。载入最新配置将替换当前输入并清空未保存的密钥。
          <Button variant="secondary" disabled={!!busy || loading} onClick={() => void refresh(true)}>载入最新配置</Button>
        </div>}
        {view.enabled && <p className="note">收款启用期间不能修改配置，请先停用。</p>}
        {view.unsettled_count > 0 && <p className="notice">存在未结收款单，暂不能更改商户、密钥或套餐报价。请先核对原单处理结果。</p>}
        <form className="alipay-form" onSubmit={(event) => { event.preventDefault(); void mutate('save') }}>
          <div className="alipay-identity-fields">
            <label className="form-field" htmlFor="alipay-environment">支付宝环境
              <select id="alipay-environment" value={draft.environment} disabled={locked} onChange={(event) => setDraft({ ...draft, environment: event.target.value as ConfigDraft['environment'] })}>
                <option value="production">正式环境</option><option value="sandbox">沙盒环境</option>
              </select>
            </label>
            <Input label="应用 App ID（16 位）" value={draft.app_id} disabled={locked} autoComplete="off" inputMode="numeric" pattern="[0-9]{16}" maxLength={16} onChange={(event) => setDraft({ ...draft, app_id: event.target.value })} required />
            <Input label="收款商户 PID（16 位）" value={draft.seller_id} disabled={locked} autoComplete="off" inputMode="numeric" pattern="[0-9]{16}" maxLength={16} onChange={(event) => setDraft({ ...draft, seller_id: event.target.value })} required />
          </div>
          <div className="alipay-key-fields">
            <label className="form-field" htmlFor="alipay-private-key">应用私钥（RSA2）
              <textarea id="alipay-private-key" value={privateKey} disabled={locked} rows={5} autoComplete="off" spellCheck={false}
                onChange={(event) => setPrivateKey(event.target.value)} placeholder={!requiresNewKeys && view.has_app_private_key ? '已保存；留空保留原私钥' : '粘贴当前应用的私钥'} />
              <small>{view.has_app_private_key ? '已有私钥，内容不会回显。' : '尚未配置应用私钥。'}</small>
            </label>
            <label className="form-field" htmlFor="alipay-public-key">支付宝公钥（RSA2）
              <textarea id="alipay-public-key" value={publicKey} disabled={locked} rows={5} autoComplete="off" spellCheck={false}
                onChange={(event) => setPublicKey(event.target.value)} placeholder={!requiresNewKeys && view.has_alipay_public_key ? '已保存；留空保留原公钥' : '粘贴当前环境的支付宝公钥'} />
              <small>{!requiresNewKeys && view.has_alipay_public_key ? '已有支付宝公钥，留空保留。' : '请使用支付宝公钥，不是应用公钥。'}</small>
            </label>
          </div>
          {view.configured && requiresNewKeys && <p className="notice">应用 App ID 或环境已更改，需要重新填写应用私钥与支付宝公钥。</p>}
          <p className="note">使用 RSA2 普通公钥模式，不支持证书模式。密钥仅在本次表单中输入，保存后清空。</p>
          <div className="alipay-notify"><span>支付异步通知地址</span><code>{view.notify_url || '尚未生成，请检查服务公开地址配置。'}</code></div>
          <fieldset className="alipay-prices">
            <legend>客户购买价格（人民币）</legend>
            <p className="note">每个套餐单独设置报价。未填写报价或未开放的套餐不会向客户销售。</p>
            {draft.prices.map((price, index) => <div className="alipay-price-row" key={price.product_code}>
              <div className="stack"><strong>{price.name}</strong><small>{price.months} 个月</small></div>
              <Input label="价格（CNY）" value={price.amount_cny} disabled={locked} inputMode="decimal" autoComplete="off" placeholder="0.00"
                onChange={(event) => setDraft({ ...draft, prices: draft.prices.map((item, i) => i === index ? { ...item, amount_cny: event.target.value } : item) })}
                aria-invalid={!!price.amount_cny.trim() && !validPrice(price.amount_cny.trim(), !price.enabled)} />
              <label className="alipay-price-enabled"><input type="checkbox" checked={price.enabled} disabled={locked}
                onChange={(event) => setDraft({ ...draft, prices: draft.prices.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item) })} />开放销售</label>
            </div>)}
            {!draft.prices.length && <p className="note">暂无可配置套餐，请先检查商品配置。</p>}
            {invalidPrice && <p className="notice error" role="alert">开放销售的报价须为 0.01–10,000.00 元，最多两位小数。未开放套餐可留空或设为 0。</p>}
          </fieldset>
          <div className="payment-save-row">
            <Button type="submit" variant="primary" disabled={!canSave}>{busy === 'save' ? '正在保存…' : '保存收款配置'}</Button>
            <span className="payment-draft-state" role="status">{dirty ? '有未保存的更改，保存后才能启用。' : view.configured ? '配置已保存，保存与启用分别操作。' : '尚未保存支付宝收款配置。'}</span>
          </div>
        </form>
        {!view.enabled && <div className="payment-enable-row">
          <div><strong>启用支付宝收款</strong><p className="note">保存报价并通过检查后，才可开放客户扫码购买。</p></div>
          <Button variant="secondary" disabled={!canEnable} onClick={() => { setConfirmOpen(true); setConfirmation('') }}>启用支付宝收款…</Button>
        </div>}
      </>}
      <Dialog.Root open={confirmOpen} onOpenChange={(open) => { if (!busy) setConfirmOpen(open) }}>
        <Dialog size="lg" className="x-modal"><form onSubmit={(event) => { event.preventDefault(); void mutate('enable') }}>
          <Dialog.Title className="modal-title">确认启用支付宝收款</Dialog.Title>
          <Dialog.Description className="modal-description">将按已保存的人民币报价开放扫码购买。服务端确认客户付款后，会自动创建对应的 X 赠送订单。</Dialog.Description>
          <Input label="输入 ENABLE_ALIPAY 确认" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} disabled={!!busy} />
          {!busy && !loading && !canEnable && <p className="notice error" role="alert">当前条件不允许启用，请关闭窗口并查看检查结果。</p>}
          {error && <p className="notice error" role="alert">{error}</p>}
          <div className="modal-footer"><Button type="button" variant="secondary" disabled={!!busy} onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button type="submit" variant="primary" disabled={!canEnable || confirmation !== 'ENABLE_ALIPAY'}>{busy === 'enable' ? '正在启用…' : '确认启用收款'}</Button></div>
        </form></Dialog>
      </Dialog.Root>
      {view && <AlipayOrders request={request} onError={onError} />}
    </section>
  )
}

type AlipayOrder = {
  id: string
  out_trade_no: string
  trade_no: string | null
  product_name: string
  months: number
  recipient: string
  amount_cny: string
  status: string
  paid_at: number | null
  order_id: string | null
  failure_code: string | null
  created_at: number
  updated_at: number
}
const orderTime = (value: number | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

export function AlipayOrders({ request, onError }: { request: Request; onError: (error: unknown) => void }) {
  const [page, setPage] = useState(1), [rows, setRows] = useState<AlipayOrder[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const sequence = useRef(0), mounted = useRef(false), onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const load = useCallback(async () => {
    const current = ++sequence.current
    setLoading(true)
    try {
      const result = await request<AlipayOrder[] | { rows: AlipayOrder[] }>(base + '/orders?page=' + page)
      if (!mounted.current || current !== sequence.current) return
      setRows(Array.isArray(result) ? result : result.rows)
      setError(''); setUpdatedAt(Date.now())
    } catch (cause) {
      if (!mounted.current || current !== sequence.current) return
      setError(errorText(cause))
      if (typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 401) onErrorRef.current(cause)
    } finally {
      if (mounted.current && current === sequence.current) setLoading(false)
    }
  }, [request, page])
  useEffect(() => {
    mounted.current = true; setRows([]); setUpdatedAt(null)
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 30000)
    return () => { mounted.current = false; sequence.current++; window.clearInterval(timer) }
  }, [load])
  return <div className="alipay-orders">
    <div className="toolbar">
      <h2>历史收款记录</h2>
      <Button variant="ghost" disabled={loading} onClick={() => void load()}><ArrowClockwise size={16} />{loading ? '刷新中…' : '刷新收款订单'}</Button>
    </div>
    <p className="note">收款与 X 赠送结果分别保留。关联赠送单的最终结果，请切回“赠送订单与队列”查看；这里不会创建新收款。</p>
    {error && <p role="alert" className="notice error">收款订单未能刷新：{error} 请重试刷新。</p>}
    <div className="table-scroll" aria-busy={loading}>
      <Table>
        <Table.Header><Table.Row>{['收款单 / 接收账号', '套餐 / 金额', '收款状态', '关联赠送单', '创建 / 更新'].map((title) => <Table.Head key={title}>{title}</Table.Head>)}</Table.Row></Table.Header>
        <Table.Body>
          {rows.map((row) => <Table.Row key={row.id}>
            <Table.Cell><span className="stack"><code>{row.out_trade_no || row.id}</code><span>@{row.recipient.replace(/^@/, '')}</span>{row.trade_no && <small>支付宝交易号：{row.trade_no}</small>}</span></Table.Cell>
            <Table.Cell><span className="stack"><span>{row.product_name} · {row.months} 个月</span><strong>¥{row.amount_cny}</strong></span></Table.Cell>
            <Table.Cell><span className="stack">
              <span className={`status ${['closed', 'failed'].includes(row.status) ? '' : row.status === 'attention' || row.failure_code ? 'status-unknown' : row.paid_at ? 'status-ACTIVE' : ''}`}>
                {legacyPaymentStatus(row.status, row.paid_at, row.failure_code)}
              </span>
              {row.paid_at && <small>付款于 {orderTime(row.paid_at)}</small>}
              {row.failure_code && <small>{row.failure_code}</small>}
            </span></Table.Cell>
            <Table.Cell>{row.order_id ? <code>{row.order_id}</code> : row.paid_at ? '已付款，尚未关联赠送单' : ['closed', 'failed'].includes(row.status) ? '未创建赠送单' : '等待原单付款结果'}</Table.Cell>
            <Table.Cell><span className="stack"><span>{orderTime(row.created_at)}</span><small>{orderTime(row.updated_at)}</small></span></Table.Cell>
          </Table.Row>)}
          {!rows.length && <Table.Row><Table.Cell colSpan={5}><div className="empty" role="status">{loading ? '正在读取历史收款…' : error ? '尚未取得订单记录，请刷新重试。' : '本页没有历史收款记录。新订单请使用卡密兑换。'}</div></Table.Cell></Table.Row>}
        </Table.Body>
      </Table>
    </div>
    <div className="pager">
      <span>第 {page} 页 · 每页最多 30 条{updatedAt && <> · 更新于 {orderTime(updatedAt)}</>}</span>
      <Button variant="ghost" aria-label="上一页收款订单" disabled={loading || page === 1} onClick={() => setPage(page - 1)}><ArrowLeft size={16} /></Button>
      <Button variant="ghost" aria-label="下一页收款订单" disabled={loading || !!error || rows.length < 30} onClick={() => setPage(page + 1)}><ArrowRight size={16} /></Button>
    </div>
  </div>
}
