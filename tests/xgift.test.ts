import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import worker from '../services/xgift/src/index.ts'
import { createKey, createUser } from '../services/xgift/src/auth.ts'
import {
  hmac,
  id,
  seal,
  unseal,
  type Env,
  type Statement,
  type Value,
} from '../services/xgift/src/core.ts'
import { createOrder, credit } from '../services/xgift/src/orders.ts'
import { cleanup, reconcile } from '../services/xgift/src/executor.ts'
import { saveSecret } from '../services/xgift/src/network.ts'
import {
  configureWebhook,
  deliverWebhook,
} from '../services/xgift/src/webhooks.ts'
import { signature } from '../shared/xgift-signature.ts'
type Context = Parameters<Parameters<typeof test>[1]>[0]
function setup(t: Context) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const migrations = new URL('../services/xgift/migrations/', import.meta.url)
  for (const name of readdirSync(migrations).filter((name) => /^\d+.*\.sql$/.test(name)).sort())
    db.exec(readFileSync(new URL(name, migrations), 'utf8'))
  const states = new WeakMap<Statement, { sql: string; values: Value[] }>()
  const env: Env = {
    MASTER_KEY: 'a'.repeat(64),
    ADMIN_PASSWORD: 'test-admin-password-only-123456789',
    EXECUTOR_URL: 'https://executor.example.test',
    EXECUTOR_SECRET: 'test-executor-secret-only-123456789',
    PAYMENTS_ENABLED: 'true',
    ASSETS: { fetch: async () => new Response('asset') },
    DB: {
      prepare(sql) {
        const state = { sql, values: [] as Value[] }
        const s: Statement = {
          bind(...v) {
            state.values = v
            return this
          },
          async first<T>() {
            return (db.prepare(sql).get(...state.values) ?? null) as T | null
          },
          async all<T>() {
            return { results: db.prepare(sql).all(...state.values) as T[] }
          },
          async run() {
            return db.prepare(sql).run(...state.values)
          },
        }
        states.set(s, state)
        return s
      },
      async batch(statements) {
        db.exec('BEGIN')
        try {
          const results = statements.map((s) => {
            const v = states.get(s)!
            return db.prepare(v.sql).run(...v.values)
          })
          db.exec('COMMIT')
          return results
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      },
    },
  }
  const call = (
    path: string,
    data?: unknown,
    cookie = '',
    origin = 'https://x-api.gptibo.com',
  ) =>
    worker.fetch(
      new Request('https://x-api.gptibo.com' + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          Origin: origin,
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      env,
    )
  const user = async (name = 'first') =>
    createUser(env, {
      name,
      email: name + '@example.test',
      password: 'test-user-password-12345',
    })
  const fund = (
    userId: string,
    points = 1000,
    reference = 'bank-receipt-001',
  ) =>
    credit(
      env,
      userId,
      { points, reference, note: 'Test payment received' },
      'admin',
    )
  const wallet = (userId: string) =>
    db
      .prepare('SELECT available,frozen FROM wallets WHERE user_id=?')
      .get(userId)
  db.exec('UPDATE products SET enabled=1')
  const order = (
    userId: string,
    merchant = 'merchant-001',
    recipient = 'testuser',
    idem = merchant,
  ) =>
    createOrder(env, userId, idem, {
      merchant_order_no: merchant,
      product_code: 'x-premium-3m',
      recipient,
    })
  const signed = async (
    key: Awaited<ReturnType<typeof createKey>>,
    path: string,
    body?: unknown,
    nonce = crypto.randomUUID(),
    timestamp = String(Math.floor(Date.now() / 1000)),
    idem = 'signed-order-001',
  ) => {
    const url = new URL('https://x-api.gptibo.com' + path),
      raw = body === undefined ? '' : JSON.stringify(body),
      method = body === undefined ? 'GET' : 'POST'
    const headers = {
      'X-Partner-Id': key.user_id,
      'X-Key-Id': key.key_id,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': await signature(
        key.secret,
        method,
        url,
        timestamp,
        nonce,
        key.key_id,
        body === undefined ? '' : idem,
        raw,
      ),
      ...(body === undefined ? {} : { 'Idempotency-Key': idem }),
      'Content-Type': 'application/json',
    }
    return worker.fetch(
      new Request(url, {
        method,
        headers,
        body: body === undefined ? undefined : raw,
      }),
      env,
    )
  }
  return { db, env, call, user, fund, wallet, order, signed }
}
test('X signing matches the compatibility vector and binds query, body, nonce and idempotency', async () => {
  const url = new URL('https://x-api.gptibo.com/v1/orders?z=two%20words&a=1')
  const args = [
    'POST',
    url,
    '1791000000',
    'unique-nonce-123456',
    'key_test',
    'order-001',
    '{"recipient":"abc"}',
  ] as const
  assert.equal(
    await signature('test-only', ...args),
    "e00170eb7e8f668c495afe984118a49e6820be070dc9c2dbb1438bd3b775d781",
  )
  assert.notEqual(
    await signature('test-only', ...args),
    await signature(
      'test-only',
      'POST',
      url,
      args[2],
      args[3],
      args[4],
      'other-001',
      args[6],
    ),
  )
})
test('encrypted secrets are bound to their record and cannot be swapped', async (t) => {
  const { env } = setup(t),
    cipher = await seal(env, 'key:one', 'test-only-private')
  assert.ok(!cipher.includes('test-only-private'))
  assert.equal(await unseal(env, 'key:one', cipher), 'test-only-private')
  await assert.rejects(unseal(env, 'key:two', cipher))
})
test('credits are idempotent and conflicting payment receipts cannot change balance', async (t) => {
  const f = setup(t),
    u = await f.user()
  await Promise.all([f.fund(u.id), f.fund(u.id)])
  assert.deepEqual({ ...f.wallet(u.id) }, { available: 1000, frozen: 0 })
  await assert.rejects(f.fund(u.id, 2000), /凭证/)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger').get()!.n, 1)
  assert.throws(
    () => f.db.exec('UPDATE ledger SET available_delta=999999'),
    /immutable_ledger/,
  )
})
test('order duplicates reserve only once and conflicting requests do not create a second order', async (t) => {
  const f = setup(t),
    u = await f.user()
  await f.fund(u.id)
  const [a, b] = await Promise.all([f.order(u.id), f.order(u.id)])
  assert.equal(a.order.id, b.order.id)
  assert.deepEqual({ ...f.wallet(u.id) }, { available: 700, frozen: 300 })
  await assert.rejects(f.order(u.id, 'merchant-001', 'different'), /绑定/)
  await assert.rejects(
    f.order(u.id, 'different-001', 'different', 'merchant-001'),
    /绑定/,
  )
})
test('concurrent distinct orders cannot overspend points', async (t) => {
  const f = setup(t),
    u = await f.user()
  await f.fund(u.id, 400)
  const results = await Promise.allSettled([
    f.order(u.id, 'merchant-001', 'one'),
    f.order(u.id, 'merchant-002', 'two'),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.deepEqual({ ...f.wallet(u.id) }, { available: 100, frozen: 300 })
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
})
test('orders preserve user prices and settle atomically exactly once', async (t) => {
  const f = setup(t),
    u = await f.user()
  await f.fund(u.id)
  f.db
    .prepare('INSERT INTO user_prices VALUES(?,?,?)')
    .run(u.id, 'x-premium-3m', 250)
  const a = await f.order(u.id)
  assert.equal(a.order.points, 250)
  f.db.exec('UPDATE products SET points=999,amount_minor=40000')
  f.db.prepare("UPDATE orders SET status='running' WHERE id=?").run(a.order.id)
  f.db
    .prepare("UPDATE orders SET status='succeeded' WHERE id=?")
    .run(a.order.id)
  f.db
    .prepare("UPDATE orders SET status='succeeded' WHERE id=?")
    .run(a.order.id)
  assert.deepEqual({ ...f.wallet(u.id) }, { available: 750, frozen: 0 })
  assert.equal(
    f.db.prepare('SELECT amount_minor FROM orders WHERE id=?').get(a.order.id)!
      .amount_minor,
    30000,
  )
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) n FROM ledger WHERE order_id=?')
      .get(a.order.id)!.n,
    2,
  )
  assert.throws(
    () =>
      f.db
        .prepare("UPDATE orders SET status='failed' WHERE id=?")
        .run(a.order.id),
    /terminal_order/,
  )
  assert.throws(
    () => f.db.prepare('UPDATE orders SET points=1 WHERE id=?').run(a.order.id),
    /immutable_order/,
  )
})
test('failed orders return frozen points and unknown orders keep them frozen', async (t) => {
  const f = setup(t),
    u = await f.user()
  await f.fund(u.id)
  const a = await f.order(u.id)
  f.db.prepare("UPDATE orders SET status='running' WHERE id=?").run(a.order.id)
  f.db.prepare("UPDATE orders SET status='unknown' WHERE id=?").run(a.order.id)
  assert.deepEqual({ ...f.wallet(u.id) }, { available: 700, frozen: 300 })
  f.db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(a.order.id)
  assert.deepEqual({ ...f.wallet(u.id) }, { available: 1000, frozen: 0 })
})
test('disabled execution rejects new orders without touching points but still allows original lookup', async (t) => {
  const f = setup(t),
    u = await f.user()
  await f.fund(u.id)
  const a = await f.order(u.id)
  f.env.PAYMENTS_ENABLED = 'false'
  assert.equal((await f.order(u.id)).order.id, a.order.id)
  await assert.rejects(f.order(u.id, 'merchant-002', 'two'), /自动支付/)
  assert.deepEqual({ ...f.wallet(u.id) }, { available: 700, frozen: 300 })
})
test('active recipient is unique across tenants', async (t) => {
  const f = setup(t),
    a = await f.user('first'),
    b = await f.user('second')
  await f.fund(a.id)
  await f.fund(b.id)
  await f.order(a.id)
  await assert.rejects(f.order(b.id), /接收账号/)
  assert.deepEqual({ ...f.wallet(b.id) }, { available: 1000, frozen: 0 })
})
test('API denies signature replay, revoked keys, stale timestamps and tenant leakage', async (t) => {
  const f = setup(t),
    a = await f.user(),
    b = await f.user('second')
  await f.fund(a.id)
  await f.fund(b.id)
  const k = await createKey(f.env, a.id, 'test'),
    other = await createKey(f.env, b.id, 'test'),
    nonce = crypto.randomUUID()
  assert.equal((await f.signed(k, '/v1/balance', undefined, nonce)).status, 200)
  assert.equal((await f.signed(k, '/v1/balance', undefined, nonce)).status, 409)
  assert.equal(
    (
      await f.signed(
        k,
        '/v1/balance',
        undefined,
        crypto.randomUUID(),
        String(Math.floor(Date.now() / 1000) - 1000),
      )
    ).status,
    401,
  )
  const order = await f.order(a.id)
  assert.equal(
    (await f.signed(other, '/v1/orders/' + order.order.id)).status,
    404,
  )
  f.db.prepare('UPDATE api_keys SET revoked=1 WHERE id=?').run(k.key_id)
  assert.equal((await f.signed(k, '/v1/balance')).status, 401)
})
test('user login cannot access admin APIs and disabling user invalidates its session', async (t) => {
  const f = setup(t),
    u = await f.user()
  const login = await f.call('/api/login', {
    email: u.email,
    password: 'test-user-password-12345',
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0]
  assert.equal(
    (await f.call('/api/admin/users', undefined, cookie)).status,
    403,
  )
  assert.equal(
    (
      await f.call(
        '/api/keys',
        { label: 'test' },
        cookie,
        'https://foreign.example',
      )
    ).status,
    403,
  )
  f.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(u.id)
  assert.equal((await f.call('/api/me', undefined, cookie)).status, 401)
})
test('admin lists never return cookies, API secrets or proxy passwords', async (t) => {
  const f = setup(t),
    u = await f.user()
  await createKey(f.env, u.id, 'test')
  const proxy = id('sec')
  await saveSecret(f.env, proxy, 'proxy', {
    name: 'test',
    protocol: 'http',
    host: 'proxy.example.test',
    port: 8080,
    username: 'test-user',
    password: 'PRIVATE-PROXY-PASSWORD',
  })
  await saveSecret(f.env, id('sec'), 'account', {
    name: 'test',
    auth_token: 'PRIVATE-X-COOKIE',
    ct0: 'PRIVATE-X-CSRF',
    proxy_id: proxy,
  })
  const login = await f.call('/api/login', {
      email: 'admin',
      password: f.env.ADMIN_PASSWORD,
    }),
    cookie = login.headers.get('Set-Cookie')!.split(';')[0]
  for (const route of [
    '/api/admin/users',
    '/api/admin/secrets',
    '/api/admin/audit',
  ]) {
    const response = await f.call(route, undefined, cookie)
    assert.equal(response.status, 200)
    assert.doesNotMatch(
      await response.text(),
      /PRIVATE|password_hash|salt|payload/,
    )
  }
})
test('admin can raise an existing account limit to 300 without changing its credentials or status', async (t) => {
  const f = setup(t), accountId = id('sec'), proxyId = id('sec')
  await saveSecret(f.env, proxyId, 'proxy', {
    name: 'proxy', protocol: 'http', host: 'proxy.example.test', port: 8080,
  })
  await saveSecret(f.env, accountId, 'account', {
    name: 'account', auth_token: 'PRIVATE-COOKIE', ct0: 'PRIVATE-CSRF',
    proxy_id: proxyId, daily_limit: 3,
  })
  f.db.prepare('UPDATE secrets SET enabled=0 WHERE id=?').run(accountId)
  const route = `/api/admin/secrets/${accountId}/limit`
  assert.equal((await f.call(route, { daily_limit: 300 })).status, 401)
  const login = await f.call('/api/login', { email: 'admin', password: f.env.ADMIN_PASSWORD })
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0]
  for (const daily_limit of [0, 301, 1.5]) {
    assert.equal((await f.call(route, { daily_limit }, cookie)).status, 400)
  }
  const changed = await f.call(route, { daily_limit: 300 }, cookie)
  assert.equal(changed.status, 200)
  assert.doesNotMatch(await changed.text(), /PRIVATE|payload/)
  const row = f.db.prepare('SELECT * FROM secrets WHERE id=?').get(accountId)!
  assert.equal(row.enabled, 0)
  assert.equal(row.name, 'account')
  assert.deepEqual(JSON.parse(await unseal(f.env, 'secret:' + accountId, String(row.payload))), {
    auth_token: 'PRIVATE-COOKIE', ct0: 'PRIVATE-CSRF', proxy_id: proxyId, daily_limit: 300,
  })
  assert.equal((await f.call(`/api/admin/secrets/${proxyId}/limit`, { daily_limit: 300 }, cookie)).status, 404)
  const list = await f.call('/api/admin/secrets', undefined, cookie)
  assert.doesNotMatch(await list.text(), /PRIVATE|payload/)
  await assert.rejects(saveSecret(f.env, id('sec'), 'account', {
    name: 'new', auth_token: 'test', ct0: 'test', daily_limit: 301,
  }), /1–300/)
})

test('gift billing profile is admin-only, encrypted and does not enable payment or expose details to audits', async (t) => {
  const f = setup(t)
  const route = '/api/admin/gift-profile'
  assert.equal((await f.call(route)).status, 401)
  const u = await f.user()
  const userLogin = await f.call('/api/login', { email: u.email, password: 'test-user-password-12345' })
  const userCookie = userLogin.headers.get('Set-Cookie')!.split(';')[0]
  assert.equal((await f.call(route, undefined, userCookie)).status, 403)
  const adminLogin = await f.call('/api/login', { email: 'admin', password: f.env.ADMIN_PASSWORD })
  const cookie = adminLogin.headers.get('Set-Cookie')!.split(';')[0]
  const profile = { first_name: 'Test', last_name: 'Holder', billing_email: 'PRIVATE@example.test', billing_country: 'cn', billing_line1: 'Private billing street', billing_city: 'Example City', billing_state: 'Example Region', billing_postal_code: '000000' }
  assert.equal((await f.call(route, profile, cookie, 'https://evil.example.test')).status, 403)
  for (const invalid of [{ billing_country: 'ZZ' }, { billing_email: 'invalid' }, { billing_line1: 'invalid\naddress' }, { billing_postal_code: 'a'.repeat(21) }]) {
    assert.equal((await f.call(route, { ...profile, ...invalid }, cookie)).status, 400)
  }
  assert.equal((await f.call(route, profile, cookie)).status, 200)
  const payload = String(f.db.prepare('SELECT payload FROM gift_profile').get()!.payload)
  assert.doesNotMatch(payload, /PRIVATE|Holder|Private billing street/)
  assert.deepEqual(JSON.parse(await unseal(f.env, 'gift-profile', payload)), {
    ...profile, billing_email: 'private@example.test', billing_country: 'CN', billing_line2: '',
  })
  const saved = (await (await f.call(route, undefined, cookie)).json()).data
  assert.equal(saved.policy.preferred_product, 'PP5583RC')
  assert.equal(saved.configured, true)
  assert.equal(saved.test_recipient, undefined)
  assert.equal(saved.billing_line1, profile.billing_line1)
  assert.doesNotMatch(await (await f.call('/api/admin/audit', undefined, cookie)).text(), /PRIVATE|private@example|Holder|Private billing/)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger').get()!.n, 0)
})

test('proxy configuration fails closed without a gateway', async (t) => {
  const f = setup(t),
    proxy = id('sec')
  await saveSecret(f.env, proxy, 'proxy', {
    name: 'test',
    protocol: 'http',
    host: 'proxy.example.test',
    port: 8080,
  })
  const login = await f.call('/api/login', {
      email: 'admin',
      password: f.env.ADMIN_PASSWORD,
    }),
    cookie = login.headers.get('Set-Cookie')!.split(';')[0]
  const r = await f.call('/api/admin/secrets/' + proxy + '/test', {}, cookie)
  assert.equal(r.status, 503)
  assert.equal((await r.json()).error.code, 'proxy_gateway_missing')
})
async function executorFixture(t: Context) {
  const f = setup(t),
    u = await f.user()
  await f.fund(u.id)
  await saveSecret(f.env, id('sec'), 'account', {
    name: 'test',
    auth_token: 'test-only-cookie',
    ct0: 'test-only-csrf',
    daily_limit: 3,
  })
  const a = await f.order(u.id)
  return { ...f, u, orderId: a.order.id }
}
test('lost executor POST is never replayed; only the bound original job is queried', async (t) => {
  const f = await executorFixture(t),
    calls: string[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, init: RequestInit) => {
      calls.push((init.method ?? 'GET') + ' ' + input)
      throw new Error('lost response')
    },
  )
  await reconcile(f.env)
  assert.equal(
    f.db.prepare('SELECT status FROM orders').get()!.status,
    'unknown',
  )
  f.db.exec('UPDATE orders SET next_check=0,lease_until=0')
  f.env.PAYMENTS_ENABLED = 'false'
  f.env.EXECUTOR_URL = 'https://changed.example.test'
  f.env.EXECUTOR_SECRET = 'different-secret'
  await reconcile(f.env)
  assert.deepEqual(calls, [
    'POST https://executor.example.test/v1/jobs',
    'GET https://executor.example.test/v1/jobs/' + f.orderId,
  ])
  assert.deepEqual({ ...f.wallet(f.u.id) }, { available: 700, frozen: 300 })
})
test('verified completion settles points, while mismatched evidence cannot settle', async (t) => {
  const f = await executorFixture(t)
  let wrong = true
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string, init: RequestInit) => {
      const hdr = new Headers(init.headers),
        data = {
          order_id: f.orderId,
          status: 'succeeded',
          evidence: {
            payment_status: 'paid',
            gift_status: 'completed',
            recipient: 'testuser',
            product_code: 'x-premium-3m',
            currency: wrong ? 'sgd' : 'bdt',
            amount_minor: 30000,
            receipt_id: 'test-receipt',
          },
        }
      const raw = JSON.stringify(data),
        sig = await hmac(
          f.env.EXECUTOR_SECRET!,
          hdr.get('X-Timestamp') + '.' + hdr.get('X-Nonce') + '.' + raw,
        )
      return new Response(raw, { headers: { 'X-Response-Signature': sig } })
    },
  )
  await reconcile(f.env)
  assert.equal(
    f.db.prepare('SELECT status FROM orders').get()!.status,
    'unknown',
  )
  wrong = false
  f.db.exec('UPDATE orders SET next_check=0,lease_until=0')
  await reconcile(f.env)
  assert.equal(
    f.db.prepare('SELECT status FROM orders').get()!.status,
    'succeeded',
  )
  assert.deepEqual({ ...f.wallet(f.u.id) }, { available: 700, frozen: 0 })
  assert.equal(
    f.db.prepare('SELECT released FROM account_slots').get()!.released,
    1,
  )
})
test('concurrent dispatch reserves account once and respects daily cap', async (t) => {
  const f = await executorFixture(t)
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    calls.push(input)
    throw new Error('unknown')
  })
  await Promise.all([reconcile(f.env), reconcile(f.env)])
  assert.equal(calls.length, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_slots').get()!.n, 1)
  await f.order(f.u.id, 'merchant-002', 'another')
  await reconcile(f.env)
  assert.equal(calls.length, 1)
})
test('daily account cap prevents a fourth dispatch even after releasing earlier jobs', async (t) => {
  const f = await executorFixture(t)
  let calls = 0
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string, init: RequestInit) => {
      calls++
      const request = JSON.parse(String(init.body)),
        headers = new Headers(init.headers)
      const raw = JSON.stringify({
        order_id: request.order_id,
        status: 'failed',
        financial_state: 'not_charged',
        failure_code: 'test_rejected',
      })
      return new Response(raw, {
        headers: {
          'X-Response-Signature': await hmac(
            f.env.EXECUTOR_SECRET!,
            headers.get('X-Timestamp') +
              '.' +
              headers.get('X-Nonce') +
              '.' +
              raw,
          ),
        },
      })
    },
  )
  for (let n = 0; n < 3; n++) {
    if (n) await f.order(f.u.id, 'merchant-00' + (n + 1), 'recipient' + n)
    await reconcile(f.env)
  }
  await f.order(f.u.id, 'merchant-004', 'recipient4')
  await reconcile(f.env)
  assert.equal(calls, 3)
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM orders WHERE status='queued'").get()!
      .n,
    1,
  )
  assert.deepEqual({ ...f.wallet(f.u.id) }, { available: 700, frozen: 300 })
})
test('tampering with an already signed order body cannot reserve any points', async (t) => {
  const f = setup(t),
    u = await f.user()
  await f.fund(u.id)
  const key = await createKey(f.env, u.id, 'test')
  const url = new URL('https://x-api.gptibo.com/v1/orders'),
    timestamp = String(Math.floor(Date.now() / 1000)),
    nonce = crypto.randomUUID(),
    idem = 'tampered-order-001'
  const raw = JSON.stringify({
    merchant_order_no: idem,
    product_code: 'x-premium-3m',
    recipient: 'testuser',
  })
  const sig = await signature(
    key.secret,
    'POST',
    url,
    timestamp,
    nonce,
    key.key_id,
    idem,
    raw,
  )
  const response = await worker.fetch(
    new Request(url, {
      method: 'POST',
      body: raw.replace('testuser', 'otheruser'),
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Id': u.id,
        'X-Key-Id': key.key_id,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': sig,
        'Idempotency-Key': idem,
      },
    }),
    f.env,
  )
  assert.equal(response.status, 401)
  assert.deepEqual({ ...f.wallet(u.id) }, { available: 1000, frozen: 0 })
})
test('signed callbacks preserve event ID across retries and never expose secrets', async (t) => {
  const f = setup(t),
    u = await f.user()
  await f.fund(u.id)
  const webhook = await configureWebhook(
    f.env,
    u.id,
    'https://notify.example.test/orders',
  )
  const a = await f.order(u.id)
  f.db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(a.order.id)
  let attempts = 0
  const events: string[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string, init: RequestInit) => {
      const headers = new Headers(init.headers),
        raw = String(init.body)
      events.push(headers.get('X-Event-Id')!)
      assert.equal(
        headers.get('X-Signature'),
        createHmac('sha256', webhook.secret!)
          .update(headers.get('X-Timestamp') + '.' + raw)
          .digest('hex'),
      )
      assert.doesNotMatch(raw, /secret|auth_token|execution_config/)
      return new Response('', { status: ++attempts === 1 ? 503 : 200 })
    },
  )
  await deliverWebhook(f.env)
  f.db.exec('UPDATE webhook_deliveries SET next_at=0')
  await deliverWebhook(f.env)
  assert.equal(events[0], events[1])
  assert.equal(
    f.db.prepare('SELECT status FROM webhook_deliveries').get()!.status,
    'sent',
  )
})
test('expired sessions and nonces are cleaned without touching ledger', async (t) => {
  const f = setup(t),
    u = await f.user()
  await f.fund(u.id)
  const key = await createKey(f.env, u.id, 'test')
  f.db
    .prepare('INSERT INTO nonces VALUES(?,?,?)')
    .run(key.key_id, 'test-expired-nonce', 0)
  await cleanup(f.env)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM nonces').get()!.n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger').get()!.n, 1)
})
test('production requires HTTPS while local preview rewrites only an explicit loopback origin', async (t) => {
  const f = setup(t)
  const request = () =>
    new Request('http://x-api.gptibo.com/api/login', {
      method: 'POST',
      headers: {
        Origin: 'http://x-api.gptibo.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'admin', password: f.env.ADMIN_PASSWORD }),
    })
  assert.equal((await worker.fetch(request(), f.env)).status, 403)
  f.env.LOCAL_ORIGIN = 'http://127.0.0.1:8791'
  assert.equal((await worker.fetch(request(), f.env)).status, 200)
  f.env.LOCAL_ORIGIN = 'http://public.example.test'
  assert.equal((await worker.fetch(request(), f.env)).status, 503)
})
