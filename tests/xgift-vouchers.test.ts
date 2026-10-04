import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { database } from '../services/xgift/server/database.ts'
import { createUser } from '../services/xgift/src/auth.ts'
import { createOrder, credit } from '../services/xgift/src/orders.ts'
import { saveSecret } from '../services/xgift/src/network.ts'
import { sha256, type Env } from '../services/xgift/src/core.ts'
import worker from '../services/xgift/src/index.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
type Issued = { id: string; code: string; product_code: string; expires_at: number }
const origin = 'https://x-api.example.test'
const password = 'voucher-test-user-password'

async function fixture(t: Context, points = 1000) {
  const { DB, sqlite: db } = database(
    ':memory:',
    fileURLToPath(new URL('../services/xgift/migrations/', import.meta.url)),
  )
  t.after(() => db.close())
  const env: Env = {
    DB,
    MASTER_KEY: 'a'.repeat(64),
    ADMIN_PASSWORD: 'voucher-test-admin-password-123456789',
    PAYMENTS_ENABLED: 'true',
    EXECUTOR_URL: 'https://executor.example.test',
    EXECUTOR_SECRET: 'voucher-test-executor-secret-123456789',
    ASSETS: { fetch: async () => new Response('asset') },
  }
  const owner = await createUser(env, {
    name: 'Voucher merchant', email: 'voucher-merchant@example.test', password,
  })
  if (points > 0)
    await credit(env, owner.id, { points, reference: 'voucher-fixture-credit', note: 'Fixture only' }, 'admin')
  db.exec('UPDATE products SET enabled=1')
  await saveSecret(env, 'sec_voucherfixture', 'account', {
    name: 'Fixture account', auth_token: 'PRIVATE-X-COOKIE', ct0: 'PRIVATE-X-CSRF', daily_limit: 300,
  })
  const upstream = { calls: 0, eligible: true, identity: '', malformed: false }
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.hostname, 'x.com', 'tests must never contact a payment provider')
    assert.ok(url.pathname.endsWith('/PremiumGiftingQuery'), 'only read-only eligibility is allowed')
    upstream.calls++
    const username = JSON.parse(url.searchParams.get('variables')!).screenName
    return Response.json({
      data: { user: { result: upstream.malformed ? {} : {
        rest_id: upstream.identity || (username === 'receiver' ? '12345' : '67890'),
        core: { screen_name: username },
        premium_gifting_eligible: upstream.eligible,
      } } },
    })
  })
  const call = (path: string, body?: unknown, cookie = '', requestOrigin = origin) =>
    worker.fetch(new Request(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: requestOrigin, Cookie: cookie, 'CF-Connecting-IP': '192.0.2.50' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env)
  const login = async (email: string, secret: string) => {
    const response = await call('/api/login', { email, password: secret })
    assert.equal(response.status, 200)
    return response.headers.get('Set-Cookie')!.split(';')[0]
  }
  const admin = await login('admin', env.ADMIN_PASSWORD)
  const issue = async (extra: Record<string, unknown> = {}) => {
    const response = await call('/api/admin/vouchers', {
      user_id: owner.id, product_code: 'x-premium-3m', quantity: 1,
      expires_in_days: 7, batch_label: 'Fixture batch', ...extra,
    }, admin)
    assert.ok(response.ok, await response.clone().text())
    return (await response.json()).data as { batch_id: string; vouchers: Issued[] }
  }
  const inspect = async (code: string, path = '/api/redeem/inspect') => {
    const response = await call(path, { code })
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).data
  }
  const redeem = (code: string, recipient = 'receiver', recipientId = '12345') =>
    call('/api/redeem', { code, recipient, recipient_id: recipientId })
  const wallet = () => ({ ...db.prepare('SELECT available,frozen FROM wallets WHERE user_id=?').get(owner.id) })
  const native = () => {
    env.STRIPE_PUBLISHABLE_KEY = 'pk_live_fixture'
    env.LOCAL_EXECUTOR = async () => { throw new Error('Tests must not execute payments') }
    db.exec('UPDATE order_admission SET enabled=1')
  }
  return { db, env, owner, upstream, call, login, admin, issue, inspect, redeem, wallet, native }
}

test('anonymous capabilities expose availability, reason and modes and follow shared daily admission', async t => {
  const f = await fixture(t)
  const available = await f.call('/api/capabilities')
  assert.equal(available.status, 200)
  assert.equal(available.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await available.json(), {
    data: { execution_ready: true, accepts_orders: true, reason: null, modes: ['direct', 'voucher'] },
  })
  f.env.PAYMENTS_ENABLED = 'false'
  const paused = await f.call('/api/capabilities')
  assert.equal(paused.status, 200)
  assert.deepEqual(await paused.json(), {
    data: { execution_ready: false, accepts_orders: false, reason: 'execution_unavailable', modes: ['direct', 'voucher'] },
  })
  f.env.PAYMENTS_ENABLED = 'true'
  f.native()
  await createOrder(f.env, f.owner.id, 'capabilities-first-order', {
    merchant_order_no: 'capabilities-first-order', product_code: 'x-premium-3m',
    recipient: 'receiver', recipient_id: '12345', expected_points: 300,
  })
  const full = await f.call('/api/capabilities')
  assert.equal(full.status, 200)
  assert.deepEqual(await full.json(), {
    data: { execution_ready: true, accepts_orders: false, reason: 'order_in_progress', modes: ['direct', 'voucher'] },
  })
  assert.equal(f.upstream.calls, 1, 'capability checks must not query upstream accounts')
})

test('incremental voucher migration preserves historical order data, balances and immutable ledger', t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const migrations = new URL('../services/xgift/migrations/', import.meta.url)
  const previous = readdirSync(migrations).filter(name => /^000[1-4]_.*\.sql$/.test(name)).sort()
  assert.equal(previous.length, 4)
  for (const name of previous) db.exec(readFileSync(new URL(name, migrations), 'utf8'))
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(
    'legacy-user', 'Legacy merchant', 'legacy@example.test', 'fixture-hash', 'fixture-salt', 1, 1,
  )
  db.prepare("INSERT INTO ledger VALUES(?, ?, NULL, 'credit', ?, 0, ?, ?, ?, ?)").run(
    'legacy-credit', 'legacy-user', 2000, 'Historical credit', 'admin', 'legacy-credit-reference', 1,
  )
  for (const [id, recipient] of [['legacy-paid', 'paiduser'], ['legacy-failed', 'faileduser'], ['legacy-unknown', 'unknownuser']]) {
    db.prepare(
      "INSERT INTO orders(id,user_id,merchant_order_no,idempotency_key,request_hash,product_code,recipient,points,currency,amount_minor,stripe_product,months,created_at,updated_at) VALUES(?,'legacy-user',?,?,?,'x-premium-3m',?,300,'bdt',30000,'prod_TJXJtpzqCpI36N',3,2,2)",
    ).run(id, id, id, 'historical-digest-' + id, recipient)
    db.prepare("UPDATE orders SET status='running' WHERE id=?").run(id)
  }
  db.prepare("UPDATE orders SET status='succeeded',receipt='legacy-receipt' WHERE id=?").run('legacy-paid')
  db.prepare("UPDATE orders SET status='failed',failure_code='not_charged' WHERE id=?").run('legacy-failed')
  db.prepare("UPDATE orders SET status='unknown' WHERE id=?").run('legacy-unknown')
  const originalOrders = db.prepare('SELECT * FROM orders ORDER BY id').all()
  const originalLedger = db.prepare('SELECT * FROM ledger ORDER BY id').all()
  const originalWallets = db.prepare('SELECT * FROM wallets ORDER BY user_id').all()
  assert.deepEqual({ ...originalWallets[0] }, { user_id: 'legacy-user', available: 1400, frozen: 300 })
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(readFileSync(new URL('0005_redemption_modes.sql', migrations), 'utf8'))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  const migrated = db.prepare('SELECT * FROM orders ORDER BY id').all()
  for (const row of migrated) {
    assert.equal(row.mode, 'direct')
    assert.equal(row.voucher_id, null)
  }
  assert.deepEqual(
    migrated.map(({ mode: _mode, voucher_id: _voucher, ...row }) => row),
    originalOrders.map(row => ({ ...row })),
  )
  assert.deepEqual(db.prepare('SELECT * FROM ledger ORDER BY id').all(), originalLedger)
  assert.deepEqual(db.prepare('SELECT * FROM wallets ORDER BY user_id').all(), originalWallets)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get()!.n, 0)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.throws(() => db.exec('UPDATE ledger SET available_delta=0'), /immutable_ledger/)
})

test('voucher issuance is admin-only, CSRF-protected and stores only unique secret digests', async t => {
  const f = await fixture(t)
  const userCookie = await f.login(f.owner.email, password)
  const body = { user_id: f.owner.id, product_code: 'x-premium-3m', quantity: 1, expires_in_days: 7 }
  assert.equal((await f.call('/api/admin/vouchers', body)).status, 401)
  assert.equal((await f.call('/api/admin/vouchers', body, userCookie)).status, 403)
  assert.equal((await f.call('/api/admin/vouchers', body, f.admin, 'https://attacker.example')).status, 403)
  assert.equal((await f.call('/api/admin/vouchers', undefined, userCookie)).status, 403)
  const issued = await f.issue({ quantity: 3 })
  assert.equal(new Set(issued.vouchers.map(v => v.code)).size, 3)
  assert.match(issued.batch_id, /^vbatch_/)
  for (const voucher of issued.vouchers) {
    assert.match(voucher.code, /^XG-[A-Fa-f0-9]{48}$/)
    const row = f.db.prepare('SELECT * FROM vouchers WHERE id=?').get(voucher.id)!
    assert.equal(row.code_hash, await sha256(voucher.code))
    assert.equal(row.product_code, 'x-premium-3m')
    assert.ok(!JSON.stringify(row).includes(voucher.code))
  }
  const list = await f.call('/api/admin/vouchers?page=1', undefined, f.admin)
  assert.equal(list.status, 200)
  const content = await list.text()
  assert.doesNotMatch(content, /code_hash|PRIVATE-X|auth_token|ct0/)
  for (const voucher of issued.vouchers) assert.ok(!content.includes(voucher.code))
  const audit = JSON.stringify(f.db.prepare('SELECT * FROM audit').all())
  for (const voucher of issued.vouchers) assert.ok(!audit.includes(voucher.code))
  assert.deepEqual(f.wallet(), { available: 1000, frozen: 0 })
  assert.equal(f.upstream.calls, 0)
})

test('public voucher inspection and eligibility do not leak merchant data or accept invalid cards', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue()).vouchers
  const view = await f.inspect(voucher.code)
  assert.deepEqual(Object.keys(view).sort(), ['expires_at', 'product', 'state'])
  assert.deepEqual(Object.keys(view.product).sort(), ['code', 'months', 'name'])
  assert.equal(view.state, 'available')
  assert.equal(view.product.months, 3)
  const checked = await f.call('/api/redeem/eligibility', { code: voucher.code, username: '@Receiver' })
  assert.equal(checked.status, 200)
  assert.equal((await checked.json()).data.recipient_id, '12345')
  assert.equal(f.upstream.calls, 1)
  const invalid = await f.call('/api/redeem/eligibility', { code: 'XG-' + '0'.repeat(48), username: 'receiver' })
  assert.equal(invalid.ok, false)
  assert.equal(f.upstream.calls, 1, 'invalid cards must not spend upstream quota')
  assert.equal((await f.call('/api/redeem/inspect?code=' + voucher.code)).ok, false)
  assert.deepEqual(f.wallet(), { available: 1000, frozen: 0 })
})

test('voucher eligibility is throttled separately from status and rejected calls never contact X', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue()).vouchers
  for (let i = 0; i < 10; i++)
    assert.equal((await f.call('/api/redeem/eligibility', { code: voucher.code, username: 'receiver' })).status, 200)
  assert.equal((await f.call('/api/redeem/eligibility', { code: voucher.code, username: 'receiver' })).status, 429)
  assert.equal(f.upstream.calls, 10)
  assert.equal((await f.inspect(voucher.code, '/api/redeem/status')).state, 'available')
  assert.equal(f.upstream.calls, 10)
})

test('public inspection and status share a persisted IP rate limit without exposing raw voucher secrets', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue()).vouchers
  for (let i = 0; i < 30; i++)
    assert.equal((await f.call(i % 2 ? '/api/redeem/status' : '/api/redeem/inspect', { code: voucher.code })).status, 200)
  assert.equal((await f.call('/api/redeem/inspect', { code: voucher.code })).status, 429)
  const counters = JSON.stringify(f.db.prepare('SELECT * FROM login_limits').all())
  assert.ok(!counters.includes(voucher.code))
  assert.equal(f.upstream.calls, 0)
})

test('concurrent redemption for different recipients binds one order and reserves points once', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue()).vouchers
  const attempts = await Promise.all([
    f.redeem(voucher.code, 'receiver', '12345'),
    f.redeem(voucher.code, 'other', '67890'),
  ])
  assert.equal(attempts.filter(response => response.ok).length, 1)
  assert.equal(attempts.filter(response => response.status === 409).length, 1)
  const order = f.db.prepare('SELECT * FROM orders').get()!
  assert.equal(order.mode, 'voucher')
  assert.equal(order.voucher_id, voucher.id)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='reserve'").get()!.n, 1)
  assert.deepEqual(f.wallet(), { available: 700, frozen: 300 })
  assert.equal(f.db.prepare('SELECT order_id FROM vouchers WHERE id=?').get(voucher.id)!.order_id, order.id)
})

test('repeat redemption returns the original order even after pause and never changes its recipient', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue()).vouchers
  const first = await f.redeem(voucher.code)
  assert.ok(first.ok, await first.clone().text())
  const original = (await first.json()).data
  assert.equal(original.state, 'redeemed')
  const calls = f.upstream.calls
  f.env.PAYMENTS_ENABLED = 'false'
  const repeat = await f.redeem(voucher.code, '@Receiver')
  assert.equal(repeat.status, 200)
  assert.equal((await repeat.json()).data.order.id, original.order.id)
  assert.equal(f.upstream.calls, calls)
  assert.equal((await f.redeem(voucher.code, 'other', '67890')).status, 409)
  assert.equal((await f.inspect(voucher.code, '/api/redeem/status')).order.id, original.order.id)
  assert.deepEqual(f.wallet(), { available: 700, frozen: 300 })
})

test('same-recipient concurrent redemption remains bound through unknown state and voucher expiry', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue({ expires_in_days: 1 })).vouchers
  const responses = await Promise.all([f.redeem(voucher.code), f.redeem(voucher.code, '@Receiver')])
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 201])
  const views = await Promise.all(responses.map(async r => (await r.json()).data))
  assert.equal(views[0].order.id, views[1].order.id)
  const orderId = views[0].order.id
  f.db.prepare("UPDATE orders SET status='running' WHERE id=?").run(orderId)
  f.db.prepare("UPDATE orders SET status='unknown' WHERE id=?").run(orderId)
  assert.throws(() => f.db.prepare("UPDATE vouchers SET status='active',order_id=NULL,redeemed_at=NULL WHERE id=?").run(voucher.id), /terminal_voucher/)
  assert.throws(() => f.db.prepare("UPDATE orders SET mode='direct',voucher_id=NULL WHERE id=?").run(orderId), /immutable_order_mode/)
  assert.throws(() => f.db.prepare('DELETE FROM vouchers WHERE id=?').run(voucher.id), /immutable_voucher/)
  const upstreamCalls = f.upstream.calls
  t.mock.method(Date, 'now', () => voucher.expires_at + 1)
  const view = await f.inspect(voucher.code, '/api/redeem/status')
  assert.equal(view.state, 'redeemed')
  assert.equal(view.order.status, 'unknown')
  assert.equal((await f.redeem(voucher.code)).status, 200)
  assert.equal(f.upstream.calls, upstreamCalls)
  assert.deepEqual(f.wallet(), { available: 700, frozen: 300 })
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='reserve'").get()!.n, 1)
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('disabled merchant or product blocks new redemption without consuming the voucher', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue()).vouchers
  f.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(f.owner.id)
  assert.equal((await f.redeem(voucher.code)).status, 409)
  assert.equal((await f.inspect(voucher.code)).state, 'available')
  f.db.prepare('UPDATE users SET enabled=1 WHERE id=?').run(f.owner.id)
  f.db.prepare('UPDATE products SET enabled=0 WHERE code=?').run(voucher.product_code)
  assert.equal((await f.redeem(voucher.code)).status, 409)
  assert.equal((await f.inspect(voucher.code)).state, 'available')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.deepEqual(f.wallet(), { available: 1000, frozen: 0 })
})

test('a failed voucher order releases merchant points but permanently retains its original binding', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue()).vouchers
  const response = await f.redeem(voucher.code)
  assert.ok(response.ok)
  const orderId = (await response.json()).data.order.id
  f.db.prepare("UPDATE orders SET status='running' WHERE id=?").run(orderId)
  f.db.prepare("UPDATE orders SET status='failed',failure_code='not_charged',receipt='PRIVATE-RECEIPT' WHERE id=?").run(orderId)
  assert.deepEqual(f.wallet(), { available: 1000, frozen: 0 })
  const repeated = await f.redeem(voucher.code)
  assert.ok(repeated.ok)
  const view = (await repeated.json()).data
  assert.equal(view.state, 'redeemed')
  assert.equal(view.order.id, orderId)
  assert.equal(view.order.status, 'failed')
  assert.deepEqual(Object.keys(view.order).sort(), [
    'created_at', 'failure_code', 'id', 'product_code', 'recipient', 'status', 'updated_at',
  ])
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|user_id|points|receipt|merchant_order_no|idempotency|code_hash/)
  assert.equal((await f.redeem(voucher.code, 'other', '67890')).status, 409)
  assert.equal((await f.call('/api/admin/vouchers/' + voucher.id + '/revoke', { note: 'Cannot revoke used voucher' }, f.admin)).status, 409)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='release'").get()!.n, 1)
})

test('revocation denies redemption and eligibility without upstream calls or wallet changes', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue()).vouchers
  const path = '/api/admin/vouchers/' + voucher.id + '/revoke'
  const userCookie = await f.login(f.owner.email, password)
  assert.equal((await f.call(path, { note: 'Fixture revoke' }, userCookie)).status, 403)
  assert.equal((await f.call(path, { note: 'Fixture revoke' }, f.admin, 'https://attacker.example')).status, 403)
  assert.ok((await f.call(path, { note: 'Fixture revoke' }, f.admin)).ok)
  assert.equal((await f.inspect(voucher.code)).state, 'revoked')
  assert.equal((await f.redeem(voucher.code)).ok, false)
  assert.equal((await f.call('/api/redeem/eligibility', { code: voucher.code, username: 'receiver' })).ok, false)
  assert.equal(f.upstream.calls, 0)
  assert.deepEqual(f.wallet(), { available: 1000, frozen: 0 })
})

test('expired vouchers remain inspectable but cannot create orders or query X', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue({ expires_in_days: 1 })).vouchers
  t.mock.method(Date, 'now', () => voucher.expires_at + 1)
  assert.equal((await f.inspect(voucher.code)).state, 'expired')
  assert.equal((await f.redeem(voucher.code)).ok, false)
  assert.equal((await f.call('/api/redeem/eligibility', { code: voucher.code, username: 'receiver' })).ok, false)
  assert.equal(f.upstream.calls, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
})

test('insufficient balance and paused payments leave vouchers available for a later retry', async t => {
  const f = await fixture(t, 200)
  const [voucher] = (await f.issue()).vouchers
  assert.equal((await f.redeem(voucher.code)).status, 409)
  assert.equal((await f.inspect(voucher.code)).state, 'available')
  assert.deepEqual(f.wallet(), { available: 200, frozen: 0 })
  await credit(f.env, f.owner.id, { points: 500, reference: 'voucher-extra-credit', note: 'Fixture extra credit' }, 'admin')
  f.env.PAYMENTS_ENABLED = 'false'
  assert.equal((await f.redeem(voucher.code)).status, 503)
  assert.equal((await f.inspect(voucher.code)).state, 'available')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  f.env.PAYMENTS_ENABLED = 'true'
  assert.ok((await f.redeem(voucher.code)).ok)
  assert.deepEqual(f.wallet(), { available: 400, frozen: 300 })
})

test('redemption rechecks identity and eligibility and applies the merchant price at redemption time', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue()).vouchers
  f.db.prepare('INSERT INTO user_prices VALUES(?,?,?)').run(f.owner.id, 'x-premium-3m', 250)
  assert.equal((await f.redeem(voucher.code, 'receiver', '999')).status, 409)
  f.upstream.eligible = false
  assert.equal((await f.redeem(voucher.code)).status, 409)
  f.upstream.eligible = true
  f.upstream.malformed = true
  assert.equal((await f.redeem(voucher.code)).status, 503)
  assert.equal((await f.inspect(voucher.code)).state, 'available')
  assert.deepEqual(f.wallet(), { available: 1000, frozen: 0 })
  f.upstream.malformed = false
  assert.ok((await f.redeem(voucher.code)).ok)
  assert.deepEqual(f.wallet(), { available: 750, frozen: 250 })
  assert.equal(f.db.prepare('SELECT recipient_id,points FROM orders').get()!.recipient_id, '12345')
})

test('native daily admission covers direct and voucher modes without consuming the blocked voucher', async t => {
  const f = await fixture(t)
  f.native()
  const [voucher] = (await f.issue()).vouchers
  await createOrder(f.env, f.owner.id, 'direct-first-order', {
    merchant_order_no: 'direct-first-order', product_code: 'x-premium-3m',
    recipient: 'receiver', recipient_id: '12345', expected_points: 300,
  })
  assert.equal((await f.redeem(voucher.code, 'other', '67890')).status, 409)
  assert.equal((await f.inspect(voucher.code)).state, 'available')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.deepEqual(f.wallet(), { available: 700, frozen: 300 })
  f.db.exec("UPDATE orders SET status='running'; UPDATE orders SET status='failed'")
  assert.ok((await f.redeem(voucher.code, 'other', '67890')).ok)
  await assert.rejects(createOrder(f.env, f.owner.id, 'direct-after-voucher', {
    merchant_order_no: 'direct-after-voucher', product_code: 'x-premium-3m',
    recipient: 'receiver', recipient_id: '12345', expected_points: 300,
  }))
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 2)
  assert.deepEqual(f.wallet(), { available: 700, frozen: 300 })
})

test('public redemption rejects foreign Origins and direct mode retains logged-in owner isolation', async t => {
  const f = await fixture(t)
  const [voucher] = (await f.issue()).vouchers
  assert.equal((await f.call('/api/redeem', {
    code: voucher.code, recipient: 'receiver', recipient_id: '12345',
  }, '', 'https://attacker.example')).status, 403)
  assert.equal((await f.inspect(voucher.code)).state, 'available')
  assert.equal((await f.call('/api/capabilities')).status, 200)
  assert.equal((await f.call('/api/eligibility', { username: 'receiver' })).status, 401)
  const cookie = await f.login(f.owner.email, password)
  assert.equal((await f.call('/api/capabilities', undefined, cookie)).status, 200)
  assert.equal((await f.call('/api/eligibility', { username: 'receiver' }, cookie)).status, 200)
  const body = {
    idempotency_key: 'direct-fixture-001', merchant_order_no: 'direct-fixture-001',
    product_code: 'x-premium-3m', recipient: 'receiver', recipient_id: '12345', expected_points: 300,
  }
  assert.equal((await f.call('/api/orders', { ...body, mode: 'voucher', voucher_id: voucher.id }, cookie)).status, 400)
  const direct = await f.call('/api/orders', body, cookie)
  assert.equal(direct.status, 201, await direct.clone().text())
  const created = (await direct.json()).data
  assert.equal(created.mode, 'direct', 'clients cannot smuggle the internal voucher mode')
  assert.equal(f.db.prepare('SELECT voucher_id FROM orders WHERE id=?').get(created.id)!.voucher_id, null)
  assert.equal((await f.call('/api/orders', body, cookie)).status, 200)
  const other = await createUser(f.env, { name: 'Other merchant', email: 'other-merchant@example.test', password })
  const otherCookie = await f.login(other.email, password)
  assert.deepEqual((await (await f.call('/api/orders', undefined, otherCookie)).json()).data, [])
  assert.equal((await f.inspect(voucher.code)).state, 'available')
  assert.deepEqual(f.wallet(), { available: 700, frozen: 300 })
})
