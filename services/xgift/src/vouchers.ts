import { audit, fail, id, integer, sha256, text, type Env } from './core.ts'
import { eligibility, normalizeRecipient } from './network.ts'
import { createOrder, executionReady, type Order } from './orders.ts'

interface VoucherRecord {
  id: string
  batch_id: string
  batch_label: string
  user_id: string
  product_code: string
  code_hash: string
  last_four: string
  status: 'active' | 'revoked' | 'redeemed'
  order_id: string | null
  created_at: number
  expires_at: number
  redeemed_at: number | null
  revoked_at: number | null
  revocation_note: string | null
  product_name: string
  months: number
}

function voucherCode(value: unknown) {
  const code = text(value, '卡密', 80).toUpperCase()
  if (!/^XG-[A-F0-9]{48}$/.test(code)) fail('invalid_voucher', '卡密无效。', 404)
  return code
}

function state(voucher: Pick<VoucherRecord, 'status' | 'expires_at'>) {
  if (voucher.status === 'redeemed') return 'redeemed' as const
  if (voucher.status === 'revoked') return 'revoked' as const
  return voucher.expires_at <= Date.now() ? 'expired' as const : 'available' as const
}

function customerOrder(order: Order) {
  return {
    id: order.id,
    product_code: order.product_code,
    recipient: order.recipient,
    status: order.status,
    failure_code: order.failure_code,
    created_at: order.created_at,
    updated_at: order.updated_at,
  }
}

function customerView(voucher: VoucherRecord, order?: Order) {
  return {
    state: state(voucher),
    product: { code: voucher.product_code, name: voucher.product_name, months: voucher.months },
    expires_at: voucher.expires_at,
    ...(order ? { order: customerOrder(order) } : {}),
  }
}

/** Only server-side session code may supply this scope; never read it from a request body. */
export type MerchantVoucherScope = { userId: string }

export async function issueVouchers(env: Env, body: Record<string, unknown>, scope?: MerchantVoucherScope) {
  const userId = text(scope ? scope.userId : body.user_id, '扣点账户', 80)
  const productCode = text(body.product_code, '商品代码', 64)
  const quantity = integer(body.quantity ?? body.count, '生成数量', 1, 100)
  const days = integer(body.expires_in_days ?? 30, '有效天数', 1, 365)
  const batchLabel = body.batch_label === undefined || body.batch_label === '' ? '' : text(body.batch_label, '批次名称', 80)
  const owner = await env.DB.prepare('SELECT id FROM users WHERE id=? AND enabled=1').bind(userId).first()
  if (!owner) fail('invalid_owner', '扣点账户不存在或已停用。', 409)
  const product = await env.DB.prepare('SELECT code FROM products WHERE code=?' + (scope ? ' AND enabled=1' : '')).bind(productCode).first()
  if (!product) {
    if (scope) fail('product_unavailable', '当前套餐未开放发卡，请选择已启用的套餐。', 409)
    fail('invalid_product', '商品不存在。', 404)
  }

  const batchId = id('vbatch'), now = Date.now(), expiresAt = now + days * 86400000
  const vouchers = await Promise.all(Array.from({ length: quantity }, async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    const code = 'XG-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
    return { id: id('vch'), code, codeHash: await sha256(code), product_code: productCode, expires_at: expiresAt }
  }))
  await env.DB.batch([
    ...vouchers.map(voucher => env.DB.prepare(
      'INSERT INTO vouchers(id,batch_id,batch_label,user_id,product_code,code_hash,last_four,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).bind(voucher.id, batchId, batchLabel, userId, productCode, voucher.codeHash, voucher.code.slice(-4), now, expiresAt)),
    env.DB.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').bind(
      id('audit'), scope ? userId : 'admin', 'issue_vouchers', batchId,
      JSON.stringify({ user_id: userId, product_code: productCode, quantity, expires_at: expiresAt, batch_label: batchLabel }), now,
    ),
  ])
  return {
    batch_id: batchId,
    vouchers: vouchers.map(({ codeHash: _hash, ...voucher }) => voucher),
  }
}

export type VoucherFilters = { status?: string; q?: string; user_id?: string }

export async function listVouchers(env: Env, offset: number, filters: VoucherFilters = {}, scope?: MerchantVoucherScope) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    fail('invalid_input', '卡密分页参数无效。')
  const status = filters.status?.trim() ?? ''
  const query = filters.q?.trim() ?? ''
  const owner = scope ? text(scope.userId, '所属商户', 80) : filters.user_id?.trim() ?? ''
  if (!['', 'available', 'active', 'redeemed', 'revoked', 'expired'].includes(status))
    fail('invalid_input', '卡密状态筛选无效。')
  if (query.length > 80 || owner.length > 80)
    fail('invalid_input', '商户或批次查询不能超过 80 个字符。')
  const conditions: string[] = [], values: (string | number)[] = []
  const now = Date.now()
  if (status === 'available' || status === 'active' || status === 'expired') {
    conditions.push(`v.status='active' AND v.expires_at${status === 'expired' ? '<=' : '>'}?`)
    values.push(now)
  } else if (status) {
    conditions.push('v.status=?')
    values.push(status)
  }
  if (owner) { conditions.push('v.user_id=?'); values.push(owner) }
  if (query) {
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
    conditions.push("(v.batch_label LIKE ? ESCAPE '\\' OR v.batch_id LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR v.user_id LIKE ? ESCAPE '\\')")
    values.push(pattern, pattern, pattern, pattern)
  }
  const rows = (await env.DB.prepare(
    `SELECT v.id,v.batch_id,v.batch_label,v.user_id,u.name user_name,v.product_code,p.name product_name,p.months,
     v.last_four,v.status,v.order_id,v.created_at,v.expires_at,v.redeemed_at,v.revoked_at,v.revocation_note,o.status order_status
     FROM vouchers v JOIN users u ON u.id=v.user_id JOIN products p ON p.code=v.product_code
     LEFT JOIN orders o ON o.id=v.order_id ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
     ORDER BY v.created_at DESC,v.id LIMIT 30 OFFSET ?`,
  ).bind(...values, offset).all<Pick<VoucherRecord, 'status' | 'expires_at'> & Record<string, unknown>>()).results
  return rows.map(row => ({ ...row, state: state(row) }))
}

export async function revokeVoucher(env: Env, voucherId: string, body: Record<string, unknown>, scope?: MerchantVoucherScope) {
  const note = text(body.note, '撤销说明', 300)
  const owner = scope ? text(scope.userId, '所属商户', 80) : null
  const ownerSql = owner ? ' AND user_id=?' : '', ownerValues = owner ? [owner] : []
  const changed = await env.DB.prepare(
    `UPDATE vouchers SET status='revoked',revoked_at=?,revocation_note=? WHERE id=?${ownerSql} AND status='active' AND order_id IS NULL RETURNING id`,
  ).bind(Date.now(), note, voucherId, ...ownerValues).first()
  if (!changed) {
    const existing = await env.DB.prepare('SELECT status FROM vouchers WHERE id=?' + ownerSql).bind(voucherId, ...ownerValues).first<{ status: string }>()
    if (!existing) fail('not_found', '卡密不存在。', 404)
    fail('cannot_revoke', '卡密已兑换或已撤销，不能再次撤销。', 409)
  }
  await audit(env, owner ?? 'admin', 'revoke_voucher', voucherId, note)
  return { revoked: true }
}

/** Internal lookup. Never expose this record through an unauthenticated response. */
export async function inspectVoucher(env: Env, value: unknown) {
  const hash = await sha256(voucherCode(value))
  const voucher = await env.DB.prepare(
    'SELECT v.*,p.name product_name,p.months FROM vouchers v JOIN products p ON p.code=v.product_code WHERE v.code_hash=?',
  ).bind(hash).first<VoucherRecord>()
  if (!voucher) return fail('invalid_voucher', '卡密无效。', 404)
  let order: Order | undefined
  if (voucher.order_id) {
    const found = await env.DB.prepare('SELECT * FROM orders WHERE id=? AND voucher_id=?')
      .bind(voucher.order_id, voucher.id).first<Order>()
    if (!found) return fail('voucher_order_unavailable', '原订单暂时无法读取，请联系管理员。', 503)
    order = found
  }
  return { voucher, ...(order ? { order } : {}) }
}

export async function voucherPublicView(env: Env, code: unknown) {
  const { voucher, order } = await inspectVoucher(env, code)
  return customerView(voucher, order)
}

export async function redeemVoucher(env: Env, body: Record<string, unknown>) {
  const recipient = normalizeRecipient(body.recipient)
  const inspected = await inspectVoucher(env, body.code)
  const alreadyRedeemed = (existing: typeof inspected) => {
    if (!existing.order) return undefined
    if (existing.order.recipient !== recipient)
      fail('voucher_recipient_conflict', '卡密已绑定其他接收账号，不能修改。', 409)
    return { ...customerView(existing.voucher, existing.order), created: false }
  }
  const previous = alreadyRedeemed(inspected)
  if (previous) return previous
  if (state(inspected.voucher) !== 'available')
    fail('voucher_unavailable', '卡密已撤销或已过期。', 409)
  if (!executionReady(env))
    fail('execution_disabled', '自动支付尚未配置或已暂停，卡密尚未使用。', 503)
  const recipientId = text(body.recipient_id, '已确认的接收账号身份', 25)
  if (!/^\d{1,25}$/.test(recipientId)) fail('invalid_input', '请先检测接收账号。')

  try {
    const voucher = inspected.voucher
    const price = await env.DB.prepare(
      `SELECT COALESCE(up.points,p.points) points FROM products p JOIN users u ON u.id=?
       LEFT JOIN user_prices up ON up.user_id=u.id AND up.product_code=p.code
       WHERE p.code=? AND p.enabled=1 AND u.enabled=1`,
    ).bind(voucher.user_id, voucher.product_code).first<{ points: number }>()
    if (!price) return fail('product_unavailable', '当前套餐暂不可兑换，请联系管理员。', 409)
    // Both native and remote execution must bind the identity the holder confirmed.
    const checked = await eligibility(env, recipient)
    if (!checked.eligible || !checked.recipient_id)
      fail('not_eligible', '该账号当前不能接收赠送。', 409)
    if (checked.recipient_id !== recipientId)
      fail('recipient_changed', '接收账号身份已变化，请重新检测。', 409)
    const result = await createOrder(env, voucher.user_id, 'voucher:' + voucher.id, {
      merchant_order_no: 'voucher:' + voucher.id,
      product_code: voucher.product_code,
      recipient,
      recipient_id: checked.recipient_id,
      expected_points: price.points,
    }, { voucherId: voucher.id, verifiedRecipientId: checked.recipient_id })
    return { ...await voucherPublicView(env, body.code), created: result.created }
  } catch (error) {
    // Concurrent redemption may have won while eligibility was being checked.
    const raced = alreadyRedeemed(await inspectVoucher(env, body.code))
    if (raced) return raced
    if (error instanceof Error && error.message.includes('voucher_unavailable'))
      fail('voucher_unavailable', '卡密已撤销、过期或已被兑换。', 409)
    throw error
  }
}
