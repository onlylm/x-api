import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { database } from '../services/xgift/server/database.ts'
import { executeNative, guardPage, X_MERCHANT } from '../services/xgift/server/native-executor.ts'
import { createUser, createKey } from '../services/xgift/src/auth.ts'
import { credit, createOrder, type Order } from '../services/xgift/src/orders.ts'
import { saveSecret, eligibility } from '../services/xgift/src/network.ts'
import { cardConfiguration, configureCards } from '../services/xgift/src/cards.ts'
import { configureGiftProfile } from '../services/xgift/src/gift-profile.ts'
import { configurePayments, paymentSettings, resolvePaymentEnv, setPaymentsEnabled } from '../services/xgift/src/payments.ts'
import { reconcile } from '../services/xgift/src/executor.ts'
import { unseal, type Env } from '../services/xgift/src/core.ts'
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
    cardId: 123, cardProduct: 'PP5583RC', cardBalance: 20, cardStatus: 'ACTIVE', cardExpiry: '12/30', cardReads: [] as number[], methodBilling: [] as string[], paymentKeys: [] as string[], onInit: undefined as (() => Promise<void>) | undefined }
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'x.com') {
      if (url.pathname.endsWith('/PremiumGiftingQuery')) return Response.json(state.xError ? { errors: [{ message: 'private-upstream' }] } : { data: { user: { result: state.malformed ? {} : { rest_id: state.recipientId, core: { screen_name: 'Receiver' }, premium_gifting_eligible: state.eligible } } } })
      if (url.pathname.endsWith('/useSubscriptionProductDetailsByRestIdQuery')) return Response.json({ data: { web_subscription_product_details_by_rest_id: { rest_id: 'prod_TJXJtpzqCpI36N', prices: [{ currency_code: 'BDT', amount_local_micro: 300000000, price_type: 'OneTime' }] } } })
      assert.ok(url.pathname.endsWith('/useOneTimePurchaseGiftMutation')); state.xCreates++
      assert.equal(init?.method, 'POST'); assert.equal(JSON.parse(String(init?.body)).variables.gift_recipient, '12345')
      return Response.json({ data: { onetimepurchase_gift: { session_status: 'Unpaid', session_id: session, session_url: 'https://checkout.stripe.com/c/pay/' + session } } })
    }
    if (url.hostname === 'zovocard.com') {
      const data = url.pathname.endsWith('/products') ? [{ product_code: 'PP5583RC', issuer: 'four', min_amount: 20, open_fee: state.openFee, recharge_fee: 0 }]
        : url.pathname.endsWith('/balance') ? { currency: 'USD', spendable_balance: 30 }
        : url.pathname.endsWith('/cards/open') ? (() => {
          state.cardOpens++; const body = JSON.parse(String(init?.body))
          assert.equal(body.init_amount, 20); assert.equal(body.product_code, 'PP5583RC'); assert.equal(body.max_on_percent, 10); assert.equal(body.transaction_limit, 10); assert.equal(body.transaction_limit_type, 'limited')
          if (state.lostCard) throw new Error('lost open reply')
          return { id: 123, status: 'ACTIVE', product_code: 'PP5583RC' }
        })() : (() => {
          assert.equal(init?.method ?? 'GET', 'GET', 'Existing-card reads must not mutate provider state')
          const requestedCard = Number(url.pathname.match(/\/cards\/(\d+)$/)?.[1])
          state.cardReads.push(requestedCard)
          return { id: state.cardId, product_code: state.cardProduct, card_number: '4242424242424242', cvv: '123', expire: state.cardExpiry, status: state.cardStatus, available_amount: state.cardBalance }
        })()
      return Response.json({ code: 0, data })
    }
    assert.equal(url.hostname, 'api.stripe.com')
    const fields = new URLSearchParams(init?.method === 'POST' ? String(init.body) : url.search)
    state.paymentKeys.push(fields.get('key') ?? '')
    if (url.pathname.endsWith('/init')) { await state.onInit?.(); return Response.json({ ...page(), ...(state.wrongPage ? { currency: 'sgd' } : {}) }) }
    if (url.pathname.endsWith('/payment_methods')) { state.methods++; state.methodBilling.push(fields.get('billing_details[email]') ?? ''); return Response.json({ id: 'pm_fixture', type: 'card', livemode: true }) }
    if (url.pathname.endsWith('/confirm')) {
      state.confirms++; assert.equal(new URLSearchParams(String(init?.body)).get('expected_amount'), '30000')
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

async function selectedFixture(t: Context) {
  const s = await fixture(t)
  s.env.NATIVE_EXECUTOR = executeNative
  s.state.cardProduct = 'EXISTING-CARD-PRODUCT'
  // Existing-card payments work with all card-provider mutations disabled.
  await configureCards(s.env, { environment: 'production', transport: 'direct', api_key: 'sk_fixture', writes_enabled: false })
  await setPaymentsEnabled(s.env, { enabled: false })
  const provider = await cardConfiguration(s.env)
  const settings = await configurePayments(s.env, {
    revision: (await paymentSettings(s.env))!.revision,
    stripe_publishable_key: 'pk_live_selectedfixture', card_id: 123, provider_revision: provider.revision,
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
