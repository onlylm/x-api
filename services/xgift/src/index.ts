import {
  createKey,
  createUser,
  login,
  logout,
  session,
  setUserEnabled,
  signedUser,
} from './auth.ts'
import {
  audit,
  booleanInt,
  browserWrite,
  fail,
  Failure,
  id,
  integer,
  json,
  limit,
  parseBody,
  rawBody,
  text,
  passwordHash,
  token,
  sha256,
  type Env,
} from './core.ts'
import { cleanup, reconcile } from './executor.ts'
import { adminApprovePayment, adminCheckOrder, adminCloseOrder, adminOrderCapabilities, adminPaymentPage } from './admin-order-actions.ts'
import {
  cardConfiguration,
  configureCards,
  cardRead,
  syncCardList,
  cardWrite,
  cardOperations,
  resolveCardOperation,
} from './cards.ts'
import {
  proxyTest,
  quote,
  saveSecret,
  secretList,
  updateAccountLimit,
  eligibility,
} from './network.ts'
import { giftProfile, configureGiftProfile } from './gift-profile.ts'
import { configurePayments, paymentView, resolvePaymentEnv, setPaymentsEnabled, parseOrderPaymentSelection } from './payments.ts'
import { admissionView, configureAdmission, pauseAdmission } from './admission.ts'
import { alipayNotification, alipayOrders, alipayView, checkoutCatalog, checkoutEligibility, checkoutStatus,
  configureAlipay, createCheckout, enableAlipay, reconcileAlipay } from './alipay-payments.ts'
import {
  createOrder,
  credit,
  executionReady,
  orderCapabilities,
  getOrder,
  pagination,
  products,
  publicOrder,
  type Order,
} from './orders.ts'
import { configureWebhook, deliverWebhook } from './webhooks.ts'
import {
  inspectVoucher,
  issueVouchers,
  listVouchers,
  redeemVoucher,
  revokeVoucher,
  voucherPublicView,
} from './vouchers.ts'
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method
  if (path === '/healthz' && method === 'GET')
    return json({ ok: true, execution_ready: executionReady(env) })
  if (!path.startsWith('/api/') && !path.startsWith('/v1/'))
    return env.ASSETS.fetch(request)
  if (!['GET', 'POST'].includes(method))
    return fail('method_not_allowed', '请求方法不支持。', 405)
  const raw = method === 'POST' ? await rawBody(request) : '',
    data = method === 'POST' && path !== '/api/alipay/notify' ? parseBody(raw) : {}
  if (path.startsWith('/v1/')) {
    const userId = await signedUser(request, env, raw)
    if (path === '/v1/capabilities' && method === 'GET') {
      return json(await orderCapabilities(env))
    }
    if (path === '/v1/eligibility' && method === 'POST')
    {
      await limit(env, 'eligibility:' + userId, 20)
      return json(await eligibility(env, data.username))
    }
    if (path === '/v1/products' && method === 'GET')
      return json(await products(env, userId))
    if (path === '/v1/balance' && method === 'GET')
      return json(
        await env.DB.prepare(
          'SELECT available,frozen FROM wallets WHERE user_id=?',
        )
          .bind(userId)
          .first(),
      )
    if (path === '/v1/orders' && method === 'POST') {
      await limit(env, 'eligibility:' + userId, 20)
      const result = await createOrder(
        env,
        userId,
        request.headers.get('Idempotency-Key') ?? '',
        data,
      )
      return json(result.order, result.created ? 201 : 200)
    }
    if (path === '/v1/orders' && method === 'GET') {
      const merchant = url.searchParams.get('merchant_order_no')
      if (merchant) {
        const o = await env.DB.prepare(
          'SELECT * FROM orders WHERE user_id=? AND merchant_order_no=?',
        )
          .bind(userId, merchant)
          .first<Order>()
        if (!o) return fail('not_found', '订单不存在。', 404)
        return json(publicOrder(o))
      }
      const { offset } = pagination(url)
      return json(
        (
          await env.DB.prepare(
            'SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 30 OFFSET ?',
          )
            .bind(userId, offset)
            .all<Order>()
        ).results.map(publicOrder),
      )
    }
    const match = path.match(/^\/v1\/orders\/(ord_[a-f0-9]{32})$/)
    if (match && method === 'GET')
      return json(await getOrder(env, userId, match[1]))
    return fail('not_found', '接口不存在。', 404)
  }
  if (path === '/api/alipay/notify') {
    if (method !== 'POST' || !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded'))
      return new Response('failure', { status: 400 })
    try {
      const form = new URLSearchParams(raw), params: Record<string, string> = {}
      for (const [key, value] of form) {
        if (Object.hasOwn(params, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return new Response('failure', { status: 400 })
        params[key] = value
      }
      return new Response(await alipayNotification(env, params) ? 'success' : 'failure', { headers: { 'Cache-Control': 'no-store' } })
    } catch { return new Response('failure', { status: 400 }) }
  }
  if (method === 'POST') browserWrite(request)
  if (path === '/api/checkout/catalog' && method === 'GET') return json(await checkoutCatalog(env))
  if (path === '/api/checkout' || path.startsWith('/api/checkout/')) {
    if (method !== 'POST') fail('method_not_allowed', '请通过购买表单提交。', 405)
    await limit(env, 'checkout-ip:' + await sha256(request.headers.get('CF-Connecting-IP') ?? 'local'), path.endsWith('/status') ? 120 : 20)
    const checkoutData = data
    if (path === '/api/checkout/eligibility') return json(await checkoutEligibility(env, checkoutData))
    if (path === '/api/checkout/status') return json(await checkoutStatus(env, checkoutData))
    if (path === '/api/checkout') return json(await createCheckout(env, checkoutData))
    return fail('not_found', '接口不存在。', 404)
  }
  // Public readiness metadata lets the unauthenticated redemption page stay usable.
  if (path === '/api/capabilities' && method === 'GET')
    return json(await orderCapabilities(env))
  if (path === '/api/redeem' || path.startsWith('/api/redeem/')) {
    if (method !== 'POST') fail('method_not_allowed', '请通过表单提交卡密。', 405)
    if (!['/api/redeem', '/api/redeem/inspect', '/api/redeem/status', '/api/redeem/eligibility'].includes(path))
      fail('not_found', '接口不存在。', 404)
    await limit(env, 'redeem-ip:' + await sha256(request.headers.get('CF-Connecting-IP') ?? 'local'), 30)
    if (path === '/api/redeem/inspect' || path === '/api/redeem/status')
      return json(await voucherPublicView(env, data.code))
    const { voucher, order } = await inspectVoucher(env, data.code)
    if (!order) {
      await limit(env, 'redeem-check:' + voucher.id, 10)
      await limit(env, 'eligibility:' + voucher.user_id, 20)
    }
    if (path === '/api/redeem/eligibility') {
      const view = await voucherPublicView(env, data.code)
      if (view.state !== 'available')
        fail('voucher_unavailable', '卡密已使用、撤销或过期，请查询原兑换记录。', 409)
      if (!(await orderCapabilities(env)).accepts_orders)
        fail('execution_disabled', '暂时无法接收新订单，卡密尚未使用，请稍后再试。', 503)
      const available = await env.DB.prepare('SELECT u.id FROM users u JOIN products p ON p.code=? WHERE u.id=? AND u.enabled=1 AND p.enabled=1')
        .bind(voucher.product_code, voucher.user_id).first()
      if (!available) fail('voucher_unavailable', '该卡密暂时无法兑换，请联系发卡商户。', 409)
      return json(await eligibility(env, data.username))
    }
    const result = await redeemVoucher(env, data)
    return json(result, result.created ? 201 : 200)
  }
  if (path === '/api/login' && method === 'POST')
    return login(request, env, data)
  if (path === '/api/logout' && method === 'POST') return logout(request, env)
  if (path === '/api/session' && method === 'GET') {
    try {
      return json({ authenticated: true, ...(await session(request, env)) })
    } catch (e) {
      if (e instanceof Failure && e.status === 401)
        return json({ authenticated: false })
      throw e
    }
  }
  const principal = await session(request, env),
    admin = principal.role === 'admin',
    userId = principal.userId
  if (path.startsWith('/api/admin/')) {
    if (!admin) return fail('forbidden', '需要管理员权限。', 403)
    if (path === '/api/admin/vouchers' && method === 'GET')
      return json(await listVouchers(env, pagination(url).offset, {
        status: url.searchParams.get('status') ?? '', q: url.searchParams.get('q') ?? '', user_id: url.searchParams.get('user_id') ?? '',
      }))
    if (path === '/api/admin/vouchers' && method === 'POST') {
      await limit(env, 'voucher-issue:admin', 5)
      return json(await issueVouchers(env, data), 201)
    }
    const voucherRevoke = path.match(/^\/api\/admin\/vouchers\/(vch_[a-f0-9]{32})\/revoke$/)
    if (voucherRevoke && method === 'POST')
      return json(await revokeVoucher(env, voucherRevoke[1], data))
    if (path === '/api/admin/gift-profile' && method === 'GET')
      return json(await giftProfile(env))
    if (path === '/api/admin/gift-profile' && method === 'POST')
      return json(await configureGiftProfile(env, data))
    if (path === '/api/admin/card-provider') {
      return json(
        method === 'GET'
          ? await cardConfiguration(env)
          : await configureCards(env, data),
      )
    }
    if (path === '/api/admin/card-provider/operations' && method === 'GET')
      return json(await cardOperations(env, pagination(url).offset))
    const cardResolve = path.match(
      /^\/api\/admin\/card-provider\/operations\/(cop_[a-f0-9]{32})\/resolve$/,
    )
    if (cardResolve && method === 'POST')
      return json(await resolveCardOperation(env, cardResolve[1], data))
    if (path === '/api/admin/card-provider/cards/sync' && method === 'POST') {
      const { page } = pagination(url)
      await limit(env, 'card-list-refresh:admin', 10)
      return json(await syncCardList(env, data, page))
    }
    const cardResource = path.match(
      /^\/api\/admin\/card-provider\/(balance|products|cards)$/,
    )
    if (cardResource && method === 'GET')
      return json(await cardRead(env, cardResource[1], pagination(url).page))
    const cardDetail = path.match(
      /^\/api\/admin\/card-provider\/cards\/(\d+)\/(transactions|recharges)$/,
    )
    if (cardDetail && method === 'GET')
      return json(
        await cardRead(
          env,
          cardDetail[2],
          pagination(url).page,
          integer(Number(cardDetail[1]), '卡 ID'),
        ),
      )
    const cardMutation = path.match(
      /^\/api\/admin\/card-provider\/(open|recharge)$/,
    )
    if (cardMutation && method === 'POST')
      return json(
        await cardWrite(env, cardMutation[1] as 'open' | 'recharge', data),
      )
    if (path === '/api/admin/payments' && method === 'GET') return json(await paymentView(env))
    if (path === '/api/admin/admission' && method === 'GET') return json(await admissionView(await resolvePaymentEnv(env)))
    if (path === '/api/admin/admission/config' && method === 'POST') return json(await configureAdmission(await resolvePaymentEnv(env), data))
    if (path === '/api/admin/admission/enabled' && method === 'POST') return json(await pauseAdmission(env, data))
    if (path === '/api/admin/alipay' && method === 'GET') return json(await alipayView(env))
    if (path === '/api/admin/alipay/config' && method === 'POST') return json(await configureAlipay(env, data))
    if (path === '/api/admin/alipay/enabled' && method === 'POST') return json(await enableAlipay(env, data))
    if (path === '/api/admin/alipay/orders' && method === 'GET') return json(await alipayOrders(env, pagination(url).offset))
    if (path === '/api/admin/payments/config' && method === 'POST') return json(await configurePayments(env, data))
    if (path === '/api/admin/payments/enabled' && method === 'POST') return json(await setPaymentsEnabled(env, data))
    if (path === '/api/admin/overview' && method === 'GET') {
      const summary = await env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM users) users,(SELECT COALESCE(SUM(available),0) FROM wallets) available,(SELECT COALESCE(SUM(frozen),0) FROM wallets) frozen,(SELECT COUNT(*) FROM orders WHERE status IN('queued','running','unknown')) pending,(SELECT COUNT(*) FROM orders WHERE status='unknown') unknown,(SELECT COUNT(*) FROM webhook_deliveries WHERE status='dead') failed_webhooks",
      ).first<Record<string, number>>()
      return json({
        ...summary,
        execution_ready: executionReady(env),
        proxy_gateway_ready:
          !!env.OUTBOUND_FETCH ||
          (!!env.OUTBOUND_GATEWAY_URL && !!env.OUTBOUND_GATEWAY_SECRET),
      })
    }
    if (path === '/api/admin/users' && method === 'GET') {
      const { offset } = pagination(url)
      const search = (url.searchParams.get('q') ?? '').trim()
      if (search.length > 80) fail('invalid_input', '商户搜索最多 80 字。')
      return json(
        (
          await env.DB.prepare(
            `SELECT u.id,u.name,u.email,u.enabled,u.created_at,w.available,w.frozen FROM users u JOIN wallets w ON w.user_id=u.id
             WHERE (?='' OR instr(lower(u.name),lower(?))>0 OR instr(lower(u.id),lower(?))>0)
             ORDER BY u.created_at DESC,u.id DESC LIMIT 30 OFFSET ?`,
          )
            .bind(search, search, search, offset)
            .all()
        ).results,
      )
    }
    if (path === '/api/admin/users' && method === 'POST') {
      const result = await createUser(env, data)
      await audit(env, 'admin', 'create_user', result.id)
      return json(result, 201)
    }
    const userMatch = path.match(
      /^\/api\/admin\/users\/(usr_[a-f0-9]{32})\/(credit|enabled|password|keys|price)$/,
    )
    if (userMatch && userMatch[2] === 'keys' && method === 'GET')
      return json(
        (
          await env.DB.prepare(
            'SELECT id,label,revoked,created_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC',
          )
            .bind(userMatch[1])
            .all()
        ).results,
      )
    const adminRevoke = path.match(
      /^\/api\/admin\/keys\/(key_[a-f0-9]{32})\/revoke$/,
    )
    if (adminRevoke && method === 'POST') {
      const changed = await env.DB.prepare(
        'UPDATE api_keys SET revoked=1 WHERE id=? RETURNING id',
      )
        .bind(adminRevoke[1])
        .first()
      if (!changed) fail('not_found', '密钥不存在。', 404)
      await audit(env, 'admin', 'revoke_key', adminRevoke[1])
      return json({ revoked: true })
    }
    if (userMatch && method === 'POST') {
      const [, target, action] = userMatch
      if (action === 'credit')
        return json(await credit(env, target, data, 'admin'))
      if (action === 'enabled') await setUserEnabled(env, target, data.enabled)
      if (action === 'keys') {
        const result = await createKey(env, target, data.label)
        await audit(env, 'admin', 'create_key', result.key_id)
        return json(result, 201)
      }
      if (action === 'password') {
        const password = text(data.password, '新密码', 256)
        if (password.length < 12) fail('invalid_input', '密码至少 12 位。')
        const salt = token()
        const updated = await env.DB.prepare(
          'UPDATE users SET password_hash=?,salt=? WHERE id=? RETURNING id',
        )
          .bind(await passwordHash(password, salt), salt, target)
          .first()
        if (!updated) fail('not_found', '用户不存在。', 404)
      }
      if (action === 'price') {
        const product = text(data.product_code, '商品代码', 64)
        if (data.points === null)
          await env.DB.prepare(
            'DELETE FROM user_prices WHERE user_id=? AND product_code=?',
          )
            .bind(target, product)
            .run()
        else
          await env.DB.prepare(
            'INSERT INTO user_prices VALUES(?,?,?) ON CONFLICT(user_id,product_code) DO UPDATE SET points=excluded.points',
          )
            .bind(target, product, integer(data.points, '用户价格'))
            .run()
      }
      await audit(env, 'admin', 'user_' + action, target)
      return json({ saved: true })
    }
    if (path === '/api/admin/products' && method === 'GET')
      return json(
        (await env.DB.prepare('SELECT * FROM products ORDER BY months').all())
          .results,
      )
    if (path === '/api/admin/products' && method === 'POST') {
      const code = text(data.code, '商品代码', 64),
        currency = text(data.currency, '币种', 3).toLowerCase()
      if (!/^[a-z]{3}$/.test(currency))
        fail('invalid_input', '币种需为三位代码。')
      const row = await env.DB.prepare(
        'UPDATE products SET points=?,currency=?,amount_minor=?,enabled=? WHERE code=? RETURNING code',
      )
        .bind(
          integer(data.points, '点数价格'),
          currency,
          integer(data.amount_minor, '实际支付金额（最小单位）'),
          booleanInt(data.enabled),
          code,
        )
        .first()
      if (!row) fail('not_found', '商品不存在。', 404)
      await audit(env, 'admin', 'update_product', code)
      return json({ saved: true })
    }
    if (path === '/api/admin/secrets' && method === 'GET')
      return json(await secretList(env))
    if (path === '/api/admin/secrets' && method === 'POST') {
      const secretId = id('sec'),
        kind = text(data.kind, '类型', 16)
      const result = await saveSecret(env, secretId, kind, data)
      await audit(env, 'admin', 'create_' + kind, secretId)
      return json(result, 201)
    }
    const secretMatch = path.match(
      /^\/api\/admin\/secrets\/(sec_[a-f0-9]{32})\/(enabled|replace|test|quote|limit)$/,
    )
    if (secretMatch && method === 'POST') {
      const [, target, action] = secretMatch
      if (action === 'test') return json(await proxyTest(env, target))
      if (action === 'quote')
        return json(await quote(env, target, data.product_code))
      if (action === 'limit') {
        const result = await updateAccountLimit(env, target, data.daily_limit)
        await audit(env, 'admin', 'secret_limit', target)
        return json(result)
      }
      if (action === 'enabled') {
        const changed = await env.DB.prepare(
          'UPDATE secrets SET enabled=? WHERE id=? RETURNING id',
        )
          .bind(booleanInt(data.enabled), target)
          .first()
        if (!changed) fail('not_found', '配置不存在。', 404)
      }
      if (action === 'replace') {
        const row = await env.DB.prepare('SELECT kind FROM secrets WHERE id=?')
          .bind(target)
          .first<{ kind: string }>()
        if (!row) return fail('not_found', '配置不存在。', 404)
        await saveSecret(env, target, row.kind, data)
      }
      await audit(env, 'admin', 'secret_' + action, target)
      return json({ saved: true })
    }
    if (path === '/api/admin/reconcile' && method === 'POST') {
      const result = await reconcile(env)
      await audit(env, 'admin', 'reconcile', 'orders')
      return json(result)
    }
    const directGift = path.match(/^\/api\/admin\/users\/(usr_[a-f0-9]{32})\/gift\/(products|eligibility|orders)$/)
    if (directGift) {
      const [, target, resource] = directGift
      const merchant = await env.DB.prepare('SELECT id,enabled FROM users WHERE id=?').bind(target).first<{ id: string; enabled: number }>()
      if (!merchant) return fail('not_found', '扣点商户不存在。', 404)
      if (resource === 'orders' && method === 'GET') {
        const reference = text(url.searchParams.get('merchant_order_no'), '原商户订单号', 128)
        const original = await env.DB.prepare('SELECT * FROM orders WHERE user_id=? AND merchant_order_no=?').bind(target, reference).first<Order>()
        if (!original) return fail('not_found', '原订单不存在。', 404)
        return json(publicOrder(original))
      }
      if (resource === 'products' && method === 'GET') return json(await products(env, target))
      if (resource === 'eligibility' && method === 'POST') {
        if (!merchant.enabled) fail('merchant_disabled', '扣点商户已停用，请选择已启用商户。', 409)
        await limit(env, 'eligibility:admin-gift', 20)
        return json(await eligibility(env, data.username))
      }
      if (resource === 'orders' && method === 'POST') {
        if (data.manual_confirmation !== undefined && typeof data.manual_confirmation !== 'boolean')
          fail('invalid_input', '人工确认付款须为布尔选项。')
        if (data.confirmation !== 'GIFT') fail('confirmation_required', '请确认账号、套餐及商户扣点后赠送。')
        if (typeof data.recipient_id !== 'string' || !/^\d{1,25}$/.test(data.recipient_id)) fail('invalid_input', '请先核验接收账号。')
        integer(data.expected_points, '确认点数', 1, 100000000)
        if (!/^admin_[A-Za-z0-9_.:-]{8,120}$/.test(text(data.merchant_order_no, '商户订单号', 128))) fail('invalid_input', '管理员赠送凭证号无效。')
        await limit(env, 'eligibility:admin-gift', 20)
        const result = await createOrder(env, target, text(data.idempotency_key, '幂等键', 128), data, {
          paymentCardSelection: parseOrderPaymentSelection(data.payment_card_selection),
          manualConfirmation: data.manual_confirmation === true,
        })
        if (result.created) await audit(env, 'admin', 'direct_gift', result.order.id)
        return json(result.order, result.created ? 201 : 200)
      }
      return fail('not_found', '接口不存在。', 404)
    }
    if (path === '/api/admin/orders' && method === 'GET') {
      const { offset } = pagination(url)
      const status = url.searchParams.get('status') ?? '', search = (url.searchParams.get('q') ?? '').trim()
      if (status && !['queued', 'running', 'unknown', 'active', 'succeeded', 'failed'].includes(status))
        fail('invalid_input', '订单状态筛选无效。')
      if (search.length > 128) fail('invalid_input', '订单搜索最多 128 字。')
      const statusSql = status === 'active' ? "AND o.status IN('queued','running','unknown')" : status ? 'AND o.status=?' : ''
      const statusValues = status && status !== 'active' ? [status] : []
      const listed = (
          await env.DB.prepare(
            `SELECT o.*,u.name user_name,CASE WHEN o.status='queued' THEN (
              SELECT COUNT(*) FROM orders q WHERE q.status='queued' AND (q.created_at<o.created_at OR (q.created_at=o.created_at AND q.id<=o.id)))
              ELSE NULL END queue_position FROM orders o JOIN users u ON u.id=o.user_id
              WHERE 1=1 ${statusSql} AND (?='' OR instr(o.id,?)>0 OR instr(lower(o.recipient),lower(?))>0 OR instr(o.merchant_order_no,?)>0)
              ORDER BY ${status === 'queued' ? 'o.created_at,o.id' : 'o.created_at DESC,o.id DESC'} LIMIT 30 OFFSET ?`,
          )
            .bind(...statusValues, search, search, search.replace(/^@/, ''), search, offset)
            .all<Order & { user_name: string; queue_position: number | null }>()
        ).results
      return json(await Promise.all(listed.map(async (o) => ({
          ...publicOrder(o),
          user_name: o.user_name,
          user_id: o.user_id,
          queue_position: o.queue_position,
          actions: await adminOrderCapabilities(env, o),
        }))))
    }
    const orderAction = path.match(/^\/api\/admin\/orders\/(ord_[a-f0-9]{32})\/(payment-page|check|close|approve-payment)$/)
    if (orderAction) {
      const [, orderId, action] = orderAction
      if (action === 'approve-payment' && method === 'POST') {
        await limit(env, 'order-payment-approval:admin', 20)
        return json(await adminApprovePayment(env, orderId, data))
      }
      if (action === 'payment-page' && method === 'GET') {
        await limit(env, 'order-payment-page:admin', 30)
        return json(await adminPaymentPage(env, orderId))
      }
      if (action === 'check' && method === 'POST') {
        await limit(env, 'order-query:admin', 20)
        return json(await adminCheckOrder(env, orderId))
      }
      if (action === 'close' && method === 'POST') return json(await adminCloseOrder(env, orderId, data))
      return fail('method_not_allowed', '请求方法不支持。', 405)
    }
    const cancel = path.match(
      /^\/api\/admin\/orders\/(ord_[a-f0-9]{32})\/cancel$/,
    )
    if (cancel && method === 'POST') {
      const note = text(data.note, '取消说明', 300)
      await adminCloseOrder(env, cancel[1], { reason: note, confirmation: 'CLOSE_ORDER' }, true)
      return json({ cancelled: true })
    }
    if (
      ['/api/admin/ledger', '/api/admin/audit', '/api/admin/webhooks'].includes(
        path,
      ) &&
      method === 'GET'
    ) {
      const { offset } = pagination(url),
        table = path.endsWith('/ledger')
          ? 'ledger'
          : path.endsWith('/audit')
            ? 'audit'
            : 'webhook_deliveries'
      const selection =
        table === 'webhook_deliveries'
          ? 'order_id,user_id,event_id,url,attempts,next_at,status'
          : '*'
      const sort = table === 'webhook_deliveries' ? 'next_at' : 'created_at'
      return json(
        (
          await env.DB.prepare(
            `SELECT ${selection} FROM ${table} ORDER BY ${sort} DESC LIMIT 30 OFFSET ?`,
          )
            .bind(offset)
            .all()
        ).results,
      )
    }
    return fail('not_found', '接口不存在。', 404)
  }
  if (!userId) return fail('forbidden', '请登录用户账户。', 403)
  if (path === '/api/vouchers' && method === 'GET')
    return json(await listVouchers(env, pagination(url).offset, {
      status: url.searchParams.get('status') ?? '', q: url.searchParams.get('q') ?? '',
    }, { userId }))
  if (path === '/api/vouchers' && method === 'POST') {
    await limit(env, 'voucher-issue:' + userId, 5)
    return json(await issueVouchers(env, data, { userId }), 201)
  }
  const merchantVoucherRevoke = path.match(/^\/api\/vouchers\/(vch_[a-f0-9]{32})\/revoke$/)
  if (merchantVoucherRevoke && method === 'POST')
    return json(await revokeVoucher(env, merchantVoucherRevoke[1], data, { userId }))
  if (path === '/api/eligibility' && method === 'POST') {
    await limit(env, 'eligibility:' + userId, 20)
    return json(await eligibility(env, data.username))
  }
  if (path === '/api/me' && method === 'GET')
    return json(
      await env.DB.prepare(
        'SELECT u.id,u.name,u.email,w.available,w.frozen,(SELECT url FROM webhook_configs WHERE user_id=u.id) webhook_url FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.id=?',
      )
        .bind(userId)
        .first(),
    )
  if (path === '/api/products' && method === 'GET')
    return json(await products(env, userId))
  if (path === '/api/keys' && method === 'GET')
    return json(
      (
        await env.DB.prepare(
          'SELECT id,label,revoked,created_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC',
        )
          .bind(userId)
          .all()
      ).results,
    )
  if (path === '/api/keys' && method === 'POST') {
    const result = await createKey(env, userId, data.label)
    await audit(env, userId, 'create_key', result.key_id)
    return json(result, 201)
  }
  const revoke = path.match(/^\/api\/keys\/(key_[a-f0-9]{32})\/revoke$/)
  if (revoke && method === 'POST') {
    const changed = await env.DB.prepare(
      'UPDATE api_keys SET revoked=1 WHERE id=? AND user_id=? RETURNING id',
    )
      .bind(revoke[1], userId)
      .first()
    if (!changed) fail('not_found', '密钥不存在。', 404)
    await audit(env, userId, 'revoke_key', revoke[1])
    return json({ revoked: true })
  }
  if (path === '/api/webhook' && method === 'POST') {
    const result = await configureWebhook(env, userId, data.url)
    await audit(env, userId, 'configure_webhook', userId)
    return json(result)
  }
  if (path === '/api/orders' && method === 'POST') {
    await limit(env, 'eligibility:' + userId, 20)
    if (typeof data.recipient_id !== 'string' || !/^\d{1,25}$/.test(data.recipient_id))
      fail('invalid_input', '请先检测并确认接收账号。')
    integer(data.expected_points, '确认点数', 1, 100000000)
    const result = await createOrder(
      env,
      userId,
      text(data.idempotency_key, '幂等键', 128),
      data,
    )
    return json(result.order, result.created ? 201 : 200)
  }
  if (path === '/api/orders' && method === 'GET') {
    const merchant = url.searchParams.get('merchant_order_no')
    if (merchant) {
      const order = await env.DB.prepare('SELECT * FROM orders WHERE user_id=? AND merchant_order_no=?')
        .bind(userId, merchant).first<Order>()
      if (!order) return fail('not_found', '订单不存在。', 404)
      return json(publicOrder(order))
    }
    const { offset } = pagination(url)
    return json(
      (
        await env.DB.prepare(
          'SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 30 OFFSET ?',
        )
          .bind(userId, offset)
          .all<Order>()
      ).results.map(publicOrder),
    )
  }
  const browserOrder = path.match(/^\/api\/orders\/(ord_[a-f0-9]{32})$/)
  if (browserOrder && method === 'GET')
    return json(await getOrder(env, userId, browserOrder[1]))
  if (path === '/api/ledger' && method === 'GET') {
    const { offset } = pagination(url)
    return json(
      (
        await env.DB.prepare(
          'SELECT kind,available_delta,frozen_delta,note,reference,created_at FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 30 OFFSET ?',
        )
          .bind(userId, offset)
          .all()
      ).results,
    )
  }
  return fail('not_found', '接口不存在。', 404)
}
function secure(response: Response) {
  const result = new Response(response.body, response)
  result.headers.set('X-Content-Type-Options', 'nosniff')
  result.headers.set('Referrer-Policy', 'no-referrer')
  result.headers.set('X-Frame-Options', 'DENY')
  result.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  )
  return result
}
export default {
  async fetch(request: Request, env: Env) {
    try {
      if (env.LOCAL_ORIGIN && new URL(request.url).protocol === 'http:') {
        const local = new URL(env.LOCAL_ORIGIN)
        if (
          local.protocol !== 'http:' ||
          !['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)
        )
          fail('invalid_configuration', '本地预览地址无效。', 503)
        const incoming = new URL(request.url)
        const headers = new Headers(request.headers)
        if (headers.get('Origin') === incoming.origin)
          headers.set('Origin', local.origin)
        request = new Request(
          local.origin + incoming.pathname + incoming.search,
          request,
        )
        request = new Request(request, { headers })
      }
      const url = new URL(request.url)
      if (
        url.protocol !== 'https:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
        return secure(
          Response.json(
            { error: { code: 'https_required', message: '请使用 HTTPS。' } },
            { status: 403 },
          ),
        )
      const path = new URL(request.url).pathname
      const bypassPaymentResolution = path.startsWith('/api/admin/payments') || path.startsWith('/api/admin/admission') || path.startsWith('/api/admin/alipay') || path === '/api/alipay/notify'
      return secure(await route(request, bypassPaymentResolution ? env : await resolvePaymentEnv(env)))
    } catch (e) {
      return secure(
        Response.json(
          {
            error: {
              code: e instanceof Failure ? e.code : 'service_unavailable',
              message:
                e instanceof Failure
                  ? e.message
                  : '服务暂时不可用，请稍后重试。',
            },
          },
          {
            status: e instanceof Failure ? e.status : 503,
            headers: { 'Cache-Control': 'no-store' },
          },
        ),
      )
    }
  },
  async scheduled(_event: unknown, env: Env) {
    env = await resolvePaymentEnv(env)
    await cleanup(env)
    await reconcileAlipay(env)
    await reconcile(env)
    await deliverWebhook(env)
  },
}
