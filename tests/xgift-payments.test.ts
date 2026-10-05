import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { database } from '../services/xgift/server/database.ts'
import { createUser } from '../services/xgift/src/auth.ts'
import { cardConfiguration, configureCards } from '../services/xgift/src/cards.ts'
import { seal, type Env, type Failure } from '../services/xgift/src/core.ts'
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
    returnedId: null as number | null, unavailable: false, onCardRead: undefined as ((cardId: number) => Promise<void>) | undefined,
    cardOverrides: new Map<number, Partial<{ balance: number; status: string; pan: string; returnedId: number; unavailable: boolean }>>(),
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
    const cardId = Number(url.pathname.split('/').at(-1))
    const card = { ...state, ...state.cardOverrides.get(cardId) }
    if (card.unavailable) throw new Error('fixture provider unavailable')
    await state.onCardRead?.(cardId)
    return Response.json({ code: 0, data: {
      id: card.returnedId ?? cardId, product_code: 'EXISTING-CARD',
      network: 'VISA', status: card.status, available_amount: card.balance,
      card_number: card.pan, cvv: '321', expire: '12/30', first_name: 'Private',
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

test('payment configuration accepts the card ID string sent by the admin form and reloads a numeric binding without payment side effects', async t => {
  const s = await fixture(t)
  const saved = await s.request('/api/admin/payments/config', await s.configurationBody({ card_id: '123' }), s.cookie)
  assert.equal(saved.status, 200)
  const view = (await saved.json()).data
  assert.equal(view.selected_card.id, 123)
  assert.equal(view.enabled, false)
  assert.equal(view.execution_ready, false)
  assert.equal(view.accepts_orders, false)
  assert.deepEqual(s.state.calls, ['GET /openapi/v1/cards/123'])

  const settings = await paymentSettings(s.env)
  assert.equal(settings?.card_id, 123)
  assert.equal(settings?.selected_card?.id, 123)
  assert.equal(settings?.enabled, false)
  const reloaded = await s.request('/api/admin/payments', undefined, s.cookie)
  assert.equal(reloaded.status, 200)
  const reloadedView = (await reloaded.json()).data
  assert.equal(reloadedView.selected_card.id, 123)
  assert.equal(reloadedView.revision, view.revision)
  assert.equal(reloadedView.enabled, false)
  const effective = await resolvePaymentEnv({ ...s.env, PAYMENT_SETTINGS: undefined })
  assert.equal(effective.PAYMENT_SETTINGS?.card_id, 123)
  assert.equal(effective.PAYMENTS_ENABLED, 'false')
  await assert.rejects(paymentBinding(effective), (e: Failure) => e.code === 'payments_paused')

  // Enable only the in-memory fixture to verify the saved ID can form a runtime binding.
  await s.enable()
  const binding = await paymentBinding(await resolvePaymentEnv(s.env))
  assert.equal(binding?.card_id, 123)
  assert.equal(binding?.revision, view.revision)
  assert.deepEqual(s.state.calls, ['GET /openapi/v1/cards/123', 'GET /openapi/v1/cards/123'])
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM card_operations').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM native_funding').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(s.state.executions, 0)
})

test('payment configuration accepts canonical decimal card ID strings and retains numeric boundary compatibility', async t => {
  const s = await fixture(t)
  for (const cardId of ['1', '1000000000', 1, 123, 1000000000]) {
    const saved = await s.request('/api/admin/payments/config', await s.configurationBody({ card_id: cardId }), s.cookie)
    assert.equal(saved.status, 200, `card_id=${JSON.stringify(cardId)}`)
    const view = (await saved.json()).data
    assert.equal(view.selected_card.id, Number(cardId))
    assert.equal(view.enabled, false)
    assert.equal((await paymentSettings(s.env))?.card_id, Number(cardId))
    assert.equal(s.state.calls.at(-1), `GET /openapi/v1/cards/${Number(cardId)}`)
  }
  assert.equal(s.state.calls.length, 5)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM card_operations').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM native_funding').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(s.state.executions, 0)
})

test('payment configuration rejects malformed card IDs before provider access or persistence', async t => {
  const s = await fixture(t)
  const invalidCardIds = [
    '', ' ', '\t\n', ' 123', '123 ', '0', '00', '0123', '+123', '-1', '1.5', '123.0',
    '1e2', '1E2', '0x7b', 'NaN', 'Infinity', '1000000001', '9999999999', '10000000000',
    '123/../../orders', '123?sync=0', '123#fragment', '123\n',
    0, -1, 1.5, 1000000001, null, true, false, [], [123], {}, { id: 123 }, undefined,
  ]
  for (const cardId of invalidCardIds) {
    const response = await s.request('/api/admin/payments/config', await s.configurationBody({ card_id: cardId }), s.cookie)
    const label = `card_id=${JSON.stringify(cardId)}`
    assert.equal(response.status, 400, label)
    assert.equal((await response.json()).error.code, 'invalid_input', label)
    assert.equal(await paymentSettings(s.env), null, label)
    assert.equal(s.state.calls.length, 0, label)
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM payment_settings').get()!.n, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='configure_payments'").get()!.n, 0)
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

test('up to three ordered backup cards are verified read-only, encrypted and frozen in the payment binding', async t => {
  const s = await fixture(t)
  const saved = await s.save({ backup_card_ids: [456, 789, 999] })
  assert.deepEqual(saved.backup_card_ids, [456, 789, 999])
  assert.deepEqual(saved.backup_cards.map(card => card.id), [456, 789, 999])
  assert.equal(saved.selected_card?.id, 123)
  assert.equal(saved.enabled, false)
  assert.equal(saved.checks.find(check => check.code === 'backup_cards')?.ok, true)
  assert.deepEqual(s.state.calls.slice().sort(), [123, 456, 789, 999].map(id => 'GET /openapi/v1/cards/' + id))
  assert.doesNotMatch(JSON.stringify(saved), /4242424242424242|cvv|expire|private-provider/)
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM payment_settings').get()), /backup_cards|backup_card_ids|pk_live/)
  await s.enable()
  assert.equal(s.state.calls.length, 8, 'Enabling must recheck the primary and all backups')
  const binding = await paymentBinding(await resolvePaymentEnv(s.env))
  assert.equal(binding?.card_id, 123)
  assert.deepEqual(binding?.backup_card_ids, [456, 789, 999])
  assert.equal((await paymentSettings(s.env))?.card_id, 123)
  await assert.rejects(s.save({ backup_card_ids: [] }), (e: Failure) => e.code === 'payments_must_be_paused')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM card_operations').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM native_funding').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
  assert.equal(s.state.executions, 0)
})

test('backup verification is parallel and bounded to the primary plus three candidates', { timeout: 5000 }, async t => {
  const s = await fixture(t)
  let inFlight = 0, maximum = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  s.state.onCardRead = async () => {
    inFlight++; maximum = Math.max(maximum, inFlight)
    if (inFlight === 4) release()
    await gate
    inFlight--
  }
  await s.save({ backup_card_ids: [456, 789, 999] })
  assert.equal(maximum, 4)
  assert.equal(s.state.calls.length, 4)
})

test('legacy payloads and bindings have no implicit backup cards', async t => {
  const s = await fixture(t)
  await s.save()
  const { backup_card_ids: _ids, backup_cards: _cards, ...legacy } = (await paymentSettings(s.env))!
  s.db.prepare('UPDATE payment_settings SET payload=? WHERE id=1').run(await seal(s.env, 'payment-settings', JSON.stringify(legacy)))
  assert.deepEqual((await paymentSettings(s.env))?.backup_card_ids, [])
  assert.deepEqual((await paymentView(s.env)).backup_cards, [])
  await s.enable()
  const effective = await resolvePaymentEnv(s.env)
  const { backup_card_ids: _snapshotIds, ...binding } = (await paymentBinding(effective))!
  await assertPaymentAllowed(effective, binding)
  assert.equal((await paymentSettings(s.env))?.card_id, 123)
})

test('omitted backup IDs preserve prior authorization and an explicit empty array clears it', async t => {
  const s = await fixture(t)
  await s.save({ backup_card_ids: [456, 789] })
  const preserved = await s.save({ stripe_publishable_key: 'pk_live_changedfixture' })
  assert.deepEqual(preserved.backup_card_ids, [456, 789])
  await assert.rejects(s.save({ card_id: 456 }), (e: Failure) => e.code === 'invalid_input')
  assert.deepEqual((await paymentSettings(s.env))?.backup_card_ids, [456, 789])
  const cleared = await s.save({ backup_card_ids: [] })
  assert.deepEqual(cleared.backup_card_ids, [])
  assert.deepEqual(cleared.backup_cards, [])
  assert.equal(cleared.enabled, false)
})

test('malformed, duplicated or excessive backup IDs fail before any provider request', async t => {
  const s = await fixture(t)
  for (const backupIds of [null, '456', ['456'], [123], [456, 456], [456, 789, 999, 1000], [0], [-1], [1.5], [1000000001], [{}], [undefined]]) {
    const calls = s.state.calls.length
    await assert.rejects(s.save({ backup_card_ids: backupIds }), (e: Failure) => e.code === 'invalid_input')
    assert.equal(s.state.calls.length, calls)
    assert.equal(await paymentSettings(s.env), null)
  }
})

test('a changed provider cannot implicitly inherit backup card identities from an older admin client', async t => {
  const s = await fixture(t)
  await s.save({ backup_card_ids: [456] })
  await configureCards(s.env, { environment: 'production', transport: 'direct', api_key: 'sk_changed_provider_fixture', writes_enabled: false })
  const calls = s.state.calls.length
  await assert.rejects(s.save(), (e: Failure) => e.code === 'payment_provider_changed')
  assert.equal(s.state.calls.length, calls)
  assert.deepEqual((await paymentSettings(s.env))?.backup_card_ids, [456])
  const cleared = await s.save({ backup_card_ids: [] })
  assert.deepEqual(cleared.backup_card_ids, [])
  assert.equal(cleared.enabled, false)
})

test('an unavailable or unready backup cannot be saved or enabled and never changes the primary binding', async t => {
  const s = await fixture(t)
  for (const patch of [{ balance: 9.99 }, { status: 'FROZEN' }, { pan: '' }, { returnedId: 999 }, { unavailable: true }]) {
    s.state.cardOverrides.set(456, patch)
    await assert.rejects(s.save({ backup_card_ids: [456] }), (e: Failure) => ['payment_card_not_ready', 'card_provider_unavailable'].includes(e.code))
    assert.equal(await paymentSettings(s.env), null)
  }
  s.state.cardOverrides.clear()
  const saved = await s.save({ backup_card_ids: [456] })
  s.state.cardOverrides.set(456, { balance: 9.99 })
  await assert.rejects(s.enable(), (e: Failure) => e.code === 'payment_card_not_ready')
  const current = (await paymentSettings(s.env))!
  assert.equal(current.enabled, false)
  assert.equal(current.card_id, 123)
  assert.equal(current.revision, saved.revision)
  assert.deepEqual(current.backup_card_ids, [456])
  assert.equal(s.state.executions, 0)
})

test('provider changes and emergency pauses win races during backup verification', async t => {
  const s = await fixture(t)
  s.state.onCardRead = async cardId => {
    if (cardId !== 456) return
    s.state.onCardRead = undefined
    await configureCards(s.env, { environment: 'production', transport: 'direct', api_key: 'sk_new_fixture_provider', writes_enabled: false })
  }
  await assert.rejects(s.save({ backup_card_ids: [456] }), (e: Failure) => e.code === 'payment_provider_changed')
  assert.equal(await paymentSettings(s.env), null)
  await s.save({ backup_card_ids: [456] })
  s.state.onCardRead = async cardId => {
    if (cardId !== 456) return
    s.state.onCardRead = undefined
    await setPaymentsEnabled(s.env, { enabled: false })
  }
  await assert.rejects(s.enable(), (e: Failure) => e.code === 'payment_config_conflict')
  assert.equal((await paymentSettings(s.env))?.enabled, false)
  assert.deepEqual((await paymentSettings(s.env))?.backup_card_ids, [456])
})

test('frozen backup authorization must exactly match the configured ordered candidate list', async t => {
  const s = await fixture(t)
  await s.save({ backup_card_ids: [456, 789] }); await s.enable()
  const effective = await resolvePaymentEnv(s.env), binding = (await paymentBinding(effective))!
  await assertPaymentAllowed(effective, binding)
  for (const backups of [undefined, [], [456], [789, 456], [456, 789, 999]])
    await assert.rejects(assertPaymentAllowed(effective, { ...binding, backup_card_ids: backups }),
      (e: Failure) => e.code === 'payment_configuration_changed')
  await setPaymentsEnabled(s.env, { enabled: false })
  await s.enable()
  await assertPaymentAllowed(await resolvePaymentEnv(s.env), binding)
  assert.equal((await paymentSettings(s.env))?.card_id, 123)
})
