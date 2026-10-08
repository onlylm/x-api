import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { database } from '../services/xgift/server/database.ts'
import { executeNative, guardPage, manualApprovalFresh, queryNativeOrder, X_MERCHANT } from '../services/xgift/server/native-executor.ts'
import { adminOrderCapabilities, adminPaymentPage } from '../services/xgift/src/admin-order-actions.ts'
import { createUser, createKey } from '../services/xgift/src/auth.ts'
import { credit, createOrder, type Order } from '../services/xgift/src/orders.ts'
import { saveSecret, eligibility } from '../services/xgift/src/network.ts'
import { cardConfiguration, configureCards } from '../services/xgift/src/cards.ts'
import { configureGiftProfile } from '../services/xgift/src/gift-profile.ts'
import { configurePayments, paymentSettings, resolvePaymentEnv, setPaymentsEnabled, paymentBinding, assertPaymentAllowed } from '../services/xgift/src/payments.ts'
import { reconcile } from '../services/xgift/src/executor.ts'
import { seal, unseal, type Env } from '../services/xgift/src/core.ts'
import { signature } from '../shared/xgift-signature.ts'
import worker from '../services/xgift/src/index.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const session = 'cs_live_fixture123'
const page = () => ({ session_id: session, account_settings: { account_id: X_MERCHANT }, livemode: true, mode: 'payment', currency: 'bdt',
  success_url: 'https://x.com/receiver/gift-premium/success', cancel_url: 'https://x.com/receiver/gift-premium',
  status: 'open', payment_status: 'unpaid', init_checksum: 'test-checksum', payment_intent: null,
  total_summary: { total: 30000, subtotal: 30000, due: 30000 }, line_item_group: { currency: 'bdt', total: 30000, subtotal: 30000, due: 30000,
    line_items: [{ name: 'Premium Gift - 3 months', quantity: 1, total: 30000, subtotal: 30000, price: { currency: 'bdt', type: 'one_time', unit_amount: 30000, product: { id: 'prod_TJXJtpzqCpI36N', name: 'Premium Gift - 3 months', livemode: true } } }] } })
async function fixture(t: Context) {
  const { DB, sqlite: db } = database(':memory:', fileURLToPath(new URL('../services/xgift/migrations/', import.meta.url)))
  t.after(() => db.close())
  const env: Env = { DB, MASTER_KEY: 'a'.repeat(64), ADMIN_PASSWORD: 'test-admin-password-only', PAYMENTS_ENABLED: 'true', STRIPE_PUBLISHABLE_KEY: 'pk_live_fixture', ASSETS: { fetch: async () => new Response('asset') } }
  env.LOCAL_EXECUTOR = (o, s) => executeNative(env, o, s)
  db.exec('UPDATE order_admission SET enabled=1')
  const user = await createUser(env, { name: 'Test', email: 'test@example.test', password: 'test-password-fixture' })
  const key = await createKey(env, user.id, 'test')
  await credit(env, user.id, { points: 10000, reference: 'fixture-fund', note: 'Fixture credit' }, 'fixture')
  db.exec('UPDATE products SET enabled=1,points=months/3*1700')
  await saveSecret(env, 'sec_testaccount', 'account', { name: 'Test sender', auth_token: 'dummy-cookie', ct0: 'dummy-csrf', daily_limit: 300 })
  await configureCards(env, { environment: 'production', transport: 'direct', api_key: 'sk_fixture', writes_enabled: true })
  await configureGiftProfile(env, { first_name: 'Test', last_name: 'User', billing_email: 'test@example.test', billing_country: 'HK', billing_line1: 'Fixture address' })
  const state = { eligible: true, recipientId: '12345', xError: false, malformed: false, xCreates: 0, cardOpens: 0, methods: 0, confirms: 0, polls: 0, lostConfirm: false, lostCard: false, wrongPage: false, openFee: 0.5, requiresAction: false,
    cardId: 123, cardProduct: 'PP5583RC', cardBalance: 20, cardStatus: 'ACTIVE', cardExpiry: '12/30', cardReads: [] as number[], methodBilling: [] as string[], paymentKeys: [] as string[], onInit: undefined as (() => Promise<void>) | undefined,
    cards: {} as Record<number, Record<string, unknown>>, methodCards: [] as string[], confirmMethods: [] as string[], methodLost: false,
    providerFailure: null as 'network' | 'unauthorized' | null, onCardRead: undefined as ((cardId: number) => Promise<void>) | undefined,
    xCreateError: false, checkoutUrl: 'https://checkout.stripe.com/c/pay/' + session }
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'x.com') {
      if (url.pathname.endsWith('/PremiumGiftingQuery')) return Response.json(state.xError ? { errors: [{ message: 'private-upstream' }] } : { data: { user: { result: state.malformed ? {} : { rest_id: state.recipientId, core: { screen_name: 'Receiver' }, premium_gifting_eligible: state.eligible } } } })
      if (url.pathname.endsWith('/useSubscriptionProductDetailsByRestIdQuery')) return Response.json({ data: { web_subscription_product_details_by_rest_id: { rest_id: 'prod_TJXJtpzqCpI36N', prices: [{ currency_code: 'BDT', amount_local_micro: 300000000, price_type: 'OneTime' }] } } })
      assert.ok(url.pathname.endsWith('/useOneTimePurchaseGiftMutation')); state.xCreates++
      assert.equal(init?.method, 'POST'); assert.equal(JSON.parse(String(init?.body)).variables.gift_recipient, '12345')
      if (state.xCreateError) return Response.json({ errors: [{ code: 353, message: 'auth_token=secret-cookie card=4242424242424242' }] }, { status: 403 })
      return Response.json({ data: { onetimepurchase_gift: { session_status: 'Unpaid', session_id: session, session_url: state.checkoutUrl } } })
    }
    if (url.hostname === 'zovocard.com') {
      const data = url.pathname.endsWith('/products') ? [{ product_code: 'PP5583RC', issuer: 'four', min_amount: 20, open_fee: state.openFee, recharge_fee: 0 }]
        : url.pathname.endsWith('/balance') ? { currency: 'USD', spendable_balance: 30 }
        : url.pathname.endsWith('/cards/open') ? (() => {
          state.cardOpens++; const body = JSON.parse(String(init?.body))
          assert.equal(body.init_amount, 20); assert.equal(body.product_code, 'PP5583RC'); assert.equal(body.max_on_percent, 10); assert.equal(body.transaction_limit, 10); assert.equal(body.transaction_limit_type, 'limited')
          if (state.lostCard) throw new Error('lost open reply')
          return { id: 123, status: 'ACTIVE', product_code: 'PP5583RC' }
        })() : await (async () => {
          assert.equal(init?.method ?? 'GET', 'GET', 'Existing-card reads must not mutate provider state')
          const requestedCard = Number(url.pathname.match(/\/cards\/(\d+)$/)?.[1])
          state.cardReads.push(requestedCard)
          await state.onCardRead?.(requestedCard)
          if (state.providerFailure === 'network') throw new Error('fixture card provider unavailable')
          return { id: state.cardId, product_code: state.cardProduct, card_number: '4242424242424242', cvv: '123', expire: state.cardExpiry, status: state.cardStatus, available_amount: state.cardBalance, ...state.cards[requestedCard] }
        })()
      if (state.providerFailure === 'unauthorized') return Response.json({ code: 1, error_code: 'forbidden' }, { status: 403 })
      return Response.json({ code: 0, data })
    }
    assert.equal(url.hostname, 'api.stripe.com')
    const fields = new URLSearchParams(init?.method === 'POST' ? String(init.body) : url.search)
    state.paymentKeys.push(fields.get('key') ?? '')
    if (url.pathname.endsWith('/init')) { await state.onInit?.(); return Response.json({ ...page(), ...(state.wrongPage ? { currency: 'sgd' } : {}) }) }
    if (url.pathname.endsWith('/payment_methods')) {
      state.methods++; state.methodBilling.push(fields.get('billing_details[email]') ?? '')
      state.methodCards.push(fields.get('card[number]') ?? '')
      if (state.methodLost) throw new Error('fixture tokenization response lost')
      return Response.json({ id: 'pm_fixture', type: 'card', livemode: true })
    }
    if (url.pathname.endsWith('/confirm')) {
      state.confirms++; assert.equal(new URLSearchParams(String(init?.body)).get('expected_amount'), '30000')
      state.confirmMethods.push(fields.get('payment_method') ?? '')
      if (state.lostConfirm) throw new Error('lost confirm reply')
      return Response.json({ ok: true })
    }
    assert.ok(url.pathname.endsWith('/poll')); state.polls++
    return Response.json({ session_id: session, livemode: true, is_sandbox_merchant: false, mode: 'payment', success_url: page().success_url, state: state.requiresAction ? 'pending' : 'succeeded', payment_object_status: state.requiresAction ? 'requires_action' : 'succeeded' })
  })
  const body = { merchant_order_no: 'fixture-001', product_code: 'x-premium-3m', recipient: '@Receiver', recipient_id: '12345', expected_points: 1700 }
  const create = (extra = {}) => createOrder(env, user.id, 'fixture-001', { ...body, ...extra })
  async function tick() { db.exec('UPDATE orders SET next_check=0'); return reconcile(env) }
  async function signedRequest(path: string, body: Record<string, unknown>, nonce = crypto.randomUUID()) {
    const url = new URL('https://x-api.example.test' + path), raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000)), idem = 'check:fixture'
    return new Request(url, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Partner-Id': user.id, 'X-Key-Id': key.key_id, 'X-Timestamp': ts, 'X-Nonce': nonce, 'Idempotency-Key': idem, 'X-Signature': await signature(key.secret, 'POST', url, ts, nonce, key.key_id, idem, raw) } })
  }
  return { env, db, user, state, create, tick, signedRequest }
}
test('g/pay checkout proceeds through the existing mock executor without recreating or repeating confirmation', async t => {
  const s = await fixture(t)
  s.state.checkoutUrl = 'https://checkout.stripe.com/g/pay/' + session + '#original-fragment'
  s.state.lostConfirm = true
  const created = await s.create(); await s.tick()
  const job = JSON.parse(await unseal(s.env, 'native:' + created.order.id,
    String(s.db.prepare('SELECT payload FROM native_jobs').get()!.payload)))
  assert.equal(job.stage, 'session'); assert.equal(job.session_url, s.state.checkoutUrl)
  assert.equal(job.first_error, undefined)
  for (let i = 0; i < 8; i++) await s.tick()
  const order = s.db.prepare('SELECT * FROM orders').get()!
  assert.equal(order.status, 'succeeded'); assert.equal(order.receipt, session)
  assert.deepEqual([s.state.xCreates, s.state.methods, s.state.confirms], [1, 1, 1])
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='consume'").get()!.n, 1)
})

test('g/pay with another session remains rejected and cannot recreate or submit payment', async t => {
  const s = await fixture(t)
  s.state.checkoutUrl = 'https://checkout.stripe.com/g/pay/cs_live_different'
  const created = await s.create(); await s.tick(); await s.tick()
  const job = JSON.parse(await unseal(s.env, 'native:' + created.order.id,
    String(s.db.prepare('SELECT payload FROM native_jobs').get()!.payload)))
  assert.equal(job.stage, 'creating'); assert.equal(job.first_error.code, 'invalid_checkout_url')
  assert.equal(s.state.xCreates, 1); assert.equal(s.state.methods + s.state.confirms + s.state.cardOpens, 0)
})

test('first creation failure is durable, redacted, audited once and not overwritten by later polling', async t => {
  const s = await fixture(t); s.state.xCreateError = true
  const created = await s.create(); await s.tick()
  const read = async () => JSON.parse(await unseal(s.env, 'native:' + created.order.id,
    String(s.db.prepare('SELECT payload FROM native_jobs').get()!.payload)))
  const first = (await read()).first_error
  assert.equal(first.stage, 'creating'); assert.equal(first.code, 'x_query_failed')
  assert.deepEqual(first.upstream, { operation: 'useOneTimePurchaseGiftMutation', kind: 'http', http_status: 403, error_codes: [353] })
  await s.tick(); await s.tick()
  assert.deepEqual((await read()).first_error, first)
  assert.equal(s.state.xCreates, 1); assert.equal(s.state.confirms + s.state.methods + s.state.cardOpens, 0)
  const audits = s.db.prepare("SELECT note FROM audit WHERE action='native_execution_first_error'").all()
  assert.equal(audits.length, 1)
  assert.doesNotMatch(JSON.stringify(audits) + JSON.stringify(first), /secret-cookie|4242424242424242|auth_token|ct0/)
})

test('signed eligibility authenticates, normalizes, rejects replay, and never touches wallet or payment APIs', async t => {
  const s = await fixture(t)
  const unsigned = await worker.fetch(new Request('https://x-api.example.test/v1/eligibility', { method: 'POST', body: '{"username":"receiver"}' }), s.env)
  assert.equal(unsigned.status, 401)
  const request = await s.signedRequest('/v1/eligibility', { username: '@Receiver' })
  const response = await worker.fetch(request.clone(), s.env)
  assert.equal(response.status, 200); assert.equal((await response.json()).data.eligible, true)
  assert.equal((await worker.fetch(request, s.env)).status, 409)
  s.state.eligible = false; assert.equal((await eligibility(s.env, 'receiver')).eligible, false)
  s.state.xError = true; await assert.rejects(eligibility(s.env, 'receiver'))
  assert.equal(s.state.cardOpens + s.state.xCreates + s.state.confirms, 0)
  assert.equal(s.db.prepare('SELECT available FROM wallets').get()!.available, 10000)
})
test('native create binds recipient identity, point price and the configured daily capacity atomically', async t => {
  const s = await fixture(t)
  await assert.rejects(s.create({ expected_points: 1 })); await assert.rejects(s.create({ recipient_id: '999' }))
  const created = await s.create(); assert.equal(created.order.points, 1700)
  assert.equal((await s.create()).created, false)
  await assert.rejects(s.create({ expected_points: 3400 }))
  await assert.rejects(s.create({ merchant_order_no: 'fixture-other' }))
  assert.equal(s.db.prepare('SELECT available FROM wallets').get()!.available, 8300)
})
test('lost confirmation is only polled, card opened once with spending limits, terminal settlement consumes points once', async t => {
  const s = await fixture(t); s.state.lostConfirm = true
  await s.create()
  for (let i = 0; i < 8; i++) await s.tick()
  const order = s.db.prepare('SELECT * FROM orders').get() as unknown as Order
  assert.equal(order.status, 'succeeded'); assert.equal(order.receipt, session)
  assert.deepEqual([s.state.xCreates, s.state.cardOpens, s.state.methods, s.state.confirms], [1,1,1,1])
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='consume'").get()!.n, 1)
  const raw = String(s.db.prepare('SELECT payload FROM native_jobs').get()!.payload)
  assert.doesNotMatch(raw, /4242424242424242|pm_fixture|test@example/)
  assert.doesNotMatch(await unseal(s.env, 'native:' + order.id, raw), /4242424242424242|"cvv"/)
})
test('a mismatched payment page cannot fund a card; lost opening cannot open a second card', async t => {
  const s = await fixture(t); s.state.wrongPage = true; await s.create()
  await s.tick(); await s.tick(); assert.equal(s.state.cardOpens, 0)
  s.state.wrongPage = false; s.state.lostCard = true
  for (let i = 0; i < 5; i++) await s.tick()
  assert.equal(s.state.cardOpens, 1); assert.equal(s.state.confirms, 0)
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'unknown')
})
test('3DS remains unconfirmed and a paused executor never submits a payment', async t => {
  const s = await fixture(t); await s.create(); s.env.PAYMENTS_ENABLED = 'false'
  await s.tick(); assert.equal(s.state.xCreates, 0)
  s.env.PAYMENTS_ENABLED = 'true'; s.state.requiresAction = true
  for (let i = 0; i < 8; i++) await s.tick()
  assert.equal(s.state.confirms, 1)
  assert.equal(s.db.prepare('SELECT failure_code FROM orders').get()!.failure_code, 'payment_requires_action')
  assert.equal(s.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 1700)
})
test('payment proof rejects wrong merchant, recipient, quantity, currency, subscription and preexisting intent', () => {
  const order = { recipient: 'receiver', months: 3, currency: 'bdt', amount_minor: 30000, stripe_product: 'prod_TJXJtpzqCpI36N' } as Order
  guardPage(page(), order, session, true)
  for (const patch of [{ currency: 'sgd' }, { account_settings: { account_id: 'other' } }, { success_url: 'https://x.com/other/gift-premium/success' }, { subscription_data: {} }, { payment_intent: { amount: 30000, currency: 'bdt' } }, { total_summary: { total: 60000, subtotal: 60000, due: 60000 } }]) assert.throws(() => guardPage({ ...page(), ...patch }, order, session, true))
  const quantity = page(); quantity.line_item_group.line_items[0]!.quantity = 2
  assert.throws(() => guardPage(quantity, order, session, true))
})

async function selectedFixture(t: Context, backupCardIds: number[] = []) {
  const s = await fixture(t)
  s.env.NATIVE_EXECUTOR = executeNative
  s.state.cardProduct = 'EXISTING-CARD-PRODUCT'
  for (const cardId of backupCardIds) s.state.cards[cardId] = { id: cardId, card_number: cardId === 456 ? '5555555555554444' : '4000000000000002',
    status: 'ACTIVE', available_amount: 20, expire: '12/30' }
  // Existing-card payments work with all card-provider mutations disabled.
  await configureCards(s.env, { environment: 'production', transport: 'direct', api_key: 'sk_fixture', writes_enabled: false })
  await setPaymentsEnabled(s.env, { enabled: false })
  const provider = await cardConfiguration(s.env)
  const settings = await configurePayments(s.env, {
    revision: (await paymentSettings(s.env))!.revision,
    stripe_publishable_key: 'pk_live_selectedfixture', card_id: 123, backup_card_ids: backupCardIds, provider_revision: provider.revision,
  })
  const resume = () => setPaymentsEnabled(s.env, { enabled: true, revision: settings.revision, confirmation: 'ENABLE_PAYMENTS' })
  const pause = () => setPaymentsEnabled(s.env, { enabled: false })
  await resume()
  Object.assign(s.env, await resolvePaymentEnv(s.env))
  async function tick() {
    s.db.exec('UPDATE orders SET next_check=0')
    return reconcile(await resolvePaymentEnv(s.env))
  }
  return { ...s, tick, pause, resume, settings }
}

async function manualFixture(t: Context) {
  const s = await selectedFixture(t, [456])
  s.env.NATIVE_ORDER_QUERY = queryNativeOrder
  s.state.checkoutUrl = 'https://checkout.stripe.com/g/pay/' + session + '#original-fragment'
  const call = (path: string, body?: unknown, cookie = '', origin = 'https://x-api.example.test') => worker.fetch(new Request('https://x-api.example.test' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), s.env)
  const login = await call('/api/login', { email: 'admin', password: s.env.ADMIN_PASSWORD })
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0]
  const route = `/api/admin/users/${s.user.id}/gift/orders`
  const body = { confirmation: 'GIFT', merchant_order_no: 'admin_manual-001', idempotency_key: 'admin_manual-001',
    product_code: 'x-premium-3m', recipient: 'receiver', recipient_id: '12345', expected_points: 1700, manual_confirmation: true }
  const made = await call(route, body, cookie)
  assert.equal(made.status, 201)
  const orderId = (await made.json()).data.id
  const row = () => s.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId) as unknown as Order
  const job = async () => JSON.parse(await unseal(s.env, 'native:' + orderId, String(s.db.prepare('SELECT payload FROM native_jobs WHERE order_id=?').get(orderId)!.payload)))
  const setJob = async (patch: Record<string, unknown>) => s.db.prepare('UPDATE native_jobs SET payload=? WHERE order_id=?').run(
    await seal(s.env, 'native:' + orderId, JSON.stringify({ ...await job(), ...patch })), orderId)
  const approval = { confirmation: 'CONFIRM_PAYMENT', expected_card_id: 123, expected_amount_minor: 30000, expected_currency: 'bdt', expected_recipient: 'receiver' }
  const approvePath = '/api/admin/orders/' + orderId + '/approve-payment'
  for (let i = 0; i < 4; i++) await s.tick()
  assert.equal((await job()).stage, 'awaiting_approval')
  return { ...s, call, cookie, route, body, orderId, row, job, setJob, approval, approvePath }
}

test('manual mode is immutable, admin-only, prepares exactly one card and never submits before a human approval', async t => {
  const s = await manualFixture(t)
  for (let i = 0; i < 10; i++) await s.tick()
  assert.equal(s.state.methods, 1); assert.equal(s.state.confirms + s.state.cardOpens, 0)
  const binding = (await paymentBinding(await resolvePaymentEnv(s.env), s.orderId))!
  assert.equal(binding.manual_confirmation, true); assert.deepEqual(binding.backup_card_ids, [])
  assert.equal((await s.call(s.route, s.body, s.cookie)).status, 200)
  assert.equal((await s.call(s.route, { ...s.body, manual_confirmation: false }, s.cookie)).status, 409)
  await assert.rejects(s.create({ manual_confirmation: true }), /仅由管理员/)
  const actions = await adminOrderCapabilities(s.env, s.row())
  assert.equal(actions.approve_payment, true); assert.equal(actions.payment_page, false)
  assert.equal(actions.payment_card_id, 123)
  await assert.rejects(adminPaymentPage(s.env, s.orderId), /不能同时手动付款/)
  const snapshot = JSON.parse(await unseal(s.env, 'execution:' + s.orderId, s.row().execution_config!))
  assert.equal((await queryNativeOrder(s.env, s.row(), snapshot)).failure_code, 'manual_payment_approval_required')
  assert.equal(s.state.polls, 0)
})

test('manual approval is admin-only, CSRF protected and rejects missing acknowledgement and stale payment identity', async t => {
  const s = await manualFixture(t)
  assert.equal((await s.call(s.approvePath, s.approval)).status, 401)
  const merchant = await s.call('/api/login', { email: s.user.email, password: 'test-password-fixture' })
  const cookie = merchant.headers.get('Set-Cookie')!.split(';')[0]
  assert.equal((await s.call(s.approvePath, s.approval, cookie)).status, 403)
  assert.equal((await s.call(s.approvePath, s.approval, s.cookie, 'https://evil.test')).status, 403)
  assert.equal((await s.call(s.approvePath, { ...s.approval, confirmation: '' }, s.cookie)).status, 400)
  for (const patch of [{ expected_card_id: 456 }, { expected_amount_minor: 1 }, { expected_currency: 'usd' }, { expected_recipient: 'other' }])
    assert.equal((await s.call(s.approvePath, { ...s.approval, ...patch }, s.cookie)).status, 409)
  assert.equal((await s.job()).manual_approved_at, undefined)
  assert.equal(s.state.confirms, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='approve_manual_payment'").get()!.n, 0)
})

test('approved manual order survives fresh environment resolution, submits once and only polls after a lost response', async t => {
  const s = await manualFixture(t); s.state.lostConfirm = true
  assert.equal((await s.call(s.approvePath, s.approval, s.cookie)).status, 200)
  assert.equal((await s.call(s.approvePath, s.approval, s.cookie)).status, 200)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='approve_manual_payment'").get()!.n, 1)
  assert.equal(s.state.confirms, 0, 'Approval endpoint must only store authority')
  await s.tick()
  assert.equal(s.state.confirms, 1)
  assert.equal((await s.call(s.approvePath, s.approval, s.cookie)).status, 409)
  for (let i = 0; i < 5; i++) await s.tick()
  assert.equal(s.row().status, 'succeeded')
  assert.deepEqual([s.state.xCreates, s.state.methods, s.state.confirms, s.state.cardOpens], [1, 1, 1, 0])
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='consume'").get()!.n, 1)
})

test('paused, expired, future-dated and revoked approvals never submit; a fresh acknowledgement can resume the same method', async t => {
  const s = await manualFixture(t)
  await s.pause()
  assert.equal((await s.call(s.approvePath, s.approval, s.cookie)).status, 503)
  assert.equal((await s.job()).manual_approved_at, undefined)
  await s.resume()
  await s.call(s.approvePath, s.approval, s.cookie)
  for (const at of [Date.now() - 300001, Date.now() + 60000, undefined]) {
    await s.setJob({ manual_approved_at: at }); await s.tick()
    assert.equal(s.state.confirms, 0)
  }
  assert.equal((await s.call(s.approvePath, s.approval, s.cookie)).status, 200)
  await s.tick(); await s.tick()
  assert.equal(s.state.methods, 1); assert.equal(s.state.confirms, 1)
})

test('approval expires during asynchronous page refresh and cannot proceed to debit', async t => {
  const s = await manualFixture(t)
  await s.call(s.approvePath, s.approval, s.cookie)
  const now = Date.now(), at = (await s.job()).manual_approved_at
  s.state.onInit = async () => { t.mock.method(Date, 'now', () => Math.max(now, at) + 300001) }
  await s.tick()
  assert.equal(s.state.confirms, 0); assert.equal((await s.job()).stage, 'awaiting_approval')
})

test('manual approval audit failure is atomic and a live worker lease prevents conflicting acknowledgement', async t => {
  const s = await manualFixture(t)
  s.db.prepare('UPDATE orders SET lease_until=? WHERE id=?').run(Date.now() + 60000, s.orderId)
  assert.equal((await s.call(s.approvePath, s.approval, s.cookie)).status, 409)
  s.db.prepare('UPDATE orders SET lease_until=0 WHERE id=?').run(s.orderId)
  s.db.exec("CREATE TRIGGER reject_approval BEFORE INSERT ON audit WHEN NEW.action='approve_manual_payment' BEGIN SELECT RAISE(ABORT,'fixture_failure'); END")
  assert.equal((await s.call(s.approvePath, s.approval, s.cookie)).status, 503)
  assert.equal((await s.job()).manual_approved_at, undefined)
  assert.equal(s.state.confirms, 0)
})

test('manual 3DS order cannot be approved again or switched to another card', async t => {
  const s = await manualFixture(t); s.state.requiresAction = true
  await s.call(s.approvePath, s.approval, s.cookie); await s.tick(); await s.tick()
  assert.equal(s.row().failure_code, 'payment_requires_action')
  const actions = await adminOrderCapabilities(s.env, s.row())
  assert.equal(actions.approve_payment, undefined); assert.equal(actions.payment_page, true)
  assert.equal((await adminPaymentPage(s.env, s.orderId)).url, s.state.checkoutUrl)
  assert.equal((await s.call(s.approvePath, s.approval, s.cookie)).status, 409)
  assert.deepEqual(s.state.methodCards, ['4242424242424242'])
  assert.equal(s.state.confirms, 1)
})

test('manual approval lifetime is bounded and nonnumeric timestamps are rejected', () => {
  for (const value of [undefined, null, true, '1', 0, -1, Infinity, NaN, 1001, 1.5]) assert.equal(manualApprovalFresh(value, 1000), false)
  assert.equal(manualApprovalFresh(1, 300000), true)
  assert.equal(manualApprovalFresh(1, 300001), false)
})

test('admin order-specific card is frozen atomically and used without changing the global card or backup list', async t => {
  const s = await selectedFixture(t, [456])
  s.state.cards[789] = { id: 789, card_number: '4000000000000002', status: 'ACTIVE', available_amount: 20, expire: '12/30' }
  const provider = await cardConfiguration(s.env), before = s.db.prepare('SELECT * FROM payment_settings').get()
  const selection = { card_id: 789, payment_revision: s.settings.revision, provider_revision: provider.revision }
  const call = (path: string, body?: unknown, cookie = '') => worker.fetch(new Request('https://x-api.example.test' + path, {
    method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: 'https://x-api.example.test', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), s.env)
  const login = await call('/api/login', { email: 'admin', password: s.env.ADMIN_PASSWORD })
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0]
  const route = `/api/admin/users/${s.user.id}/gift/orders`
  const payload = { confirmation: 'GIFT', merchant_order_no: 'admin_selected-001', idempotency_key: 'admin_selected-001', product_code: 'x-premium-3m', recipient: 'receiver', recipient_id: '12345', expected_points: 1700, payment_card_selection: selection }
  const made = await call(route, payload, cookie)
  assert.equal(made.status, 201)
  const id = (await made.json()).data.id
  const stored = s.db.prepare('SELECT * FROM orders WHERE id=?').get(id)!
  assert.doesNotMatch(String(stored.payment_card_selection), /pk_live|test@example|billing/)
  assert.throws(() => s.db.prepare('UPDATE orders SET payment_card_selection=NULL WHERE id=?').run(id), /immutable_order_payment_selection/)
  const binding = (await paymentBinding(await resolvePaymentEnv(s.env), id))!
  assert.equal(binding.card_id, 789)
  assert.deepEqual(binding.backup_card_ids, [])
  await assertPaymentAllowed(s.env, binding, id)
  await assert.rejects(assertPaymentAllowed(s.env, binding), /未匹配原订单授权/)
  await assert.rejects(assertPaymentAllowed(s.env, { ...binding, card_id: 456 }, id), /未匹配原订单授权/)
  const reads = s.state.cardReads.length
  assert.equal((await call(route, payload, cookie)).status, 200)
  assert.equal(s.state.cardReads.length, reads, 'Retry must not reselect a card or recheck a new candidate')
  assert.equal((await call(route, { ...payload, payment_card_selection: { ...selection, card_id: 456 } }, cookie)).status, 409)
  assert.deepEqual(s.db.prepare('SELECT * FROM payment_settings').get(), before)
  for (let i = 0; i < 8; i++) await s.tick()
  assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(id)!.status, 'succeeded')
  assert.deepEqual(s.state.methodCards, ['4000000000000002'])
  assert.deepEqual([s.state.cardOpens, s.state.methods, s.state.confirms], [0, 1, 1])
  assert.deepEqual(s.db.prepare('SELECT * FROM payment_settings').get(), before)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM native_funding').get()!.n, 0)
})

test('a chosen order card failing preflight never silently falls back to the global primary or backups', async t => {
  const s = await selectedFixture(t, [456]), settings = await paymentSettings(s.env)
  s.state.cards[789] = { id: 789, card_number: '4000000000000002', status: 'ACTIVE', available_amount: 20, expire: '12/30' }
  const selection = { card_id: 789, payment_revision: settings!.revision, provider_revision: settings!.provider_revision! }
  const body = { merchant_order_no: 'admin_chosen-002', product_code: 'x-premium-3m', recipient: 'receiver', recipient_id: '12345', expected_points: 1700, payment_card_selection: selection }
  await createOrder(s.env, s.user.id, 'admin_chosen-002', body, { paymentCardSelection: selection })
  s.state.cardReads.length = 0; s.state.cards[789].status = 'FROZEN'
  for (let i = 0; i < 5; i++) await s.tick()
  assert.ok(s.state.cardReads.every(card => card === 789))
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'unknown')
  assert.equal(s.db.prepare('SELECT failure_code FROM orders').get()!.failure_code, 'card_frozen')
  assert.deepEqual([s.state.methods, s.state.confirms, s.state.cardOpens], [0, 0, 0])
  assert.equal((await paymentSettings(s.env))!.card_id, 123)
})

test('unready or stale order-card selection rejects before freezing points and cannot be supplied by merchants', async t => {
  const s = await selectedFixture(t, [456]), settings = (await paymentSettings(s.env))!
  const selection = { card_id: 456, payment_revision: settings.revision, provider_revision: settings.provider_revision! }
  const body = { merchant_order_no: 'admin_chosen-003', product_code: 'x-premium-3m', recipient: 'receiver', recipient_id: '12345', expected_points: 1700, payment_card_selection: selection }
  await assert.rejects(createOrder(s.env, s.user.id, 'admin_chosen-003', body), /仅由管理员/)
  await assert.rejects(createOrder(s.env, s.user.id, 'admin_chosen-003', body, { paymentCardSelection: { ...selection, payment_revision: 'paycfg_stale' } }), /配置已变化/)
  s.state.cards[456].available_amount = 5
  await assert.rejects(createOrder(s.env, s.user.id, 'admin_chosen-003', body, { paymentCardSelection: selection }), /不少于 10 USD/)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT frozen FROM wallets WHERE user_id=?').get(s.user.id)!.frozen, 0)
})

test('selected existing card never opens or funds a card and freezes key, card and billing per execution', async t => {
  const s = await selectedFixture(t)
  await s.create(); await s.tick()
  await configureGiftProfile(s.env, { first_name: 'Changed', last_name: 'Profile', billing_email: 'changed@example.test', billing_country: 'HK' })
  for (let i = 0; i < 7; i++) await s.tick()
  const order = s.db.prepare('SELECT * FROM orders').get() as unknown as Order
  assert.equal(order.status, 'succeeded')
  assert.deepEqual([s.state.xCreates, s.state.cardOpens, s.state.methods, s.state.confirms], [1, 0, 1, 1])
  assert.deepEqual(s.state.methodBilling, ['test@example.test'])
  assert.ok(s.state.cardReads.every(id => id === 123))
  assert.ok(s.state.paymentKeys.every(key => key === 'pk_live_selectedfixture'))
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM native_funding').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM card_operations').get()!.n, 0)
  const snapshot = JSON.parse(await unseal(s.env, 'execution:' + order.id, order.execution_config!))
  assert.equal(snapshot.payment.card_id, 123)
  assert.equal(snapshot.payment.billing.billing_email, 'test@example.test')
  const raw = String(s.db.prepare('SELECT payload FROM native_jobs').get()!.payload)
  assert.doesNotMatch(raw, /4242424242424242|selectedfixture|test@example/)
  assert.doesNotMatch(await unseal(s.env, 'native:' + order.id, raw), /4242424242424242|"cvv"/)
})

test('a pause while checkout is refreshed blocks confirmation and resuming preserves the original card', async t => {
  const s = await selectedFixture(t)
  await s.create()
  for (let i = 0; i < 4; i++) await s.tick()
  s.state.onInit = async () => { s.state.onInit = undefined; await s.pause() }
  await s.tick()
  assert.equal(s.state.confirms, 0)
  assert.equal(s.db.prepare('SELECT failure_code FROM orders').get()!.failure_code, 'payments_paused')
  assert.equal(s.db.prepare('SELECT stage FROM native_jobs').get()!.stage, 'tokenized')
  await s.resume(); await s.tick()
  assert.equal(s.state.confirms, 1)
  await s.pause(); await s.tick()
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'succeeded')
  assert.deepEqual([s.state.cardOpens, s.state.methods, s.state.confirms], [0, 1, 1])
})

test('insufficient or expired selected cards never tokenize, confirm, top up or open replacements', async t => {
  const s = await selectedFixture(t)
  await s.create(); await s.tick(); await s.tick()
  s.state.cardBalance = 9.99
  await s.tick(); await s.tick()
  assert.equal(s.db.prepare('SELECT stage FROM native_jobs').get()!.stage, 'funding')
  s.state.cardBalance = 20; s.state.cardExpiry = '00/00'
  await s.tick()
  assert.deepEqual([s.state.cardOpens, s.state.methods, s.state.confirms], [0, 0, 0])
  assert.equal(s.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 1700)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM card_operations').get()!.n, 0)
})

test('a pause arriving after the durable submit marker still prevents the upstream confirmation', async t => {
  const s = await selectedFixture(t)
  await s.create()
  for (let i = 0; i < 4; i++) await s.tick()
  const prepare = s.env.DB.prepare.bind(s.env.DB)
  let paused = false
  t.mock.method(s.env.DB, 'prepare', (sql: string) => {
    const statement = prepare(sql)
    if (!sql.startsWith('INSERT INTO native_jobs')) return statement
    const bind = statement.bind.bind(statement), run = statement.run.bind(statement)
    let stage: unknown
    statement.bind = (...values) => { stage = values[1]; bind(...values); return statement }
    statement.run = async () => {
      const result = await run()
      if (stage === 'submitted' && !paused) { paused = true; await s.pause() }
      return result
    }
    return statement
  })
  await s.tick()
  assert.equal(paused, true)
  assert.equal(s.state.confirms, 0)
  assert.equal(s.db.prepare('SELECT stage FROM native_jobs').get()!.stage, 'tokenized')
  await s.resume(); await s.tick(); await s.tick()
  assert.equal(s.state.confirms, 1)
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'succeeded')
})

test('provider changes stop bound work without selecting a different card; pending orders block configuration edits', async t => {
  const s = await selectedFixture(t)
  await s.create(); await s.tick(); await s.pause()
  await assert.rejects(configurePayments(s.env, { revision: s.settings.revision, stripe_publishable_key: 'pk_live_changed', card_id: 456, provider_revision: s.settings.provider_revision }), /未结订单/)
  await s.resume()
  await assert.rejects(configureCards(s.env, { environment: 'production', transport: 'direct', api_key: 'sk_changedfixture', writes_enabled: false }), /未结订单/)
  // Even a direct database/operator change cannot silently switch the bound payment.
  s.db.exec("UPDATE card_provider SET revision='cfg_changedoutsideapi'")
  for (let i = 0; i < 4; i++) await s.tick()
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'unknown')
  assert.deepEqual([s.state.cardOpens, s.state.methods, s.state.confirms], [0, 0, 0])
  assert.ok(s.state.cardReads.every(id => id === 123))
})

test('incoming closure stops native confirmation but already submitted sessions remain read-only pollable', async t => {
  const s = await selectedFixture(t)
  await s.create()
  s.db.exec(`INSERT INTO alipay_checkouts(id,access_hash,request_hash,out_trade_no,product_code,product_name,months,points,currency,amount_minor,stripe_product,
    amount_cents,recipient,recipient_id,provider_revision,outbound_revision,config_payload,status,paid_at,order_id,created_at,expires_at,updated_at)
    SELECT 'chk_fixture','fixture','fixture','xgift_fixture',product_code,'Fixture',months,points,currency,amount_minor,stripe_product,
      8880,recipient,recipient_id,'fixture','fixture','fixture','paid',1,id,1,9999999999999,1 FROM orders`)
  for (let i = 0; i < 4; i++) await s.tick()
  s.state.onInit = async () => {
    s.state.onInit = undefined
    s.db.exec("UPDATE alipay_checkouts SET status='attention',failure_code='payment_closed_unconfirmed'")
  }
  await s.tick()
  assert.equal(s.state.confirms, 0)
  assert.equal(s.db.prepare('SELECT failure_code FROM orders').get()!.failure_code, 'collection_requires_review')
  assert.equal(s.db.prepare('SELECT stage FROM native_jobs').get()!.stage, 'tokenized')
  s.db.exec("UPDATE alipay_checkouts SET status='paid',failure_code=NULL")
  await s.tick()
  assert.equal(s.state.confirms, 1)
  s.db.exec("UPDATE alipay_checkouts SET status='attention',failure_code='payment_closed_unconfirmed'")
  await s.tick()
  assert.equal(s.state.confirms, 1)
  assert.equal(s.state.polls, 1)
})

test('selected-card lost confirmation and 3DS only poll the original checkout, including while paused', async t => {
  const s = await selectedFixture(t)
  s.state.lostConfirm = true; s.state.requiresAction = true
  await s.create()
  for (let i = 0; i < 8; i++) await s.tick()
  assert.equal(s.db.prepare('SELECT failure_code FROM orders').get()!.failure_code, 'payment_requires_action')
  assert.equal(s.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 1700)
  assert.deepEqual([s.state.xCreates, s.state.cardOpens, s.state.methods, s.state.confirms], [1, 0, 1, 1])
  await s.pause(); s.state.requiresAction = false
  await s.tick(); await s.tick()
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'succeeded')
  assert.equal(s.state.confirms, 1)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='consume'").get()!.n, 1)
})

test('creating a saved payment configuration cannot turn a legacy in-flight job into automatic card funding', async t => {
  const s = await fixture(t)
  await s.create(); await s.tick(); await s.tick()
  await setPaymentsEnabled(s.env, { enabled: false })
  // Deliberately pass the old boot-time environment: the executor must re-read the database guard.
  await s.tick(); await s.tick()
  assert.equal(s.state.cardOpens, 0)
  assert.equal(s.state.confirms, 0)
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'unknown')
})

type SelectedFixture = Awaited<ReturnType<typeof selectedFixture>>
async function nativeRecord(s: SelectedFixture) {
  const order = s.db.prepare('SELECT * FROM orders').get() as unknown as Order
  const row = s.db.prepare('SELECT * FROM native_jobs WHERE order_id=?').get(order.id)!
  return { order, job: JSON.parse(await unseal(s.env, 'native:' + order.id, String(row.payload))) }
}
async function enterFunding(s: SelectedFixture) {
  await s.create(); await s.tick(); await s.tick()
  assert.equal(s.db.prepare('SELECT stage FROM native_jobs').get()!.stage, 'funding')
  s.state.cardReads.length = 0
}

test('authorized backups are checked in order once per tick and persist across restart without changing global selection', async t => {
  const s = await selectedFixture(t, [456, 789]); await enterFunding(s)
  const settings = await paymentSettings(s.env)
  s.state.cards[123] = { status: 'FROZEN' }; s.state.cards[456].available_amount = 9
  await s.tick()
  assert.deepEqual(s.state.cardReads, [123])
  let record = await nativeRecord(s)
  assert.equal(record.job.card_id, 456); assert.equal(record.job.candidate_index, 1)
  assert.deepEqual(record.job.rejected_cards, [{ card_id: 123, reason: 'card_frozen' }])
  await s.tick()
  assert.deepEqual(s.state.cardReads, [123, 456])
  record = await nativeRecord(s)
  assert.equal(record.job.card_id, 789); assert.equal(record.job.candidate_index, 2)
  s.state.cards[123].status = 'ACTIVE'; s.state.cards[456].available_amount = 20
  // Recreate the execution environment; all candidate state must come from the encrypted job.
  s.db.exec('UPDATE orders SET next_check=0')
  await reconcile(await resolvePaymentEnv({ ...s.env }))
  assert.deepEqual(s.state.cardReads, [123, 456, 789])
  for (let i = 0; i < 5; i++) await s.tick()
  assert.equal((await nativeRecord(s)).order.status, 'succeeded')
  assert.deepEqual(s.state.methodCards, ['4000000000000002'])
  assert.deepEqual(s.state.confirmMethods, ['pm_fixture'])
  assert.deepEqual([s.state.xCreates, s.state.cardOpens, s.state.methods, s.state.confirms], [1, 0, 1, 1])
  assert.ok(s.state.cardReads.slice(2).every(card => card === 789))
  assert.deepEqual(await paymentSettings(s.env), settings)
  const audit = s.db.prepare("SELECT actor,action,target,note FROM audit WHERE action='payment_card_failover' ORDER BY created_at,id").all()
  assert.equal(audit.length, 2); assert.ok(audit.every(row => row.actor === 'system' && row.target === record.order.id))
  assert.doesNotMatch(JSON.stringify(audit), /4242424242424242|5555555555554444|4000000000000002|cvv|billing/)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM card_operations').get()!.n, 0)
})

test('exhausted backups remain on the last card, audit once, and can resume after that card recovers', async t => {
  const s = await selectedFixture(t, [456]); await enterFunding(s)
  s.state.cards[123] = { status: 'DELETED' }; s.state.cards[456].status = 'CANCELLED'
  await s.tick(); await s.tick()
  assert.equal((await nativeRecord(s)).order.failure_code, 'payment_cards_exhausted')
  for (let i = 0; i < 3; i++) await s.tick()
  assert.deepEqual(s.state.cardReads, [123, 456, 456, 456, 456])
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='payment_cards_exhausted'").get()!.n, 1)
  assert.equal(s.state.methods + s.state.confirms, 0)
  s.state.cards[456].status = 'ACTIVE'
  for (let i = 0; i < 5; i++) await s.tick()
  const record = await nativeRecord(s)
  assert.equal(record.order.status, 'succeeded'); assert.equal(record.job.card_id, 456)
  assert.equal(record.job.candidates_exhausted, false)
  assert.equal(record.job.rejected_cards.length, 2)
  assert.deepEqual(s.state.methodCards, ['5555555555554444'])
  assert.equal(s.state.confirms, 1)
  assert.equal(s.state.cardReads.filter(card => card === 123).length, 1)
})

test('a card expiring between preflight reads may switch before any payment method is prepared', async t => {
  const s = await selectedFixture(t, [456]); await enterFunding(s)
  await s.tick(); assert.equal((await nativeRecord(s)).job.stage, 'funded')
  s.state.cards[123] = { expire: '12/20' }
  await s.tick()
  const record = await nativeRecord(s)
  assert.equal(record.job.stage, 'funding'); assert.equal(record.job.card_id, 456)
  assert.equal(record.job.rejected_cards[0].reason, 'card_expired')
  assert.equal(s.state.methods, 0)
  for (let i = 0; i < 5; i++) await s.tick()
  assert.deepEqual(s.state.methodCards, ['5555555555554444'])
  assert.equal(s.state.confirms, 1)
})

test('unverified identity, malformed card fields, unknown statuses and invalid balances never authorize failover', async t => {
  const cases: [string, Record<string, unknown>][] = [
    ['wrong identity', { id: 999 }], ['unknown status', { status: 'UNKNOWN' }], ['missing number', { card_number: '' }],
    ['invalid cvv', { cvv: 'invalid' }], ['invalid expiry month', { expire: '00/30' }], ['invalid expiry format', { expire: '2030-12' }],
    ['null balance', { available_amount: null }], ['negative balance', { available_amount: -1 }],
    ['nonnumeric balance', { available_amount: 'unknown' }], ['empty balance', { available_amount: '' }], ['wrong currency', { currency: 'BDT' }],
  ]
  for (const [name, patch] of cases) await t.test(name, async t => {
    const s = await selectedFixture(t, [456]); await enterFunding(s)
    s.state.cards[123] = patch
    await s.tick(); await s.tick()
    const record = await nativeRecord(s)
    assert.equal(record.order.failure_code, 'payment_card_unverified')
    assert.equal(record.job.card_id, 123); assert.equal(record.job.rejected_cards, undefined)
    assert.deepEqual(s.state.cardReads, [123, 123])
    assert.equal(s.state.methods + s.state.confirms, 0)
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='payment_card_failover'").get()!.n, 0)
  })
})

test('card-provider timeout and authentication failures keep the original candidate without trying a backup', async t => {
  for (const failure of ['network', 'unauthorized'] as const) await t.test(failure, async t => {
    const s = await selectedFixture(t, [456]); await enterFunding(s)
    s.state.providerFailure = failure
    await s.tick(); await s.tick()
    const record = await nativeRecord(s)
    assert.equal(record.order.status, 'unknown'); assert.equal(record.job.card_id, 123)
    assert.equal(record.job.rejected_cards, undefined)
    assert.deepEqual(s.state.cardReads, [123, 123]); assert.equal(s.state.methods + s.state.confirms, 0)
  })
})

test('lost tokenization and a tokenized card becoming unavailable never create a second method or switch cards', async t => {
  for (const lost of [false, true]) await t.test(lost ? 'lost method response' : 'method already bound', async t => {
    const s = await selectedFixture(t, [456]); await enterFunding(s)
    s.state.methodLost = lost
    await s.tick(); await s.tick()
    assert.equal((await nativeRecord(s)).job.stage, lost ? 'tokenizing' : 'tokenized')
    s.state.cards[123] = { status: 'FROZEN' }
    for (let i = 0; i < 3; i++) await s.tick()
    const record = await nativeRecord(s)
    assert.equal(record.job.card_id, 123); assert.equal(record.job.tokenization_started, true)
    assert.equal(record.order.failure_code, lost ? 'original_request_unconfirmed' : 'card_frozen')
    assert.equal(s.state.methods, 1); assert.equal(s.state.confirms, 0)
    assert.ok(s.state.cardReads.every(card => card === 123))
  })
})

test('an authorized backup with lost confirmation or 3DS only polls its original checkout even if another backup is usable', async t => {
  const s = await selectedFixture(t, [456, 789]); await enterFunding(s)
  s.state.cards[123] = { status: 'FROZEN' }; s.state.lostConfirm = true; s.state.requiresAction = true
  for (let i = 0; i < 7; i++) await s.tick()
  assert.equal((await nativeRecord(s)).order.failure_code, 'payment_requires_action')
  assert.equal((await nativeRecord(s)).job.card_id, 456)
  const reads = [...s.state.cardReads]
  s.state.cards[456].status = 'FROZEN'
  await s.tick(); await s.tick()
  assert.deepEqual(s.state.cardReads, reads)
  await s.pause(); s.state.requiresAction = false; await s.tick()
  assert.equal((await nativeRecord(s)).order.status, 'succeeded')
  assert.deepEqual(s.state.methodCards, ['5555555555554444'])
  assert.equal(s.state.methods, 1); assert.equal(s.state.confirms, 1)
  assert.ok(!s.state.cardReads.includes(789))
})

test('an old snapshot without backups never adopts candidates later added to live settings', async t => {
  const s = await selectedFixture(t); await enterFunding(s)
  let { order, job } = await nativeRecord(s)
  delete job.payment.backup_card_ids
  const snapshot = JSON.parse(await unseal(s.env, 'execution:' + order.id, order.execution_config!))
  delete snapshot.payment.backup_card_ids
  s.db.prepare('UPDATE native_jobs SET payload=? WHERE order_id=?').run(await seal(s.env, 'native:' + order.id, JSON.stringify(job)), order.id)
  s.db.prepare('UPDATE orders SET execution_config=? WHERE id=?').run(await seal(s.env, 'execution:' + order.id, JSON.stringify(snapshot)), order.id)
  s.state.cards[123] = { status: 'FROZEN' }
  await s.tick()
  assert.equal((await nativeRecord(s)).order.failure_code, 'card_frozen')
  assert.deepEqual(s.state.cardReads, [123])
  const row = s.db.prepare('SELECT payload FROM payment_settings').get()!
  const settings = JSON.parse(await unseal(s.env, 'payment-settings', String(row.payload)))
  settings.backup_card_ids = [456]
  s.db.prepare('UPDATE payment_settings SET payload=?').run(await seal(s.env, 'payment-settings', JSON.stringify(settings)))
  await s.tick()
  const latest = await nativeRecord(s)
  assert.equal(latest.order.failure_code, 'payment_configuration_changed')
  assert.equal(latest.job.card_id, 123); assert.equal(latest.job.payment.backup_card_ids, undefined)
  assert.deepEqual(s.state.cardReads, [123])
})

test('pause, changed payment revisions and collection reversal detected during card reads block candidate advancement', async t => {
  for (const change of ['pause', 'revision', 'collection']) await t.test(change, async t => {
    const s = await selectedFixture(t, [456]); await enterFunding(s)
    if (change === 'collection') s.db.exec(`INSERT INTO alipay_checkouts(id,access_hash,request_hash,out_trade_no,product_code,product_name,months,points,currency,amount_minor,stripe_product,
      amount_cents,recipient,recipient_id,provider_revision,outbound_revision,config_payload,status,paid_at,order_id,created_at,expires_at,updated_at)
      SELECT 'chk_fixture','fixture','fixture','xgift_fixture',product_code,'Fixture',months,points,currency,amount_minor,stripe_product,
        8880,recipient,recipient_id,'fixture','fixture','fixture','paid',1,id,1,9999999999999,1 FROM orders`)
    s.state.cards[123] = { status: 'FROZEN' }
    s.state.onCardRead = async () => {
      s.state.onCardRead = undefined
      if (change === 'pause') await s.pause()
      if (change === 'revision') s.db.exec("UPDATE payment_settings SET revision='paycfg_changed'")
      if (change === 'collection') s.db.exec("UPDATE alipay_checkouts SET status='attention',failure_code='payment_closed_unconfirmed'")
    }
    await s.tick()
    const record = await nativeRecord(s)
    assert.equal(record.order.failure_code, change === 'pause' ? 'payments_paused' : change === 'revision' ? 'payment_configuration_changed' : 'collection_requires_review')
    assert.equal(record.job.card_id, 123); assert.equal(record.job.rejected_cards, undefined)
    assert.equal(s.state.methods + s.state.confirms, 0)
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='payment_card_failover'").get()!.n, 0)
  })
})

test('a pause after the atomic failover save prevents backup use until resumed and preserves its cursor', async t => {
  const s = await selectedFixture(t, [456]); await enterFunding(s)
  s.state.cards[123] = { status: 'FROZEN' }
  const batch = s.env.DB.batch.bind(s.env.DB); let paused = false
  t.mock.method(s.env.DB, 'batch', async statements => {
    const result = await batch(statements)
    if (!paused && (await nativeRecord(s)).job.card_id === 456) { paused = true; await s.pause() }
    return result
  })
  await s.tick()
  assert.equal(paused, true)
  assert.equal((await nativeRecord(s)).order.failure_code, 'payments_paused')
  assert.equal((await nativeRecord(s)).job.card_id, 456)
  assert.deepEqual(s.state.cardReads, [123]); assert.equal(s.state.methods, 0)
  s.state.cards[123].status = 'ACTIVE'; await s.resume(); s.state.cardReads.length = 0
  for (let i = 0; i < 5; i++) await s.tick()
  assert.equal((await nativeRecord(s)).order.status, 'succeeded')
  assert.ok(s.state.cardReads.every(card => card === 456))
  assert.equal(s.state.methods, 1); assert.equal(s.state.confirms, 1)
})

test('a tokenization marker survives a last-moment pause rollback and permanently locks the candidate', async t => {
  const s = await selectedFixture(t, [456]); await enterFunding(s); await s.tick()
  const prepare = s.env.DB.prepare.bind(s.env.DB); let paused = false
  t.mock.method(s.env.DB, 'prepare', (sql: string) => {
    const statement = prepare(sql)
    if (!sql.startsWith('INSERT INTO native_jobs')) return statement
    const bind = statement.bind.bind(statement), run = statement.run.bind(statement); let stage: unknown
    statement.bind = (...values) => { stage = values[1]; bind(...values); return statement }
    statement.run = async () => {
      const result = await run()
      if (stage === 'tokenizing' && !paused) { paused = true; await s.pause() }
      return result
    }
    return statement
  })
  await s.tick()
  const record = await nativeRecord(s)
  assert.equal(record.job.stage, 'funded'); assert.equal(record.job.tokenization_started, true)
  assert.equal(record.order.failure_code, 'payments_paused'); assert.equal(s.state.methods, 0)
  await s.resume(); s.state.cards[123] = { status: 'FROZEN' }; s.state.cardReads.length = 0
  await s.tick(); await s.tick()
  assert.equal((await nativeRecord(s)).job.card_id, 123)
  assert.equal((await nativeRecord(s)).order.failure_code, 'card_frozen')
  assert.deepEqual(s.state.cardReads, [123, 123]); assert.equal(s.state.methods + s.state.confirms, 0)
})
