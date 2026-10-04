import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { ArrowClockwise, ArrowLeft, ArrowRight } from '@phosphor-icons/react'
import type { Request } from './Recharge'

type PaymentCard = {
  id: string
  last_four: string | null
  network: string | null
  status: string
  available_amount: number | string | null
  product_code?: string | null
}
type PaymentView = {
  configured: boolean
  revision: string | null
  enabled: boolean
  source: 'database' | 'environment'
  native_available: boolean
  stripe_publishable_key: string
  selected_card: PaymentCard | null
  card_checked_at: number | null
  provider_revision: string | null
  selected_provider_revision: string | null
  checks: { code: string; label: string; ok: boolean }[]
  ready_to_enable: boolean
  execution_ready: boolean
  accepts_orders: boolean
  has_unsettled_orders: boolean
}
type PaymentCardResponse = Omit<PaymentCard, 'id'> & { id: string | number }
type PaymentViewResponse = Omit<PaymentView, 'selected_card'> & { selected_card: PaymentCardResponse | null }
const normalizeCard = (card: PaymentCardResponse): PaymentCard => ({ ...card, id: String(card.id) })
const normalizeView = (view: PaymentViewResponse): PaymentView => ({
  ...view, selected_card: view.selected_card ? normalizeCard(view.selected_card) : null,
})
type Draft = {
  key: string
  cardId: string
  originalKey: string
  originalCardId: string
  revision: string | null
  providerRevision: string | null
}
const base = '/api/admin/payments'
const cardStatus: Record<string, string> = {
  ACTIVE: '可用', FROZEN: '冻结', DELETED: '已删除', CANCELLED: '已取消',
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '请求未确认，请刷新状态后重试。'
const amount = (value: PaymentCard['available_amount']) => {
  const parsed = value === null || value === '' ? NaN : Number(value)
  return Number.isFinite(parsed) ? parsed.toFixed(2) + ' USD' : '余额未知'
}
const cardLabel = (card: PaymentCard) =>
  `ID …${card.id.slice(-4)} · ${card.network || '未知品牌'} 尾号 ${card.last_four || '未知'} · ${cardStatus[card.status] || card.status} · ${amount(card.available_amount)}`
const draftFrom = (view: PaymentView): Draft => ({
  key: view.stripe_publishable_key || '', cardId: view.selected_card?.id || '',
  originalKey: view.stripe_publishable_key || '', originalCardId: view.selected_card?.id || '',
  revision: view.revision, providerRevision: view.provider_revision,
})
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export function PaymentSettings({ request, onError }: { request: Request; onError: (error: unknown) => void }) {
  const [view, setView] = useState<PaymentView | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [retainedCard, setRetainedCard] = useState<PaymentCard | null>(null)
  const [cards, setCards] = useState<PaymentCard[]>([])
  const [page, setPage] = useState(1), [total, setTotal] = useState(0)
  const [statusLoading, setStatusLoading] = useState(true), [cardsLoading, setCardsLoading] = useState(false)
  const [statusError, setStatusError] = useState(''), [cardsError, setCardsError] = useState('')
  const [actionError, setActionError] = useState(''), [message, setMessage] = useState('')
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState<'save' | 'enable' | 'disable' | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false), [confirmation, setConfirmation] = useState('')
  const statusSequence = useRef(0), cardsSequence = useRef(0)
  const mounted = useRef(false), busyRef = useRef(false), onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const reportAuth = useCallback((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 401)
      onErrorRef.current(error)
  }, [])
  const refreshStatus = useCallback(async (replaceDraft = false) => {
    if (busyRef.current) return
    const sequence = ++statusSequence.current
    setStatusLoading(true)
    try {
      const next = normalizeView(await request<PaymentViewResponse>(base))
      if (!mounted.current || sequence !== statusSequence.current) return
      setView(next)
      setDraft((current) => !current || replaceDraft ? draftFrom(next) : current)
      if (replaceDraft) {
        setRetainedCard(next.selected_card); setActionError(''); setMessage('已载入最新配置。')
        setConfirmation(''); setConfirmOpen(false)
      }
      setStatusError(''); setCheckedAt(Date.now())
    } catch (error) {
      if (!mounted.current || sequence !== statusSequence.current) return
      setStatusError(errorText(error)); reportAuth(error)
    } finally {
      if (mounted.current && sequence === statusSequence.current) setStatusLoading(false)
    }
  }, [request, reportAuth])
  useEffect(() => {
    mounted.current = true
    void refreshStatus()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshStatus()
    }, 30000)
    return () => {
      mounted.current = false; statusSequence.current++; cardsSequence.current++
      window.clearInterval(timer)
    }
  }, [refreshStatus])

  const providerRevision = view?.provider_revision ?? null
  const refreshCards = useCallback(async () => {
    if (!providerRevision) return
    const sequence = ++cardsSequence.current
    setCardsLoading(true); setCardsError('')
    try {
      const result = await request<{ total: number; list: PaymentCardResponse[] }>(
        '/api/admin/card-provider/cards?page=' + page,
      )
      if (!mounted.current || sequence !== cardsSequence.current) return
      setCards(result.list.map(normalizeCard)); setTotal(result.total)
    } catch (error) {
      if (!mounted.current || sequence !== cardsSequence.current) return
      setCardsError(errorText(error)); setCards([]); reportAuth(error)
    } finally {
      if (mounted.current && sequence === cardsSequence.current) setCardsLoading(false)
    }
  }, [request, page, providerRevision, reportAuth])
  useEffect(() => {
    setCards([]); setTotal(0); setCardsLoading(false); setCardsError('')
    void refreshCards()
    return () => { cardsSequence.current++ }
  }, [refreshCards])

  const dirty = !!draft && (draft.key.trim() !== draft.originalKey || draft.cardId !== draft.originalCardId)
  const conflict = !!view && !!draft && (view.revision !== draft.revision || view.provider_revision !== draft.providerRevision)
  const cardBindingChanged = !!view?.selected_card && view.selected_provider_revision !== view.provider_revision
  const selected = cards.find((card) => card.id === draft?.cardId)
    ?? (retainedCard?.id === draft?.cardId ? retainedCard : null)
    ?? (view?.selected_card && view.selected_card.id === draft?.cardId ? view.selected_card : null)
  const options = selected && !cards.some((card) => card.id === selected.id) ? [selected, ...cards] : cards
  const locked = !!busy || !!view?.enabled || !!view?.has_unsettled_orders || conflict || !!statusError
  const canSave = !!view && !!draft && !locked && !statusLoading && !cardsLoading && !cardsError
    && !!providerRevision && !!draft.key.trim() && selected?.status === 'ACTIVE'
    && (dirty || !view.configured || view.source === 'environment' || cardBindingChanged)
  const canEnable = !!view?.configured && view.ready_to_enable && !view.enabled
    && !dirty && !conflict && !statusError && !statusLoading && !busy

  async function mutate(kind: 'save' | 'enable' | 'disable') {
    if (!view || !draft || busyRef.current) return
    if (kind === 'save' && !canSave) return
    if (kind === 'enable' && (!canEnable || confirmation !== 'ENABLE_PAYMENTS')) return
    busyRef.current = true; statusSequence.current++
    setStatusLoading(false); setBusy(kind); setActionError(''); setMessage('')
    try {
      let next: PaymentView
      if (kind === 'save') {
        next = normalizeView(await request<PaymentViewResponse>(base + '/config', {
          revision: draft.revision, provider_revision: draft.providerRevision,
          stripe_publishable_key: draft.key.trim(), card_id: draft.cardId,
        }))
      } else {
        await request(base + '/enabled', {
          enabled: kind === 'enable', revision: view.revision,
          ...(kind === 'enable' ? { confirmation: 'ENABLE_PAYMENTS' } : {}),
        })
        next = normalizeView(await request<PaymentViewResponse>(base))
      }
      if (!mounted.current) return
      setView(next); setDraft(draftFrom(next)); setRetainedCard(next.selected_card)
      setStatusError(''); setCheckedAt(Date.now()); setConfirmOpen(false); setConfirmation('')
      setMessage(kind === 'save' ? '配置已保存，X 付款仍关闭。检查通过后可单独启用。'
        : kind === 'disable' ? 'X 付款已停用。请继续核对未结订单的处理结果。'
        : next.accepts_orders ? 'X 付款已启用，当前允许在每日接单额度内接单。' : 'X 付款已启用；新单还须通过上方每日接单设置与未结订单检查。')
    } catch (error) {
      if (!mounted.current) return
      setActionError(errorText(error) + ' 请刷新状态后核对结果。')
      setStatusError('本次操作结果尚未核对。'); reportAuth(error)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(null)
    }
  }

  return (
    <section className="payment-settings" aria-labelledby="payment-settings-title">
      <div className="toolbar payment-heading">
        <h2 id="payment-settings-title">X 付款配置</h2>
        <div className="actions">
          {view?.enabled && <Button variant="secondary" disabled={!!busy} onClick={() => void mutate('disable')}>
            {busy === 'disable' ? '正在停用…' : '停用 X 付款'}
          </Button>}
          <Button variant="ghost" disabled={!!busy || statusLoading} onClick={() => void refreshStatus()}>
            <ArrowClockwise size={16} />{statusLoading ? '刷新中…' : '刷新状态'}
          </Button>
        </div>
      </div>
      <p className="note payment-intro">后台 / 卡台与卡池。指定已有卡支付 X 赠送订单；客户的支付宝收款另行配置。</p>
      {statusError && <p role="alert" className="notice error">状态未确认：{statusError} 请刷新状态。</p>}
      {actionError && <p role="alert" className="notice error">{actionError}</p>}
      {message && <p role="status" className="notice">{message}</p>}
      {!view || !draft ? <div className="payment-loading" role="status">
        {statusLoading ? '正在读取 X 付款配置与检查结果…' : '尚未取得配置，请点击刷新状态重试。'}
      </div> : <>
        <div className="payment-status" aria-live="polite">
          <span className={`status ${view.enabled ? 'status-ACTIVE' : ''}`}>{view.enabled ? 'X 付款已启用' : 'X 付款已关闭'}</span>
          <span>{view.accepts_orders ? '当前可接单' : '当前不接新单'}</span>
          <span>{view.execution_ready ? '执行条件已就绪' : '执行条件未就绪'}</span>
          <span>接单上限在上方“每日接单设置”中调整</span>
        </div>
        <ul className="payment-checks" aria-label="X 付款条件检查">
          {view.checks.map((check) => <li key={check.code}>
            <span className={`status ${check.ok ? 'status-ACTIVE' : 'status-unknown'}`}>{check.ok ? '已通过' : '待处理'}</span>
            <span>{check.label}</span>
          </li>)}
        </ul>
        <p className="note payment-meta">
          {checkedAt && <>状态更新于 {time(checkedAt)} · 页面可见时每 30 秒刷新</>}
          {view.card_checked_at && <>；所选卡检查于 {time(view.card_checked_at)}</>}
        </p>
        {conflict && <div className="notice error" role="alert">
          支付配置或卡台连接已发生变化。载入最新配置后重新选择卡并核对；这会替换当前未保存的输入。
          <Button variant="secondary" disabled={!!busy || statusLoading} onClick={() => void refreshStatus(true)}>载入最新配置</Button>
        </div>}
        {view.enabled && <p className="note">X 付款启用期间不能修改公钥或指定卡，请先停用。</p>}
        {view.has_unsettled_orders && <p className="notice">有未结订单，暂不能修改付款配置。请先在充值订单中核对原单；符合检查条件时仍可恢复付款以处理原单。</p>}
        {!providerRevision && <p className="notice">尚未接入卡台。请先在下方“卡台连接”中完成接入，再刷新状态并选择已有卡。</p>}
        {providerRevision && cardBindingChanged && !conflict && <p className="notice">卡台连接已更新。请核对指定卡并重新保存，以便验证这张卡属于当前卡台。</p>}
        {view.source === 'environment' && <p className="note">当前读取环境配置。保存后将使用后台配置，付款保持关闭。</p>}
        <form className="payment-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void mutate('save') }}>
          <Input label="Stripe 发布公钥" name="stripe_publishable_key" value={draft.key}
            onChange={(event) => { setDraft({ ...draft, key: event.target.value }); setMessage('') }}
            disabled={locked} autoComplete="off" spellCheck={false} placeholder="pk_live_…" required />
          <div className="payment-card-field">
            <label className="form-field" htmlFor="payment-card-select">指定付款卡
              <select id="payment-card-select" value={draft.cardId}
                disabled={locked || !providerRevision || cardsLoading || !!cardsError}
                onChange={(event) => {
                  setDraft({ ...draft, cardId: event.target.value })
                  setRetainedCard(options.find((card) => card.id === event.target.value) ?? null); setMessage('')
                }} required>
                <option value="">{cardsLoading ? '正在读取已有卡…' : '选择卡台中的已有卡'}</option>
                {options.map((card) => <option key={card.id} value={card.id} disabled={card.status !== 'ACTIVE'}>{cardLabel(card)}</option>)}
              </select>
            </label>
            <div className="pager payment-card-pager">
              <span>第 {page} 页 · 共 {total} 张 · 每页 30 张</span>
              <Button type="button" variant="ghost" aria-label="刷新付款卡列表" disabled={!!busy || !providerRevision || cardsLoading} onClick={() => void refreshCards()}><ArrowClockwise size={16} /></Button>
              <Button type="button" variant="ghost" aria-label="上一页付款卡" disabled={!!busy || cardsLoading || page === 1} onClick={() => setPage(page - 1)}><ArrowLeft size={16} /></Button>
              <Button type="button" variant="ghost" aria-label="下一页付款卡" disabled={!!busy || cardsLoading || page * 30 >= total} onClick={() => setPage(page + 1)}><ArrowRight size={16} /></Button>
            </div>
            {cardsError && <p role="alert" className="notice error">卡列表读取失败：{cardsError} 请刷新付款卡列表。</p>}
            {providerRevision && !cardsLoading && !cardsError && cards.length === 0 && <p className="note">
              {page === 1 ? '卡台中暂无已有卡。请先准备可用卡，再刷新列表。' : '本页暂无卡，请返回上一页或刷新列表。'}
            </p>}
            {cards.length > 0 && !cards.some((card) => card.status === 'ACTIVE') && <p className="note">本页没有 ACTIVE 可用卡，请换页查看或在卡台处理卡状态。</p>}
          </div>
          <p className="note payment-policy">只可选择 ACTIVE 卡，余额至少 10 USD 为保守门槛。保存时只读查卡并再次校验，不会扣款；不会自动开卡、充值或换卡。遇到 3DS 验证需人工处理。</p>
          <div className="payment-save-row">
            <Button type="submit" variant="primary" disabled={!canSave}>{busy === 'save' ? '正在保存…' : '保存付款配置'}</Button>
            <span className="payment-draft-state" role="status">{dirty ? '有未保存的更改，保存后才能启用。' : view.configured ? '当前配置已保存。保存与启用分别操作。' : '尚未保存付款配置。'}</span>
          </div>
        </form>
        {!view.enabled && <div className="payment-enable-row">
          <div><strong>启用 X 付款</strong><p className="note">检查通过且配置已保存后，可确认启用。启用后订单可能产生真实扣款。</p></div>
          <Button variant="secondary" disabled={!canEnable} onClick={() => { setConfirmOpen(true); setConfirmation('') }}>启用 X 付款…</Button>
        </div>}
      </>}
      <Dialog.Root open={confirmOpen} onOpenChange={(open) => { if (!busy) setConfirmOpen(open) }}>
        <Dialog size="lg" className="x-modal">
          <form onSubmit={(event) => { event.preventDefault(); void mutate('enable') }}>
            <Dialog.Title className="modal-title">确认启用 X 付款</Dialog.Title>
            <Dialog.Description className="modal-description">将使用已保存的指定卡支付 X 赠送订单，可能产生真实扣款。新增接单还受后台每日额度与接单开关控制；遇到 3DS 验证需人工处理。</Dialog.Description>
            {view?.selected_card && <p className="note">{cardLabel(view.selected_card)}</p>}
            <Input label="输入 ENABLE_PAYMENTS 确认" value={confirmation} autoComplete="off" spellCheck={false} disabled={!!busy} onChange={(event) => setConfirmation(event.target.value)} />
            {!busy && !statusLoading && !canEnable && <p className="notice error" role="alert">当前条件不允许启用，请关闭此窗口并查看最新检查结果。</p>}
            {actionError && <p role="alert" className="notice error">{actionError}</p>}
            <div className="modal-footer">
              <Button type="button" variant="secondary" disabled={!!busy} onClick={() => setConfirmOpen(false)}>取消</Button>
              <Button type="submit" variant="primary" disabled={!canEnable || confirmation !== 'ENABLE_PAYMENTS'}>{busy === 'enable' ? '正在启用…' : '确认启用付款'}</Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
    </section>
  )
}
