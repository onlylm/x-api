import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { database } from '../services/xgift/server/database.ts'
import { createUser } from '../services/xgift/src/auth.ts'
import { cardConfiguration, configureCards } from '../services/xgift/src/cards.ts'
import { type Env, type Failure } from '../services/xgift/src/core.ts'
import { configureGiftProfile } from '../services/xgift/src/gift-profile.ts'
import { saveSecret } from '../services/xgift/src/network.ts'
import {
  assertPaymentAllowed, configurePayments, paymentBinding, paymentSettings,
  paymentView, resolvePaymentEnv, setPaymentsEnabled,
} from '../services/xgift/src/payments.ts'
import worker from '../services/xgift/src/index.ts'

type Context = Parameters<Parameters<typeof test>[1]>[0]
const origin = 'https://x-api.example.test'

async function fixture(t: Context) {
  const { DB, sqlite: db } = database(':memory:', fileURLToPath(new URL('../services/xgift/migrations/', import.meta.url)))
  t.after(() => db.close())
  const state = {
    calls: [] as string[], executions: 0, balance: 20, status: 'ACTIVE', pan: '4242424242424242',
    returnedId: null as number | null, unavailable: false, onCardRead: undefined as (() => Promise<void>) | undefined,
  }
  const env: Env = {
    DB, MASTER_KEY: 'a'.repeat(64), ADMIN_PASSWORD: 'test-admin-password-only',
    PAYMENTS_ENABLED: 'false', ASSETS: { fetch: async () => new Response('asset') },
    NATIVE_EXECUTOR: async (_env, order) => {
      state.executions++
      return { order_id: order.id, status: 'unknown' }
    },
  }
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    state.calls.push((init?.method ?? 'GET') + ' ' + url.pathname)
    assert.equal(url.hostname, 'zovocard.com')
    assert.equal(init?.method ?? 'GET', 'GET', 'Payment configuration must never make a provider write')
    assert.match(url.pathname, /^\/openapi\/v1\/cards\/\d+$/)
    assert.equal(url.searchParams.get('sync'), '1')
    if (state.unavailable) throw new Error('fixture provider unavailable')
    await state.onCardRead?.()
    return Response.json({ code: 0, data: {
      id: state.returnedId ?? Number(url.pathname.split('/').at(-1)), product_code: 'EXISTING-CARD',
      network: 'VISA', status: state.status, available_amount: state.balance,
      card_number: state.pan, cvv: '321', expire: '12/30', first_name: 'Private',
      last_name: 'Fixture', email: 'private-card@example.test', extra: 'private-provider-payload',
    } })
  })
  await configureCards(env, { environment: 'production', transport: 'direct', api_key: 'sk_private_fixture_key', writes_enabled: false })
  await configureGiftProfile(env, { first_name: 'Private', last_name: 'Fixture', billing_email: 'private-billing@example.test', billing_country: 'HK', billing_line1: 'Private fixture address' })
  await saveSecret(env, 'sec_fixture_account', 'account', { name: 'Fixture sender', auth_token: 'private-fixture-cookie', ct0: 'private-fixture-csrf' })
  db.exec('UPDATE products SET enabled=1')
  const user = await createUser(env, { name: 'Test merchant', email: 'merchant@example.test', password: 'test-merchant-password' })
  const request = (path: string, body?: Record<string, unknown>, cookie = '', requestOrigin = origin) => worker.fetch(new Request(origin + path, {
    method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: requestOrigin, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env)
  const login = await request('/api/login', { email: 'admin', password: env.ADMIN_PASSWORD })
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0]!
  const merchantLogin = await request('/api/login', { email: 'merchant@example.test', password: 'test-merchant-password' })
  const merchantCookie = merchantLogin.headers.get('Set-Cookie')!.split(';')[0]!
  async function configurationBody(extra: Record<string, unknown> = {}) {
    return { revision: (await paymentSettings(env))?.revision ?? null,
      stripe_publishable_key: 'pk_live_fixturepublic', card_id: 123,
      provider_revision: (await cardConfiguration(env)).revision, ...extra }
  }
  const save = async (extra: Record<string, unknown> = {}) => configurePayments(env, await configurationBody(extra))
  const enable = async (extra: Record<string, unknown> = {}) => setPaymentsEnabled(env, {
    enabled: true, revision: (await paymentSettings(env))?.revision ?? null, confirmation: 'ENABLE_PAYMENTS', ...extra,
  })
  return { env, db, state, user, request, cookie, merchantCookie, save, enable, configurationBody }
}

test('payment admin endpoints require an administrator, same-origin JSON and explicit enabling confirmation', async t => {
  const s = await fixture(t)
  assert.equal((await s.request('/api/admin/payments')).status, 401)
  assert.equal((await s.request('/api/admin/payments', undefined, s.merchantCookie)).status, 403)
  const body = await s.configurationBody()
  assert.equal((await s.request('/api/admin/payments/config', body, s.merchantCookie)).status, 403)
  assert.equal((await s.request('/api/admin/payments/config', body, s.cookie, 'https://attacker.example.test')).status, 403)
  const invalidContent = await worker.fetch(new Request(origin + '/api/admin/payments/config', {
    method: 'POST', headers: { Cookie: s.cookie, Origin: origin, 'Content-Type': 'text/plain' }, body: JSON.stringify(body),
  }), s.env)
  assert.equal(invalidContent.status, 415)
  assert.equal(s.state.calls.length, 0)
  const saved = await s.request('/api/admin/payments/config', body, s.cookie)
  assert.equal(saved.status, 200)
  const view = (await saved.json()).data
  assert.equal(view.enabled, false)
  const missingConfirmation = await s.request('/api/admin/payments/enabled', { enabled: true, revision: view.revision }, s.cookie)
  assert.equal(missingConfirmation.status, 400)
  assert.equal((await missingConfirmation.json()).error.code, 'confirmation_required')
  const enabled = await s.request('/api/admin/payments/enabled', { enabled: true, revision: view.revision, confirmation: 'ENABLE_PAYMENTS' }, s.cookie)
  assert.equal(enabled.status, 200)
  assert.equal((await enabled.json()).data.execution_ready, true)
  assert.equal((await s.request('/api/capabilities')).status, 200)
  assert.equal(s.state.executions, 0)
})

test('configuration persists encrypted metadata, masks card data, and does not expose billing or credentials through views or audits', async t => {
  const s = await fixture(t)
  const view = await s.save()
  assert.equal(view.selected_card?.last_four, '4242')
  assert.equal(view.selected_card?.id, 123)
  assert.equal(view.stripe_publishable_key, 'pk_live_fixturepublic')
  assert.doesNotMatch(JSON.stringify(view), /4242424242424242|cvv|expire|private-billing|Private fixture|sk_private|private-fixture|private-provider/)
  const stored = JSON.stringify(s.db.prepare('SELECT * FROM payment_settings').get())
  assert.doesNotMatch(stored, /pk_live_fixturepublic|4242424242424242|last_four|EXISTING-CARD/)
  const audit = await s.request('/api/admin/audit', undefined, s.cookie)
  assert.equal(audit.status, 200)
  assert.doesNotMatch(await audit.text(), /pk_live_fixturepublic|4242424242424242|private-billing|Private fixture|sk_private|private-fixture|private-provider/)
  const publicView = await s.request('/api/capabilities')
  assert.doesNotMatch(await publicView.text(), /card_id|last_four|publishable_key|provider_revision|billing|4242/)
  const reloaded = await resolvePaymentEnv({ ...s.env, PAYMENT_SETTINGS: undefined })
  assert.equal(reloaded.PAYMENT_SETTINGS?.card_id, 123)
  assert.equal(reloaded.PAYMENTS_ENABLED, 'false')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM card_operations').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM native_funding').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(s.state.executions, 0)
})

test('configuration rejects private keys, unsupported runtimes, stale versions and unready cards without changing persisted settings', async t => {
  const s = await fixture(t)
  await assert.rejects(s.save({ stripe_publishable_key: 'sk_live_privatefixture' }), (e: Failure) => e.code === 'invalid_input')
  const native = s.env.NATIVE_EXECUTOR
  s.env.NATIVE_EXECUTOR = undefined
  await assert.rejects(s.save(), (e: Failure) => e.code === 'native_executor_unavailable')
  s.env.NATIVE_EXECUTOR = native
  for (const patch of [{ balance: 9.99 }, { status: 'FROZEN' }, { returnedId: 999 }, { pan: '' }]) {
    Object.assign(s.state, { balance: 20, status: 'ACTIVE', returnedId: null, pan: '4242424242424242' }, patch)
    await assert.rejects(s.save(), (e: Failure) => e.code === 'payment_card_not_ready')
    assert.equal(await paymentSettings(s.env), null)
  }
  Object.assign(s.state, { balance: 20, status: 'ACTIVE', returnedId: null, pan: '4242424242424242' })
  const saved = await s.save()
  await assert.rejects(s.save({ revision: null, card_id: 456 }), (e: Failure) => e.code === 'payment_config_conflict')
  await s.enable()
  await assert.rejects(s.save(), (e: Failure) => e.code === 'payments_must_be_paused')
  assert.equal((await paymentSettings(s.env))!.revision, saved.revision)
})

test('concurrent configuration saves allow one version and enabling always rechecks the selected card balance', async t => {
  const s = await fixture(t)
  const body = await s.configurationBody()
  const results = await Promise.allSettled([
    configurePayments(s.env, body), configurePayments(s.env, { ...body, card_id: 456 }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='configure_payments'").get()!.n, 1)
  const before = s.state.calls.length
  s.state.balance = 0
  await assert.rejects(s.enable(), (e: Failure) => e.code === 'payment_card_not_ready')
  assert.equal(s.state.calls.length, before + 1)
  assert.equal((await paymentSettings(s.env))!.enabled, false)
})

test('a pause during enable verification wins the race and is persistent without consulting an unavailable provider', async t => {
  const s = await fixture(t)
  await s.save()
  s.state.onCardRead = async () => {
    s.state.onCardRead = undefined
    await setPaymentsEnabled(s.env, { enabled: false })
  }
  await assert.rejects(s.enable(), (e: Failure) => e.code === 'payment_config_conflict')
  assert.equal((await paymentSettings(s.env))!.enabled, false)
  await s.enable()
  s.state.unavailable = true
  const before = s.state.calls.length
  const response = await s.request('/api/admin/payments/enabled', { enabled: false, revision: 'stale-view' }, s.cookie)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, { paused: true, enabled: false })
  assert.equal(s.state.calls.length, before)
  assert.equal((await resolvePaymentEnv(s.env)).PAYMENTS_ENABLED, 'false')
  assert.equal((await paymentSettings(s.env))!.card_id, 123)
})

test('runtime refresh and emergency lock override stale enabled environments while preserving frozen payment bindings', async t => {
  const s = await fixture(t)
  const saved = await s.save(); await s.enable()
  const effective = await resolvePaymentEnv(s.env)
  assert.equal(s.env.PAYMENTS_ENABLED, 'false', 'Resolving runtime settings must not mutate boot configuration')
  assert.equal(effective.PAYMENTS_ENABLED, 'true')
  const binding = await paymentBinding(effective)
  assert.equal(binding?.revision, saved.revision)
  assert.equal(binding?.card_id, 123)
  await assertPaymentAllowed(effective, binding)
  await setPaymentsEnabled(s.env, { enabled: false })
  await assert.rejects(assertPaymentAllowed(effective, binding), (e: Failure) => e.code === 'payments_paused')
  await s.enable()
  assert.equal((await paymentBinding(await resolvePaymentEnv(s.env)))!.revision, saved.revision)
  const locked = await resolvePaymentEnv({ ...s.env, PAYMENTS_LOCKED: 'true' })
  assert.equal(locked.PAYMENTS_ENABLED, 'false')
  await assert.rejects(assertPaymentAllowed(locked, binding), (e: Failure) => e.code === 'payments_paused')
  assert.equal((await paymentView(locked)).ready_to_enable, false)
  await assert.rejects(assertPaymentAllowed(effective, { ...binding!, card_id: 456 }), (e: Failure) => e.code === 'payment_configuration_changed')
})
