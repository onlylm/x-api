import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Table } from '@cloudflare/kumo/components/table'
import { ArrowClockwise, ArrowLeft, ArrowRight } from '@phosphor-icons/react'
import type { Request } from './Recharge'
import {
  normalizePlatformOrdersView, parsePlatformOrdersHash, platformFulfillmentOptions, platformGiftHref,
  platformMoney, platformOrderProduct, platformOrdersError, platformOrdersHash, platformOrdersPath,
  platformPaymentOptions, platformStatus, platformTime,
  type PlatformFulfillment, type PlatformOrdersResult, type PlatformOrdersView, type PlatformPayment,
} from './platform-orders-model'
import './platform-orders.css'

function PlatformStatus({ kind, value }: { kind: 'payment' | 'fulfillment'; value: string }) {
  const { label, tone } = platformStatus(kind, value)
  return <span className={`status po-status-${tone}`}>{label}</span>
}

export function PlatformOrders({ request, onError }: { request: Request; onError: (error: unknown) => void }) {
  const [view, setView] = useState(() => parsePlatformOrdersHash(window.location.hash))
  const [search, setSearch] = useState(view.query), [refresh, setRefresh] = useState(0)
  const [snapshot, setSnapshot] = useState<{ result: PlatformOrdersResult; path: string } | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const sequence = useRef(0), onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const path = platformOrdersPath(view)
  const current = snapshot?.path === path, result = snapshot?.result
  const filtered = !!view.query || view.payment !== 'all' || view.fulfillment !== 'all'

  useEffect(() => {
    const sync = () => {
      if (window.location.hash.split('?')[0] !== '#platform-orders') return
      const next = parsePlatformOrdersHash(window.location.hash)
      setView(next); setSearch(next.query)
    }
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  useEffect(() => {
    let active = true, inFlight = false
    const generation = ++sequence.current
    async function load() {
      if (inFlight) return
      inFlight = true; setLoading(true)
      try {
        const next = await request<PlatformOrdersResult>(path)
        if (!active || generation !== sequence.current) return
        if (!next || !Array.isArray(next.items) || next.page !== view.page || typeof next.has_next !== 'boolean') throw new Error('invalid_platform_orders')
        setSnapshot({ result: next, path }); setError('')
      } catch (failure) {
        if (!active || generation !== sequence.current) return
        const readable = platformOrdersError(failure)
        setError(readable.message)
        if (readable.status === 401) { setSnapshot(null); onErrorRef.current(failure) }
        if (readable.status === 403) setSnapshot(null)
      } finally {
        inFlight = false
        if (active && generation === sequence.current) setLoading(false)
      }
    }
    void load()
    const refreshVisible = () => { if (document.visibilityState === 'visible') void load() }
    const timer = window.setInterval(refreshVisible, 30000)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => { active = false; sequence.current++; window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible) }
  }, [request, path, view.page, refresh])

  function navigate(next: PlatformOrdersView) {
    const safe = normalizePlatformOrdersView(next)
    if (platformOrdersPath(safe) === path) setRefresh((value) => value + 1)
    setView(safe); setSearch(safe.query)
    const hash = platformOrdersHash(safe)
    if (window.location.hash !== hash) window.location.hash = hash
  }
  function submitSearch(event: FormEvent) { event.preventDefault(); navigate({ ...view, query: search, page: 1 }) }
  function reset() { navigate({ page: 1, query: '', payment: 'all', fulfillment: 'all' }) }

  return <section className="platform-orders" aria-label="平台付款与赠送订单">
    <div className="po-intro">
      <p>客户付款和 X 赠送分别记录。已付款不代表赠送完成；待核对的订单请查看原单，不要重复付款。</p>
      <Button variant="secondary" disabled={loading} onClick={() => setRefresh((value) => value + 1)}><ArrowClockwise size={16} />{loading ? '正在刷新…' : '刷新订单'}</Button>
    </div>
    <form className="po-controls" onSubmit={submitSearch}>
      <div className="po-search"><Input label="搜索平台单号、付款单号或 X 用户名" value={search} maxLength={100} autoComplete="off" spellCheck={false} onChange={(event) => setSearch(event.target.value)} /><Button type="submit" variant="secondary">搜索</Button></div>
      <div className="po-filters">
        <label>付款状态<select value={view.payment} onChange={(event) => navigate({ ...view, payment: event.target.value as PlatformPayment, page: 1 })}>{platformPaymentOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>赠送状态<select value={view.fulfillment} onChange={(event) => navigate({ ...view, fulfillment: event.target.value as PlatformFulfillment, page: 1 })}>{platformFulfillmentOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {filtered && <Button type="button" variant="ghost" onClick={reset}>清除筛选</Button>}
      </div>
    </form>
    {error && <p className="po-notice po-error" role="alert">{error}{result ? ' 下方保留上次查询结果，数据可能已过期。' : ''}</p>}
    {result && !current && <p className="po-notice" role="status">{loading ? '正在查询新的筛选条件。' : '尚未取得当前筛选结果。'}下方仍为上一次筛选结果，请勿作为当前结果使用。</p>}
    <div className="po-table-wrap" role="region" aria-label="平台订单列表，可横向滚动" tabIndex={0} aria-busy={loading}>
      <Table className={result?.items.length ? 'po-table' : 'po-table po-table-empty'} aria-label="平台订单">
        <Table.Header><Table.Row>
          <Table.Head>平台单号 / 付款单号</Table.Head><Table.Head>接收账号 / 套餐</Table.Head>
          <Table.Head>金额（人民币）</Table.Head><Table.Head>客户付款</Table.Head>
          <Table.Head>X 赠送</Table.Head><Table.Head>时间（北京）</Table.Head>
        </Table.Row></Table.Header>
        <Table.Body>
          {result?.items.length ? result.items.map((row) => {
            const giftHref = platformGiftHref(row.upstream_order_id)
            return <Table.Row key={row.order_id}>
              <Table.Cell><div className="po-stack po-identifiers"><span><small>平台单号</small><code>{row.client_order_id || '未提供'}</code></span><span><small>付款单号</small><code>{row.order_id}</code></span></div></Table.Cell>
              <Table.Cell><div className="po-stack"><strong>{row.recipient ? '@' + row.recipient.replace(/^@/, '') : '接收账号未提供'}</strong><span>{platformOrderProduct(row.product)}</span></div></Table.Cell>
              <Table.Cell><div className="po-stack"><strong className="po-amount">{platformMoney(row.amount)}</strong><small>供货价 {row.supply_price === null ? '未提供' : platformMoney(row.supply_price)}</small></div></Table.Cell>
              <Table.Cell><PlatformStatus kind="payment" value={row.payment_status} /></Table.Cell>
              <Table.Cell><div className="po-stack"><PlatformStatus kind="fulfillment" value={row.fulfillment_status} />{giftHref ? <a className="po-original" href={giftHref} aria-label={`查看 ${row.client_order_id || row.order_id} 的赠送原单`}>查看赠送原单 <ArrowRight size={14} aria-hidden="true" /></a> : <small>{row.upstream_order_id ? '原单编号待核对' : '未关联赠送原单'}</small>}{row.fulfillment_status === 'review' && <small>仅核对原单，请勿重复付款</small>}</div></Table.Cell>
              <Table.Cell><div className="po-stack po-times"><span><small>创建</small>{platformTime(row.created_at)}</span><span><small>更新</small>{platformTime(row.updated_at)}</span>{row.paid_at !== null && <span><small>付款</small>{platformTime(row.paid_at)}</span>}</div></Table.Cell>
            </Table.Row>
          }) : <Table.Row><Table.Cell colSpan={6}><div className="po-empty" role="status">
            {loading && !result ? <><strong>正在读取平台订单…</strong><span>只查询已有记录，不会触发付款或赠送。</span></>
              : error && !result ? <><strong>暂时无法显示平台订单</strong><span>请按上方提示处理后刷新。</span></>
              : <><strong>{filtered || view.page > 1 ? '没有匹配的订单' : '暂无平台订单'}</strong><span>{filtered || view.page > 1 ? '可清除筛选或返回第一页查看。' : '平台创建的付款订单会显示在这里，卡密兑换请到“订单与队列”查看。'}</span>{(filtered || view.page > 1) && <Button variant="secondary" onClick={reset}>查看全部订单</Button>}</>}
          </div></Table.Cell></Table.Row>}
        </Table.Body>
      </Table>
    </div>
    <div className="po-pager">
      <div><span>{result ? `第 ${result.page} 页 · 本页 ${result.items.length} 条` : `第 ${view.page} 页`}</span><small role="status">{result ? `${error || !current ? '上次查询' : '状态更新'}：${platformTime(result.updated_at)}（北京时间）` : '尚未取得订单状态'} · 页面可见时每 30 秒刷新</small></div>
      <Button variant="ghost" aria-label="平台订单上一页" disabled={loading || !current || view.page <= 1} onClick={() => navigate({ ...view, page: view.page - 1 })}><ArrowLeft size={16} /></Button>
      <Button variant="ghost" aria-label="平台订单下一页" disabled={loading || !current || !result?.has_next || view.page >= 100000} onClick={() => navigate({ ...view, page: view.page + 1 })}><ArrowRight size={16} /></Button>
    </div>
  </section>
}
