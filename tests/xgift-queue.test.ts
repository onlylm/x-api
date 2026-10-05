import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { database } from '../services/xgift/server/database.ts'
import { admissionView, pauseAdmission } from '../services/xgift/src/admission.ts'
import { createUser } from '../services/xgift/src/auth.ts'
import { createOrder, credit, type Order } from '../services/xgift/src/orders.ts'
import { saveSecret } from '../services/xgift/src/network.ts'
import { reconcile, type Result } from '../services/xgift/src/executor.ts'
import { Failure, type Env } from '../services/xgift/src/core.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const migrations = fileURLToPath(new URL('../services/xgift/migrations/', import.meta.url))
const paid = (order: Order): Result => ({ order_id: order.id, status: 'succeeded', evidence: {
  payment_status: 'paid', gift_status: 'checkout_completed', recipient: order.recipient,
  product_code: order.product_code, currency: order.currency, amount_minor: order.amount_minor,
  receipt_id: 'queue_fixture_' + order.id,
} })

async function fixture(t: Context, limit = 10, path = ':memory:') {
  const { DB, sqlite: db } = database(path, migrations)
  t.after(() => db.close())
  const state = { calls: [] as string[], result: 'running' as 'running' | 'unknown' | 'succeeded' | 'failed' }
  const env: Env = { DB, MASTER_KEY: 'a'.repeat(64), ADMIN_PASSWORD: 'queue-fixture-password',
    PAYMENTS_ENABLED: 'true', STRIPE_PUBLISHABLE_KEY: 'pk_live_fixture',
    ASSETS: { fetch: async () => new Response('fixture') },
    LOCAL_EXECUTOR: async order => {
      state.calls.push(order.id)
      if (state.result === 'succeeded') return paid(order)
      if (state.result === 'failed') return { order_id: order.id, status: 'failed', financial_state: 'not_charged', failure_code: 'fixture_unpaid' }
      return { order_id: order.id, status: state.result, ...(state.result === 'unknown' ? { failure_code: 'payment_requires_action' } : {}) }
    },
  }
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.hostname, 'x.com')
    assert.equal(init?.method ?? 'GET', 'GET', 'Queue tests may only make mocked eligibility reads')
    assert.ok(url.pathname.endsWith('/PremiumGiftingQuery'))
    const username = JSON.parse(url.searchParams.get('variables')!).screenName
    return Response.json({ data: { user: { result: { rest_id: '12345', core: { screen_name: username }, premium_gifting_eligible: true } } } })
  })
  db.exec('UPDATE products SET enabled=1,points=300')
  db.prepare('UPDATE order_admission SET enabled=1,daily_limit=?').run(limit)
  const user = await createUser(env, { name: 'Queue fixture', email: 'queue@example.test', password: 'queue-test-password' })
  await credit(env, user.id, { points: 10000, reference: 'queue-fixture-credit', note: 'Fixture only' }, 'fixture')
  // Multiple usable accounts are deliberate: an account-specific unique index
  // must not accidentally hide a missing global payment lock in these tests.
  for (let i = 0; i < 3; i++) await saveSecret(env, 'sec_queue_' + i, 'account', {
    name: 'Queue account ' + i, auth_token: 'fixture-cookie', ct0: 'fixture-csrf', daily_limit: 300,
  })
  const create = (recipient: string, identity = recipient) => createOrder(env, user.id, 'queue:' + identity, {
    merchant_order_no: 'queue:' + identity, product_code: 'x-premium-3m', recipient, recipient_id: '12345', expected_points: 300,
  })
  const rows = () => db.prepare('SELECT * FROM orders ORDER BY created_at,id').all() as unknown as Order[]
  const due = () => db.exec("UPDATE orders SET lease_until=0,next_check=0 WHERE status IN('running','unknown')")
  return { env, db, state, user, create, rows, due }
}

test('different recipients queue within the daily quota without starting payment or duplicating a recipient', async t => {
  const f = await fixture(t)
  const orders = await Promise.all(['one', 'two', 'three'].map(name => f.create(name)))
  assert.deepEqual(orders.map(o => o.order.status), ['queued', 'queued', 'queued'])
  assert.deepEqual(f.state.calls, [])
  const view = await admissionView(f.env)
  assert.equal(view.accepts_orders, true); assert.equal(view.active_orders, 3); assert.equal(view.queued_orders, 3)
  assert.equal(view.executing_orders, 0); assert.equal(view.unknown_orders, 0); assert.equal(view.queue_blocked, false)
  assert.equal(view.blocked_order_id, null); assert.equal(view.used, 3); assert.equal(view.remaining, 7)
  assert.equal(f.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 900)
  assert.equal((await f.create('one')).created, false)
  await assert.rejects(f.create('one', 'new-identity'), (e: unknown) => e instanceof Failure && e.code === 'recipient_busy')
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='reserve'").get()!.n, 3)
})

test('concurrent native workers acquire exactly one FIFO head and one global payment slot', async t => {
  const f = await fixture(t)
  for (const recipient of ['one', 'two', 'three']) await f.create(recipient)
  const first = f.rows()[0]
  const results = await Promise.all(Array.from({ length: 12 }, () => reconcile({ ...f.env })))
  assert.equal(results.filter(result => result.processed).length, 1)
  assert.deepEqual(f.state.calls, [first.id])
  assert.deepEqual(f.rows().map(o => o.status), ['running', 'queued', 'queued'])
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_slots WHERE released=0').get()!.n, 1)
  assert.equal((await admissionView(f.env)).executing_orders, 1)
  assert.equal((await reconcile(f.env)).processed, false, 'A running job not due for polling still owns the global slot')
  assert.deepEqual(f.state.calls, [first.id])
})

test('equal-timestamp FIFO order is deterministic and a cancelled head releases only its own reservation', async t => {
  t.mock.method(Date, 'now', () => 1791168000000)
  const f = await fixture(t)
  for (const recipient of ['tieone', 'tietwo', 'tiethree']) await f.create(recipient)
  const ordered = f.rows()
  assert.ok(ordered.every(o => o.created_at === ordered[0].created_at))
  assert.deepEqual(ordered.map(o => o.id), ordered.map(o => o.id).sort())
  f.db.prepare("UPDATE orders SET status='failed',failure_code='cancelled_by_admin' WHERE id=? AND status='queued' AND execution_config IS NULL").run(ordered[0].id)
  assert.equal((await admissionView(f.env)).used, 2)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='release' AND order_id=?").get(ordered[0].id)!.n, 1)
  await reconcile(f.env)
  assert.deepEqual(f.state.calls, [ordered[1].id])
  assert.equal(f.rows()[2].status, 'queued')
})

test('unknown or 3DS jobs freeze only execution, retain the original snapshot and permit different recipients to queue', async t => {
  const f = await fixture(t)
  await f.create('pending'); await f.create('waiting')
  f.state.result = 'unknown'
  await reconcile(f.env)
  const original = f.rows()[0], snapshot = original.execution_config
  assert.equal(original.status, 'unknown'); assert.equal(original.failure_code, 'payment_requires_action')
  await f.create('another')
  f.db.prepare('UPDATE orders SET lease_until=?,next_check=? WHERE id=?').run(Date.now() + 180000, Date.now() + 60000, original.id)
  const results = await Promise.all(Array.from({ length: 8 }, () => reconcile({ ...f.env })))
  assert.ok(results.every(result => !result.processed))
  assert.deepEqual(f.state.calls, [original.id])
  const view = await admissionView(f.env)
  assert.equal(view.accepts_orders, true); assert.equal(view.queue_blocked, true)
  assert.equal(view.blocked_order_id, original.id); assert.equal(view.unknown_orders, 1); assert.equal(view.queued_orders, 2)
  assert.equal(f.rows()[0].execution_config, snapshot)
  assert.equal(f.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 900)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind IN('consume','release')").get()!.n, 0)
})

test('verified settlement releases execution for the next queued order, never before the original result', async t => {
  const f = await fixture(t)
  for (const recipient of ['settleone', 'settletwo', 'settlethree']) await f.create(recipient)
  const ordered = f.rows()
  f.state.result = 'unknown'; await reconcile(f.env)
  f.state.result = 'succeeded'; f.due(); await reconcile(f.env)
  assert.deepEqual(f.state.calls, [ordered[0].id, ordered[0].id])
  assert.equal(f.rows()[0].status, 'succeeded')
  assert.equal(f.db.prepare('SELECT released FROM account_slots WHERE order_id=?').get(ordered[0].id)!.released, 1)
  f.state.result = 'unknown'
  await Promise.all(Array.from({ length: 8 }, () => reconcile(f.env)))
  assert.deepEqual(f.state.calls, [ordered[0].id, ordered[0].id, ordered[1].id])
  f.state.result = 'failed'; f.due(); await reconcile(f.env)
  f.state.result = 'running'; await reconcile(f.env)
  assert.deepEqual(f.state.calls, [ordered[0].id, ordered[0].id, ordered[1].id, ordered[1].id, ordered[2].id])
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='consume'").get()!.n, 1)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='release'").get()!.n, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_slots WHERE released=0').get()!.n, 1)
})

test('payment pause preserves FIFO and reservations; stopping new admission does not cancel queued work', async t => {
  const f = await fixture(t)
  await f.create('pauseone'); await f.create('pausetwo')
  f.env.PAYMENTS_ENABLED = 'false'
  assert.equal((await reconcile(f.env)).processed, false)
  assert.equal((await admissionView(f.env)).queue_blocked, true)
  assert.equal(f.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 600)
  await pauseAdmission(f.env, { enabled: false })
  f.env.PAYMENTS_ENABLED = 'true'
  f.state.result = 'succeeded'
  // A fresh environment object emulates a restarted worker; order state is durable.
  for (let i = 0; i < 2; i++) await reconcile({ ...f.env })
  assert.ok(f.rows().every(o => o.status === 'succeeded'))
  assert.equal((await admissionView(f.env)).accepts_orders, false)
  assert.equal(f.state.calls.length, 2)
  assert.equal(f.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 0)
})

test('queued submissions atomically share the last daily quota and a known unpaid failure releases it', async t => {
  const f = await fixture(t, 3)
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => f.create('quota' + i)))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3)
  assert.equal((await admissionView(f.env)).used, 3)
  assert.equal((await admissionView(f.env)).reason, 'daily_limit_reached')
  assert.equal(f.rows().length, 3)
  assert.equal(f.db.prepare('SELECT frozen FROM wallets').get()!.frozen, 900)
  f.state.result = 'failed'; await reconcile(f.env)
  assert.equal((await admissionView(f.env)).used, 2)
  await f.create('replacement')
  assert.equal((await admissionView(f.env)).used, 3)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='reserve'").get()!.n, 4)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='release'").get()!.n, 1)
})

test('separate database connections cannot claim different native queue heads concurrently', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'xgift-queue-'))
  // Register cleanup before fixtures; SQLite handles are closed explicitly first.
  const path = join(directory, 'fixture.sqlite')
  let other: ReturnType<typeof database> | undefined
  const f = await fixture(t, 10, path)
  t.after(() => { other?.sqlite.close(); rmSync(directory, { recursive: true, force: true }) })
  for (const recipient of ['dbone', 'dbtwo', 'dbthree']) await f.create(recipient)
  other = database(path, migrations)
  await Promise.all(Array.from({ length: 10 }, (_, i) => reconcile({ ...f.env, DB: i % 2 ? other!.DB : f.env.DB })))
  assert.deepEqual(f.state.calls, [f.rows()[0].id])
  assert.equal(f.rows().filter(o => o.status === 'running').length, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_slots WHERE released=0').get()!.n, 1)
})
