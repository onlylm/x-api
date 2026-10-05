import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { database } from '../services/xgift/server/database.ts'
import { admissionDay, admissionView, configureAdmission, pauseAdmission } from '../services/xgift/src/admission.ts'
import { createUser } from '../services/xgift/src/auth.ts'
import { configureCards } from '../services/xgift/src/cards.ts'
import { configureGiftProfile } from '../services/xgift/src/gift-profile.ts'
import { configurePayments, paymentSettings, resolvePaymentEnv, setPaymentsEnabled } from '../services/xgift/src/payments.ts'
import { alipayNotification, alipaySettings, checkoutCatalog, configureAlipay, createCheckout, enableAlipay, reconcileAlipay } from '../services/xgift/src/alipay-payments.ts'
import { createOrder, credit, orderCapabilities } from '../services/xgift/src/orders.ts'
import { issueVouchers, redeemVoucher } from '../services/xgift/src/vouchers.ts'
import { saveSecret } from '../services/xgift/src/network.ts'
import { reconcile } from '../services/xgift/src/executor.ts'
import { Failure, token, type Env } from '../services/xgift/src/core.ts'
import worker from '../services/xgift/src/index.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const origin = 'https://admission.example.test'
const appId = '2021000000000001', sellerId = '2088000000000001'
const migrations = new URL('../services/xgift/migrations/', import.meta.url)
const purchase = () => ({ request_id: crypto.randomUUID().replaceAll('-', ''), access_token: token(),
  product_code: 'x-premium-3m', username: 'checkoutuser', recipient_id: '12345', expected_amount_cny: '88.80' })

function expectFailure(code: string) {
  return (error: unknown) => { assert.ok(error instanceof Failure); assert.equal(error.code, code); return true }
}

async function fixture(t: Context, enabled = true, dailyLimit = 1) {
  const { DB, sqlite: db } = database(':memory:', fileURLToPath(migrations))
  t.after(() => db.close())
  const state = { precreates: 0, native: 0, queryLost: false, closes: 0, fetches: 0 }
  const env: Env = {
    DB, MASTER_KEY: 'a'.repeat(64), ADMIN_PASSWORD: 'admission-test-admin-password', PUBLIC_ORIGIN: origin,
    PAYMENTS_ENABLED: 'false', ALIPAY_SALES_ENABLED: 'true', ASSETS: { fetch: async () => new Response('asset') },
    NATIVE_EXECUTOR: async (_env, order) => {
      state.native++
      return { order_id: order.id, status: 'succeeded', evidence: { payment_status: 'paid', gift_status: 'checkout_completed',
        recipient: order.recipient, product_code: order.product_code, currency: order.currency,
        amount_minor: order.amount_minor, receipt_id: 'fixture_receipt_' + order.id } }
    },
    ALIPAY_CLIENT: () => ({
      async precreate(input) { state.precreates++; return { out_trade_no: input.out_trade_no, qr_code: 'https://qr.alipay.com/fixture' } },
      async query(outTradeNo) {
        if (state.queryLost) throw new Error('fixture unknown query')
        return { found: false as const, out_trade_no: outTradeNo }
      },
      async close(outTradeNo) { state.closes++; return { closed: true as const, out_trade_no: outTradeNo } },
      verifyNotification(params) { return params.sign === 'fixture_signature' && params.sign_type === 'RSA2' },
    }),
  }
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    state.fetches++
    const url = new URL(String(input))
    assert.equal(init?.method ?? 'GET', 'GET', 'Only mocked read-only upstream calls are permitted')
    if (url.hostname === 'zovocard.com') {
      assert.equal(url.pathname, '/openapi/v1/cards/123')
      return Response.json({ code: 0, data: { id: 123, status: 'ACTIVE', card_number: '4242424242424242', available_amount: 20, network: 'VISA' } })
    }
    assert.equal(url.hostname, 'x.com')
    assert.ok(url.pathname.endsWith('/PremiumGiftingQuery'))
    const username = JSON.parse(url.searchParams.get('variables')!).screenName
    return Response.json({ data: { user: { result: { rest_id: '12345', core: { screen_name: username }, premium_gifting_eligible: true } } } })
  })
  db.exec('UPDATE products SET enabled=1,points=300')
  const user = await createUser(env, { name: 'Fixture merchant', email: 'merchant@example.test', password: 'fixture-merchant-password' })
  await credit(env, user.id, { points: 10000, reference: 'admission-fixture-credit', note: 'Fixture only' }, 'fixture')
  await saveSecret(env, 'sec_admissionfixture', 'account', { name: 'Fixture', auth_token: 'fixture-cookie', ct0: 'fixture-csrf' })
  const provider = await configureCards(env, { environment: 'production', transport: 'direct', api_key: 'sk_fixture', writes_enabled: false })
  await configureGiftProfile(env, { first_name: 'Test', last_name: 'User', billing_email: 'fixture@example.test', billing_country: 'HK' })
  const payment = await configurePayments(env, { revision: null, provider_revision: provider.revision, stripe_publishable_key: 'pk_live_fixture', card_id: 123 })
  await setPaymentsEnabled(env, { enabled: true, revision: payment.revision, confirmation: 'ENABLE_PAYMENTS' })
  await configureAlipay(env, { revision: null, environment: 'production', app_id: appId, seller_id: sellerId,
    app_private_key: 'fixture_private', alipay_public_key: 'fixture_public',
    prices: [{ product_code: 'x-premium-3m', amount_cny: '88.80', enabled: true },
      { product_code: 'x-premium-6m', amount_cny: '168.00', enabled: true }] })
  await enableAlipay(env, { enabled: true, revision: (await alipaySettings(env))!.revision, confirmation: 'ENABLE_ALIPAY' })
  const effective = () => resolvePaymentEnv(env)
  const view = async () => admissionView(await effective())
  const configure = async (limit: number, on = true) => configureAdmission(await effective(), {
    revision: (await view()).revision, enabled: on, daily_limit: limit, confirmation: 'UPDATE_ORDER_LIMITS',
  })
  if (enabled) await configure(dailyLimit)
  const direct = async (name = 'directuser') => createOrder(await effective(), user.id, 'admission:' + name, {
    merchant_order_no: 'admission:' + name, product_code: 'x-premium-3m', recipient: name, recipient_id: '12345', expected_points: 300,
  })
  const settle = (id: string, status: 'succeeded' | 'failed' | 'unknown' = 'succeeded') => {
    db.prepare("UPDATE orders SET status='running' WHERE id=? AND status='queued'").run(id)
    db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(status, Date.now(), id)
  }
  const checkoutRow = (body: ReturnType<typeof purchase>) => db.prepare('SELECT * FROM alipay_checkouts WHERE id=?').get('chk_' + body.request_id)!
  const pay = async (body: ReturnType<typeof purchase>) => {
    const row = checkoutRow(body)
    assert.equal(await alipayNotification(env, { app_id: appId, seller_id: sellerId, out_trade_no: String(row.out_trade_no),
      trade_no: '2026100522000000000000000001', trade_status: 'TRADE_SUCCESS', total_amount: '88.80', sign_type: 'RSA2', sign: 'fixture_signature' }), true)
  }
  const tick = async () => { db.exec('UPDATE alipay_checkouts SET next_check=0,lease_until=0'); await reconcileAlipay(env) }
  const request = (path: string, body?: unknown, cookie = '', requestOrigin = origin) => worker.fetch(new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  const login = async (email: string, password: string) => {
    const response = await request('/api/login', { email, password })
    assert.equal(response.status, 200)
    return response.headers.get('Set-Cookie')!.split(';')[0]
  }
  return { env, db, state, user, effective, view, configure, direct, settle, checkoutRow, pay, tick, request, login }
}

test('upgrades default to paused daily admission without disabling configured payment execution', async t => {
  const f = await fixture(t, false), view = await f.view()
  assert.equal(view.enabled, false); assert.equal(view.daily_limit, 1); assert.equal(view.timezone, 'Asia/Shanghai')
  assert.equal(view.used, 0); assert.equal(view.remaining, 1); assert.equal(view.reason, 'paused')
  assert.equal(view.execution_ready, true); assert.equal(view.accepts_orders, false)
  assert.equal((await checkoutCatalog(f.env)).available, false)
  await assert.rejects(f.direct(), expectFailure('product_unavailable'))
  await assert.rejects(createCheckout(f.env, purchase()), expectFailure('checkout_unavailable'))
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(f.state.precreates + f.state.native, 0)
})

test('admission endpoints enforce admin access, CSRF, JSON, confirmation, integers and versioned updates', async t => {
  const f = await fixture(t, false), admin = await f.login('admin', f.env.ADMIN_PASSWORD), merchant = await f.login(f.user.email, 'fixture-merchant-password')
  assert.equal((await f.request('/api/admin/admission')).status, 401)
  assert.equal((await f.request('/api/admin/admission', undefined, merchant)).status, 403)
  const original = (await (await f.request('/api/admin/admission', undefined, admin)).json()).data
  const body = { revision: original.revision, enabled: true, daily_limit: 2, confirmation: 'UPDATE_ORDER_LIMITS' }
  assert.equal((await f.request('/api/admin/admission/config', body)).status, 401)
  assert.equal((await f.request('/api/admin/admission/config', body, merchant)).status, 403)
  assert.equal((await f.request('/api/admin/admission/config', body, admin, 'https://attacker.example')).status, 403)
  const textBody = await worker.fetch(new Request(origin + '/api/admin/admission/config', { method: 'POST',
    headers: { Cookie: admin, Origin: origin, 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }), f.env)
  assert.equal(textBody.status, 415)
  assert.equal((await f.request('/api/admin/admission/config', { ...body, confirmation: '' }, admin)).status, 400)
  for (const limit of [0, -1, 1.5, 10001, '2', null])
    assert.equal((await f.request('/api/admin/admission/config', { ...body, daily_limit: limit }, admin)).status, 400)
  assert.equal((await f.request('/api/admin/admission/config', { ...body, enabled: 'true' }, admin)).status, 400)
  const saved = await f.request('/api/admin/admission/config', body, admin)
  assert.equal(saved.status, 200); assert.equal((await saved.json()).data.daily_limit, 2)
  const conflict = await f.request('/api/admin/admission/config', body, admin)
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'admission_config_conflict')
  const beforePause = (await f.view()).revision, payment = await paymentSettings(f.env)
  assert.equal((await f.request('/api/admin/admission/enabled', { enabled: false }, merchant)).status, 403)
  assert.equal((await f.request('/api/admin/admission/enabled', { enabled: false }, admin, 'https://attacker.example')).status, 403)
  assert.equal((await f.request('/api/admin/admission/enabled', { enabled: true }, admin)).status, 400)
  assert.equal((await f.request('/api/admin/admission/enabled', { enabled: false }, admin)).status, 200)
  assert.equal((await f.view()).enabled, false)
  assert.equal((await f.request('/api/admin/admission/config', { ...body, revision: beforePause }, admin)).status, 409)
  assert.deepEqual(await paymentSettings(f.env), payment, 'Stopping new orders must not pause or change payment execution')
  assert.equal(f.state.precreates + f.state.native, 0)
})

test('concurrent saves retain one daily limit and a stale page cannot undo an emergency pause', async t => {
  const f = await fixture(t), revision = (await f.view()).revision, env = await f.effective()
  const updates = await Promise.allSettled([2, 3].map(daily_limit => configureAdmission(env, {
    revision, daily_limit, enabled: true, confirmation: 'UPDATE_ORDER_LIMITS',
  })))
  assert.equal(updates.filter(v => v.status === 'fulfilled').length, 1)
  assert.equal(updates.filter(v => v.status === 'rejected').length, 1)
  const stale = (await f.view()).revision
  await pauseAdmission(env, { enabled: false })
  await assert.rejects(configureAdmission(env, { revision: stale, enabled: true, daily_limit: 9, confirmation: 'UPDATE_ORDER_LIMITS' }), expectFailure('admission_config_conflict'))
  assert.equal((await f.view()).enabled, false)
})

test('successful orders consume the configured daily total; failures release it and retries do not double count', async t => {
  const f = await fixture(t, true, 2)
  const first = await f.direct('firstuser'); f.settle(first.order.id)
  const failed = await f.direct('faileduser'); f.settle(failed.order.id, 'failed')
  assert.equal((await f.view()).used, 1)
  const second = await f.direct('seconduser'); f.settle(second.order.id)
  assert.equal((await f.direct('seconduser')).created, false)
  const full = await f.view()
  assert.equal(full.used, 2); assert.equal(full.remaining, 0); assert.equal(full.reason, 'daily_limit_reached')
  await assert.rejects(f.direct('thirduser'), expectFailure('product_unavailable'))
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 3)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='reserve'").get()!.n, 3)
})

test('Beijing midnight resets successful daily use exactly, independently of UTC midnight', async t => {
  let now = Date.parse('2026-10-05T15:59:59.999Z')
  t.mock.method(Date, 'now', () => now)
  const f = await fixture(t), order = await f.direct(); f.settle(order.order.id)
  const old = await f.view()
  assert.equal(old.day_start, Date.parse('2026-10-04T16:00:00Z'))
  assert.equal(old.next_reset_at, Date.parse('2026-10-05T16:00:00Z'))
  assert.equal(old.used, 1); assert.equal(old.accepts_orders, false)
  now++
  const fresh = await f.view()
  assert.equal(fresh.used, 0); assert.equal(fresh.remaining, 1); assert.equal(fresh.accepts_orders, true)
  assert.deepEqual(admissionDay(now), { start: now, end: now + 86400000 })
  const next = await f.direct('nextday'); f.settle(next.order.id)
  now = Date.parse('2026-10-06T00:00:00Z')
  assert.equal((await f.view()).used, 1, 'UTC midnight must not reset the Beijing day again')
})

test('unknown orders keep execution blocked after midnight while different recipients can queue', async t => {
  let now = Date.parse('2026-10-05T15:59:00Z')
  t.mock.method(Date, 'now', () => now)
  const f = await fixture(t), order = await f.direct(); f.settle(order.order.id, 'unknown')
  now = Date.parse('2026-10-05T16:00:00Z')
  const view = await f.view()
  assert.equal(view.used, 0); assert.equal(view.remaining, 1); assert.equal(view.active_orders, 1)
  assert.equal(view.reason, null); assert.equal(view.accepts_orders, true)
  assert.equal(view.queue_blocked, true); assert.equal(view.unknown_orders, 1)
  assert.equal(view.blocked_order_id, order.order.id)
  const next = await f.direct('nextuser')
  assert.equal(next.order.status, 'queued')
  await assert.rejects(createCheckout(f.env, purchase()), expectFailure('checkout_unavailable'))
  assert.equal((await f.direct()).created, false, 'Original idempotent reads remain available')
})

test('direct orders, vouchers and Alipay atomically compete for the final shared slot', async t => {
  const f = await fixture(t, true, 2), first = await f.direct('previoususer'); f.settle(first.order.id)
  const voucher = (await issueVouchers(f.env, { user_id: f.user.id, product_code: 'x-premium-3m', quantity: 1 })).vouchers[0]
  const checkout = purchase(), env = await f.effective()
  const results = await Promise.allSettled([
    f.direct('directwinner'),
    redeemVoucher(env, { code: voucher.code, recipient: 'voucherwinner', recipient_id: '12345' }),
    createCheckout(f.env, checkout),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  for (const result of results.filter(result => result.status === 'rejected')) assert.ok(result.reason instanceof Failure)
  assert.equal((await f.view()).used, 2)
  const orders = Number(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n)
  const checkouts = Number(f.db.prepare('SELECT COUNT(*) n FROM alipay_checkouts').get()!.n)
  assert.equal(orders + checkouts, 2)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='reserve'").get()!.n, orders)
  assert.equal(f.db.prepare('SELECT status FROM vouchers WHERE id=?').get(voucher.id)!.status,
    results[1].status === 'fulfilled' ? 'redeemed' : 'active')
  assert.equal(f.state.precreates, results[2].status === 'fulfilled' ? 1 : 0)
})

test('checkout reservation transfers to its gift once and survives a crash before order_id is backfilled', async t => {
  const f = await fixture(t), body = purchase()
  await createCheckout(f.env, body); assert.equal((await f.view()).used, 1)
  await f.pay(body); await f.tick()
  const row = f.checkoutRow(body), orderId = String(row.order_id)
  assert.ok(row.order_id); assert.equal((await f.view()).used, 1)
  f.db.prepare('UPDATE alipay_checkouts SET order_id=NULL WHERE id=?').run(String(row.id))
  assert.equal((await f.view()).used, 1, 'The system merchant identity deduplicates the crash window')
  await f.tick()
  assert.equal(f.checkoutRow(body).order_id, orderId)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='credit'").get()!.n, 2)
  f.settle(orderId); await f.tick()
  assert.equal(f.checkoutRow(body).status, 'fulfilled'); assert.equal((await f.view()).used, 1)
})

test('admission pause, a reduced quota and midnight never strand an already paid checkout', async t => {
  for (const change of ['pause', 'lower', 'midnight']) await t.test(change, async t => {
    let now = Date.parse('2026-10-05T15:59:00Z')
    t.mock.method(Date, 'now', () => now)
    const f = await fixture(t, true, 3), prior = await f.direct('prioruser'); f.settle(prior.order.id)
    const body = purchase(); await createCheckout(f.env, body); await f.pay(body)
    const originalPayment = await paymentSettings(f.env)
    if (change === 'pause') await pauseAdmission(await f.effective(), { enabled: false })
    if (change === 'lower') await f.configure(1)
    if (change === 'midnight') now = Date.parse('2026-10-05T16:00:00Z')
    await f.tick()
    const row = f.checkoutRow(body)
    assert.ok(row.order_id, row.failure_code as string)
    assert.deepEqual(await paymentSettings(f.env), originalPayment)
    await reconcile(await f.effective()); await f.tick()
    assert.equal(f.checkoutRow(body).status, 'fulfilled'); assert.equal(f.state.native, 1)
    assert.equal((await f.view()).used, change === 'midnight' ? 0 : 2)
    if (change === 'pause') assert.equal((await f.view()).reason, 'paused')
    if (change === 'lower') assert.equal((await f.view()).reason, 'daily_limit_reached')
    if (change === 'midnight') assert.equal((await f.view()).accepts_orders, true)
  })
})

test('historical paid checkouts wait for existing queued gifts to drain without blocking their execution', async t => {
  const f = await fixture(t, true, 10), body = purchase()
  await createCheckout(f.env, body)
  // Model historical queued work from the external-executor mode that predates
  // native shared-card serialization; it must not be stranded after an upgrade.
  const legacy: Env = { ...f.env, LOCAL_EXECUTOR: undefined, PAYMENTS_ENABLED: 'true',
    EXECUTOR_URL: 'https://executor.example.test', EXECUTOR_SECRET: 'fixture-executor-secret-32-characters' }
  for (const recipient of ['legacyone', 'legacytwo']) await createOrder(legacy, f.user.id, 'legacy:' + recipient, {
    merchant_order_no: 'legacy:' + recipient, product_code: 'x-premium-3m', recipient,
  })
  await f.pay(body); await f.tick()
  assert.equal(f.checkoutRow(body).order_id, null)
  assert.equal((await f.view()).reason, 'checkout_in_progress')
  for (let i = 0; i < 2; i++) await reconcile(await f.effective())
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orders WHERE status='succeeded'").get()!.n, 2)
  await f.tick()
  assert.ok(f.checkoutRow(body).order_id, 'A paid reservation converts once prior queue work settles')
  await reconcile(await f.effective()); await f.tick()
  assert.equal(f.checkoutRow(body).status, 'fulfilled')
  assert.equal(f.state.native, 3)
  assert.equal((await f.view()).used, 3)
})

test('pausing new admission preserves an already queued gift and allows original fulfillment', async t => {
  const f = await fixture(t), order = await f.direct(), payment = await paymentSettings(f.env)
  await pauseAdmission(await f.effective(), { enabled: false })
  await reconcile(await f.effective())
  assert.equal(f.db.prepare('SELECT status FROM orders WHERE id=?').get(order.order.id)!.status, 'succeeded')
  assert.equal((await f.direct()).created, false)
  await assert.rejects(f.direct('anotheruser'), expectFailure('product_unavailable'))
  assert.deepEqual(await paymentSettings(f.env), payment)
})

test('an expired unknown checkout holds the slot across midnight until verified unpaid closure', async t => {
  let now = Date.parse('2026-10-05T15:45:00Z')
  t.mock.method(Date, 'now', () => now)
  const f = await fixture(t), body = purchase(); await createCheckout(f.env, body)
  now = Number(f.checkoutRow(body).expires_at) + 120000
  f.state.queryLost = true; await f.tick()
  assert.equal((await f.view()).used, 0)
  assert.equal((await f.view()).reason, 'checkout_in_progress')
  await assert.rejects(f.direct(), expectFailure('product_unavailable'))
  assert.equal(f.state.closes, 0)
  f.state.queryLost = false; await f.tick()
  assert.equal(f.checkoutRow(body).status, 'closed')
  assert.equal(f.checkoutRow(body).paid_at, null); assert.equal(f.state.closes, 1)
  assert.equal((await f.view()).accepts_orders, true)
  await f.direct()
})

test('external execution keeps its established admission behavior while native policy is paused', async t => {
  const f = await fixture(t, false), env: Env = { ...f.env, LOCAL_EXECUTOR: undefined, NATIVE_EXECUTOR: undefined,
    PAYMENTS_ENABLED: 'true', EXECUTOR_URL: 'https://executor.example.test', EXECUTOR_SECRET: 'fixture-executor-secret-32-characters' }
  assert.equal((await orderCapabilities(env)).accepts_orders, true)
  for (const recipient of ['externalone', 'externaltwo']) await createOrder(env, f.user.id, 'external:' + recipient, {
    merchant_order_no: 'external:' + recipient, product_code: 'x-premium-3m', recipient,
  })
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 2)
  assert.equal((await f.view()).enabled, false); assert.equal(f.state.native, 0)
})

test('the admission migration preserves historical orders, balances, ledger and paid reservations', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const files = readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name)).sort()
  for (const name of files.filter(name => name < '0008')) db.exec(readFileSync(new URL(name, migrations), 'utf8'))
  db.exec("INSERT INTO users VALUES('legacy-user','Legacy','legacy@example.test','hash','salt',1,1)")
  db.exec("INSERT INTO ledger VALUES('legacy-credit','legacy-user',NULL,'credit',5000,0,'Historical','fixture','legacy-credit',1)")
  for (const status of ['succeeded', 'unknown']) {
    const name = 'legacy-' + status
    db.prepare(`INSERT INTO orders(id,user_id,merchant_order_no,idempotency_key,request_hash,product_code,recipient,points,currency,amount_minor,stripe_product,months,created_at,updated_at)
      VALUES(?,'legacy-user',?,?,?,'x-premium-3m',?,300,'bdt',30000,'prod_TJXJtpzqCpI36N',3,2,2)`).run(name, name, name, name, status)
    db.prepare("UPDATE orders SET status='running' WHERE id=?").run(name)
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, name)
  }
  db.exec("INSERT INTO payment_settings VALUES(1,1,'legacy-payment','encrypted-fixture',1)")
  db.exec(`INSERT INTO alipay_checkouts(id,access_hash,request_hash,out_trade_no,trade_no,product_code,product_name,months,points,currency,amount_minor,stripe_product,
    amount_cents,recipient,recipient_id,provider_revision,outbound_revision,config_payload,status,paid_at,created_at,expires_at,updated_at)
    VALUES('chk_legacy','access','digest','xgift_legacy','trade_legacy','x-premium-3m','Legacy',3,300,'bdt',30000,'prod_TJXJtpzqCpI36N',
      8880,'legacybuyer','12345','legacy-provider','legacy-payment','encrypted-fixture','paid',3,2,100,3)`)
  const tables = ['users', 'wallets', 'orders', 'ledger', 'payment_settings', 'alipay_checkouts']
  const snapshot = () => Object.fromEntries(tables.map(name => [name, db.prepare('SELECT * FROM ' + name + ' ORDER BY 1').all()]))
  const before = snapshot(), admissionMigration = files.find(name => name.startsWith('0008'))!
  assert.ok(admissionMigration)
  db.exec(readFileSync(new URL(admissionMigration, migrations), 'utf8'))
  assert.deepEqual(snapshot(), before)
  assert.deepEqual({ ...db.prepare('SELECT enabled,daily_limit FROM order_admission').get() }, { enabled: 0, daily_limit: 1 })
  assert.throws(() => db.exec("UPDATE ledger SET note='changed'"), /immutable_ledger/)
  assert.throws(() => db.exec("UPDATE alipay_checkouts SET paid_at=NULL WHERE id='chk_legacy'"), /immutable_alipay_paid_trade/)
})
