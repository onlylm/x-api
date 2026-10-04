import { audit, booleanInt, constantEqual, fail, Failure, id, integer, passwordHash, seal, sha256, text, token, unseal, type Env } from './core.ts'
import type { AlipayConfig } from '../server/alipay.ts'
import { eligibility } from './network.ts'
import { createOrder, credit, orderCapabilities, type Order } from './orders.ts'
import { paymentSettings, resolvePaymentEnv } from './payments.ts'

type Row = Record<string, unknown>
type Settings = { enabled: boolean; revision: string; updated_at: number; config: AlipayConfig }
type Checkout = {
  id: string; access_hash: string; request_hash: string; out_trade_no: string; trade_no: string | null;
  product_code: string; product_name: string; months: number; points: number; currency: string; amount_minor: number;
  stripe_product: string; amount_cents: number; recipient: string; recipient_id: string;
  provider_revision: string; outbound_revision: string; config_payload: string;
  status: 'creating' | 'pending' | 'paid' | 'closed' | 'failed' | 'fulfilled' | 'attention';
  qr_deadline_enforced: number;
  paid_at: number | null; qr_code: string | null; order_id: string | null; failure_code: string | null;
  created_at: number; expires_at: number; updated_at: number; next_check: number; lease_until: number; work_token: string | null;
}
const pendingSql = "SELECT 1 FROM alipay_checkouts WHERE status IN('creating','pending','paid','attention')"
const settlementId = 'usr_' + '0'.repeat(28) + 'a11a'
const money = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
function cents(value: unknown, allowZero = false) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(value))
    return fail('invalid_amount', '人民币金额须为非负数字，最多两位小数。')
  const [whole, fraction = ''] = value.split('.')
  return integer(Number(whole) * 100 + Number(fraction.padEnd(2, '0')), '人民币金额（分）', allowZero ? 0 : 1, 1000000)
}
function origin(env: Env) {
  const url = new URL(env.PUBLIC_ORIGIN ?? 'https://invalid.invalid')
  if (!env.PUBLIC_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    return fail('public_origin_missing', '服务器尚未配置有效的 HTTPS 站点地址。', 503)
  return url.origin
}
export async function alipaySettings(env: Env): Promise<Settings | null> {
  const row = await env.DB.prepare('SELECT * FROM alipay_settings WHERE id=1').first<{ enabled: number; revision: string; payload: string; updated_at: number }>()
  if (!row) return null
  return { enabled: !!row.enabled, revision: row.revision, updated_at: row.updated_at,
    config: JSON.parse(await unseal(env, 'alipay-settings', row.payload)) }
}
function client(env: Env, config: AlipayConfig) {
  if (!env.ALIPAY_CLIENT) return fail('alipay_unavailable', '当前服务器不支持支付宝收款。', 503)
  try { return env.ALIPAY_CLIENT(config) } catch { return fail('alipay_configuration_invalid', '支付宝密钥或商户配置格式无效，请检查 RSA2 公钥模式配置。', 409) }
}
async function prices(env: Env) {
  return (await env.DB.prepare(`SELECT p.code product_code,p.name,p.months,COALESCE(a.amount_cents,0) amount_cents,
    COALESCE(a.enabled,0) enabled,p.enabled product_enabled FROM products p LEFT JOIN alipay_prices a ON a.product_code=p.code ORDER BY p.months`).all<Row>()).results
}
export async function alipayView(env: Env) {
  const settings = await alipaySettings(env)
  const pending = await env.DB.prepare(`SELECT COUNT(*) n FROM alipay_checkouts WHERE status IN('creating','pending','paid','attention')`).first<{ n: number }>()
  const effective = await resolvePaymentEnv(env)
  const capability = await orderCapabilities(effective)
  const list = await prices(env)
  let notify = ''
  try { notify = origin(env) + '/api/alipay/notify' } catch { /* Report the missing prerequisite below. */ }
  const checks = [
    { code: 'configured', label: '已保存支付宝应用及 RSA2 密钥', ok: !!settings },
    { code: 'runtime', label: '服务器支持支付宝签名与验签', ok: !!env.ALIPAY_CLIENT },
    { code: 'production', label: '支付宝为正式环境（沙盒不会发放真实套餐）', ok: settings?.config.environment === 'production' },
    { code: 'notify', label: 'HTTPS 支付结果通知地址已配置', ok: !!notify },
    { code: 'prices', label: '至少一个已启用套餐有人民币售价', ok: list.some(p => p.enabled && p.product_enabled && Number(p.amount_cents) > 0) },
    { code: 'outbound', label: 'X 指定卡支付已就绪', ok: capability.execution_ready && !!effective.PAYMENT_SETTINGS?.card_id },
  ]
  return { configured: !!settings, enabled: settings?.enabled ?? false, revision: settings?.revision ?? null,
    environment: settings?.config.environment ?? 'sandbox', app_id: settings?.config.app_id ?? '', seller_id: settings?.config.seller_id ?? '',
    has_app_private_key: !!settings?.config.app_private_key, has_alipay_public_key: !!settings?.config.alipay_public_key,
    notify_url: notify, prices: list.map(p => ({ product_code: p.product_code, name: p.name, months: p.months,
      amount_cny: Number(p.amount_cents) > 0 ? money(Number(p.amount_cents)) : '', enabled: !!p.enabled })),
    checks, ready: checks.every(c => c.ok), unsettled_count: pending?.n ?? 0 }
}
export async function configureAlipay(env: Env, body: Row) {
  const old = await alipaySettings(env)
  if (body.revision !== (old?.revision ?? null)) return fail('alipay_config_conflict', '配置已变化，请刷新后再保存。', 409)
  if (old?.enabled) return fail('alipay_must_be_paused', '请先暂停支付宝收款，再修改配置。', 409)
  if (await env.DB.prepare(pendingSql + ' LIMIT 1').first()) return fail('alipay_orders_pending', '尚有待付款或待处理订单，请先核对原订单。', 409)
  const environment = text(body.environment, '支付宝环境', 16)
  if (!['production', 'sandbox'].includes(environment)) return fail('invalid_input', '请选择正式或沙盒环境。')
  const app_id = text(body.app_id, '支付宝 APPID', 32), seller_id = text(body.seller_id, '收款商户 PID', 32)
  if (!/^\d{16}$/.test(app_id) || !/^\d{16}$/.test(seller_id)) return fail('invalid_input', 'APPID 和收款商户 PID 须为 16 位数字。')
  const sameApp = old?.config.app_id === app_id && old.config.environment === environment
  const config: AlipayConfig = { environment: environment as AlipayConfig['environment'], app_id, seller_id,
    app_private_key: body.app_private_key === '' && sameApp ? old!.config.app_private_key : text(body.app_private_key, '应用私钥（RSA2）', 6000),
    alipay_public_key: body.alipay_public_key === '' && sameApp ? old!.config.alipay_public_key : text(body.alipay_public_key, '支付宝公钥', 2000) }
  client(env, config) // Offline validation only; no payment or gateway call.
  if (!Array.isArray(body.prices) || body.prices.length > 20) return fail('invalid_input', '请配置套餐人民币售价。')
  const products = await prices(env), seen = new Set<string>()
  const values = body.prices.map((p: Row) => {
    if (!p || typeof p !== 'object') return fail('invalid_input', '套餐售价格式无效。')
    const code = text(p.product_code, '套餐编号', 64)
    if (!products.some(x => x.product_code === code) || seen.has(code)) return fail('invalid_input', '套餐编号重复或不存在。')
    seen.add(code)
    const enabled = booleanInt(p.enabled), amount = p.amount_cny === '' && !enabled ? 0 : cents(p.amount_cny, !enabled)
    return { code, enabled, amount }
  })
  if (seen.size !== products.length) return fail('invalid_input', '请提交完整套餐报价列表。')
  const revision = id('alicfg'), now = Math.max(Date.now(), (old?.updated_at ?? 0) + 1)
  const payload = await seal(env, 'alipay-settings', JSON.stringify(config))
  const change = old
    ? env.DB.prepare(`UPDATE alipay_settings SET revision=?,payload=?,updated_at=? WHERE id=1 AND enabled=0 AND revision=? AND updated_at=? AND NOT EXISTS(${pendingSql})`)
      .bind(revision, payload, now, old.revision, old.updated_at)
    : env.DB.prepare(`INSERT INTO alipay_settings SELECT 1,0,?,?,? WHERE NOT EXISTS(SELECT 1 FROM alipay_settings) AND NOT EXISTS(${pendingSql}) ON CONFLICT(id) DO NOTHING`).bind(revision, payload, now)
  await env.DB.batch([change, ...values.map(v => env.DB.prepare(`INSERT INTO alipay_prices SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM alipay_settings WHERE revision=?)
      ON CONFLICT(product_code) DO UPDATE SET amount_cents=excluded.amount_cents,enabled=excluded.enabled,updated_at=excluded.updated_at`).bind(v.code, v.amount, v.enabled, now, revision))])
  if ((await alipaySettings(env))?.revision !== revision) return fail('alipay_config_conflict', '订单或配置状态刚发生变化，请刷新。', 409)
  await audit(env, 'admin', 'configure_alipay', revision)
  return alipayView(env)
}
export async function enableAlipay(env: Env, body: Row) {
  const enabled = booleanInt(body.enabled)
  if (!enabled) {
    await env.DB.prepare('UPDATE alipay_settings SET enabled=0,updated_at=MAX(updated_at+1,?) WHERE id=1').bind(Date.now()).run()
    await audit(env, 'admin', 'pause_alipay', 'alipay')
    return { paused: true, enabled: false }
  }
  if (body.confirmation !== 'ENABLE_ALIPAY') return fail('confirmation_required', '请输入 ENABLE_ALIPAY 确认开放真实收款。')
  const settings = await alipaySettings(env)
  if (!settings || body.revision !== settings.revision) return fail('alipay_config_conflict', '请先保存配置并刷新页面。', 409)
  if (!(await alipayView(env)).ready) return fail('alipay_not_ready', '收款前置条件未满足，请检查后台状态。', 409)
  const changed = await env.DB.prepare('UPDATE alipay_settings SET enabled=1,updated_at=? WHERE id=1 AND revision=? AND updated_at=? RETURNING id')
    .bind(Math.max(Date.now(), settings.updated_at + 1), settings.revision, settings.updated_at).first()
  if (!changed) return fail('alipay_config_conflict', '启停状态已变化，请刷新。', 409)
  await audit(env, 'admin', 'enable_alipay', settings.revision)
  return alipayView(env)
}
export async function checkoutCatalog(env: Env) {
  const settings = await alipaySettings(env), effective = await resolvePaymentEnv(env)
  const caps = await orderCapabilities(effective)
  const busy = !!(await env.DB.prepare(pendingSql + ' LIMIT 1').first())
  const available = !!settings?.enabled && settings.config.environment === 'production' && !!env.ALIPAY_CLIENT &&
    !!effective.PAYMENT_SETTINGS?.card_id && caps.accepts_orders && !busy
  return { available, reason: available ? null : '当前暂未开放扫码购买，已有付款仍可查询；请勿重复付款。',
    payment_label: '支付宝当面付', products: (await prices(env)).filter(p => p.enabled && p.product_enabled && Number(p.amount_cents) > 0)
      .map(p => ({ code: p.product_code, name: p.name, months: p.months, price_cny: money(Number(p.amount_cents)) })) }
}
export async function checkoutEligibility(env: Env, body: Row) {
  const catalog = await checkoutCatalog(env)
  if (!catalog.available || !catalog.products.some(p => p.code === body.product_code)) return fail('checkout_unavailable', '当前套餐暂不可购买，请稍后再试。', 409)
  return eligibility(env, body.username)
}
async function record(env: Env, checkoutId: string) {
  return env.DB.prepare('SELECT * FROM alipay_checkouts WHERE id=?').bind(checkoutId).first<Checkout>()
}
async function publicCheckout(env: Env, row: Checkout) {
  const order = row.order_id ? await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(row.order_id).first<Order>() : null
  const paid = row.paid_at !== null
  const fulfillment = order?.status === 'succeeded' ? 'succeeded' :
    row.status === 'attention' || order?.status === 'unknown' || order?.status === 'failed' ? 'attention' :
    order ? 'processing' : paid ? 'waiting_execution' : 'waiting_payment'
  const payment = paid ? 'paid' : ['closed', 'failed'].includes(row.status) ? row.status : row.status === 'creating' ? 'creating' : 'pending'
  return { id: row.id, product_name: row.product_name, months: row.months, recipient: row.recipient,
    amount_cny: money(row.amount_cents), paid, payment_status: payment, fulfillment_status: fulfillment,
    qr_code: !paid && fulfillment !== 'attention' && Date.now() < row.expires_at && payment === 'pending' ? row.qr_code : null,
    expires_at: row.expires_at, order_id: row.order_id,
    message: fulfillment === 'succeeded' ? '赠送结账已完成，请到 X 核对接收账号权益。' :
      fulfillment === 'attention' ? '付款或赠送结果需人工核对，请联系站点管理员。请勿重复付款。' :
      paid ? '已确认支付宝收款，正在处理 X 赠送订单。请勿重复付款。' :
      payment === 'closed' || payment === 'failed' ? '本次付款窗口已关闭；如已扣款，请继续查询原订单并联系管理员核对。' :
      Date.now() >= row.expires_at ? '二维码已过期，正在核对原付款状态，请勿重新付款。' :
      payment === 'creating' ? '正在确认支付二维码，请保留此页面。' : '请核对套餐、接收账号和人民币金额，再使用支付宝扫码。' }
}
async function configFor(env: Env, row: Checkout): Promise<AlipayConfig> {
  return JSON.parse(await unseal(env, 'alipay-checkout:' + row.id, row.config_payload))
}
async function precreate(env: Env, row: Checkout) {
  const settings = await alipaySettings(env)
  // Pausing collection prevents creating new QR codes, not processing already paid invoices.
  if (!settings?.enabled || settings.revision !== row.provider_revision || Date.now() >= row.expires_at) return
  const remainingMinutes = Math.floor((row.expires_at - Date.now()) / 60000)
  if (remainingMinutes < 1) return
  try {
    const config = await configFor(env, row)
    const result = await client(env, config).precreate({ out_trade_no: row.out_trade_no, total_amount: money(row.amount_cents),
      subject: `${row.product_name} · ${row.recipient}`, notify_url: origin(env) + '/api/alipay/notify',
      timeout_express: `${remainingMinutes}m`, qr_code_timeout_express: `${remainingMinutes}m` })
    const qr = new URL(result.qr_code)
    if (result.out_trade_no !== row.out_trade_no || qr.protocol !== 'https:' ||
        !(qr.hostname === 'qr.alipay.com' || qr.hostname.endsWith('.alipay.com')) || qr.username || qr.password)
      throw new Error('invalid_qr')
    await env.DB.prepare("UPDATE alipay_checkouts SET status='pending',qr_code=?,updated_at=?,failure_code=NULL WHERE id=? AND status='creating' AND paid_at IS NULL")
      .bind(result.qr_code, Date.now(), row.id).run()
  } catch {
    await env.DB.prepare("UPDATE alipay_checkouts SET failure_code='payment_creation_unconfirmed',next_check=? WHERE id=? AND status='creating'")
      .bind(Date.now() + 15000, row.id).run()
  }
}
export async function createCheckout(env: Env, body: Row) {
  const requestId = text(body.request_id, '购买请求编号', 32), access = text(body.access_token, '查询凭证', 64)
  if (!/^[a-f0-9]{32}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(access)) return fail('invalid_input', '购买请求凭证无效。')
  const checkoutId = 'chk_' + requestId
  const code = text(body.product_code, '套餐编号', 64)
  const username = text(body.username, 'X 用户名', 16).replace(/^@/, '').toLowerCase()
  const recipientId = text(body.recipient_id, '已核验接收账号', 25)
  const expectedAmount = cents(body.expected_amount_cny)
  if (!/^[a-z0-9_]{1,15}$/.test(username) || !/^\d{1,25}$/.test(recipientId)) return fail('invalid_input', '请先核验接收账号。')
  const accessHash = await sha256(access), digest = await sha256(JSON.stringify({ code, username, recipientId, expectedAmount }))
  const previous = await record(env, checkoutId)
  if (previous) {
    if (!constantEqual(previous.access_hash, accessHash)) return fail('not_found', '购买记录不存在或凭证无效。', 404)
    if (previous.request_hash !== digest) return fail('checkout_conflict', '这次购买已绑定原套餐和账号，请查询原订单。', 409)
    return publicCheckout(env, previous)
  }
  const catalog = await checkoutCatalog(env)
  if (!catalog.available) return fail('checkout_unavailable', '当前暂不接受新的扫码购买，请稍后再试。', 409)
  const check = await eligibility(env, username)
  if (!check.eligible || check.recipient_id !== recipientId) return fail('recipient_changed', '接收账号未通过核验，请重新检查。', 409)
  const settings = await alipaySettings(env), payment = await paymentSettings(env)
  if (!settings?.enabled || settings.config.environment !== 'production' || !payment?.enabled)
    return fail('checkout_unavailable', '收款或付款服务已暂停。', 409)
  const product = await env.DB.prepare(`SELECT p.*,a.amount_cents FROM products p JOIN alipay_prices a ON a.product_code=p.code
    WHERE p.code=? AND p.enabled=1 AND a.enabled=1 AND a.amount_cents>0`).bind(code).first<Row>()
  if (!product) return fail('product_unavailable', '套餐暂不可购买。', 409)
  if (Number(product.amount_cents) !== expectedAmount) return fail('checkout_price_changed', '人民币售价已变化，请刷新并重新确认金额。', 409)
  if (product.currency !== 'bdt' || !((Number(product.months) === 3 && Number(product.amount_minor) === 30000 && product.stripe_product === 'prod_TJXJtpzqCpI36N') ||
    (Number(product.months) === 6 && Number(product.amount_minor) === 60000 && product.stripe_product === 'prod_TJXKKNJwZJIhCM')))
    return fail('product_unavailable', '套餐尚未满足赠送验收条件。', 409)
  const now = Date.now(), expires = now + 15 * 60000
  const payload = await seal(env, 'alipay-checkout:' + checkoutId, JSON.stringify(settings.config))
  try {
    const inserted = await env.DB.prepare(`INSERT INTO alipay_checkouts(id,access_hash,request_hash,out_trade_no,product_code,product_name,months,points,currency,amount_minor,stripe_product,
      amount_cents,recipient,recipient_id,provider_revision,outbound_revision,config_payload,status,qr_deadline_enforced,created_at,expires_at,updated_at,next_check,lease_until)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'creating',1,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM alipay_settings WHERE id=1 AND enabled=1 AND revision=?)
      AND EXISTS(SELECT 1 FROM payment_settings WHERE id=1 AND enabled=1 AND revision=?)
      AND EXISTS(SELECT 1 FROM products p JOIN alipay_prices a ON a.product_code=p.code WHERE p.code=? AND p.enabled=1 AND a.enabled=1
        AND a.amount_cents=? AND p.months=? AND p.points=? AND p.currency=? AND p.amount_minor=? AND p.stripe_product=?)
      AND NOT EXISTS(SELECT 1 FROM orders WHERE status<>'failed') AND NOT EXISTS(${pendingSql}) RETURNING *`)
      .bind(checkoutId, accessHash, digest, 'xgift_' + requestId, code, String(product.name), Number(product.months), Number(product.points),
        String(product.currency), Number(product.amount_minor), String(product.stripe_product), Number(product.amount_cents), username, recipientId,
        settings.revision, payment.revision, payload, now, expires, now, now + 15000, now + 45000, settings.revision, payment.revision,
        code, expectedAmount, Number(product.months), Number(product.points), String(product.currency), Number(product.amount_minor), String(product.stripe_product)).first<Checkout>()
    if (!inserted) return fail('checkout_unavailable', '服务状态或验收名额已变化，请刷新。', 409)
    await precreate(env, inserted)
    await env.DB.prepare('UPDATE alipay_checkouts SET lease_until=0 WHERE id=? AND work_token IS NULL').bind(checkoutId).run()
    return publicCheckout(env, (await record(env, checkoutId))!)
  } catch (error) {
    const raced = await record(env, checkoutId)
    if (raced && constantEqual(raced.access_hash, accessHash) && raced.request_hash === digest) return publicCheckout(env, raced)
    if (error instanceof Failure) throw error
    return fail('checkout_busy', '当前已有购买正在处理，请勿重复提交。', 409)
  }
}
export async function checkoutStatus(env: Env, body: Row) {
  const checkoutId = text(body.checkout_id, '购买编号', 40), access = text(body.access_token, '查询凭证', 64)
  if (!/^chk_[a-f0-9]{32}$/.test(checkoutId) || !/^[a-f0-9]{64}$/.test(access)) return fail('not_found', '购买记录不存在或凭证无效。', 404)
  const row = await record(env, checkoutId)
  if (!row || !constantEqual(row.access_hash, await sha256(access))) return fail('not_found', '购买记录不存在或凭证无效。', 404)
  return publicCheckout(env, row)
}
async function observePayment(env: Env, row: Checkout, data: Row, config: AlipayConfig, notification: boolean) {
  if (config.environment !== 'production')
    return fail('alipay_sandbox_no_fulfillment', '沙盒付款不会发放真实套餐。', 409)
  if (data.out_trade_no !== row.out_trade_no || (notification && (data.app_id !== config.app_id || data.seller_id !== config.seller_id)) ||
      (data.app_id !== undefined && data.app_id !== config.app_id) || (data.seller_id !== undefined && data.seller_id !== config.seller_id) ||
      cents(data.total_amount) !== row.amount_cents) return fail('alipay_payment_mismatch', '收款身份、订单或金额不匹配。', 400)
  if (['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(data.trade_status))) {
    if (!/^\d{16,64}$/.test(String(data.trade_no ?? ''))) return fail('alipay_payment_mismatch', '支付宝交易编号无效。', 400)
    if (row.trade_no && row.trade_no !== data.trade_no) return fail('alipay_payment_mismatch', '支付宝交易编号不匹配。', 400)
    // CLOSED may mean fully refunded. A later-arriving success notification is
    // a reason to query, never authority to fulfill. Check the current SQL row
    // so a notification that read stale pending state cannot undo a closure.
    const conflict = "(?=1 AND (failure_code='payment_closed_unconfirmed' OR (paid_at IS NULL AND status IN('closed','attention'))))"
    const changed = await env.DB.prepare(`UPDATE alipay_checkouts SET
      status=CASE WHEN ${conflict} THEN 'attention' WHEN status='fulfilled' OR (paid_at IS NOT NULL AND status='attention' AND ?=1) THEN status ELSE 'paid' END,
      trade_no=COALESCE(trade_no,?),
      paid_at=CASE WHEN ${conflict} THEN paid_at ELSE COALESCE(paid_at,?) END,
      failure_code=CASE WHEN ${conflict} THEN CASE WHEN failure_code='payment_closed_unconfirmed' THEN failure_code ELSE 'payment_late_success_unconfirmed' END
        WHEN status='attention' AND paid_at IS NOT NULL AND ?=1 THEN failure_code ELSE NULL END,
      updated_at=MAX(updated_at+1,?),next_check=0 WHERE id=? AND (trade_no IS NULL OR trade_no=?)
      AND (?=1 OR updated_at=?) RETURNING id`)
      .bind(Number(notification), Number(notification), String(data.trade_no), Number(notification), Date.now(),
        Number(notification), Number(notification), Date.now(), row.id, String(data.trade_no), Number(notification), row.updated_at).first()
    if (!changed) {
      if (!notification) {
        // A callback arrived while the gateway query was in flight. Preserve it
        // and obtain a newer query instead of applying the older observation.
        await env.DB.prepare("UPDATE alipay_checkouts SET status='attention',failure_code='payment_late_success_unconfirmed',next_check=0 WHERE id=? AND status='closed' AND paid_at IS NULL")
          .bind(row.id).run()
        return fail('alipay_observation_changed', '付款状态刚发生变化，请重新核对原订单。', 409)
      }
      return fail('alipay_payment_mismatch', '支付宝交易编号不匹配。', 400)
    }
  } else if (data.trade_status === 'TRADE_CLOSED') {
    if (!/^\d{16,64}$/.test(String(data.trade_no ?? '')) || (row.trade_no && row.trade_no !== data.trade_no))
      return fail('alipay_payment_mismatch', '支付宝交易编号不匹配。', 400)
    await env.DB.prepare(`UPDATE alipay_checkouts SET status=CASE WHEN paid_at IS NULL THEN 'closed' ELSE 'attention' END,
      updated_at=MAX(updated_at+1,?),next_check=0,failure_code=CASE WHEN paid_at IS NULL THEN NULL ELSE 'payment_closed_unconfirmed' END
      WHERE id=? AND (trade_no IS NULL OR trade_no=?)`)
      .bind(Date.now(), row.id, String(data.trade_no)).run()
  }
}
export async function alipayNotification(env: Env, params: Record<string, string>) {
  if (!/^xgift_[a-f0-9]{32}$/.test(params.out_trade_no ?? '')) return false
  const row = await env.DB.prepare('SELECT * FROM alipay_checkouts WHERE out_trade_no=?').bind(params.out_trade_no).first<Checkout>()
  if (!row) return false
  const config = await configFor(env, row)
  if (config.environment !== 'production' || !client(env, config).verifyNotification(params)) return false
  await observePayment(env, row, params, config, true)
  return true
}
async function settlementAccount(env: Env) {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(settlementId).first()
  if (existing) return settlementId
  const salt = token(), hash = await passwordHash(token(), salt)
  await env.DB.prepare(`INSERT INTO users(id,name,email,password_hash,salt,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(settlementId, '支付宝收款结算（系统专用）', 'alipay-settlement@xgift.invalid', hash, salt, Date.now()).run()
  return settlementId
}
async function fulfill(env: Env, row: Checkout) {
  if (!row.paid_at) return
  if ((await configFor(env, row)).environment !== 'production') {
    await env.DB.prepare("UPDATE alipay_checkouts SET status='attention',failure_code='alipay_sandbox_no_fulfillment',updated_at=? WHERE id=?")
      .bind(Date.now(), row.id).run()
    return
  }
  // Preserve paid history, but never deliver against unresolved closure/refund evidence.
  if (row.failure_code === 'payment_closed_unconfirmed') return
  if (row.order_id) {
    const order = await env.DB.prepare('SELECT status FROM orders WHERE id=?').bind(row.order_id).first<{ status: string }>()
    if (order?.status === 'succeeded') await env.DB.prepare("UPDATE alipay_checkouts SET status='fulfilled',updated_at=? WHERE id=? AND failure_code IS NOT 'payment_closed_unconfirmed'").bind(Date.now(), row.id).run()
    else if (order?.status === 'failed' || order?.status === 'unknown')
      await env.DB.prepare("UPDATE alipay_checkouts SET status='attention',failure_code='gift_requires_review',updated_at=? WHERE id=? AND failure_code IS NOT 'payment_closed_unconfirmed'").bind(Date.now(), row.id).run()
    return
  }
  try {
    const effective = await resolvePaymentEnv(env), payment = await paymentSettings(env)
    if (!payment?.enabled || payment.revision !== row.outbound_revision) return fail('payment_configuration_changed', '付款配置已变化或暂停。', 409)
    const product = await env.DB.prepare('SELECT * FROM products WHERE code=? AND enabled=1').bind(row.product_code).first<Row>()
    if (!product || product.currency !== row.currency || Number(product.amount_minor) !== row.amount_minor ||
        product.stripe_product !== row.stripe_product || Number(product.months) !== row.months || Number(product.points) !== row.points)
      return fail('checkout_product_changed', '套餐配置已变化，需要人工核对。', 409)
    const resumed = await env.DB.prepare("UPDATE alipay_checkouts SET status='paid',failure_code=NULL,updated_at=? WHERE id=? AND paid_at IS NOT NULL AND status IN('paid','attention') AND failure_code IS NOT 'payment_closed_unconfirmed' RETURNING id")
      .bind(Date.now(), row.id).first()
    if (!resumed) return
    const userId = await settlementAccount(env)
    await credit(env, userId, { points: row.points, reference: 'alipay:' + row.id, note: '支付宝收款核验后的系统订单结算' }, 'alipay')
    const result = await createOrder(effective, userId, 'alipay:' + row.id, { merchant_order_no: 'alipay:' + row.id,
      product_code: row.product_code, recipient: row.recipient, recipient_id: row.recipient_id, expected_points: row.points }, { alipayCheckoutId: row.id })
    await env.DB.prepare("UPDATE alipay_checkouts SET order_id=?,status=CASE WHEN failure_code='payment_closed_unconfirmed' THEN status ELSE 'paid' END,failure_code=CASE WHEN failure_code='payment_closed_unconfirmed' THEN failure_code ELSE NULL END,updated_at=? WHERE id=? AND paid_at IS NOT NULL AND (order_id IS NULL OR order_id=?)")
      .bind(result.order.id, Date.now(), row.id, result.order.id).run()
  } catch (error) {
    await env.DB.prepare("UPDATE alipay_checkouts SET status='attention',failure_code=CASE WHEN failure_code='payment_closed_unconfirmed' THEN failure_code ELSE ? END,updated_at=? WHERE id=? AND order_id IS NULL")
      .bind(error instanceof Failure ? error.code : 'gift_creation_unconfirmed', Date.now(), row.id).run()
  }
}
export async function reconcileAlipay(env: Env) {
  if (!env.ALIPAY_CLIENT) return
  const now = Date.now(), work = id('aliwork')
  const row = await env.DB.prepare(`UPDATE alipay_checkouts SET work_token=?,lease_until=? WHERE id=(SELECT id FROM alipay_checkouts
    WHERE status IN('creating','pending','paid','attention') AND lease_until<=? AND next_check<=? ORDER BY next_check,created_at LIMIT 1) RETURNING *`)
    .bind(work, now + 90000, now, now).first<Checkout>()
  if (!row) return
  try {
    const config = await configFor(env, row)
    if (config.environment !== 'production') {
      await env.DB.prepare("UPDATE alipay_checkouts SET status='attention',failure_code='alipay_sandbox_no_fulfillment',updated_at=? WHERE id=?")
        .bind(Date.now(), row.id).run()
      return
    }
    if (row.paid_at !== null && row.failure_code !== 'payment_closed_unconfirmed') await fulfill(env, row)
    else {
      const result = await client(env, config).query(row.out_trade_no)
      if (result.found) await observePayment(env, row, result as unknown as Row, config, false)
      else if (row.status === 'creating' && now < row.expires_at) await precreate(env, row)
      if (row.qr_deadline_enforced === 1 && now >= row.expires_at + 120000 && row.paid_at === null && !row.order_id &&
          ['creating', 'pending'].includes(row.status) && (!result.found || result.trade_status === 'WAIT_BUYER_PAY')) {
        const gateway = client(env, config), closed = await gateway.close(row.out_trade_no)
        const verified = await gateway.query(row.out_trade_no)
        if (verified.found) await observePayment(env, row, verified as unknown as Row, config, false)
        else if (closed.closed || closed.not_found) {
          // Both gateway results are signed. A new-version QR has an explicit
          // deadline that retries cannot extend. Keep the record for late evidence.
          await env.DB.prepare(`UPDATE alipay_checkouts SET status='closed',failure_code='payment_window_expired',updated_at=MAX(updated_at+1,?)
            WHERE id=? AND updated_at=? AND work_token=? AND qr_deadline_enforced=1 AND paid_at IS NULL AND order_id IS NULL
            AND status IN('creating','pending') AND trade_no IS NULL`)
            .bind(Date.now(), row.id, row.updated_at, work).run()
        }
      }
      // A timeout alone is never proof of non-payment; keep polling the same merchant order.
      const latest = (await record(env, row.id))!
      if (latest.paid_at !== null) await fulfill(env, latest)
    }
  } catch {
    await env.DB.prepare("UPDATE alipay_checkouts SET failure_code='payment_query_unconfirmed' WHERE id=? AND paid_at IS NULL").bind(row.id).run()
  } finally {
    await env.DB.prepare('UPDATE alipay_checkouts SET lease_until=0,next_check=? WHERE id=? AND work_token=?')
      .bind(Date.now() + (row.paid_at !== null ? 5000 : 15000), row.id, work).run()
  }
}
export async function alipayOrders(env: Env, offset = 0) {
  return (await env.DB.prepare(`SELECT id,out_trade_no,trade_no,product_name,months,recipient,amount_cents,status,paid_at,order_id,failure_code,created_at,updated_at
    FROM alipay_checkouts ORDER BY created_at DESC LIMIT 30 OFFSET ?`).bind(offset).all<Row>()).results.map(r => ({ ...r, amount_cny: money(Number(r.amount_cents)) }))
}
