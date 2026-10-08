import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import type { Request } from './Recharge'

export type OrderCardChoice = { card_id: number; payment_revision: string; provider_revision: string; label: string }
type Card = { id: number | string; last_four?: string; network?: string; status: string; available_amount?: number | string }
type Settings = { revision: string | null; provider_revision: string | null; selected_provider_revision: string | null; selected_card: Card | null }
type Inventory = { list: Card[]; total: number; provider_revision: string }
const label = (card: Card) => `ID ${card.id} · ${card.network || '银行卡'} 尾号 ${card.last_four || '未知'} · ${card.available_amount ?? '未知'} USD`

export function OrderCardPicker({ request, value, disabled, onChange }: {
  request: Request; value: OrderCardChoice | null; disabled: boolean; onChange: (value: OrderCardChoice | null) => void
}) {
  const [settings, setSettings] = useState<Settings | null>(null), [cards, setCards] = useState<Card[]>([])
  const [page, setPage] = useState(1), [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [checkedAt, setCheckedAt] = useState<number | null>(null)
  const mounted = useRef(false), sequence = useRef(0), lock = useRef(false), disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const load = useCallback(async (force = false) => {
    if (lock.current || disabledRef.current) return
    lock.current = true; const current = ++sequence.current
    setLoading(true)
    try {
      const config = await request<Settings>('/api/admin/payments')
      if (!config.revision || !config.provider_revision || config.selected_provider_revision !== config.provider_revision)
        throw new Error('请先在 X 付款设置中确认卡台与主卡配置。')
      const inventory = await request<Inventory>('/api/admin/card-provider/cards' + (force ? '/sync' : '') + '?page=' + page,
        force ? { provider_revision: config.provider_revision } : undefined)
      if (!mounted.current || current !== sequence.current || disabledRef.current) return
      if (inventory.provider_revision !== config.provider_revision) throw new Error('卡台配置已变化，请重新同步后选择。')
      setSettings(config); setCards(inventory.list); setTotal(inventory.total); setCheckedAt(Date.now()); setError('')
    } catch (cause) { if (mounted.current && current === sequence.current) setError(cause instanceof Error ? cause.message : '卡列表读取失败，请重试。') }
    finally { if (mounted.current && current === sequence.current) { lock.current = false; setLoading(false) } }
  }, [request, page])
  useEffect(() => {
    mounted.current = true; sequence.current++; lock.current = false
    setCards([]); setCheckedAt(null); setError(''); setLoading(false)
    void load()
    return () => { mounted.current = false; sequence.current++; lock.current = false }
  }, [load])
  const conflict = !!value && !!settings && (value.payment_revision !== settings.revision || value.provider_revision !== settings.provider_revision)
  return <div className="order-card-picker">
    <label className="form-field">本单付款卡
      <select value={value ? String(value.card_id) : ''} disabled={disabled || loading || !settings} onChange={event => {
        if (!event.target.value) { onChange(null); return }
        const card = cards.find(row => String(row.id) === event.target.value)
        if (card && settings?.revision && settings.provider_revision) onChange({ card_id: Number(card.id), payment_revision: settings.revision, provider_revision: settings.provider_revision, label: label(card) })
      }}>
        <option value="">使用系统主卡{settings?.selected_card ? ' · ' + label(settings.selected_card) : ''}</option>
        {value && !cards.some(card => Number(card.id) === value.card_id) && <option value={value.card_id}>{value.label} · 已选择</option>}
        {cards.map(card => <option key={card.id} value={String(card.id)} disabled={card.status !== 'ACTIVE' || !Number.isFinite(Number(card.available_amount)) || Number(card.available_amount) < 10}>{label(card)}{card.status !== 'ACTIVE' ? ' · 不可用' : ''}</option>)}
      </select>
    </label>
    <p className="note">只影响本单，不改系统主卡。指定本单卡时仅用这张卡，不自动使用系统备用卡；使用系统主卡时沿用已有备用卡规则。卡台列表为缓存，提交与付款前会再核验。</p>
    <div className="recharge-actions"><Button type="button" variant="secondary" disabled={disabled || loading} onClick={() => void load(true)}>{loading ? '读取中…' : '同步卡台'}</Button><Button type="button" variant="ghost" disabled={disabled || loading || page === 1} onClick={() => setPage(value => value - 1)}>上一页卡片</Button><Button type="button" variant="ghost" disabled={disabled || loading || !!error || page * 30 >= total} onClick={() => setPage(value => value + 1)}>下一页卡片</Button><span className="note">第 {page} 页 · 共 {total} 张{checkedAt ? ' · 最近读取 ' + new Date(checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</span></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {conflict && <p className="notice error" role="alert">付款配置已变化，请重新选择本单卡后核验账号。</p>}
  </div>
}
