import { audit, booleanInt, fail, id, integer, secureEndpoint, type Env } from './core.ts'

type Settings = { enabled: number; daily_limit: number; revision: string; updated_at: number }
export const alipaySettlementId = 'usr_' + '0'.repeat(28) + 'a11a'
export const activeOrdersSql = "SELECT 1 FROM orders WHERE status IN('queued','running','unknown')"
export const pendingCheckoutsSql = "SELECT 1 FROM alipay_checkouts WHERE status IN('creating','pending','paid','attention')"
const dayMilliseconds = 86400000
const beijingOffset = 8 * 3600000

export function admissionDay(now = Date.now()) {
  const start = Math.floor((now + beijingOffset) / dayMilliseconds) * dayMilliseconds - beijingOffset
  return { start, end: start + dayMilliseconds }
}

export function executionReady(env: Env) {
  try {
    if (env.LOCAL_EXECUTOR) return env.PAYMENTS_ENABLED === 'true' && /^pk_live_[A-Za-z0-9]+$/.test(env.STRIPE_PUBLISHABLE_KEY ?? '')
    return env.PAYMENTS_ENABLED === 'true' && !!secureEndpoint(env.EXECUTOR_URL) && (env.EXECUTOR_SECRET?.length ?? 0) >= 32
  } catch { return false }
}

// The merchant identity also covers a crash after the order INSERT but before
// alipay_checkouts.order_id is filled. Every purchase belongs to its original day.
const relatedOrder = `(o.id=a.order_id OR (o.user_id='${alipaySettlementId}' AND o.merchant_order_no='alipay:'||a.id))`
export function dailyUsageSql(now: number) {
  const { start, end } = admissionDay(now)
  return `((SELECT COUNT(*) FROM orders o WHERE o.status<>'failed' AND o.created_at>=${start} AND o.created_at<${end}
    AND NOT EXISTS(SELECT 1 FROM alipay_checkouts a WHERE ${relatedOrder})) +
    (SELECT COUNT(*) FROM alipay_checkouts a WHERE a.created_at>=${start} AND a.created_at<${end}
      AND (EXISTS(SELECT 1 FROM orders o WHERE ${relatedOrder} AND o.status<>'failed') OR
        (NOT EXISTS(SELECT 1 FROM orders o WHERE ${relatedOrder}) AND
          (a.status IN('creating','pending','paid','attention','fulfilled') OR a.paid_at IS NOT NULL)))))`
}

// Embed this predicate in the INSERT itself. A preliminary capability read can
// explain a pause, but cannot reserve quota. The executor separately serializes
// the shared payment card; admitting a queue must never start a second payment.
export function newAdmissionSql(now: number) {
  return `EXISTS(SELECT 1 FROM order_admission WHERE id=1 AND enabled=1 AND ${dailyUsageSql(now)}<daily_limit)
    AND NOT EXISTS(${pendingCheckoutsSql})`
}

export async function admissionView(env: Env) {
  const now = Date.now(), day = admissionDay(now)
  const row = await env.DB.prepare(`SELECT enabled,daily_limit,revision,updated_at,${dailyUsageSql(now)} used,
    (SELECT COUNT(*) FROM orders WHERE status IN('queued','running','unknown')) active_orders,
    (SELECT COUNT(*) FROM orders WHERE status='queued') queued_orders,
    (SELECT COUNT(*) FROM orders WHERE status='running') executing_orders,
    (SELECT COUNT(*) FROM orders WHERE status='unknown') unknown_orders,
    (SELECT id FROM orders WHERE status='unknown' ORDER BY created_at,id LIMIT 1) blocked_order_id,
    (SELECT COUNT(*) FROM alipay_checkouts WHERE status IN('creating','pending','paid','attention')) pending_checkouts
    FROM order_admission WHERE id=1`).first<Settings & { used: number; active_orders: number; queued_orders: number;
      executing_orders: number; unknown_orders: number; blocked_order_id: string | null; pending_checkouts: number }>()
  if (!row) return fail('admission_configuration_missing', '接单设置尚未初始化，请完成数据库升级。', 503)
  const ready = executionReady(env)
  const reason = !row.enabled ? 'paused' : !ready ? 'execution_unavailable' :
    row.pending_checkouts > 0 ? 'checkout_in_progress' : row.used >= row.daily_limit ? 'daily_limit_reached' : null
  const messages = {
    paused: '新接单已暂停；已接订单继续按原付款设置处理。',
    execution_unavailable: 'X 付款尚未就绪或已暂停。',
    checkout_in_progress: '仍有待付款或待核对的支付宝购买，等待原购买结果后再接单。',
    daily_limit_reached: '北京时间今日接单额度已用完。',
  }
  return { revision: row.revision, enabled: !!row.enabled, daily_limit: row.daily_limit, timezone: 'Asia/Shanghai' as const,
    used: row.used, remaining: Math.max(0, row.daily_limit - row.used), active_orders: row.active_orders,
    queued_orders: row.queued_orders, executing_orders: row.executing_orders, unknown_orders: row.unknown_orders,
    queue_blocked: row.unknown_orders > 0 || (!ready && row.queued_orders > 0), blocked_order_id: row.blocked_order_id,
    pending_checkouts: row.pending_checkouts, accepts_orders: reason === null, execution_ready: ready,
    reason, reason_message: reason ? messages[reason] : null, updated_at: row.updated_at,
    day_start: day.start, next_reset_at: day.end }
}

export async function configureAdmission(env: Env, body: Record<string, unknown>) {
  const enabled = booleanInt(body.enabled), dailyLimit = integer(body.daily_limit, '每日接单上限', 1, 10000)
  if (enabled && body.confirmation !== 'UPDATE_ORDER_LIMITS')
    return fail('confirmation_required', '请输入 UPDATE_ORDER_LIMITS 确认开放每日接单。')
  if (typeof body.revision !== 'string') return fail('admission_config_conflict', '请刷新接单设置后再保存。', 409)
  const revision = id('admcfg')
  const changed = await env.DB.prepare(`UPDATE order_admission SET enabled=?,daily_limit=?,revision=?,updated_at=MAX(updated_at+1,?)
    WHERE id=1 AND revision=? RETURNING id`).bind(enabled, dailyLimit, revision, Date.now(), body.revision).first()
  if (!changed) return fail('admission_config_conflict', '接单设置已变化，请刷新后再保存。', 409)
  await audit(env, 'admin', 'configure_order_admission', revision, `enabled=${enabled};daily_limit=${dailyLimit};timezone=Asia/Shanghai`)
  return admissionView(env)
}

export async function pauseAdmission(env: Env, body: Record<string, unknown>) {
  if (booleanInt(body.enabled)) return fail('confirmation_required', '开放接单请通过接单设置保存并确认。')
  const revision = id('admcfg')
  await env.DB.prepare('UPDATE order_admission SET enabled=0,revision=?,updated_at=MAX(updated_at+1,?) WHERE id=1')
    .bind(revision, Date.now()).run()
  await audit(env, 'admin', 'pause_order_admission', revision)
  return { paused: true, enabled: false, revision }
}
