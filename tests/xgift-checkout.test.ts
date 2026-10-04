import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { database } from '../services/xgift/server/database.ts'
import { configureAlipay, enableAlipay, alipaySettings, alipayView, checkoutCatalog, createCheckout,
  checkoutStatus, alipayNotification, reconcileAlipay, alipayOrders } from '../services/xgift/src/alipay-payments.ts'
import { configureCards, cardConfiguration } from '../services/xgift/src/cards.ts'
import { configureGiftProfile } from '../services/xgift/src/gift-profile.ts'
import { configurePayments, setPaymentsEnabled, paymentSettings, resolvePaymentEnv } from '../services/xgift/src/payments.ts'
import { saveSecret } from '../services/xgift/src/network.ts'
import { createUser } from '../services/xgift/src/auth.ts'
import { credit, createOrder } from '../services/xgift/src/orders.ts'
import { reconcile } from '../services/xgift/src/executor.ts'
import { Failure, seal, sha256, token, type Env } from '../services/xgift/src/core.ts'
import type { AlipayPrecreate, AlipayQueryResult } from '../services/xgift/server/alipay.ts'
import worker from '../services/xgift/src/index.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const appId = '2021000000000001', sellerId = '2088000000000001'
const tradeNo = '2026100522000000000000000001'
const cardConfig = { environment: 'production', transport: 'direct', api_key: 'sk_fixture_card_secret', writes_enabled: false }
const purchase = () => ({
  request_id: crypto.randomUUID().replaceAll('-', ''), access_token: token(), product_code: 'x-premium-3m',
  username: 'Receiver', recipient_id: '12345', expected_amount_cny: '88.80',
})
const alipayConfig = {
  revision: null as string | null, environment: 'production', app_id: appId, seller_id: sellerId,
  app_private_key: 'fixture_application_private_secret', alipay_public_key: 'fixture_alipay_public',
  prices: [
    { product_code: 'x-premium-3m', amount_cny: '88.80', enabled: true },
    { product_code: 'x-premium-6m', amount_cny: '168.00', enabled: true },
  ],
}
async function fixture(t: Context, enabled = true) {
  const { DB, sqlite: db } = database(':memory:', fileURLToPath(new URL('../services/xgift/migrations/', import.meta.url)))
  t.after(() => db.close())
  const state = {
    precreates: [] as AlipayPrecreate[], queries: [] as string[], closes: [] as string[], notifications: [] as Record<string, string>[], verifies: 0, native: 0, xQueries: 0,
    precreateLost: false, queryLost: false, closeLost: false, closeConfirmed: false, signatureValid: true, xFails: false,
    queryPatch: null as null | Record<string, unknown>,
    nativeResult: 'failed' as 'failed' | 'succeeded',
  }
  const env: Env = {
    DB, MASTER_KEY: 'a'.repeat(64), ADMIN_PASSWORD: 'fixture-admin-password-long-enough',
    PUBLIC_ORIGIN: 'https://x-api.example.test', PAYMENTS_ENABLED: 'false',
    ASSETS: { fetch: async () => new Response('asset') },
    NATIVE_EXECUTOR: async (_env, order) => {
      state.native++
      return state.nativeResult === 'failed'
        ? { order_id: order.id, status: 'failed', financial_state: 'not_charged', failure_code: 'fixture_gift_rejected' }
        : { order_id: order.id, status: 'succeeded', evidence: { payment_status: 'paid', gift_status: 'checkout_completed',
          recipient: order.recipient, product_code: order.product_code, currency: order.currency,
          amount_minor: order.amount_minor, receipt_id: 'fixture_gift_receipt' } }
    },
    ALIPAY_CLIENT: () => ({
      async precreate(input) {
        state.precreates.push({ ...input })
        if (state.precreateLost) throw new Error('fixture unknown response with private data')
        return { out_trade_no: input.out_trade_no, qr_code: 'https://qr.alipay.com/fixture' }
      },
      async query(outTradeNo): Promise<AlipayQueryResult> {
        state.queries.push(outTradeNo)
        if (state.queryLost) throw new Error('fixture query response lost')
        return state.queryPatch === null ? { found: false, out_trade_no: outTradeNo } : {
          found: true, out_trade_no: outTradeNo, trade_no: tradeNo, trade_status: 'TRADE_SUCCESS',
          total_amount: '88.80', ...state.queryPatch,
        } as AlipayQueryResult
      },
      async close(outTradeNo) {
        state.closes.push(outTradeNo)
        if (state.closeLost) throw new Error('fixture close result unknown')
        if (state.closeConfirmed) return { closed: true as const, out_trade_no: outTradeNo }
        return { closed: false as const, not_found: true as const, out_trade_no: outTradeNo }
      },
      verifyNotification(params) {
        state.verifies++
        state.notifications.push({ ...params })
        return state.signatureValid && params.sign === 'fixture_valid_signature' && params.sign_type === 'RSA2'
      },
    }),
  }
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'zovocard.com' && url.pathname === '/openapi/v1/cards/123') {
      assert.equal(init?.method, 'GET')
      return Response.json({ code: 0, data: { id: 123, card_number: '4242424242424242', cvv: '997', status: 'ACTIVE',
        available_amount: 20, product_code: 'EXISTING_CARD_FIXTURE', network: 'VISA' } })
    }
    assert.equal(url.hostname, 'x.com', 'all network requests must be local mocks')
    assert.ok(url.pathname.endsWith('/PremiumGiftingQuery'), 'no payment or mutation requests allowed')
    state.xQueries++
    if (state.xFails) throw new Error('fixture eligibility unavailable')
    const username = JSON.parse(url.searchParams.get('variables')!).screenName
    return Response.json({ data: { user: { result: { rest_id: '12345', core: { screen_name: username }, premium_gifting_eligible: true } } } })
  })
  db.exec('UPDATE products SET enabled=1,points=months/3*1700')
  db.exec('UPDATE order_admission SET enabled=1')
  await saveSecret(env, 'sec_fixtureaccount', 'account', { name: 'Fixture sender', auth_token: 'fixture-auth', ct0: 'fixture-csrf' })
  const provider = await configureCards(env, cardConfig)
  await configureGiftProfile(env, { first_name: 'Test', last_name: 'User', billing_email: 'test@example.test', billing_country: 'HK' })
  const payment = await configurePayments(env, { revision: null, provider_revision: provider.revision, stripe_publishable_key: 'pk_live_fixture', card_id: 123 })
  await setPaymentsEnabled(env, { enabled: true, revision: payment.revision, confirmation: 'ENABLE_PAYMENTS' })
  await configureAlipay(env, alipayConfig)
  if (enabled) await enableAlipay(env, { enabled: true, revision: (await alipaySettings(env))!.revision, confirmation: 'ENABLE_ALIPAY' })
  function row() { return db.prepare('SELECT * FROM alipay_checkouts ORDER BY created_at,id LIMIT 1').get()! }
  async function status(body: ReturnType<typeof purchase>) {
    return checkoutStatus(env, { checkout_id: 'chk_' + body.request_id, access_token: body.access_token })
  }
  function notification(patch: Record<string, string> = {}) {
    return { app_id: appId, seller_id: sellerId, out_trade_no: String(row().out_trade_no), trade_no: tradeNo,
      trade_status: 'TRADE_SUCCESS', total_amount: '88.80', sign_type: 'RSA2', sign: 'fixture_valid_signature', ...patch }
  }
  async function tick() {
    db.exec('UPDATE alipay_checkouts SET next_check=0,lease_until=0')
    await reconcileAlipay(env)
  }
  return { env, db, state, row, status, notification, tick }
}
function failure(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof Failure)
    assert.equal(error.code, code)
    if (status) assert.equal(error.status, status)
    return true
  }
}
function api(env: Env, path: string, body?: unknown, cookie = '', origin = 'https://x-api.example.test') {
  return worker.fetch(new Request('https://x-api.example.test' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
}
function notifyRequest(env: Env, raw: string, contentType = 'application/x-www-form-urlencoded; charset=UTF-8') {
  // Provider callbacks are server-to-server and intentionally have no browser
  // session, Origin header or JSON payload.
  return worker.fetch(new Request('https://x-api.example.test/api/alipay/notify', {
    method: 'POST', headers: { 'Content-Type': contentType }, body: raw,
  }), env)
}

test('HTTP form notification consumes the body once, returns plain success, and needs no browser login', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  await enableAlipay(f.env, { enabled: false })
  const subject = '点数充值 + 100% & 单号=fixture%2B'
  const form = new URLSearchParams({ ...f.notification(), subject }).toString()
  const response = await notifyRequest(f.env, form)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type')!, /^text\/plain/)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(await response.text(), 'success')
  assert.ok(f.row().paid_at)
  const paidAt = f.row().paid_at
  assert.equal(await (await notifyRequest(f.env, form)).text(), 'success')
  assert.equal(f.row().paid_at, paidAt)
  assert.equal(f.state.verifies, 2)
  assert.equal(f.state.notifications[0].subject, subject)
  assert.equal(f.state.notifications[1].subject, subject)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(f.state.native, 0)
})

test('HTTP callback rejects duplicate form keys, JSON, invalid signatures and wrong merchant', async t => {
  const f = await fixture(t)
  await createCheckout(f.env, purchase())
  const form = new URLSearchParams(f.notification()).toString()
  for (const raw of [form + '&total_amount=88.80', form + '&%74otal_amount=88.80', form + '&__proto__=polluted']) {
    const response = await notifyRequest(f.env, raw)
    assert.equal(response.status, 400)
    assert.equal(await response.text(), 'failure')
    assert.equal(f.row().paid_at, null)
  }
  assert.equal(f.state.verifies, 0)
  const json = await notifyRequest(f.env, JSON.stringify(f.notification()), 'application/json')
  assert.equal(json.status, 400)
  assert.equal(await json.text(), 'failure')
  for (const patch of [
    { sign: 'invalid-signature' }, { sign_type: 'RSA' }, { seller_id: '2088000000000002' },
    { app_id: '2021000000000002' }, { total_amount: '0.01' },
  ]) {
    const response = await notifyRequest(f.env, new URLSearchParams(f.notification(patch)).toString())
    assert.equal(await response.text(), 'failure')
    assert.equal(f.row().paid_at, null)
  }
  const get = await worker.fetch(new Request('https://x-api.example.test/api/alipay/notify?' + form), f.env)
  assert.equal(get.status, 400)
  assert.equal(await get.text(), 'failure')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(f.state.native, 0)
})

test('public checkout HTTP routes enforce CSRF while status remains read-only and token-scoped', async t => {
  const f = await fixture(t), body = purchase()
  const before = f.state.xQueries
  for (const path of ['/api/checkout', '/api/checkout/eligibility', '/api/checkout/status']) {
    const response = await api(f.env, path, body, '', 'https://attacker.example.test')
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'origin_rejected')
  }
  assert.equal(f.state.precreates.length, 0)
  assert.equal(f.state.xQueries, before)
  const catalog = await api(f.env, '/api/checkout/catalog')
  assert.equal(catalog.status, 200)
  assert.equal((await catalog.json()).data.available, true)
  const eligible = await api(f.env, '/api/checkout/eligibility', { username: body.username, product_code: body.product_code })
  assert.equal(eligible.status, 200, await eligible.clone().text())
  assert.equal((await eligible.json()).data.eligible, true)
  const created = await api(f.env, '/api/checkout', body)
  assert.equal(created.status, 200)
  const checkout = (await created.json()).data
  assert.equal(checkout.payment_status, 'pending')
  const calls = { precreate: f.state.precreates.length, query: f.state.queries.length, x: f.state.xQueries }
  const read = await api(f.env, '/api/checkout/status', { checkout_id: checkout.id, access_token: body.access_token })
  assert.equal(read.status, 200)
  assert.equal((await read.json()).data.id, checkout.id)
  const wrong = await api(f.env, '/api/checkout/status', { checkout_id: checkout.id, access_token: token() })
  assert.equal(wrong.status, 404)
  assert.equal((await api(f.env, '/api/checkout/status')).status, 405)
  assert.deepEqual({ precreate: f.state.precreates.length, query: f.state.queries.length, x: f.state.xQueries }, calls)
  assert.equal(f.state.native, 0)
})

test('admin Alipay routes require administrator session, same-origin writes and explicit enabling', async t => {
  const f = await fixture(t, false)
  for (const path of ['/api/admin/alipay', '/api/admin/alipay/orders'])
    assert.equal((await api(f.env, path)).status, 401)
  assert.equal((await api(f.env, '/api/admin/alipay/config', alipayConfig)).status, 401)
  await createUser(f.env, { name: 'Fixture user', email: 'ordinary@example.test', password: 'fixture-ordinary-password' })
  const userLogin = await api(f.env, '/api/login', { email: 'ordinary@example.test', password: 'fixture-ordinary-password' })
  assert.equal(userLogin.status, 200)
  const userCookie = userLogin.headers.get('Set-Cookie')!.split(';')[0]
  assert.equal((await api(f.env, '/api/admin/alipay', undefined, userCookie)).status, 403)
  assert.equal((await api(f.env, '/api/admin/alipay/config', alipayConfig, userCookie)).status, 403)
  const adminLogin = await api(f.env, '/api/login', { email: 'admin', password: f.env.ADMIN_PASSWORD })
  assert.equal(adminLogin.status, 200)
  const adminCookie = adminLogin.headers.get('Set-Cookie')!.split(';')[0]
  const revision = (await alipaySettings(f.env))!.revision
  for (const path of ['/api/admin/alipay/config', '/api/admin/alipay/enabled'])
    assert.equal((await api(f.env, path, { ...alipayConfig, enabled: true, revision, confirmation: 'ENABLE_ALIPAY' }, adminCookie, 'https://attacker.example.test')).status, 403)
  const missingConfirmation = await api(f.env, '/api/admin/alipay/enabled', { enabled: true, revision }, adminCookie)
  assert.equal(missingConfirmation.status, 400)
  assert.equal((await missingConfirmation.json()).error.code, 'confirmation_required')
  const stale = await api(f.env, '/api/admin/alipay/enabled', { enabled: true, revision: 'stale', confirmation: 'ENABLE_ALIPAY' }, adminCookie)
  assert.equal(stale.status, 409)
  const saved = await api(f.env, '/api/admin/alipay/config', { ...alipayConfig, revision }, adminCookie)
  assert.equal(saved.status, 200)
  const savedView = (await saved.json()).data
  assert.equal(savedView.enabled, false)
  assert.doesNotMatch(JSON.stringify(savedView), /fixture_application_private_secret|fixture_alipay_public/)
  const enabled = await api(f.env, '/api/admin/alipay/enabled', { enabled: true, revision: savedView.revision, confirmation: 'ENABLE_ALIPAY' }, adminCookie)
  assert.equal(enabled.status, 200)
  assert.equal((await enabled.json()).data.enabled, true)
  const paused = await api(f.env, '/api/admin/alipay/enabled', { enabled: false, revision: 'stale' }, adminCookie)
  assert.equal(paused.status, 200)
  assert.equal((await paused.json()).data.enabled, false)
  assert.equal(f.state.precreates.length, 0)
  assert.equal(f.state.queries.length, 0)
  assert.equal(f.state.native, 0)
})

test('production collection defaults off, saves encrypted keys, and requires deliberate enable', async t => {
  const f = await fixture(t, false)
  assert.equal((await alipayView(f.env)).enabled, false)
  assert.equal((await checkoutCatalog(f.env)).available, false)
  await assert.rejects(createCheckout(f.env, purchase()), failure('checkout_unavailable', 409))
  await assert.rejects(enableAlipay(f.env, { enabled: true, revision: (await alipaySettings(f.env))!.revision }), failure('confirmation_required'))
  const raw = JSON.stringify(f.db.prepare('SELECT * FROM alipay_settings').all()) +
    JSON.stringify(f.db.prepare('SELECT * FROM audit').all()) + JSON.stringify(await alipayView(f.env))
  assert.doesNotMatch(raw, /fixture_application_private_secret|fixture_alipay_public/)
  assert.equal(f.state.precreates.length, 0)
})

test('sandbox cannot enable collection or create a real gift checkout', async t => {
  const f = await fixture(t, false)
  await configureAlipay(f.env, { ...alipayConfig, environment: 'sandbox', revision: (await alipaySettings(f.env))!.revision })
  const view = await alipayView(f.env)
  assert.equal(view.ready, false)
  await assert.rejects(enableAlipay(f.env, { enabled: true, revision: view.revision, confirmation: 'ENABLE_ALIPAY' }), failure('alipay_not_ready'))
  await assert.rejects(createCheckout(f.env, purchase()), failure('checkout_unavailable'))
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
})

test('checkout freezes selected recipient and price and ignores client claimed payment success', async t => {
  const f = await fixture(t), body = purchase()
  const created = await createCheckout(f.env, { ...body, paid: true, status: 'paid', payment_status: 'paid', trade_no: tradeNo })
  assert.equal(created.paid, false)
  assert.equal(created.payment_status, 'pending')
  assert.equal(created.fulfillment_status, 'waiting_payment')
  assert.equal(created.amount_cny, '88.80')
  assert.equal(created.recipient, 'receiver')
  assert.equal(f.row().paid_at, null)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 0)
  assert.equal(f.state.precreates.length, 1)
  assert.equal(f.state.precreates[0].total_amount, '88.80')
  assert.equal(f.state.native, 0)
})

test('client must confirm current CNY price before any QR or collection is created', async t => {
  const f = await fixture(t)
  await assert.rejects(createCheckout(f.env, { ...purchase(), expected_amount_cny: '0.01' }))
  const missing: Record<string, unknown> = purchase()
  delete missing.expected_amount_cny
  await assert.rejects(createCheckout(f.env, missing))
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM alipay_checkouts').get()!.n, 0)
  assert.equal(f.state.precreates.length, 0)
})

test('concurrent distinct checkouts reserve exactly one global acceptance slot', async t => {
  const f = await fixture(t)
  const results = await Promise.allSettled([createCheckout(f.env, purchase()), createCheckout(f.env, { ...purchase(), username: 'Another' })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM alipay_checkouts').get()!.n, 1)
  assert.equal(f.state.precreates.length, 1)
})

test('concurrent retries of the same checkout dispatch one precreate and preserve its frozen price', async t => {
  const f = await fixture(t), body = purchase()
  const result = await Promise.all([createCheckout(f.env, body), createCheckout(f.env, body)])
  assert.equal(result[0].id, result[1].id)
  assert.equal(f.state.precreates.length, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM alipay_checkouts').get()!.n, 1)
  await assert.rejects(createCheckout(f.env, { ...body, expected_amount_cny: '168.00' }), failure('checkout_conflict', 409))
})

test('access tokens are hashed and status/replay neither expose other records nor start gateway work', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  assert.equal(f.row().access_hash, await sha256(body.access_token))
  const snapshot = { ...f.state, precreates: f.state.precreates.length, queries: f.state.queries.length }
  const view = await f.status(body)
  assert.equal((await createCheckout(f.env, body)).id, view.id)
  await assert.rejects(f.status({ ...body, access_token: token() }), failure('not_found', 404))
  await assert.rejects(f.status({ ...body, request_id: crypto.randomUUID().replaceAll('-', '') }), failure('not_found', 404))
  await assert.rejects(createCheckout(f.env, { ...body, access_token: token() }), failure('not_found', 404))
  await assert.rejects(createCheckout(f.env, { ...body, username: 'different' }), failure('checkout_conflict', 409))
  assert.doesNotMatch(JSON.stringify(view) + JSON.stringify(await alipayOrders(f.env)),
    /access_hash|access_token|request_hash|config_payload|fixture_application_private_secret/)
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM alipay_checkouts').all()).includes(body.access_token), false)
  assert.equal(f.state.precreates.length, snapshot.precreates)
  assert.equal(f.state.queries.length, snapshot.queries)
  assert.equal(f.state.xQueries, snapshot.xQueries)
  assert.equal(f.state.native, snapshot.native)
})

test('unverified notifications and wrong amount, identities, trade ID or order never mark paid', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  assert.equal(await alipayNotification(f.env, f.notification({ sign: 'wrong' })), false)
  for (const patch of [
    { total_amount: '0.01' }, { app_id: '2021000000000002' }, { seller_id: '2088000000000002' },
    { trade_no: '' }, { trade_no: 'nondigits' }, { app_id: '' }, { seller_id: '' },
  ]) await assert.rejects(alipayNotification(f.env, f.notification(patch)), failure('alipay_payment_mismatch'))
  assert.equal(await alipayNotification(f.env, f.notification({ out_trade_no: 'xgift_' + 'f'.repeat(32) })), false)
  assert.equal(f.row().paid_at, null)
  assert.equal((await f.status(body)).paid, false)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
})

test('duplicate and reordered notifications preserve one paid record and immutable trade evidence', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  await Promise.all([alipayNotification(f.env, f.notification()), alipayNotification(f.env, f.notification())])
  const paidAt = f.row().paid_at
  assert.ok(paidAt)
  await alipayNotification(f.env, f.notification({ trade_status: 'TRADE_FINISHED' }))
  await alipayNotification(f.env, f.notification({ trade_status: 'WAIT_BUYER_PAY' }))
  await alipayNotification(f.env, f.notification({ trade_status: 'TRADE_CLOSED' }))
  assert.equal(f.row().paid_at, paidAt)
  assert.equal(f.row().trade_no, tradeNo)
  assert.equal(f.row().status, 'attention')
  assert.equal(f.row().failure_code, 'payment_closed_unconfirmed')
  await assert.rejects(alipayNotification(f.env, f.notification({ trade_no: '2026100522000000000000000002' })), failure('alipay_payment_mismatch'))
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM alipay_checkouts WHERE paid_at IS NOT NULL').get()!.n, 1)
})

test('success arriving after closure requires current signed query before recording payment and fulfilling', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  await alipayNotification(f.env, f.notification({ trade_status: 'TRADE_CLOSED' }))
  assert.equal(f.row().status, 'closed')
  await alipayNotification(f.env, f.notification())
  assert.equal(f.row().status, 'attention')
  assert.equal(f.row().paid_at, null)
  assert.equal(f.row().trade_no, tradeNo)
  await f.tick() // signed query says the trade is not found
  assert.equal(f.row().paid_at, null)
  f.state.queryLost = true
  await f.tick()
  await alipayNotification(f.env, f.notification())
  assert.equal(f.row().paid_at, null)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  f.state.queryLost = false
  f.state.queryPatch = {}
  await f.tick()
  assert.ok(f.row().paid_at)
  assert.ok(f.row().order_id)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 1)
})

test('closure/refund evidence after payment blocks fulfillment despite repeated success notifications', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  await alipayNotification(f.env, f.notification())
  const paidAt = f.row().paid_at
  await alipayNotification(f.env, f.notification({ trade_status: 'TRADE_CLOSED' }))
  await alipayNotification(f.env, f.notification())
  assert.equal(f.row().paid_at, paidAt)
  assert.equal(f.row().failure_code, 'payment_closed_unconfirmed')
  f.state.queryLost = true
  await f.tick()
  assert.equal(f.row().failure_code, 'payment_closed_unconfirmed')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  f.state.queryLost = false
  f.state.queryPatch = { trade_status: 'TRADE_CLOSED' }
  await f.tick()
  assert.equal(f.row().failure_code, 'payment_closed_unconfirmed')
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 0)
  f.state.queryPatch = {}
  await f.tick()
  assert.ok(f.row().order_id)
  assert.equal(f.row().paid_at, paidAt)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
})

test('success callback using an earlier pending snapshot cannot override a concurrent closure', async t => {
  const f = await fixture(t)
  await createCheckout(f.env, purchase())
  const prepare = f.env.DB.prepare.bind(f.env.DB)
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  let held = false
  t.mock.method(f.env.DB, 'prepare', (sql: string) => {
    const statement = prepare(sql)
    if (sql === 'SELECT * FROM alipay_checkouts WHERE out_trade_no=?') {
      const first = statement.first.bind(statement)
      statement.first = async <T>() => {
        const result = await first<T>()
        if (!held) {
          held = true
          entered.resolve()
          await resume.promise
        }
        return result
      }
    }
    return statement
  })
  const success = alipayNotification(f.env, f.notification())
  await entered.promise
  await alipayNotification(f.env, f.notification({ trade_status: 'TRADE_CLOSED' }))
  resume.resolve()
  await success
  assert.equal(f.row().status, 'attention')
  assert.equal(f.row().paid_at, null)
  assert.equal(f.row().failure_code, 'payment_late_success_unconfirmed')
})

test('recovery never queries or fulfills a frozen sandbox invoice, including a legacy paid record', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  const frozen = { ...f.row() }
  // Simulate a historical import using the same immutable schema, not a live
  // configuration change. No order or ledger exists when this row is copied.
  frozen.config_payload = await seal(f.env, 'alipay-checkout:' + frozen.id, JSON.stringify({
    environment: 'sandbox', app_id: appId, seller_id: sellerId,
    app_private_key: alipayConfig.app_private_key, alipay_public_key: alipayConfig.alipay_public_key,
  }))
  f.db.prepare('DELETE FROM alipay_checkouts WHERE id=?').run(String(frozen.id))
  const columns = Object.keys(frozen)
  f.db.prepare('INSERT INTO alipay_checkouts(' + columns.join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ')')
    .run(...Object.values(frozen))
  assert.equal(await alipayNotification(f.env, f.notification()), false)
  await f.tick()
  assert.equal(f.row().failure_code, 'alipay_sandbox_no_fulfillment')
  f.db.prepare("UPDATE alipay_checkouts SET status='paid',paid_at=?,trade_no=? WHERE id=?")
    .run(Date.now(), tradeNo, String(frozen.id))
  await f.tick()
  assert.equal(f.row().status, 'attention')
  assert.equal(f.row().failure_code, 'alipay_sandbox_no_fulfillment')
  assert.equal(f.state.precreates.length, 1)
  assert.equal(f.state.queries.length, 0)
  assert.equal(f.state.native, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 0)
})

test('an in-flight successful query cannot overwrite a newer closure notification in the same millisecond', async t => {
  const f = await fixture(t)
  await createCheckout(f.env, purchase())
  t.mock.method(Date, 'now', () => Number(f.row().created_at))
  f.state.queryPatch = {}
  const factory = f.env.ALIPAY_CLIENT!
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  let held = false
  f.env.ALIPAY_CLIENT = config => {
    const client = factory(config)
    return { ...client, async query(outTradeNo) {
      const result = await client.query(outTradeNo)
      if (!held) { held = true; entered.resolve(); await resume.promise }
      return result
    } }
  }
  const tick = f.tick()
  await entered.promise
  await alipayNotification(f.env, f.notification({ trade_status: 'TRADE_CLOSED' }))
  resume.resolve()
  await tick
  assert.equal(f.row().paid_at, null)
  assert.equal(f.row().status, 'attention')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  // A fresh, authenticated success query may subsequently resolve the conflict.
  await f.tick()
  assert.ok(f.row().paid_at)
  assert.ok(f.row().order_id)
})

test('pausing collection still accepts verified payment for an existing invoice', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  await enableAlipay(f.env, { enabled: false })
  await alipayNotification(f.env, f.notification())
  assert.equal((await f.status(body)).paid, true)
  await f.tick()
  assert.ok(f.row().order_id)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(f.state.precreates.length, 1)
})

test('outbound pause retains incoming paid evidence and resumes the same order without duplicate credit', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  await setPaymentsEnabled(f.env, { enabled: false })
  await alipayNotification(f.env, f.notification())
  const paidAt = f.row().paid_at
  await f.tick()
  const paused = await f.status(body)
  assert.equal(paused.payment_status, 'paid')
  assert.equal(paused.fulfillment_status, 'attention')
  assert.equal(f.row().order_id, null)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 0)
  await setPaymentsEnabled(f.env, { enabled: true, confirmation: 'ENABLE_PAYMENTS', revision: (await paymentSettings(f.env))!.revision })
  await f.tick()
  await f.tick()
  assert.equal(f.row().paid_at, paidAt)
  assert.ok(f.row().order_id)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 1)
})

test('lost precreate/query responses stay unresolved and recover through the same merchant order', async t => {
  const f = await fixture(t), body = purchase()
  f.state.precreateLost = true
  const created = await createCheckout(f.env, body)
  assert.equal(created.payment_status, 'creating')
  assert.equal(created.paid, false)
  f.state.queryLost = true
  await f.tick()
  assert.equal(f.row().status, 'creating')
  assert.equal(f.row().failure_code, 'payment_query_unconfirmed')
  f.state.queryLost = false
  f.state.queryPatch = {}
  await f.tick()
  assert.ok(f.row().paid_at)
  assert.ok(f.row().order_id)
  assert.deepEqual(f.state.queries, [f.row().out_trade_no, f.row().out_trade_no])
  assert.equal(f.state.precreates.length, 1)
  assert.equal(f.state.native, 0)
})

test('a verified not-found result can retry only the same precreate without declaring payment failed', async t => {
  const f = await fixture(t), body = purchase()
  f.state.precreateLost = true
  await createCheckout(f.env, body)
  await f.tick()
  assert.equal(f.row().status, 'creating')
  assert.equal(f.row().paid_at, null)
  assert.equal(f.state.precreates.length, 2)
  assert.equal(f.state.precreates[0].out_trade_no, f.state.precreates[1].out_trade_no)
  await assert.rejects(createCheckout(f.env, purchase()), failure('checkout_unavailable'))
})

test('unexpired invoices and the expiration grace period never trigger close', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  const expires = Number(f.row().expires_at)
  let now = expires - 1
  t.mock.method(Date, 'now', () => now)
  await f.tick()
  assert.equal(f.state.closes.length, 0)
  assert.equal(f.row().status, 'pending')
  now = expires + 119999
  await f.tick()
  assert.equal(f.state.closes.length, 0)
  assert.equal(f.row().status, 'pending')
  assert.equal((await checkoutCatalog(f.env)).available, false)
  assert.equal((await f.status(body)).qr_code, null)
})

test('a new-policy expired invoice releases capacity only after close and a signed not-found query', async t => {
  for (const confirmed of [false, true]) await t.test(confirmed ? 'confirmed close' : 'signed close not-found', async t => {
    const f = await fixture(t), body = purchase()
    await createCheckout(f.env, body)
    const original = { ...f.row() }, now = Number(original.expires_at) + 120000
    t.mock.method(Date, 'now', () => now)
    f.state.closeConfirmed = confirmed
    await f.tick()
    assert.equal(f.row().qr_deadline_enforced, 1)
    assert.equal(f.row().status, 'closed')
    assert.equal(f.row().failure_code, 'payment_window_expired')
    assert.equal(f.row().paid_at, null)
    assert.equal(f.row().order_id, null)
    assert.equal(f.row().expires_at, original.expires_at)
    assert.equal(f.row().access_hash, original.access_hash)
    assert.deepEqual(f.state.closes, [original.out_trade_no])
    assert.deepEqual(f.state.queries, [original.out_trade_no, original.out_trade_no])
    assert.equal((await checkoutCatalog(f.env)).available, true)
    assert.equal((await f.status(body)).payment_status, 'closed')
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM alipay_checkouts').get()!.n, 1)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  })
})

test('an imported old-policy invoice remains reserved after expiry without automatic close', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  const legacy = { ...f.row(), qr_deadline_enforced: 0 }
  // Model an old stored record by inserting it with the old default. The
  // immutable expires_at and policy flag are never updated in place.
  f.db.prepare('DELETE FROM alipay_checkouts WHERE id=?').run(String(legacy.id))
  const columns = Object.keys(legacy)
  f.db.prepare('INSERT INTO alipay_checkouts(' + columns.join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ')')
    .run(...Object.values(legacy))
  const now = Number(legacy.expires_at) + 24 * 60 * 60000
  t.mock.method(Date, 'now', () => now)
  f.state.closeConfirmed = true
  await f.tick()
  assert.equal(f.row().qr_deadline_enforced, 0)
  assert.equal(f.row().status, 'pending')
  assert.equal(f.state.closes.length, 0)
  assert.equal((await checkoutCatalog(f.env)).available, false)
  await assert.rejects(createCheckout(f.env, purchase()), failure('checkout_unavailable'))
})

test('uncertain close or missing post-close confirmation never releases an expired invoice', async t => {
  const f = await fixture(t)
  await createCheckout(f.env, purchase())
  const now = Number(f.row().expires_at) + 120000
  t.mock.method(Date, 'now', () => now)
  f.state.closeLost = true
  await f.tick()
  assert.equal(f.row().status, 'pending')
  assert.equal(f.row().paid_at, null)
  assert.equal(f.row().failure_code, 'payment_query_unconfirmed')
  assert.equal(f.state.closes.length, 1)
  assert.equal(f.state.queries.length, 1)
  assert.equal((await checkoutCatalog(f.env)).available, false)
  f.state.closeLost = false
  f.state.closeConfirmed = true
  const factory = f.env.ALIPAY_CLIENT!
  f.env.ALIPAY_CLIENT = config => {
    const client = factory(config)
    return { ...client, async close(outTradeNo) {
      const result = await client.close(outTradeNo)
      f.state.queryLost = true
      return result
    } }
  }
  await f.tick()
  assert.equal(f.row().status, 'pending')
  assert.equal(f.row().paid_at, null)
  assert.equal(f.state.closes.length, 2)
  assert.equal((await checkoutCatalog(f.env)).available, false)
})

test('verified success arriving during close wins over expiry release and is credited once', async t => {
  const f = await fixture(t)
  await createCheckout(f.env, purchase())
  const now = Number(f.row().expires_at) + 120000
  t.mock.method(Date, 'now', () => now)
  const factory = f.env.ALIPAY_CLIENT!
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  f.env.ALIPAY_CLIENT = config => {
    const client = factory(config)
    return { ...client, async close(outTradeNo) {
      const result = await client.close(outTradeNo)
      entered.resolve()
      await resume.promise
      return result
    } }
  }
  const closing = f.tick()
  await entered.promise
  await alipayNotification(f.env, f.notification())
  const paidAt = f.row().paid_at
  assert.ok(paidAt)
  resume.resolve()
  await closing
  assert.equal(f.row().paid_at, paidAt)
  assert.equal(f.row().status, 'paid')
  assert.notEqual(f.row().failure_code, 'payment_window_expired')
  assert.ok(f.row().order_id)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 1)
  assert.equal((await checkoutCatalog(f.env)).available, false)
})

test('an expired invoice cannot be released by a worker after its lease ownership changes', async t => {
  const f = await fixture(t)
  await createCheckout(f.env, purchase())
  const now = Number(f.row().expires_at) + 120000
  t.mock.method(Date, 'now', () => now)
  const factory = f.env.ALIPAY_CLIENT!
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  f.env.ALIPAY_CLIENT = config => {
    const client = factory(config)
    return { ...client, async close(outTradeNo) {
      const result = await client.close(outTradeNo)
      entered.resolve()
      await resume.promise
      return result
    } }
  }
  const closing = f.tick()
  await entered.promise
  f.db.prepare('UPDATE alipay_checkouts SET work_token=?,lease_until=? WHERE id=?')
    .run('newer-worker', now + 90000, String(f.row().id))
  resume.resolve()
  await closing
  assert.equal(f.row().status, 'pending')
  assert.equal(f.row().work_token, 'newer-worker')
  assert.equal(f.row().lease_until, now + 90000)
  assert.equal((await checkoutCatalog(f.env)).available, false)
})

test('late success on a released old invoice cannot bypass query while a newer invoice is pending', async t => {
  const f = await fixture(t), originalBody = purchase()
  await createCheckout(f.env, originalBody)
  const oldId = String(f.row().id), oldNumber = String(f.row().out_trade_no)
  const now = Number(f.row().expires_at) + 120000
  t.mock.method(Date, 'now', () => now)
  await f.tick()
  assert.equal(f.row().status, 'closed')
  const newerBody = { ...purchase(), username: 'Another' }
  const newer = await createCheckout(f.env, newerBody)
  assert.equal(newer.payment_status, 'pending')
  const queries = f.state.queries.length
  await alipayNotification(f.env, f.notification({ out_trade_no: oldNumber }))
  const old = () => f.db.prepare('SELECT * FROM alipay_checkouts WHERE id=?').get(oldId)!
  assert.equal(old().status, 'attention')
  assert.equal(old().paid_at, null)
  assert.equal(f.state.queries.length, queries)
  assert.equal((await f.status(newerBody)).payment_status, 'pending')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  await f.tick()
  assert.equal(f.state.queries.at(-1), oldNumber)
  assert.equal(old().paid_at, null)
  assert.equal((await f.status(newerBody)).payment_status, 'pending')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM alipay_checkouts').get()!.n, 2)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(f.state.native, 0)
})

test('precreate retries use rounded-down remaining QR lifetime and stop below one minute', async t => {
  const f = await fixture(t)
  f.state.precreateLost = true
  await createCheckout(f.env, purchase())
  const expires = Number(f.row().expires_at)
  let now = expires - 179999
  t.mock.method(Date, 'now', () => now)
  await f.tick()
  assert.equal(f.state.precreates.length, 2)
  assert.equal(f.state.precreates[1].timeout_express, '2m')
  assert.equal(f.state.precreates[1].qr_code_timeout_express, '2m')
  now = expires - 59999
  await f.tick()
  assert.equal(f.state.precreates.length, 2)
  assert.equal(f.state.closes.length, 0)
  assert.equal(f.row().expires_at, expires)
  assert.equal(f.row().status, 'creating')
})

test('wrong authenticated query amount, app and seller cannot pay or fulfill an invoice', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  for (const patch of [{ total_amount: '0.01' }, { app_id: '2021000000000002' }, { seller_id: '2088000000000002' },
    { out_trade_no: 'xgift_' + 'b'.repeat(32) }, { trade_no: 'invalid' }]) {
    f.state.queryPatch = patch
    await f.tick()
    assert.equal(f.row().paid_at, null)
    assert.equal(f.row().order_id, null)
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 0)
})

test('payment credit and gift creation are idempotent across a crash after order insertion', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  await alipayNotification(f.env, f.notification())
  const prepare = f.env.DB.prepare.bind(f.env.DB)
  let dropped = false
  t.mock.method(f.env.DB, 'prepare', (sql: string) => {
    const statement = prepare(sql)
    if (sql.includes('UPDATE alipay_checkouts SET order_id=')) {
      const run = statement.run.bind(statement)
      statement.run = async () => {
        if (!dropped) { dropped = true; throw new Error('fixture crash after order was saved') }
        return run()
      }
    }
    return statement
  })
  await f.tick()
  assert.equal(f.row().order_id, null)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  await f.tick()
  await f.tick()
  assert.ok(f.row().order_id)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='reserve'").get()!.n, 1)
  assert.deepEqual({ ...f.db.prepare('SELECT available,frozen FROM wallets').get() }, { available: 0, frozen: 1700 })
})

test('gift failure remains paid and needs attention; only native completion marks fulfillment successful', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  await alipayNotification(f.env, f.notification())
  await f.tick()
  await reconcile(await resolvePaymentEnv(f.env))
  await f.tick()
  const view = await f.status(body)
  assert.equal(view.paid, true)
  assert.equal(view.payment_status, 'paid')
  assert.equal(view.fulfillment_status, 'attention')
  assert.equal(f.row().status, 'attention')
  assert.equal(f.state.native, 1)
  await f.tick()
  assert.equal(f.state.native, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
})

test('completed gift and repeated paid notification cannot credit or fulfill twice', async t => {
  const f = await fixture(t), body = purchase()
  f.state.nativeResult = 'succeeded'
  await createCheckout(f.env, body)
  await alipayNotification(f.env, f.notification())
  await f.tick()
  await reconcile(await resolvePaymentEnv(f.env))
  await f.tick()
  assert.equal((await f.status(body)).fulfillment_status, 'succeeded')
  await alipayNotification(f.env, f.notification())
  await f.tick()
  assert.equal(f.row().status, 'fulfilled')
  assert.equal(f.state.native, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='consume'").get()!.n, 1)
  assert.equal((await checkoutCatalog(f.env)).available, false)
})

test('pending invoice locks merchant and price configuration updates', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body)
  await enableAlipay(f.env, { enabled: false })
  const previous = (await alipaySettings(f.env))!
  await assert.rejects(configureAlipay(f.env, { ...alipayConfig, revision: previous.revision, seller_id: '2088000000000002' }), failure('alipay_orders_pending'))
  assert.equal((await alipaySettings(f.env))!.revision, previous.revision)
  assert.equal((await f.status(body)).amount_cny, '88.80')
})

test('pending checkout reserves shared daily capacity against direct API gift creation', async t => {
  const f = await fixture(t)
  await createCheckout(f.env, purchase())
  const user = await createUser(f.env, { name: 'Fixture partner', email: 'fixture@example.test', password: 'fixture-user-password' })
  await credit(f.env, user.id, { points: 10000, reference: 'fixture-credit', note: 'Fixture' }, 'fixture')
  await assert.rejects(createOrder(await resolvePaymentEnv(f.env), user.id, 'fixture-direct-001', {
    merchant_order_no: 'fixture-direct-001', product_code: 'x-premium-3m', recipient: 'other',
    recipient_id: '12345', expected_points: 1700,
  }))
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
})

test('pending invoice locks outbound card and payment configuration changes after pause', async t => {
  const f = await fixture(t)
  await createCheckout(f.env, purchase())
  await setPaymentsEnabled(f.env, { enabled: false })
  const payment = (await paymentSettings(f.env))!, card = await cardConfiguration(f.env)
  await assert.rejects(configurePayments(f.env, { revision: payment.revision, provider_revision: card.revision,
    stripe_publishable_key: 'pk_live_changed', card_id: 123 }))
  await assert.rejects(configureCards(f.env, { ...cardConfig, api_key: 'sk_fixture_changed' }))
  assert.equal((await paymentSettings(f.env))!.revision, payment.revision)
  assert.equal((await cardConfiguration(f.env)).revision, card.revision)
})
