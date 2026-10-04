import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { ArrowClockwise } from '@phosphor-icons/react'
import type { Request } from './Recharge'

type AdmissionView = {
  revision: string
  enabled: boolean
  daily_limit: number
  timezone: 'Asia/Shanghai'
  used: number
  remaining: number
  active_orders: number
  pending_checkouts: number
  accepts_orders: boolean
  execution_ready: boolean
  reason: string | null
  reason_message: string | null
  updated_at: number
  day_start: number
  next_reset_at: number
}
type Draft = {
  revision: string
  dailyLimit: string
  enabled: boolean
  originalLimit: string
  originalEnabled: boolean
}
const base = '/api/admin/admission'
const draftFrom = (view: AdmissionView): Draft => ({
  revision: view.revision, dailyLimit: String(view.daily_limit), enabled: view.enabled,
  originalLimit: String(view.daily_limit), originalEnabled: view.enabled,
})
const isDirty = (draft: Draft) => draft.dailyLimit !== draft.originalLimit || draft.enabled !== draft.originalEnabled
const beijingTime = (milliseconds: number) => new Date(milliseconds).toLocaleString('zh-CN', {
  timeZone: 'Asia/Shanghai', hour12: false,
})
const errorText = (error: unknown) => error instanceof Error ? error.message : '请求未确认，请刷新状态后核对。'

export function AdmissionSettings({ request, onError }: { request: Request; onError: (error: unknown) => void }) {
  const [view, setView] = useState<AdmissionView | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusError, setStatusError] = useState(''), [actionError, setActionError] = useState('')
  const [message, setMessage] = useState(''), [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState<'save' | 'pause' | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false), [confirmation, setConfirmation] = useState('')
  const mounted = useRef(false), busyRef = useRef(false), sequence = useRef(0), onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const reportAuth = useCallback((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 401)
      onErrorRef.current(error)
  }, [])
  const refresh = useCallback(async (replaceDraft = false) => {
    if (busyRef.current) return
    const currentSequence = ++sequence.current
    setLoading(true)
    try {
      const next = await request<AdmissionView>(base)
      if (!mounted.current || currentSequence !== sequence.current) return
      setView(next)
      setDraft((current) => !current || replaceDraft || !isDirty(current) ? draftFrom(next) : current)
      setStatusError(''); setCheckedAt(Date.now())
      if (replaceDraft) {
        setActionError(''); setMessage('已载入最新接单设置，未保存的输入已替换。')
        setConfirmOpen(false); setConfirmation('')
      }
    } catch (error) {
      if (!mounted.current || currentSequence !== sequence.current) return
      setStatusError(errorText(error)); reportAuth(error)
    } finally {
      if (mounted.current && currentSequence === sequence.current) setLoading(false)
    }
  }, [request, reportAuth])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 30000)
    return () => { mounted.current = false; sequence.current++; window.clearInterval(timer) }
  }, [refresh])

  const dirty = !!draft && isDirty(draft)
  const conflict = !!draft && !!view && draft.revision !== view.revision
  const validLimit = !!draft && /^[1-9][0-9]{0,4}$/.test(draft.dailyLimit) && Number(draft.dailyLimit) <= 10000
  const canSave = !!view && !!draft && dirty && validLimit && !conflict && !statusError && !loading && !busy

  async function mutate(kind: 'save' | 'pause') {
    if (busyRef.current) return
    if (kind === 'save' && (!canSave || !draft || (draft.enabled && confirmation !== 'UPDATE_ORDER_LIMITS'))) return
    busyRef.current = true; sequence.current++
    setBusy(kind); setLoading(false); setActionError(''); setMessage('')
    try {
      let next: AdmissionView
      if (kind === 'save' && draft) {
        next = await request<AdmissionView>(base + '/config', {
          revision: draft.revision, enabled: draft.enabled, daily_limit: Number(draft.dailyLimit),
          ...(draft.enabled ? { confirmation: 'UPDATE_ORDER_LIMITS' } : {}),
        })
      } else {
        await request(base + '/enabled', { enabled: false })
        next = await request<AdmissionView>(base)
      }
      if (!mounted.current) return
      setView(next)
      setDraft((current) => kind === 'pause' && current
        ? { ...draftFrom(next), dailyLimit: current.dailyLimit }
        : draftFrom(next))
      setStatusError(''); setCheckedAt(Date.now()); setConfirmOpen(false); setConfirmation('')
      if (kind === 'pause' && next.enabled)
        setActionError('暂停请求已执行，但最新设置已重新开放。请核对其他管理操作，必要时再次暂停新增接单。')
      setMessage(kind === 'pause'
        ? next.enabled ? '' : '已暂停新增接单。未保存的额度输入已保留；已有订单仍按原付款设置处理。'
        : next.enabled
          ? next.accepts_orders ? '每日接单设置已保存，当前可接受新订单。' : '每日接单设置已保存；当前仍有阻断条件，请查看下方状态。'
          : '每日额度已保存，新增接单保持暂停。已有订单仍按原付款设置处理。')
    } catch (error) {
      if (!mounted.current) return
      setActionError(errorText(error) + ' 请刷新状态核对结果，不要连续重复提交。')
      setStatusError('本次操作结果尚未核对。'); reportAuth(error)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(null)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSave || !draft) return
    if (draft.enabled) { setConfirmOpen(true); setConfirmation('') }
    else void mutate('save')
  }

  return (
    <section className="payment-settings" aria-labelledby="admission-settings-title">
      <div className="toolbar payment-heading">
        <h2 id="admission-settings-title">每日接单设置</h2>
        <div className="actions">
          <Button variant="secondary" disabled={!!busy} onClick={() => void mutate('pause')}>
            {busy === 'pause' ? '正在暂停…' : '暂停新增接单'}
          </Button>
          <Button variant="ghost" disabled={!!busy || loading} onClick={() => void refresh()}>
            <ArrowClockwise size={16} />{loading ? '刷新中…' : '刷新接单状态'}
          </Button>
        </div>
      </div>
      <p className="note payment-intro">卡密兑换、商户直充与支付宝扫码购买共享每日额度，按北京时间每日 00:00 重置。此处只控制新增接单，不会开启或停用 X 付款、支付宝收款。</p>
      {statusError && <p role="alert" className="notice error">状态未确认：{statusError} 下方如有数据，仅为上次确认结果；请刷新状态。</p>}
      {actionError && <p role="alert" className="notice error">{actionError}</p>}
      {message && <p role="status" className="notice">{message}</p>}
      {!view || !draft ? <div className="payment-loading" role="status">
        {loading ? '正在读取每日接单设置…' : '尚未取得接单设置，请刷新状态重试。仍可使用“暂停新增接单”。'}
      </div> : <>
        <div className="payment-status" aria-live="polite">
          <span className={`status ${view.enabled ? 'status-ACTIVE' : ''}`}>{view.enabled ? '接单开关已开放' : '新增接单已暂停'}</span>
          <span>{view.accepts_orders ? '当前可接新单' : '当前不接新单'}</span>
          <span>今日已占用 {view.used} / {view.daily_limit} 笔</span>
          <span>今日剩余 {view.remaining} 笔</span>
        </div>
        {view.reason_message && <p className="notice" role="status">{view.reason_message}</p>}
        <ul className="payment-checks" aria-label="新增接单条件">
          <li><span className={`status ${view.execution_ready ? 'status-ACTIVE' : 'status-unknown'}`}>{view.execution_ready ? '已就绪' : '待处理'}</span><span>X 付款执行条件{view.execution_ready ? '已就绪' : '未就绪，请检查下方 X 付款配置'}</span></li>
          <li><span className={`status ${view.remaining > 0 ? 'status-ACTIVE' : 'status-unknown'}`}>{view.remaining > 0 ? '有额度' : '已用完'}</span><span>北京时间今日接单额度</span></li>
          <li><span className={`status ${view.active_orders === 0 ? 'status-ACTIVE' : 'status-unknown'}`}>{view.active_orders === 0 ? '无阻断' : '待核对'}</span><span>处理中 / 待核对的赠送订单 {view.active_orders} 笔</span></li>
          <li><span className={`status ${view.pending_checkouts === 0 ? 'status-ACTIVE' : 'status-unknown'}`}>{view.pending_checkouts === 0 ? '无阻断' : '待处理'}</span><span>待付款 / 待核对的支付宝购买 {view.pending_checkouts} 笔</span></li>
        </ul>
        <p className="note payment-meta">下次重置：{beijingTime(view.next_reset_at)}（北京时间）。零点只重置每日额度，不会清除待核对订单。<br />
          {checkedAt && <>状态确认于 {beijingTime(checkedAt)}（北京时间）· 页面可见时每 30 秒刷新</>}
        </p>
        {conflict && <div className="notice error" role="alert">
          接单设置已在其他页面发生变化。请载入最新配置后重新调整；这会替换当前未保存的输入。
          <Button variant="secondary" disabled={!!busy || loading} onClick={() => void refresh(true)}>载入最新接单设置</Button>
        </div>}
        <form className="payment-form" onSubmit={submit}>
          <Input label="每日接单上限（笔）" name="daily_limit" type="number" min={1} max={10000} step={1}
            value={draft.dailyLimit} required disabled={!!busy || conflict || !!statusError}
            aria-describedby="admission-limit-help" aria-invalid={!validLimit}
            onChange={(event) => { setDraft({ ...draft, dailyLimit: event.target.value }); setMessage('') }} />
          <label className="form-field" htmlFor="admission-enabled">保存后的接单状态
            <select id="admission-enabled" value={draft.enabled ? 'enabled' : 'paused'} disabled={!!busy || conflict || !!statusError}
              onChange={(event) => { setDraft({ ...draft, enabled: event.target.value === 'enabled' }); setMessage('') }}>
              <option value="paused">暂停新增接单</option>
              <option value="enabled">开放新增接单（保存时需确认）</option>
            </select>
          </label>
          <p id="admission-limit-help" className="note payment-policy">请输入 1–10000 的整数。未结束的扫码购买会预占额度；成功订单计入当日额度。降低上限或暂停接单不会取消已有订单、退款或重复扣款。未确认的付款结果仍须核对原单。</p>
          {!validLimit && <p className="notice error payment-policy" role="alert">每日上限必须是 1–10000 的整数。</p>}
          {validLimit && Number(draft.dailyLimit) < view.used && <p className="notice payment-policy">新上限低于今日已占用额度；保存后今日不再接新单，不会取消已有订单。</p>}
          <div className="payment-save-row">
            <Button type="submit" variant="primary" disabled={!canSave}>{busy === 'save' ? '正在保存…' : draft.enabled ? '保存并确认开放…' : '保存接单设置'}</Button>
            <span className="payment-draft-state" role="status">{dirty ? '有未保存的更改，尚未生效。' : '当前接单设置已保存。'}</span>
          </div>
        </form>
      </>}
      <Dialog.Root open={confirmOpen} onOpenChange={(open) => { if (!busy) setConfirmOpen(open) }}>
        <Dialog size="lg" className="x-modal">
          <form onSubmit={(event) => { event.preventDefault(); void mutate('save') }}>
            <Dialog.Title className="modal-title">确认开放每日接单</Dialog.Title>
            <Dialog.Description className="modal-description">每日上限将设为 {draft?.dailyLimit} 笔，北京时间 00:00 重置。X 付款须已就绪，扫码购买另需启用支付宝收款；接受的订单可能产生真实扣款。已有未结订单仍会阻止新增接单。</Dialog.Description>
            <Input label="输入 UPDATE_ORDER_LIMITS 确认" value={confirmation} autoComplete="off" spellCheck={false}
              disabled={!!busy} onChange={(event) => setConfirmation(event.target.value)} />
            {!busy && !loading && !canSave && <p className="notice error" role="alert">配置或状态已变化，请关闭此窗口并刷新接单状态后核对。</p>}
            {actionError && <p className="notice error" role="alert">{actionError}</p>}
            <div className="modal-footer">
              <Button type="button" variant="secondary" disabled={!!busy} onClick={() => setConfirmOpen(false)}>取消</Button>
              <Button type="submit" variant="primary" disabled={!canSave || confirmation !== 'UPDATE_ORDER_LIMITS'}>{busy === 'save' ? '正在保存…' : '确认保存并开放'}</Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
    </section>
  )
}
