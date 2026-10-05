import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { database } from '../services/xgift/server/database.ts'
import { executeNative, queryNativeOrder, validatedCheckoutUrl, X_MERCHANT } from '../services/xgift/server/native-executor.ts'
import { adminCheckOrder, adminCloseOrder, adminOrderCapabilities, adminPaymentPage } from '../services/xgift/src/admin-order-actions.ts'
import { createUser } from '../services/xgift/src/auth.ts'
import { credit, type Order } from '../services/xgift/src/orders.ts'
import { saveSecret } from '../services/xgift/src/network.ts'
import { issueVouchers, redeemVoucher, voucherPublicView } from '../services/xgift/src/vouchers.ts'
import { Failure, id, seal, type Env } from '../services/xgift/src/core.ts'
import type { Snapshot } from '../services/xgift/src/executor.ts'
import worker from '../services/xgift/src/index.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const sessionId = 'cs_live_originalfixture123'
const originalUrl = 'https://checkout.stripe.com/c/pay/' + sessionId + '#original-checkout-options'
const page = () => ({ session_id: sessionId, account_settings: { account_id: X_MERCHANT }, livemode: true, mode: 'payment', currency: 'bdt',
  success_url: 'https://x.com/receiver/gift-premium/success', cancel_url: 'https://x.com/receiver/gift-premium',
  status: 'open', payment_status: 'unpaid', init_checksum: 'fixture-checksum', payment_intent: null, url: originalUrl,
  total_summary: { total: 30000, subtotal: 30000, due: 30000 }, line_item_group: { currency: 'bdt', total: 30000, subtotal: 30000, due: 30000,
    line_items: [{ name: 'Premium Gift - 3 months', quantity: 1, total: 30000, subtotal: 30000, price: { currency: 'bdt', type: 'one_time', unit_amount: 30000,
      product: { id: 'prod_TJXJtpzqCpI36N', name: 'Premium Gift - 3 months', livemode: true } } }] } })

async function fixture(t: Context) {
  const { DB, sqlite: db } = database(':memory:', fileURLToPath(new URL('../services/xgift/migrations/', import.meta.url)))
  t.after(() => db.close())
  const env: Env = { DB, MASTER_KEY: 'a'.repeat(64), ADMIN_PASSWORD: 'fixture-admin-password-long', PAYMENTS_ENABLED: 'true',
    STRIPE_PUBLISHABLE_KEY: 'pk_live_fixture', NATIVE_ORDER_QUERY: queryNativeOrder, ASSETS: { fetch: async () => new Response('asset') } }
  env.LOCAL_EXECUTOR = async () => { throw new Error('Admin must never call the payment executor') }
  const user = await createUser(env, { name: 'Fixture', email: 'fixture@example.test', password: 'fixture-user-password' })
  await credit(env, user.id, { points: 10000, reference: 'fixture-credit', note: 'Fixture only' }, 'fixture')
  await saveSecret(env, 'sec_actionfixture', 'account', { name: 'Fixture sender', auth_token: 'fixture-cookie', ct0: 'fixture-csrf' })
  db.exec('UPDATE products SET enabled=1')
  const snapshot: Snapshot = { endpoint: 'local:v1', secret: '', account_id: 'sec_actionfixture',
    account: { auth_token: 'fixture-cookie', ct0: 'fixture-csrf' }, proxy: null }
  async function order(status: Order['status'] = 'queued', recipient = 'receiver', voucherId: string | null = null) {
    const orderId = id('ord'), now = Date.now()
    db.prepare(`INSERT INTO orders(id,user_id,merchant_order_no,idempotency_key,request_hash,product_code,recipient,recipient_id,
      points,currency,amount_minor,stripe_product,months,created_at,updated_at,mode,voucher_id) VALUES(?,?,?,?,?,'x-premium-3m',?,'12345',300,'bdt',30000,'prod_TJXJtpzqCpI36N',3,?,?,?,?)`)
      .run(orderId, user.id, 'merchant-' + orderId, orderId, 'fixture-hash', recipient, now, now, voucherId ? 'voucher' : 'direct', voucherId)
    if (status !== 'queued') {
      db.prepare("UPDATE orders SET status='running',execution_config=?,work_token='fixtureworker',lease_until=0 WHERE id=?")
        .run(await seal(env, 'execution:' + orderId, JSON.stringify(snapshot)), orderId)
      if (status !== 'running') db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, orderId)
    }
    return db.prepare('SELECT * FROM orders WHERE id=?').get(orderId) as unknown as Order
  }
  async function job(order: Order, patch: Record<string, unknown> = {}) {
    const body = { stage: 'submitted', session: sessionId, key: 'pk_live_fixture', submitted_at: Date.now(), method: 'pm_fixture', proof: page(), ...patch }
    db.prepare('INSERT INTO native_jobs VALUES(?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET stage=excluded.stage,payload=excluded.payload')
      .run(order.id, body.stage, await seal(env, 'native:' + order.id, JSON.stringify(body)), Date.now())
  }
  async function api(path: string, data?: unknown, cookie = '', origin = 'https://x-api.example.test') {
    return worker.fetch(new Request('https://x-api.example.test' + path, { method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: data === undefined ? undefined : JSON.stringify(data) }), env)
  }
  async function login(email = 'admin', password = env.ADMIN_PASSWORD) {
    const response = await api('/api/login', { email, password })
    assert.equal(response.status, 200)
    return response.headers.get('Set-Cookie')!.split(';')[0]!
  }
  return { env, db, user, snapshot, order, job, api, login }
}
const close = { reason: '测试结束，不再执行', confirmation: 'CLOSE_ORDER' }
const rejectsCode = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: Failure) => e.code === code)

test('only administrators can reveal original payment links; public order data never includes checkout secrets', async t => {
  const f = await fixture(t), order = await f.order('unknown'); await f.job(order)
  const path = '/api/admin/orders/' + order.id + '/payment-page'
  assert.equal((await f.api(path)).status, 401)
  const merchant = await f.login(f.user.email, 'fixture-user-password')
  assert.equal((await f.api(path, undefined, merchant)).status, 403)
  const admin = await f.login(), result = await f.api(path, undefined, admin)
  assert.equal(result.status, 200); assert.equal(result.headers.get('Cache-Control'), 'no-store')
  assert.equal((await result.json()).data.url, originalUrl)
  const publicResult = await f.api('/api/orders', undefined, merchant)
  assert.doesNotMatch(await publicResult.text(), /checkout\.stripe|original-checkout-options|pk_live|pm_fixture/)
  assert.equal((await f.api('/api/admin/orders/' + order.id + '/close', close, admin, 'https://other.example')).status, 403)
})

test('checkout links require exact HTTPS Stripe host and original session, with no alternate port or credentials', () => {
  assert.equal(validatedCheckoutUrl(originalUrl, sessionId), originalUrl)
  for (const url of ['http://checkout.stripe.com/c/pay/' + sessionId, 'https://checkout.stripe.com.evil.test/c/pay/' + sessionId,
    'https://user:pass@checkout.stripe.com/c/pay/' + sessionId, 'https://checkout.stripe.com:444/c/pay/' + sessionId,
    'https://checkout.stripe.com/other/c/pay/' + sessionId, 'https://checkout.stripe.com/c/pay/cs_live_different',
    'https://checkout.stripe.com/c/pay/' + sessionId + '/extra']) assert.throws(() => validatedCheckoutUrl(url, sessionId))
})

test('payment links are read-only, preserve new and legacy full URLs, and reject proof mismatch', async t => {
  const f = await fixture(t), order = await f.order('unknown'); await f.job(order)
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Opening link must not send any request') })
  const before = f.db.prepare('SELECT payload FROM native_jobs').get()!.payload
  assert.equal((await adminPaymentPage(f.env, order.id)).url, originalUrl)
  assert.equal(f.db.prepare('SELECT payload FROM native_jobs').get()!.payload, before)
  await f.job(order, { session_url: originalUrl + '-new' })
  assert.equal((await adminPaymentPage(f.env, order.id)).url, originalUrl + '-new')
  await f.job(order, { proof: { ...page(), currency: 'usd' } })
  await rejectsCode(adminPaymentPage(f.env, order.id), 'payment_page_unverified')
})

test('queued, terminal and pre-submission orders cannot open a competing manual payment page', async t => {
  const f = await fixture(t), queued = await f.order()
  await rejectsCode(adminPaymentPage(f.env, queued.id), 'payment_page_unavailable')
  const running = await f.order('running', 'other')
  await f.job(running, { stage: 'tokenized' })
  await rejectsCode(adminPaymentPage(f.env, running.id), 'payment_page_not_ready')
  f.db.prepare("UPDATE orders SET status='succeeded' WHERE id=?").run(running.id)
  await rejectsCode(adminPaymentPage(f.env, running.id), 'payment_page_unavailable')
})

test('safe close settles queued orders and atomically audits once without deleting or reopening voucher history', async t => {
  const f = await fixture(t)
  const batch = await issueVouchers(f.env, { user_id: f.user.id, product_code: 'x-premium-3m', quantity: 1 })
  const voucher = batch.vouchers[0]!, order = await f.order('queued', 'receiver', voucher.id)
  const closed = await adminCloseOrder(f.env, order.id, close)
  assert.equal(closed.closed, true); assert.equal(closed.status, 'failed')
  assert.equal(f.db.prepare('SELECT available FROM wallets').get()!.available, 10000)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='release'").get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='close_order'").get()!.n, 1)
  await rejectsCode(adminCloseOrder(f.env, order.id, close), 'order_already_closed')
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='release'").get()!.n, 1)
  const view = await voucherPublicView(f.env, voucher.code)
  assert.equal(view.state, 'redeemed'); assert.equal(view.order!.id, order.id); assert.equal(view.order!.status, 'failed')
  const retry = await redeemVoucher(f.env, { code: voucher.code, recipient: 'receiver', recipient_id: '12345' })
  assert.equal(retry.created, false); assert.equal(retry.order!.id, order.id)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
})

test('close requires explanation and confirmation; audit failure rolls back financial state', async t => {
  const f = await fixture(t), order = await f.order()
  await rejectsCode(adminCloseOrder(f.env, order.id, { reason: close.reason }), 'confirmation_required')
  await rejectsCode(adminCloseOrder(f.env, order.id, { ...close, reason: '' }), 'invalid_input')
  f.db.exec("CREATE TRIGGER reject_admin_audit BEFORE INSERT ON audit WHEN NEW.action='close_order' BEGIN SELECT RAISE(ABORT,'fixture_audit_failure'); END")
  await assert.rejects(adminCloseOrder(f.env, order.id, close), /fixture_audit_failure/)
  assert.equal(f.db.prepare('SELECT status FROM orders').get()!.status, 'queued')
  assert.equal(f.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 300)
})

test('preflight close releases account slot; a live worker lease must finish before admin claims an order', async t => {
  const f = await fixture(t), order = await f.order('unknown')
  f.db.prepare('INSERT INTO account_slots VALUES(?,?,?,0)').run(order.id, 'sec_actionfixture', '2026-10-05')
  await f.job(order, { stage: 'preflight', session: undefined, submitted_at: undefined, method: undefined, proof: undefined })
  f.db.prepare('UPDATE orders SET lease_until=? WHERE id=?').run(Date.now() + 10000, order.id)
  await rejectsCode(adminCloseOrder(f.env, order.id, close), 'order_busy')
  await rejectsCode(adminCheckOrder(f.env, order.id), 'order_busy')
  f.db.prepare('UPDATE orders SET lease_until=0 WHERE id=?').run(order.id)
  await adminCloseOrder(f.env, order.id, close)
  assert.equal(f.db.prepare('SELECT released FROM account_slots').get()!.released, 1)
})

test('legacy cancel retains queued-only semantics while close can inspect unstarted preflight jobs', async t => {
  const f = await fixture(t), order = await f.order('unknown'), admin = await f.login()
  const response = await f.api('/api/admin/orders/' + order.id + '/cancel', { note: '旧版取消入口' }, admin)
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'cannot_cancel')
  assert.equal(f.db.prepare('SELECT status FROM orders').get()!.status, 'unknown')
  const closed = await f.api('/api/admin/orders/' + order.id + '/close', close, admin)
  assert.equal(closed.status, 200); assert.equal((await closed.json()).data.closed, true)
})

test('a possible original checkout or 3DS never permits local close or releases frozen points', async t => {
  const f = await fixture(t), order = await f.order('unknown')
  for (const stage of ['creating', 'session', 'funding', 'funded', 'tokenizing', 'tokenized', 'submitted']) {
    await f.job(order, { stage })
    await rejectsCode(adminCloseOrder(f.env, order.id, close), 'cannot_close_payment_started')
    assert.equal(f.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 300)
    assert.equal(f.db.prepare('SELECT status FROM orders').get()!.status, 'unknown')
    assert.equal(f.db.prepare('SELECT lease_until FROM orders').get()!.lease_until, 0)
  }
})

test('targeted query only GETs the original checkout and settles verified success once, without processing another queued order', async t => {
  const f = await fixture(t), order = await f.order('unknown'), queued = await f.order('queued', 'another'); await f.job(order)
  let polls = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)); assert.equal(init?.method, 'GET')
    assert.equal(url.hostname, 'api.stripe.com'); assert.equal(url.pathname, '/v1/payment_pages/' + sessionId + '/poll'); polls++
    return Response.json({ session_id: sessionId, livemode: true, is_sandbox_merchant: false, mode: 'payment', success_url: page().success_url,
      state: 'succeeded', payment_object_status: 'succeeded' })
  })
  const result = await adminCheckOrder(f.env, order.id)
  assert.equal(result.checked, true); assert.equal(result.status, 'succeeded')
  assert.equal(f.db.prepare('SELECT status FROM orders WHERE id=?').get(queued.id)!.status, 'queued')
  assert.equal((await adminCheckOrder(f.env, order.id)).checked, false); assert.equal(polls, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='consume'").get()!.n, 1)
  await rejectsCode(adminPaymentPage(f.env, order.id), 'payment_page_unavailable')
})

test('3DS, pending, mismatched evidence and lost query remain frozen without new writes to the provider', async t => {
  const f = await fixture(t), order = await f.order('unknown'); await f.job(order)
  let mode = '3ds', polls = 0
  t.mock.method(globalThis, 'fetch', async (_input: string | URL, init?: RequestInit) => {
    assert.equal(init?.method, 'GET'); polls++
    if (mode === 'lost') throw new Error('fixture_network_error')
    return Response.json({ session_id: mode === 'mismatch' ? 'cs_live_other' : sessionId, livemode: true, is_sandbox_merchant: false,
      mode: 'payment', success_url: page().success_url, state: 'pending', payment_object_status: mode === '3ds' ? 'requires_action' : 'processing' })
  })
  for (const [scenario, code] of [['3ds', 'payment_requires_action'], ['pending', 'payment_pending'], ['mismatch', 'payment_evidence_mismatch'], ['lost', 'payment_query_failed']]) {
    mode = scenario!
    const result = await adminCheckOrder(f.env, order.id)
    assert.equal(result.status, 'unknown'); assert.equal(result.failure_code, code)
    assert.equal(f.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 300)
  }
  assert.equal(polls, 4)
})

test('query without a checkout does not create one; unbound queued queries never invoke the executor', async t => {
  const f = await fixture(t), order = await f.order('unknown'), queued = await f.order('queued', 'another')
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No request authorized') })
  assert.equal((await adminCheckOrder(f.env, order.id)).failure_code, 'payment_not_started')
  assert.equal((await adminCheckOrder(f.env, queued.id)).checked, false)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM native_jobs').get()!.n, 0)
})

test('closing an expired preflight prevents its stale worker from subsequently creating a checkout', async t => {
  const f = await fixture(t), order = await f.order('running')
  f.db.prepare('UPDATE orders SET lease_until=? WHERE id=?').run(Date.now() + 180000, order.id)
  let notify!: () => void, resume!: () => void, writes = 0
  const started = new Promise<void>(resolve => { notify = resolve }), pending = new Promise<void>(resolve => { resume = resolve })
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (init?.method === 'POST') { writes++; throw new Error('Stale worker must not create or pay') }
    if (url.pathname.endsWith('/PremiumGiftingQuery')) {
      notify(); await pending
      return Response.json({ data: { user: { result: { rest_id: '12345', core: { screen_name: 'receiver' }, premium_gifting_eligible: true } } } })
    }
    return Response.json({ data: { web_subscription_product_details_by_rest_id: { rest_id: 'prod_TJXJtpzqCpI36N',
      prices: [{ currency_code: 'BDT', amount_local_micro: 300000000, price_type: 'OneTime' }] } } })
  })
  const execution = executeNative(f.env, order, f.snapshot)
  await started
  f.db.prepare('UPDATE orders SET lease_until=0 WHERE id=?').run(order.id)
  await adminCloseOrder(f.env, order.id, close)
  resume(); await execution
  assert.equal(writes, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM native_jobs').get()!.n, 0)
  assert.equal(f.db.prepare('SELECT status FROM orders').get()!.status, 'failed')
})

test('admin list filters and searches by bound parameters and reports true FIFO queue positions', async t => {
  const f = await fixture(t), first = await f.order('queued', 'first'), second = await f.order('queued', 'second')
  f.db.prepare('UPDATE orders SET updated_at=updated_at WHERE id=?').run(first.id)
  const admin = await f.login()
  const response = await f.api('/api/admin/orders?status=queued', undefined, admin)
  const rows = (await response.json()).data
  assert.equal(rows.length, 2); assert.deepEqual(rows.map((r: any) => r.queue_position), [1, 2])
  const filtered = await f.api('/api/admin/orders?status=active&q=%40second', undefined, admin)
  assert.equal((await filtered.json()).data[0].id, second.id)
  assert.equal((await f.api('/api/admin/orders?status=notvalid', undefined, admin)).status, 400)
  const injection = await f.api('/api/admin/orders?q=' + encodeURIComponent("' OR 1=1 --"), undefined, admin)
  assert.deepEqual((await injection.json()).data, [])
})

test('admin action capabilities are read-only, private, and never expose execution or payment secrets', async t => {
  const f = await fixture(t), order = await f.order('unknown'); await f.job(order)
  const admin = await f.login(), merchant = await f.login(f.user.email, 'fixture-user-password')
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Capabilities must not contact any provider') })
  f.env.NATIVE_ORDER_QUERY = async () => { throw new Error('Capabilities must not poll or settle an order') }
  const before = JSON.stringify({ orders: f.db.prepare('SELECT * FROM orders').all(), jobs: f.db.prepare('SELECT * FROM native_jobs').all(),
    ledger: f.db.prepare('SELECT * FROM ledger').all(), audit: f.db.prepare('SELECT * FROM audit').all() })
  assert.equal((await f.api('/api/admin/orders')).status, 401)
  assert.equal((await f.api('/api/admin/orders', undefined, merchant)).status, 403)
  const response = await f.api('/api/admin/orders', undefined, admin), body = await response.text()
  assert.equal(response.status, 200)
  const row = JSON.parse(body).data[0]
  assert.equal(row.actions.check, true); assert.equal(row.actions.payment_page, true); assert.equal(row.actions.close, false)
  assert.doesNotMatch(body, /execution_config|work_token|lease_until|checkout\.stripe|original-checkout-options|pk_live|pm_fixture|fixture-cookie|fixture-csrf/)
  assert.doesNotMatch(await (await f.api('/api/orders', undefined, merchant)).text(), /"actions"|reason_code|payment_page/)
  assert.equal(JSON.stringify({ orders: f.db.prepare('SELECT * FROM orders').all(), jobs: f.db.prepare('SELECT * FROM native_jobs').all(),
    ledger: f.db.prepare('SELECT * FROM ledger').all(), audit: f.db.prepare('SELECT * FROM audit').all() }), before)
})

test('action hints respect live workers, terminal orders, and queued close constraints', async t => {
  const f = await fixture(t), queued = await f.order(), running = await f.order('running', 'other')
  assert.deepEqual(await adminOrderCapabilities(f.env, queued), {
    check: false, payment_page: false, close: true, reason_code: 'queued', message: '按接收顺序等待执行，尚未付款。',
  })
  await f.job(running)
  for (const status of ['running', 'unknown'] as const) {
    const result = await adminOrderCapabilities(f.env, { ...running, status, lease_until: Date.now() + 60000 })
    assert.equal(result.reason_code, 'executing'); assert.equal(result.check, false)
    assert.equal(result.payment_page, false); assert.equal(result.close, false)
  }
  for (const status of ['succeeded', 'failed'] as const) {
    const result = await adminOrderCapabilities(f.env, { ...running, status })
    assert.equal(result.check, false); assert.equal(result.payment_page, false); assert.equal(result.close, false)
  }
  assert.equal((await adminOrderCapabilities(f.env, { ...queued, execution_config: running.execution_config })).close, false)
  await f.job(queued, { stage: 'creating' })
  assert.equal((await adminOrderCapabilities(f.env, queued)).close, false)
})

test('only proven original submitted checkouts advertise a payment page and never advertise close', async t => {
  const f = await fixture(t), order = await f.order('unknown')
  const noPayment = await adminOrderCapabilities(f.env, order)
  assert.equal(noPayment.close, true); assert.equal(noPayment.payment_page, false)
  await f.job(order, { stage: 'preflight', session: undefined, method: undefined, submitted_at: undefined, proof: undefined })
  assert.equal((await adminOrderCapabilities(f.env, order)).close, true)
  for (const stage of ['creating', 'session', 'funding', 'funded', 'tokenizing', 'tokenized']) {
    await f.job(order, { stage })
    const result = await adminOrderCapabilities(f.env, order)
    assert.equal(result.close, false, stage); assert.equal(result.payment_page, false, stage)
  }
  for (const stage of ['submitted', 'paid']) {
    await f.job(order, { stage })
    const result = await adminOrderCapabilities(f.env, { ...order, failure_code: 'payment_requires_action' })
    assert.equal(result.close, false); assert.equal(result.payment_page, true); assert.equal(result.reason_code, 'payment_requires_action')
  }
  for (const patch of [
    { proof: { ...page(), currency: 'usd' } }, { submitted_at: undefined }, { method: 'invalid' },
    { session_url: 'https://checkout.stripe.com.evil.example/c/pay/' + sessionId },
    { session_url: 'https://checkout.stripe.com/c/pay/cs_live_other' },
  ]) {
    await f.job(order, patch)
    const result = await adminOrderCapabilities(f.env, order)
    assert.equal(result.close, false); assert.equal(result.payment_page, false)
  }
})

test('missing, external or inconsistent execution evidence fails capability display closed', async t => {
  const f = await fixture(t), order = await f.order('unknown')
  for (const execution_config of [null, 'invalid', await seal(f.env, 'execution:' + order.id, JSON.stringify({ ...f.snapshot, endpoint: 'https://external.example.test' }))]) {
    const result = await adminOrderCapabilities(f.env, { ...order, execution_config })
    assert.equal(result.check, false); assert.equal(result.payment_page, false); assert.equal(result.close, false)
  }
  await f.job(order)
  f.db.prepare("UPDATE native_jobs SET stage='preflight' WHERE order_id=?").run(order.id)
  const result = await adminOrderCapabilities(f.env, order)
  assert.equal(result.check, false); assert.equal(result.payment_page, false); assert.equal(result.close, false)
})
