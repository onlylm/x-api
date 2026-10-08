import { fail, id, seal, text, unseal, type Env } from './core.ts'
import { publicOrder, type Order } from './orders.ts'
import type { Result, Snapshot } from './executor.ts'
import { guardPage, manualApprovalFresh, validatedCheckoutUrl } from '../server/native-executor.ts'
import { assertPaymentAllowed } from './payments.ts'

const active = (order: Order) => ['running', 'unknown'].includes(order.status)
async function loadOrder(env: Env, orderId: string) {
  const order = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first<Order>()
  if (!order) return fail('not_found', '订单不存在。', 404)
  return order
}
async function snapshotFor(env: Env, order: Order) {
  if (!order.execution_config) return fail('missing_execution', '原订单执行配置缺失，不能确认付款状态。', 409)
  const snapshot = JSON.parse(await unseal(env, 'execution:' + order.id, order.execution_config)) as Snapshot
  if (snapshot.endpoint !== 'local:v1') return fail('unsupported_execution', '该历史订单由外部执行端处理，请到原执行端核对。', 409)
  return snapshot
}
async function nativeJob(env: Env, order: Order) {
  const row = await env.DB.prepare('SELECT stage,payload FROM native_jobs WHERE order_id=?').bind(order.id)
    .first<{ stage: string; payload: string }>()
  if (!row) return null
  const job = JSON.parse(await unseal(env, 'native:' + order.id, row.payload)) as Record<string, any>
  if (job.stage !== row.stage) return fail('execution_state_unconfirmed', '原订单执行记录不一致，请保留订单并核对。', 409)
  return job
}

export type AdminOrderCapabilities = {
  check: boolean
  payment_page: boolean
  close: boolean
  reason_code: string
  message: string
  close_confirmation?: 'CLOSE_UNCONFIRMED_CREATION'
  approve_payment?: boolean
  payment_card_id?: number
}

const hasNotStartedPayment = (job: Record<string, any> | null) => !job ||
  (job.stage === 'preflight' && !job.session && !job.session_url && !job.method && !job.submitted_at && !job.tokenization_started)

// Creation only sends recipient/product data to X, never card details. Terminating
// this local job does not expire a possibly orphaned upstream checkout. Therefore
// require a distinct admin acknowledgement and reject ANY downstream evidence.
const hasUnconfirmedCreation = (order: Order, job: Record<string, any> | null) =>
  order.status === 'unknown' && order.receipt === null && job?.stage === 'creating' &&
  ['session', 'session_url', 'method', 'checksum', 'submitted_at', 'proof', 'tokenization_started']
    .every(field => !Object.hasOwn(job, field))

/** Admin-only display hints from persisted evidence. No claims, HTTP requests,
 * provider queries or financial writes. Action endpoints still recheck state. */
export async function adminOrderCapabilities(env: Env, order: Order): Promise<AdminOrderCapabilities> {
  const unavailable = (reason_code: string, message: string): AdminOrderCapabilities =>
    ({ check: false, payment_page: false, close: false, reason_code, message })
  if (order.status === 'succeeded') return unavailable('completed', '赠送付款已完成，可核对接收账号权益。')
  if (order.status === 'failed') return unavailable('ended', '订单已结束，无需继续执行。')
  if (order.lease_until > Date.now()) return unavailable('executing', '系统正在执行，请等待本笔结果。')
  try {
    if (order.status === 'queued') {
      if (order.execution_config) return unavailable('state_changed', '执行状态已变化，请刷新原单。')
      const job = await nativeJob(env, order)
      return hasNotStartedPayment(job)
        ? { ...unavailable('queued', '按接收顺序等待执行，尚未付款。'), close: true }
        : unavailable('original_request_unconfirmed', '原请求结果需要核对，请保留订单。')
    }
    if (!active(order)) return unavailable('unsupported_state', '请保留原单并核对执行状态。')
    await snapshotFor(env, order)
    const job = await nativeJob(env, order), check = !!env.NATIVE_ORDER_QUERY
    if (job?.stage === 'awaiting_approval' && job.payment?.manual_confirmation) {
      guardPage(job.proof, order, job.session, true)
      validatedCheckoutUrl(job.session_url, job.session)
      if (!/^pm_[A-Za-z0-9]+$/.test(job.method ?? '') || job.submitted_at || job.card_id !== job.payment.card_id)
        return unavailable('evidence_unavailable', '人工付款准备记录不完整，请核对原单。')
      const approved = manualApprovalFresh(job.manual_approved_at)
      return { check, payment_page: false, close: false, approve_payment: !approved, payment_card_id: job.card_id,
        reason_code: approved ? 'manual_payment_approved' : 'manual_payment_approval_required',
        message: approved ? '已收到本单付款授权，等待队列提交；请勿重复付款。' : '银行卡支付方式已准备，尚未提交扣款。请核对账号、金额和本单银行卡后，人工确认付款。' }
    }
    if (hasNotStartedPayment(job)) return {
      check, payment_page: false, close: true, reason_code: 'payment_not_started',
      message: '未创建付款会话，可继续核对或安全关闭。',
    }
    if (hasUnconfirmedCreation(order, job)) return {
      check, payment_page: false, close: true, close_confirmation: 'CLOSE_UNCONFIRMED_CREATION',
      reason_code: 'unconfirmed_creation_not_submitted',
      message: 'X 账单创建结果未知，但本单没有进入银行卡支付阶段。可由管理员确认风险后终止本地订单；此操作不会撤销 X 端可能创建的账单。',
    }
    let payment_page = false
    if (job && ['submitted', 'paid'].includes(job.stage)) {
      try {
        guardPage(job.proof, order, job.session, true)
        if (job.submitted_at && /^pm_[A-Za-z0-9]+$/.test(job.method ?? '')) {
          validatedCheckoutUrl(job.session_url ?? job.proof?.url, job.session)
          payment_page = true
        }
      } catch { /* Incomplete evidence must never advertise a manual payment path. */ }
    }
    return { check, payment_page, close: false,
      reason_code: payment_page && order.failure_code === 'payment_requires_action' ? 'payment_requires_action' : 'reconcile_original',
      message: payment_page && order.failure_code === 'payment_requires_action'
        ? '原付款需要验证，可获取原付款页完成验证。'
        : check ? '付款结果待确认，请先核对原单。' : '原付款尚待确认，请保留订单并检查查询服务。',
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'unsupported_execution')
      return unavailable('external_execution', '该历史订单由外部执行端处理，请到原执行端核对。')
    return unavailable('evidence_unavailable', '原单执行证据暂不可用，请保留订单并刷新核对。')
  }
}

/** This endpoint only reveals the original hosted page to an authenticated admin.
 * It never creates/reinitializes a checkout, and must never be added to publicOrder. */
export async function adminPaymentPage(env: Env, orderId: string) {
  const order = await loadOrder(env, orderId)
  if (!active(order)) return fail('payment_page_unavailable', '排队或已结束的订单不能打开付款页面。', 409)
  await snapshotFor(env, order)
  const job = await nativeJob(env, order)
  // Before submission the automatic worker can still confirm. Do not expose a
  // competing manual payment path until the worker is permanently query-only.
  if (!job || !['submitted', 'paid'].includes(job.stage))
    return fail('payment_page_not_ready', '这笔订单尚未进入提交后核对阶段，不能同时手动付款。可先核对原单，或安全关闭尚未执行的订单。', 409)
  let url: string
  try {
    guardPage(job.proof, order, job.session, true)
    if (!job.submitted_at || !/^pm_[A-Za-z0-9]+$/.test(job.method ?? '')) throw new Error('missing_submission_proof')
    url = validatedCheckoutUrl(job.session_url ?? job.proof?.url, job.session)
  } catch { return fail('payment_page_unverified', '没有可验证的原付款链接。请核对原单，不要重新创建付款。', 409) }
  // A background poll may have completed while decryption was in progress.
  if (!active(await loadOrder(env, orderId))) return fail('payment_page_unavailable', '原订单状态已更新，请刷新订单列表。', 409)
  return { url, message: '仅打开原付款页面。请先查看是否已经付款；不要重复下单或重复提交。' }
}

async function claimOrder(env: Env, orderId: string) {
  const now = Date.now(), work = id('adminwork')
  const order = await env.DB.prepare(`UPDATE orders SET work_token=?,lease_until=?
    WHERE id=? AND status IN('running','unknown') AND lease_until<=? RETURNING *`)
    .bind(work, now + 180000, orderId, now).first<Order>()
  if (!order) return fail('order_busy', '订单正在执行或状态已变化，请稍后刷新再操作。此操作不会重新扣款。', 409)
  return order
}
async function releaseClaim(env: Env, order: Order) {
  await env.DB.prepare("UPDATE orders SET lease_until=0 WHERE id=? AND work_token=? AND status IN('running','unknown')")
    .bind(order.id, order.work_token).run()
}

/** Persist order-bound human authority only. The worker still submits once. */
export async function adminApprovePayment(env: Env, orderId: string, data: Record<string, unknown>) {
  if (data.confirmation !== 'CONFIRM_PAYMENT') fail('confirmation_required', '请输入 CONFIRM_PAYMENT 确认真实扣款。')
  const order = await claimOrder(env, orderId)
  try {
    const snapshot = await snapshotFor(env, order), job = await nativeJob(env, order)
    if (!job || job.stage !== 'awaiting_approval' || !job.payment?.manual_confirmation ||
        !snapshot.payment?.manual_confirmation || JSON.stringify(snapshot.payment) !== JSON.stringify(job.payment) ||
        job.submitted_at || !/^pm_[A-Za-z0-9]+$/.test(job.method ?? '') || job.card_id !== job.payment.card_id)
      return fail('manual_payment_not_ready', '本单不是待人工确认的付款，或已经提交；请核对原单，不可重复扣款。', 409)
    guardPage(job.proof, order, job.session, true)
    validatedCheckoutUrl(job.session_url, job.session)
    if (data.expected_card_id !== job.card_id || data.expected_amount_minor !== order.amount_minor ||
        data.expected_currency !== order.currency || data.expected_recipient !== order.recipient)
      fail('manual_payment_confirmation_changed', '账号、金额或银行卡与当前原单不匹配，请刷新后重新确认。', 409)
    await assertPaymentAllowed(env, job.payment, order.id)
    if (manualApprovalFresh(job.manual_approved_at)) return { approved: true, order_id: order.id, already_approved: true }
    const now = Date.now()
    job.manual_approved_at = now
    const payload = await seal(env, 'native:' + order.id, JSON.stringify(job))
    await env.DB.batch([
      env.DB.prepare(`UPDATE native_jobs SET payload=?,updated_at=? WHERE order_id=? AND stage='awaiting_approval'
        AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status IN('running','unknown') AND work_token=? AND lease_until>?)`)
        .bind(payload, now, order.id, order.id, order.work_token, now),
      env.DB.prepare(`INSERT INTO audit SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM native_jobs WHERE order_id=? AND payload=?)`)
        .bind(id('audit'), 'admin', 'approve_manual_payment', order.id,
          JSON.stringify({ card_id: job.card_id, currency: order.currency, amount_minor: order.amount_minor, expires_at: now + 300000 }), now, order.id, payload),
      env.DB.prepare(`UPDATE orders SET next_check=0,updated_at=? WHERE id=? AND work_token=?
        AND EXISTS(SELECT 1 FROM native_jobs WHERE order_id=? AND payload=?)`).bind(now, order.id, order.work_token, order.id, payload),
    ])
    if (!await env.DB.prepare('SELECT 1 FROM native_jobs WHERE order_id=? AND payload=?').bind(order.id, payload).first())
      fail('order_busy', '原单状态已改变，本次付款授权未确认，请刷新原单。', 409)
    return { approved: true, order_id: order.id, expires_at: now + 300000 }
  } finally { await releaseClaim(env, order) }
}
function verifiedSuccess(order: Order, result: Result) {
  const e = result.evidence
  return result.order_id === order.id && result.status === 'succeeded' && e?.payment_status === 'paid' &&
    e.gift_status === 'checkout_completed' && e.recipient === order.recipient && e.product_code === order.product_code &&
    e.currency === order.currency && e.amount_minor === order.amount_minor && /^cs_live_[A-Za-z0-9]+$/.test(e.receipt_id)
}
const queryMessages: Record<string, string> = {
  payment_not_started: '尚未创建原付款会话；没有发起扣款，可使用安全关闭。',
  payment_requires_action: '原付款需要验证。请打开原付款页面完成验证；本次核对没有重新扣款。',
  payment_pending: '原付款仍未确认，尚不能证明没有扣款。可打开原付款页面查看，不能直接关闭释放。',
  payment_query_failed: '原付款查询暂时失败；没有重新扣款，也没有释放订单。稍后可再次核对。',
  checkout_proof_missing: '原付款会话尚无完整身份与金额校验证据，不能确认付款或安全关闭。',
  original_request_unconfirmed: '原请求结果尚不明确，不能证明未创建付款。请保留原订单继续核对。',
}
export async function adminCheckOrder(env: Env, orderId: string) {
  const existing = await loadOrder(env, orderId)
  if (!active(existing)) return { order_id: existing.id, status: existing.status, failure_code: existing.failure_code,
    checked: false, message: existing.status === 'queued' ? '订单仍在排队，尚未开始付款。' : '订单已经结束，无需再次查询付款。' }
  const snapshot = await snapshotFor(env, existing)
  if (!env.NATIVE_ORDER_QUERY) return fail('query_unavailable', '服务器暂不支持只读原单核对。', 503)
  const order = await claimOrder(env, orderId)
  try {
    let result: Result
    try { result = await env.NATIVE_ORDER_QUERY(env, order, snapshot) }
    catch { result = { order_id: order.id, status: 'unknown', failure_code: 'payment_query_failed' } }
    const succeeded = verifiedSuccess(order, result)
    const code = succeeded ? null : result.order_id === order.id && /^[a-z0-9_]{1,64}$/.test(result.failure_code ?? '')
      ? result.failure_code! : 'payment_query_failed'
    const status = succeeded ? 'succeeded' : code === 'payment_not_started' ? order.status : 'unknown'
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(`UPDATE orders SET status=?,receipt=?,failure_code=?,lease_until=0,next_check=?,updated_at=?
        WHERE id=? AND work_token=? AND status IN('running','unknown')`)
        .bind(status, succeeded ? result.evidence!.receipt_id : order.receipt, code, now + 5000, now, order.id, order.work_token),
      env.DB.prepare(`INSERT INTO audit SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND work_token=? AND updated_at=?)`)
        .bind(id('audit'), 'admin', 'check_original_order', order.id, succeeded ? 'verified_checkout_paid' : code!, now, order.id, order.work_token, now),
    ])
    const current = await loadOrder(env, order.id)
    return { order_id: current.id, status: current.status, failure_code: current.failure_code, checked: true,
      message: current.status === 'succeeded' ? '已核实原赠送付款完成，原单已结算；没有重新扣款。' :
        queryMessages[current.failure_code ?? ''] ?? '本次没有取得可确认的付款结果，订单仍保留待核对；没有重新扣款。' }
  } finally { await releaseClaim(env, order) }
}

export async function adminCloseOrder(env: Env, orderId: string, data: Record<string, unknown>, queuedOnly = false) {
  const terminateCreation = data.confirmation === 'CLOSE_UNCONFIRMED_CREATION'
  if (data.confirmation !== 'CLOSE_ORDER' && !terminateCreation) return fail('confirmation_required', '请确认关闭原订单。')
  const reason = text(data.reason, '关闭原因', 300), existing = await loadOrder(env, orderId)
  if (queuedOnly && (existing.status !== 'queued' || existing.execution_config))
    return fail('cannot_cancel', '只能取消尚未开始执行的订单。', 409)
  if (!['queued', 'running', 'unknown'].includes(existing.status))
    return fail('order_already_closed', '订单已经结束，不能再次关闭或退回点数。', 409)
  let order = existing, claimed = false
  if (existing.status !== 'queued') {
    await snapshotFor(env, existing)
    order = await claimOrder(env, orderId); claimed = true
  }
  try {
    const job = await nativeJob(env, order)
    // A live checkout can still be paid outside this service. Without merchant
    // permission to expire it, "unpaid" is not enough to release this order.
    if (terminateCreation && (queuedOnly || !hasUnconfirmedCreation(order, job)))
      return fail('cannot_terminate_creation', '仅允许终止没有付款会话、支付方式或扣款提交记录的待核对账单创建请求。状态已变化，请刷新原单；不能强制关闭已进入支付阶段的订单。', 409)
    if (!terminateCreation && !hasNotStartedPayment(job))
      return fail('cannot_close_payment_started', '原付款可能已创建或已提交，不能仅关闭本地订单。请先核对原单；需要验证时打开原付款页面。只有确认未创建付款的订单可安全关闭，防止关闭后仍被扣款。', 409)
    if (!claimed && existing.execution_config)
      return fail('cannot_close_execution_bound', '订单已绑定执行配置，请刷新并先核对原单。', 409)
    const now = Date.now(), marker = claimed ? order.work_token! : id('adminclose')
    const failureCode = terminateCreation ? 'cancelled_unconfirmed_creation' : 'cancelled_before_execution'
    const condition = claimed ? "status IN('running','unknown') AND work_token=?" : "status='queued' AND execution_config IS NULL AND lease_until<=?"
    // State transition and audit are committed together. Existing database
    // triggers return the frozen points and release the account exactly once.
    await env.DB.batch([
      env.DB.prepare(`UPDATE orders SET status='failed',failure_code=?,work_token=?,lease_until=0,updated_at=?
        WHERE id=? AND ${condition}`)
        .bind(failureCode, marker, now, order.id, claimed ? marker : now),
      env.DB.prepare(`INSERT INTO audit SELECT ?,?,?,?,?,? WHERE EXISTS(
        SELECT 1 FROM orders WHERE id=? AND status='failed' AND work_token=? AND updated_at=?)`)
        .bind(id('audit'), 'admin', terminateCreation ? 'close_unconfirmed_creation' : 'close_order', order.id,
          terminateCreation ? JSON.stringify({ reason, stage: 'creating', upstream_checkout_unconfirmed: true, no_card_submission: true }) : reason,
          now, order.id, marker, now),
    ])
    const current = await loadOrder(env, order.id)
    if (current.status !== 'failed' || current.work_token !== marker)
      return fail('order_busy', '订单已开始执行或状态已变化，本次未关闭。请刷新并核对原单。', 409)
    return { closed: true, order_id: current.id, status: current.status, order: publicOrder(current) }
  } finally { if (claimed) await releaseClaim(env, order) }
}
