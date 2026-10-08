import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { DirectRecharge, type Request } from './Recharge'
import { adminGiftRequest } from './admin-gift-flow'

type Merchant = { id: string; name: string; enabled: number; available: number; frozen: number }
const selectionKey = 'xgift.admin-gift.merchant'
function savedMerchant() { try { return sessionStorage.getItem(selectionKey) || '' } catch { return '' } }

export function AdminDirectGift({ request, onCreated }: { request: Request; onCreated: () => void }) {
  const [merchantId, setMerchantId] = useState(savedMerchant)
  const [merchants, setMerchants] = useState<Merchant[]>([]), [page, setPage] = useState(1)
  const [search, setSearch] = useState(''), [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [locked, setLocked] = useState(false)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    request<Merchant[]>(`/api/admin/users?page=${page}&q=${encodeURIComponent(query)}`)
      .then(rows => { if (live) setMerchants(rows) })
      .catch(cause => { if (live) { setMerchants([]); setError(cause instanceof Error ? cause.message : '商户列表读取失败，请重试。') } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [request, page, query, version])
  const scopedRequest = useMemo(() => adminGiftRequest(request, merchantId), [request, merchantId])
  const created = useCallback(() => { setVersion(value => value + 1); onCreated() }, [onCreated])
  const selected = merchants.find(row => row.id === merchantId)
  return <div className="admin-direct-gift">
    <p className="note">先选择本次扣点商户。订单和点数流水归属该商户，可在下方队列继续核对。</p>
    <form className="recharge-actions" onSubmit={event => { event.preventDefault(); if (!locked) { setQuery(search.trim()); setPage(1); setVersion(value => value + 1) } }}>
      <Input label="查找扣点商户" value={search} maxLength={80} disabled={locked} onChange={event => setSearch(event.target.value)} placeholder="商户名称或 ID" />
      <Button type="submit" variant="secondary" disabled={locked || loading}>查询商户</Button>
    </form>
    <label className="form-field">扣点商户
      <select value={merchantId} disabled={locked || loading} onChange={event => {
        setMerchantId(event.target.value)
        try { sessionStorage.setItem(selectionKey, event.target.value) } catch { /* No credentials are stored. */ }
      }}>
        <option value="">请选择扣点商户</option>
        {merchantId && !selected && <option value={merchantId}>已选择商户 {merchantId}（可继续查询原单）</option>}
        {merchants.map(row => <option key={row.id} value={row.id} disabled={!row.enabled}>{row.name} · 可用 {row.available} 点{row.enabled ? '' : ' · 已停用'}</option>)}
      </select>
    </label>
    {selected && <p className="note">{selected.name}：可用 {selected.available} 点，冻结 {selected.frozen} 点。</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="recharge-actions"><span className="note">商户列表第 {page} 页{loading ? ' · 读取中…' : ''}</span><Button variant="ghost" disabled={locked || loading || page === 1} onClick={() => setPage(value => value - 1)}>上一页</Button><Button variant="ghost" disabled={locked || loading || !!error || merchants.length < 30} onClick={() => setPage(value => value + 1)}>下一页</Button></div>
    {merchantId && <DirectRecharge key={merchantId} request={scopedRequest} cardRequest={request} userId={merchantId} adminGift onCreated={created} onLocked={setLocked} />}
  </div>
}
