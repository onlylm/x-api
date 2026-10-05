import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { database } from '../services/xgift/server/database.ts'
import { createUser } from '../services/xgift/src/auth.ts'
import { credit } from '../services/xgift/src/orders.ts'
import { issueVouchers, listVouchers, revokeVoucher } from '../services/xgift/src/vouchers.ts'
import { Failure, id, sha256, type Env } from '../services/xgift/src/core.ts'
import worker from '../services/xgift/src/index.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
type Issued = { batch_id: string; vouchers: { id: string; code: string; product_code: string; expires_at: number }[] }
const origin = 'https://merchant-vouchers.example.test'
const password = 'merchant-voucher-fixture-password'
const body = { product_code: 'x-premium-3m', quantity: 1, expires_in_days: 7, batch_label: 'Merchant fixture' }

async function fixture(t: Context) {
  const { DB, sqlite: db } = database(':memory:', fileURLToPath(new URL('../services/xgift/migrations/', import.meta.url)))
  t.after(() => db.close())
  const env: Env = { DB, MASTER_KEY: 'b'.repeat(64), ADMIN_PASSWORD: 'merchant-voucher-admin-fixture-password',
    PAYMENTS_ENABLED: 'false', ASSETS: { fetch: async () => new Response('asset') } }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Voucher management must not call X or any payment provider') })
  env.LOCAL_EXECUTOR = async () => { throw new Error('Voucher management must not execute a payment') }
  const alice = await createUser(env, { name: 'Alice merchant', email: 'alice@example.test', password })
  const bob = await createUser(env, { name: 'Bob merchant', email: 'bob@example.test', password })
  db.exec('UPDATE products SET enabled=1')
  function call(path: string, data?: unknown, cookie = '', options: { origin?: string | null; contentType?: string; method?: string } = {}) {
    const headers: Record<string, string> = { Cookie: cookie, 'Content-Type': options.contentType ?? 'application/json' }
    if (options.origin !== null) headers.Origin = options.origin ?? origin
    return worker.fetch(new Request(origin + path, { method: options.method ?? (data === undefined ? 'GET' : 'POST'), headers,
      body: data === undefined ? undefined : JSON.stringify(data) }), env)
  }
  async function login(email: string, secret = password) {
    const response = await call('/api/login', { email, password: secret })
    assert.equal(response.status, 200, await response.clone().text())
    return response.headers.get('Set-Cookie')!.split(';')[0]!
  }
  const aliceCookie = await login(alice.email), bobCookie = await login(bob.email), admin = await login('admin', env.ADMIN_PASSWORD)
  async function issue(cookie = aliceCookie, extra: Record<string, unknown> = {}) {
    const response = await call('/api/vouchers', { ...body, ...extra }, cookie)
    assert.equal(response.status, 201, await response.clone().text())
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    return (await response.json()).data as Issued
  }
  async function list(path = '/api/vouchers', cookie = aliceCookie) {
    const response = await call(path, undefined, cookie)
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    return (await response.json()).data as Record<string, unknown>[]
  }
  return { db, env, alice, bob, aliceCookie, bobCookie, admin, call, issue, list }
}

test('merchant voucher routes require user sessions and same-origin JSON writes', async t => {
  const f = await fixture(t), voucher = (await f.issue()).vouchers[0]!
  const revokePath = '/api/vouchers/' + voucher.id + '/revoke'
  for (const [path, data] of [['/api/vouchers', undefined], ['/api/vouchers', body], [revokePath, { note: 'Fixture revoke' }]] as const) {
    assert.equal((await f.call(path, data)).status, 401)
    assert.equal((await f.call(path, data, f.admin)).status, 403)
  }
  for (const [path, data] of [['/api/vouchers', body], [revokePath, { note: 'Fixture revoke' }]] as const) {
    assert.equal((await f.call(path, data, f.aliceCookie, { origin: 'https://attacker.example' })).status, 403)
    assert.equal((await f.call(path, data, f.aliceCookie, { origin: null })).status, 403)
    assert.equal((await f.call(path, data, f.aliceCookie, { contentType: 'text/plain' })).status, 415)
  }
  assert.equal((await f.call('/api/vouchers', undefined, f.aliceCookie, { method: 'DELETE' })).status, 405)
  assert.equal((await f.call(revokePath, undefined, f.aliceCookie)).status, 404)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vouchers').get()!.n, 1)
  assert.equal(f.db.prepare('SELECT status FROM vouchers WHERE id=?').get(voucher.id)!.status, 'active')
})

test('merchant issuance ignores forged owner and actor, returns plaintext only once and never debits a wallet', async t => {
  const f = await fixture(t)
  const walletsBefore = JSON.stringify(f.db.prepare('SELECT * FROM wallets ORDER BY user_id').all())
  const issued = await f.issue(f.aliceCookie, { user_id: f.bob.id, actor: 'admin', scope: { userId: f.bob.id }, quantity: 3 })
  assert.equal(new Set(issued.vouchers.map(v => v.code)).size, 3)
  for (const voucher of issued.vouchers) {
    const stored = f.db.prepare('SELECT * FROM vouchers WHERE id=?').get(voucher.id)!
    assert.equal(stored.user_id, f.alice.id)
    assert.equal(stored.code_hash, await sha256(voucher.code))
    assert.ok(!JSON.stringify(stored).includes(voucher.code))
  }
  const listed = await f.list(), content = JSON.stringify(listed)
  assert.equal(listed.length, 3); assert.deepEqual(await f.list('/api/vouchers', f.bobCookie), [])
  assert.doesNotMatch(content, /code_hash|"code"|password|auth_token|ct0/)
  const audit = f.db.prepare("SELECT * FROM audit WHERE action='issue_vouchers'").get()!
  assert.equal(audit.actor, f.alice.id); assert.equal(audit.target, issued.batch_id)
  assert.equal(JSON.parse(String(audit.note)).user_id, f.alice.id)
  for (const voucher of issued.vouchers) {
    assert.ok(!content.includes(voucher.code)); assert.ok(!JSON.stringify(audit).includes(voucher.code))
  }
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM wallets ORDER BY user_id').all()), walletsBefore)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger').get()!.n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM native_jobs').get()!.n, 0)
})

test('merchant scope is applied before search and pagination and cannot be replaced by query or helper filters', async t => {
  const f = await fixture(t), label = '自己 %_\\ 批次'
  const own = await issueVouchers(f.env, { ...body, user_id: f.alice.id, quantity: 35, batch_label: label })
  const other = await issueVouchers(f.env, { ...body, user_id: f.bob.id, quantity: 35, batch_label: 'Other private batch' })
  const base = '/api/vouchers?user_id=' + f.bob.id + '&status=available&q=' + encodeURIComponent(label)
  const first = await f.list(base + '&page=1'), second = await f.list(base + '&page=2')
  assert.equal(first.length, 30); assert.equal(second.length, 5)
  assert.ok([...first, ...second].every(row => row.user_id === f.alice.id))
  assert.deepEqual(new Set([...first, ...second].map(row => row.id)), new Set(own.vouchers.map(row => row.id)))
  assert.deepEqual(await f.list(base + '&page=3'), [])
  for (const query of [other.batch_id, f.bob.id, f.bob.name, 'Other private', "' OR 1=1 --"])
    assert.deepEqual(await f.list('/api/vouchers?q=' + encodeURIComponent(query)), [])
  assert.equal((await f.list('/api/vouchers?q=' + encodeURIComponent('%_\\'))).length, 30)
  const scoped = await listVouchers(f.env, 0, { user_id: f.bob.id }, { userId: f.alice.id })
  assert.equal(scoped.length, 30); assert.ok(scoped.every(row => row.user_id === f.alice.id))
  assert.ok((await f.list('/api/vouchers?user_id=' + f.alice.id, f.bobCookie)).every(row => row.user_id === f.bob.id))
  for (const query of ['?page=0', '?page=10001', '?status=bogus', '?q=' + 'x'.repeat(81)])
    assert.equal((await f.call('/api/vouchers' + query, undefined, f.aliceCookie)).status, 400)
})

test('foreign voucher revocation has the same 404 as a missing voucher and does not reveal terminal state', async t => {
  const f = await fixture(t), own = (await f.issue()).vouchers[0]!, foreign = (await f.issue(f.bobCookie)).vouchers[0]!
  const missing = id('vch'), requestBody = { note: 'Merchant fixture revoke', user_id: f.bob.id, actor: 'admin' }
  const missingResponse = await f.call('/api/vouchers/' + missing + '/revoke', requestBody, f.aliceCookie)
  assert.equal(missingResponse.status, 404)
  const expectedError = await missingResponse.json()
  const foreignPath = '/api/vouchers/' + foreign.id + '/revoke'
  const active = await f.call(foreignPath, requestBody, f.aliceCookie)
  assert.equal(active.status, 404); assert.deepEqual(await active.json(), expectedError)
  assert.equal(f.db.prepare('SELECT status FROM vouchers WHERE id=?').get(foreign.id)!.status, 'active')
  assert.equal((await f.call(foreignPath, { note: 'Owner revoke' }, f.bobCookie)).status, 200)
  const terminal = await f.call(foreignPath, requestBody, f.aliceCookie)
  assert.equal(terminal.status, 404); assert.deepEqual(await terminal.json(), expectedError)
  await assert.rejects(revokeVoucher(f.env, foreign.id, requestBody, { userId: f.alice.id }),
    (error: Failure) => error.code === 'not_found' && error.status === 404)
  const ownPath = '/api/vouchers/' + own.id + '/revoke'
  assert.equal((await f.call(ownPath, requestBody, f.aliceCookie)).status, 200)
  assert.equal((await f.call(ownPath, requestBody, f.aliceCookie)).status, 409)
  const audit = f.db.prepare("SELECT actor FROM audit WHERE action='revoke_voucher' AND target=?").get(own.id)!
  assert.equal(audit.actor, f.alice.id)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='revoke_voucher'").get()!.n, 2)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger').get()!.n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal((await f.list('/api/vouchers?status=revoked')).length, 1)
})

test('disabled merchants lose access and disabled products cannot be issued through merchant scope', async t => {
  const f = await fixture(t), own = (await f.issue()).vouchers[0]!
  f.db.prepare('UPDATE products SET enabled=0 WHERE code=?').run(body.product_code)
  const disabledProduct = await f.call('/api/vouchers', body, f.aliceCookie)
  assert.equal(disabledProduct.status, 409); assert.equal((await disabledProduct.json()).error.code, 'product_unavailable')
  await assert.rejects(issueVouchers(f.env, { ...body, user_id: f.bob.id }, { userId: f.alice.id }),
    (error: Failure) => error.code === 'product_unavailable')
  assert.equal((await f.list()).length, 1, 'existing records remain readable when a product is disabled')
  f.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(f.alice.id)
  for (const [path, data] of [['/api/vouchers', undefined], ['/api/vouchers', body], ['/api/vouchers/' + own.id + '/revoke', { note: 'Blocked revoke' }]] as const)
    assert.equal((await f.call(path, data, f.aliceCookie)).status, 401)
  assert.equal(f.db.prepare('SELECT status FROM vouchers WHERE id=?').get(own.id)!.status, 'active')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vouchers').get()!.n, 1)
})

test('redeemed cards keep their original order and frozen points; merchant sessions never gain admin payment actions', async t => {
  const f = await fixture(t), voucher = (await f.issue(f.bobCookie)).vouchers[0]!
  await credit(f.env, f.bob.id, { points: 1000, reference: 'merchant-voucher-fixture', note: 'Fixture only' }, 'admin')
  const orderId = id('ord'), now = Date.now()
  // Seed only the local original order. Database triggers model redemption and
  // reserve points; no upstream request or payment executor is allowed here.
  f.db.prepare(`INSERT INTO orders(id,user_id,merchant_order_no,idempotency_key,request_hash,product_code,recipient,recipient_id,
    points,currency,amount_minor,stripe_product,months,created_at,updated_at,mode,voucher_id)
    VALUES(?,?,?,?,?,'x-premium-3m','receiver','12345',300,'bdt',30000,'prod_TJXJtpzqCpI36N',3,?,?,'voucher',?)`)
    .run(orderId, f.bob.id, 'merchant-' + orderId, orderId, 'fixture-hash', now, now, voucher.id)
  const walletBefore = JSON.stringify(f.db.prepare('SELECT * FROM wallets WHERE user_id=?').get(f.bob.id))
  const foreign = await f.call('/api/vouchers/' + voucher.id + '/revoke', { note: 'Foreign fixture revoke' }, f.aliceCookie)
  const missing = await f.call('/api/vouchers/' + id('vch') + '/revoke', { note: 'Foreign fixture revoke' }, f.aliceCookie)
  assert.equal(foreign.status, 404); assert.deepEqual(await foreign.json(), await missing.json())
  assert.equal((await f.call('/api/vouchers/' + voucher.id + '/revoke', { note: 'Cannot revoke redeemed' }, f.bobCookie)).status, 409)
  for (const cookie of [f.aliceCookie, f.bobCookie]) {
    assert.equal((await f.call('/api/admin/orders/' + orderId + '/payment-page', undefined, cookie)).status, 403)
    assert.equal((await f.call('/api/admin/orders/' + orderId + '/check', {}, cookie)).status, 403)
    assert.equal((await f.call('/api/admin/orders/' + orderId + '/close', { reason: 'Blocked', confirmation: 'CLOSE_ORDER' }, cookie)).status, 403)
  }
  assert.equal((await f.call('/api/orders/' + orderId, undefined, f.aliceCookie)).status, 404)
  assert.equal((await f.call('/api/orders/' + orderId, undefined, f.bobCookie)).status, 200)
  const records = await f.list('/api/vouchers?status=redeemed', f.bobCookie)
  assert.equal(records.length, 1); assert.equal(records[0]!.order_id, orderId)
  assert.equal(f.db.prepare('SELECT status FROM vouchers WHERE id=?').get(voucher.id)!.status, 'redeemed')
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM wallets WHERE user_id=?').get(f.bob.id)), walletBefore)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='reserve'").get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='revoke_voucher'").get()!.n, 0)
})

test('merchant issuance rate limit is per account and keeps validation bounds', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 5; i++) await f.issue()
  assert.equal((await f.call('/api/vouchers', body, f.aliceCookie)).status, 429)
  await f.issue(f.bobCookie)
  assert.equal((await f.call('/api/vouchers', { ...body, quantity: 101 }, f.bobCookie)).status, 400)
  assert.equal((await f.call('/api/vouchers', { ...body, expires_in_days: 366 }, f.bobCookie)).status, 400)
  assert.equal((await f.call('/api/vouchers', { ...body, batch_label: 'x'.repeat(81) }, f.bobCookie)).status, 400)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vouchers').get()!.n, 6)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger').get()!.n, 0)
})

test('admin voucher routes retain cross-owner management and original audit actor', async t => {
  const f = await fixture(t), own = (await f.issue()).vouchers[0]!
  f.db.prepare('UPDATE products SET enabled=0 WHERE code=?').run(body.product_code)
  const response = await f.call('/api/admin/vouchers', { ...body, user_id: f.bob.id }, f.admin)
  assert.equal(response.status, 201, await response.clone().text())
  const issued = (await response.json()).data as Issued, foreign = issued.vouchers[0]!
  assert.equal(f.db.prepare('SELECT user_id FROM vouchers WHERE id=?').get(foreign.id)!.user_id, f.bob.id)
  assert.equal((await f.list('/api/admin/vouchers', f.admin)).length, 2)
  const filtered = await f.list('/api/admin/vouchers?user_id=' + f.bob.id, f.admin)
  assert.equal(filtered.length, 1); assert.equal(filtered[0]!.id, foreign.id)
  for (const voucher of [own, foreign]) {
    const path = '/api/admin/vouchers/' + voucher.id + '/revoke'
    assert.equal((await f.call(path, { note: 'Admin fixture revoke' }, f.aliceCookie)).status, 403)
    assert.equal((await f.call(path, { note: 'Admin fixture revoke' }, f.admin)).status, 200)
  }
  assert.equal((await f.call('/api/admin/vouchers', undefined, f.aliceCookie)).status, 403)
  assert.equal((await f.call('/api/admin/vouchers', { ...body, user_id: f.bob.id }, f.aliceCookie)).status, 403)
  assert.equal(f.db.prepare("SELECT actor FROM audit WHERE action='issue_vouchers' AND target=?").get(issued.batch_id)!.actor, 'admin')
  assert.ok(f.db.prepare("SELECT actor FROM audit WHERE action='revoke_voucher'").all().every(row => row.actor === 'admin'))
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger').get()!.n, 0)
})
