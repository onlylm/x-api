import {
  fail,
  id,
  integer,
  sha256,
  seal,
  text,
  type Env,
} from './core.ts'
import { eligibility } from './network.ts'
import { paymentBinding, prepareOrderPaymentSelection, type OrderPaymentSelection } from './payments.ts'
import { activeOrdersSql, admissionView, alipaySettlementId, executionReady, newAdmissionSql } from './admission.ts'
export { executionReady } from './admission.ts'
export interface Order {
  recipient_id?: string | null
  mode?: 'direct' | 'voucher'
  voucher_id?: string | null
  id: string
  user_id: string
  merchant_order_no: string
  idempotency_key: string
  request_hash: string
  product_code: string
  recipient: string
  points: number
  currency: string
  amount_minor: number
  stripe_product: string
  months: number
  status: 'queued' | 'running' | 'unknown' | 'succeeded' | 'failed'
  executor_ref: string | null
  execution_config: string | null
  payment_card_selection?: string | null
  failure_code: string | null
  receipt: string | null
  created_at: number
  updated_at: number
  lease_until: number
  next_check: number
  work_token: string | null
}
export function publicOrder(o: Order) {
  return {
    id: o.id,
    mode: o.mode ?? 'direct',
    merchant_order_no: o.merchant_order_no,
    product_code: o.product_code,
    recipient: o.recipient,
    points: o.points,
    currency: o.currency,
    amount_minor: o.amount_minor,
    status: o.status,
    failure_code: o.failure_code,
    receipt: o.receipt,
    created_at: o.created_at,
    updated_at: o.updated_at,
  }
}
export async function orderCapabilities(env: Env) {
  // Preserve the established external-executor API behavior; these limits guard
  // the native executor's shared payment card.
  const admission = env.LOCAL_EXECUTOR ? await admissionView(env) : null
  const ready = admission?.execution_ready ?? executionReady(env)
  return {
    execution_ready: ready,
    accepts_orders: admission?.accepts_orders ?? ready,
    reason: admission?.reason ?? (ready ? null : 'execution_unavailable'),
    modes: ['direct', 'voucher'],
  }
}
export async function products(env: Env, userId: string) {
  return (
    await env.DB.prepare(
      'SELECT p.code,p.name,p.months,p.currency,p.amount_minor,COALESCE(up.points,p.points) points,p.enabled FROM products p LEFT JOIN user_prices up ON up.product_code=p.code AND up.user_id=? ORDER BY p.months',
    )
      .bind(userId)
      .all()
  ).results
}
export async function createOrder(
  env: Env,
  userId: string,
  idem: string,
  body: Record<string, unknown>,
  options: { voucherId?: string; verifiedRecipientId?: string; alipayCheckoutId?: string; paymentCardSelection?: OrderPaymentSelection; manualConfirmation?: boolean } = {},
) {
  // Voucher authority is supplied only by the server-side redemption flow.
  const mode = options.voucherId ? 'voucher' : 'direct'
  if (body.manual_confirmation !== undefined && options.manualConfirmation === undefined)
    fail('invalid_input', '人工付款模式仅由管理员赠送入口授权。')
  if (body.payment_card_selection !== undefined && !options.paymentCardSelection)
    fail('invalid_input', '本单指定付款卡仅由管理员赠送入口授权。')
  if ((body.mode !== undefined && body.mode !== mode) || body.voucher_id !== undefined)
    fail('invalid_mode', '卡密订单请使用卡密兑换入口。')
  if (options.voucherId && !/^vch_[a-f0-9]{32}$/.test(options.voucherId))
    fail('invalid_input', '卡密编号无效。')
  if (options.alipayCheckoutId && (userId !== alipaySettlementId ||
      !/^chk_[a-f0-9]{32}$/.test(options.alipayCheckoutId) || options.voucherId))
    fail('invalid_input', '支付宝系统结算授权无效。')
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idem))
    fail('invalid_idempotency', '请提供 8–128 位幂等键。')
  const merchant = text(body.merchant_order_no, '商户订单号', 128),
    product = text(body.product_code, '商品代码', 64),
    recipient = text(body.recipient, 'X 用户名', 16)
      .replace(/^@/, '')
      .toLowerCase()
  if (
    !/^[a-z0-9_]{1,15}$/.test(recipient) ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(merchant)
  )
    fail('invalid_input', '订单号或 X 用户名格式无效。')
  if (options.alipayCheckoutId && (merchant !== 'alipay:' + options.alipayCheckoutId || idem !== merchant))
    fail('invalid_input', '支付宝结算订单标识不匹配。')
  const checkIdentity = !!env.LOCAL_EXECUTOR || !!options.voucherId || body.recipient_id !== undefined
  const checkPrice = !!env.LOCAL_EXECUTOR || !!options.voucherId || body.expected_points !== undefined
  // Retain the old digest for existing direct API callers and native orders.
  const digest = await sha256(JSON.stringify({
    merchant, product, recipient,
    ...(checkIdentity || checkPrice ? { recipient_id: body.recipient_id, expected_points: body.expected_points } : {}),
    ...(options.voucherId ? { mode, voucher_id: options.voucherId } : {}),
    ...(options.paymentCardSelection ? { payment_card_selection: options.paymentCardSelection } : {}),
    ...(options.manualConfirmation ? { manual_confirmation: true } : {}),
  }))
  const existing = async () =>
    env.DB.prepare(
      'SELECT * FROM orders WHERE user_id=? AND (merchant_order_no=? OR idempotency_key=?)',
    )
      .bind(userId, merchant, idem)
      .all<Order>()
  const check = (list: Order[]) => {
    if (
      list.length !== 1 ||
      (list[0].mode ?? 'direct') !== mode ||
      (list[0].voucher_id ?? null) !== (options.voucherId ?? null) ||
      list[0].request_hash !== digest ||
      list[0].idempotency_key !== idem
    )
      fail('idempotency_conflict', '订单号或幂等键已绑定其他请求。', 409)
    return publicOrder(list[0])
  }
  const previous = await existing()
  if (previous.results.length)
    return { order: check(previous.results), created: false }
  if (!executionReady(env))
    fail('execution_disabled', '自动支付尚未配置或已暂停，未冻结点数。', 503)
  let recipientId: string | null = null
  if (checkPrice)
    integer(body.expected_points, '确认点数', 1, 100000000)
  if (checkIdentity) {
    if (typeof body.recipient_id !== 'string' || !/^\d{1,25}$/.test(body.recipient_id))
      fail('invalid_input', '请先检测并确认接收账号。')
    if (options.voucherId && options.verifiedRecipientId) {
      if (options.verifiedRecipientId !== body.recipient_id)
        fail('recipient_changed', '接收账号身份已变化，请重新检测。', 409)
      recipientId = options.verifiedRecipientId
    } else {
      const check = await eligibility(env, recipient)
      if (!check.eligible || !check.recipient_id) return fail('not_eligible', '该账号当前不能接收赠送。', 409)
      if (check.recipient_id !== body.recipient_id) fail('recipient_changed', '接收账号身份已变化，请重新检测。', 409)
      recipientId = check.recipient_id
    }
  }
  const orderId = id('ord'),
    now = Date.now()
  let binding = options.paymentCardSelection ? await prepareOrderPaymentSelection(env, options.paymentCardSelection) : null
  if (options.manualConfirmation) {
    if (!env.NATIVE_EXECUTOR || !env.LOCAL_EXECUTOR || env.PAYMENTS_ENABLED !== 'true' || options.voucherId || options.alipayCheckoutId)
      fail('execution_disabled', '人工确认付款仅支持已启用的管理员原生赠送。', 503)
    binding ??= await paymentBinding(env)
    if (!binding) return fail('payment_configuration_missing', '请先配置指定卡付款服务。', 409)
    // Immutable per-order authority, with one known card and no automatic failover.
    binding = { ...binding, backup_card_ids: [], order_card_selection: true, manual_confirmation: true }
  }
  const selectedPayment = binding ? await seal(env, 'order-payment:' + orderId, JSON.stringify(binding)) : null
  // Paid checkouts already reserved their slot. Admission changes and midnight
  // must not strand that payment; retain all identity, product, payment revision
  // and shared-card serialization checks when converting the reservation.
  const admissionSql = options.alipayCheckoutId
    ? `NOT EXISTS(${activeOrdersSql})
      AND NOT EXISTS(SELECT 1 FROM alipay_checkouts WHERE status IN('creating','pending','paid','attention') AND id<>?)
      AND EXISTS(SELECT 1 FROM alipay_checkouts a WHERE a.id=? AND a.paid_at IS NOT NULL AND a.status='paid'
        AND a.order_id IS NULL AND a.failure_code IS NULL AND a.product_code=p.code AND a.recipient=? AND a.recipient_id=?
        AND a.points=COALESCE(up.points,p.points) AND a.currency=p.currency AND a.amount_minor=p.amount_minor
        AND a.stripe_product=p.stripe_product AND a.months=p.months
        AND EXISTS(SELECT 1 FROM payment_settings WHERE id=1 AND enabled=1 AND revision=a.outbound_revision))`
    : newAdmissionSql(now)
  try {
    const row = await env.DB.prepare(
      `INSERT INTO orders(id,user_id,merchant_order_no,idempotency_key,request_hash,product_code,recipient,points,currency,amount_minor,stripe_product,months,created_at,updated_at,recipient_id,mode,voucher_id,payment_card_selection)
   SELECT ?,u.id,?,?,?,?,?,COALESCE(up.points,p.points),p.currency,p.amount_minor,p.stripe_product,p.months,?,?,?,?,?,?
   FROM users u JOIN products p ON p.code=? LEFT JOIN user_prices up ON up.user_id=u.id AND up.product_code=p.code WHERE u.id=? AND u.enabled=1 AND p.enabled=1${checkPrice ? ' AND COALESCE(up.points,p.points)=?' : ''}${env.LOCAL_EXECUTOR ? ' AND (' + admissionSql + ')' : ''}${env.PAYMENT_SETTINGS ? ' AND EXISTS(SELECT 1 FROM payment_settings WHERE id=1 AND enabled=1 AND revision=?)' : ''} RETURNING *`,
    )
      .bind(
        orderId,
        merchant,
        idem,
        digest,
        product,
        recipient,
        now,
        now,
        recipientId,
        mode,
        options.voucherId ?? null,
        selectedPayment,
        product,
        userId,
        ...(checkPrice ? [Number(body.expected_points)] : []),
        ...(env.LOCAL_EXECUTOR && options.alipayCheckoutId ? [options.alipayCheckoutId, options.alipayCheckoutId, recipient, recipientId] : []),
        ...(env.PAYMENT_SETTINGS ? [env.PAYMENT_SETTINGS.revision] : []),
      )
      .first<Order>()
    if (!row)
      return fail('product_unavailable', '商品或账户不可用、点数价格已变化，或接单已暂停、今日额度已用完、原订单仍待处理。', 409)
    return { order: publicOrder(row), created: true }
  } catch (e) {
    const raced = await existing()
    if (raced.results.length)
      return { order: check(raced.results), created: false }
    if (e instanceof Error && e.message.includes('insufficient_points'))
      return fail('insufficient_points', '可用点数不足。', 409)
    if (e instanceof Error && e.message.includes('orders.recipient'))
      return fail(
        'recipient_busy',
        '该接收账号已有处理中的充值，请等待原订单结果。',
        409,
      )
    throw e
  }
}
export async function credit(
  env: Env,
  userId: string,
  body: Record<string, unknown>,
  actor: string,
) {
  const points = integer(body.points, '充值点数'),
    reference = text(body.reference, '入账凭证号', 128),
    note = text(body.note, '入账说明', 300)
  const row = await env.DB.prepare(
    "SELECT available_delta,note FROM ledger WHERE user_id=? AND kind='credit' AND reference=?",
  )
    .bind(userId, reference)
    .first<{ available_delta: number; note: string }>()
  if (row) {
    if (row.available_delta !== points || row.note !== note)
      fail('credit_conflict', '该凭证号已用于其他入账。', 409)
    return { credited: true, duplicate: true }
  }
  try {
    const inserted = await env.DB.prepare(
      "INSERT INTO ledger SELECT ?,id,NULL,'credit',?,0,?,?,?,? FROM users WHERE id=? RETURNING id",
    )
      .bind(id('led'), points, note, actor, reference, Date.now(), userId)
      .first<{ id: string }>()
    if (!inserted) fail('not_found', '用户不存在。', 404)
  } catch (e) {
    const raced = await env.DB.prepare(
      "SELECT available_delta,note FROM ledger WHERE user_id=? AND kind='credit' AND reference=?",
    )
      .bind(userId, reference)
      .first<{ available_delta: number; note: string }>()
    if (!raced) throw e
    if (raced.available_delta !== points || raced.note !== note)
      fail('credit_conflict', '入账凭证冲突。', 409)
    return { credited: true, duplicate: true }
  }
  return { credited: true, duplicate: false }
}
export async function getOrder(env: Env, userId: string, orderId: string) {
  const row = await env.DB.prepare(
    'SELECT * FROM orders WHERE id=? AND user_id=?',
  )
    .bind(orderId, userId)
    .first<Order>()
  if (!row) return fail('not_found', '订单不存在。', 404)
  return publicOrder(row)
}
export function pagination(url: URL) {
  const page = integer(
    Number(url.searchParams.get('page') ?? 1),
    '页码',
    1,
    10000,
  )
  return { page, offset: (page - 1) * 30 }
}
