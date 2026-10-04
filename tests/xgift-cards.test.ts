import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import {
  cardConfiguration,
  configureCards,
  cardRead,
  cardWrite,
  cardOperations,
  resolveCardOperation,
} from '../services/xgift/src/cards.ts'
import {
  hmac,
  sha256,
  type Env,
  type Statement,
  type Value,
} from '../services/xgift/src/core.ts'
import worker from '../services/xgift/src/index.ts'
type Context = Parameters<Parameters<typeof test>[1]>[0]
function setup(t: Context) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  for (const name of ['0001_platform', '0002_card_provider'])
    db.exec(
      readFileSync(
        new URL(`../services/xgift/migrations/${name}.sql`, import.meta.url),
        'utf8',
      ),
    )
  const env: Env = {
    MASTER_KEY: 'a'.repeat(64),
    ADMIN_PASSWORD: 'test-admin-password-123456789',
    ASSETS: { fetch: async () => new Response('asset') },
    DB: {
      prepare(sql) {
        let values: Value[] = []
        const statement: Statement = {
          bind(...v) {
            values = v
            return this
          },
          async first<T>() {
            return (db.prepare(sql).get(...values) ?? null) as T | null
          },
          async all<T>() {
            return { results: db.prepare(sql).all(...values) as T[] }
          },
          async run() {
            return db.prepare(sql).run(...values)
          },
        }
        return statement
      },
      async batch() {
        throw new Error('Not used')
      },
    },
  }
  return { env, db }
}
const config = {
  environment: 'sandbox',
  transport: 'direct',
  api_key: 'sk_dummy_test_not_real',
  app_id: 'ak_dummy_test',
  writes_enabled: false,
}
const recharge = {
  confirmation: 'CHARGE',
  reference: 'test-operation-001',
  card_id: 123,
  amount_minor: 2000,
}
function mock(t: Context, impl: typeof fetch) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  t.after(() => (globalThis.fetch = original))
}
test('configuration encrypts keys and retains only same-environment blank credentials', async (t) => {
  const { env, db } = setup(t)
  await configureCards(env, config)
  assert.doesNotMatch(
    JSON.stringify(db.prepare('SELECT * FROM card_provider').get()),
    /sk_dummy/,
  )
  assert.doesNotMatch(JSON.stringify(await cardConfiguration(env)), /sk_dummy/)
  await configureCards(env, { ...config, api_key: '', writes_enabled: true })
  assert.equal((await cardConfiguration(env)).writes_enabled, true)
  await assert.rejects(
    configureCards(env, { ...config, environment: 'production', api_key: '' }),
  )
  await assert.rejects(
    configureCards(env, { ...config, environment: 'toString' }),
  )
})
test('card lists and transaction metadata redact PAN/CVV; spendable balance stays separate', async (t) => {
  const { env } = setup(t)
  await configureCards(env, config)
  mock(t, async (target, init) => {
    assert.equal(new Headers(init?.headers).get('X-API-Key'), config.api_key)
    const path = new URL(String(target)).pathname
    const data = path.endsWith('/balance')
      ? {
          balance: 100,
          spendable_balance: 80,
          account_reserve_amount: 20,
          currency: 'USD',
        }
      : path.endsWith('/transactions')
        ? [{ auth_id: 'a1', merchant_name: 'X 4111111111111111', cvv: '123' }]
        : {
            total: 1,
            list: [
              {
                id: 123,
                card_number: '4111111111111111',
                cvv: '123',
                status: 'ACTIVE',
                payload: { secret: 'hidden' },
                product_name: 'PAN 4111111111111111',
              },
            ],
          }
    return Response.json({ code: 0, data })
  })
  const cards = (await cardRead(env, 'cards')) as {
    list: Record<string, unknown>[]
  }
  assert.equal(cards.list[0].last_four, '1111')
  assert.doesNotMatch(JSON.stringify(cards), /4111111111111111|cvv|hidden/)
  assert.doesNotMatch(
    JSON.stringify(await cardRead(env, 'transactions', 1, 123)),
    /4111111111111111|cvv/,
  )
  const balance = (await cardRead(env, 'balance')) as Record<string, unknown>
  assert.equal(balance.spendable_balance, 80)
  assert.equal(balance.balance, 100)
})
test('financial writes need switch, confirmation, integer cents and configured gateway', async (t) => {
  const { env, db } = setup(t)
  await configureCards(env, config)
  mock(t, async () => {
    assert.fail('must not contact provider')
  })
  await assert.rejects(cardWrite(env, 'recharge', recharge), /只读/)
  await configureCards(env, { ...config, writes_enabled: true })
  await assert.rejects(
    cardWrite(env, 'recharge', { ...recharge, confirmation: '' }),
  )
  await assert.rejects(
    cardWrite(env, 'recharge', { ...recharge, amount_minor: 10.2 }),
  )
  await configureCards(env, {
    ...config,
    transport: 'gateway',
    writes_enabled: true,
  })
  await assert.rejects(cardWrite(env, 'recharge', recharge))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM card_operations').get()?.n, 0)
})
test('concurrent/repeated topups dispatch once and bind reference to immutable amount', async (t) => {
  const { env } = setup(t)
  await configureCards(env, { ...config, writes_enabled: true })
  let count = 0
  mock(t, async (target, init) => {
    count++
    assert.match(
      String(target),
      /sandbox\.zovocard\.com\/openapi\/v1\/cards\/recharge$/,
    )
    assert.equal(JSON.parse(String(init?.body)).amount, 20)
    assert.match(
      new Headers(init?.headers).get('Idempotency-Key')!,
      /^cop_[a-f0-9]{32}$/,
    )
    return Response.json({ code: 0 })
  })
  await Promise.all([
    cardWrite(env, 'recharge', recharge),
    cardWrite(env, 'recharge', recharge),
  ])
  assert.equal((await cardWrite(env, 'recharge', recharge)).status, 'succeeded')
  assert.equal(count, 1)
  await assert.rejects(
    cardWrite(env, 'recharge', { ...recharge, amount_minor: 3000 }),
    /其他操作/,
  )
})
test('ambiguous 400 never resubmits and blocks new topup on same card', async (t) => {
  const { env } = setup(t)
  await configureCards(env, { ...config, writes_enabled: true })
  let count = 0
  mock(t, async () => {
    count++
    return Response.json(
      { code: 400, msg: '充值确认中 sk_should_never_leak' },
      { status: 400 },
    )
  })
  const result = await cardWrite(env, 'recharge', recharge)
  assert.equal(result.status, 'unknown')
  assert.doesNotMatch(JSON.stringify(result), /should_never_leak/)
  await cardWrite(env, 'recharge', recharge)
  await assert.rejects(
    cardWrite(env, 'recharge', {
      ...recharge,
      reference: 'test-operation-002',
    }),
    /未确认操作/,
  )
  assert.equal(count, 1)
})
test('timeout and 202 accepted preserve unknown; no blind replay', async (t) => {
  const { env } = setup(t)
  await configureCards(env, { ...config, writes_enabled: true })
  let count = 0
  mock(t, async () => {
    count++
    if (count === 1) throw new Error('lost response')
    return Response.json({ code: 0, data: { pending: true } }, { status: 202 })
  })
  assert.equal((await cardWrite(env, 'recharge', recharge)).status, 'unknown')
  await cardWrite(env, 'recharge', recharge)
  assert.equal(count, 1)
  assert.equal(
    (
      await cardWrite(env, 'recharge', {
        ...recharge,
        card_id: 124,
        reference: 'test-pending-002',
      })
    ).status,
    'unknown',
  )
})
test('known pre-charge rejection fails; HTTP 200 nonzero business code cannot succeed', async (t) => {
  const { env } = setup(t)
  await configureCards(env, { ...config, writes_enabled: true })
  let count = 0
  mock(t, async () =>
    ++count === 1
      ? Response.json(
          { code: 400, error_code: 'insufficient_balance' },
          { status: 400 },
        )
      : Response.json({ code: 404, msg: 'missing' }),
  )
  assert.equal((await cardWrite(env, 'recharge', recharge)).status, 'failed')
  assert.equal(
    (
      await cardWrite(env, 'recharge', {
        ...recharge,
        reference: 'second-ref-001',
      })
    ).status,
    'unknown',
  )
})
test('opened cards store only local ID; product and active state must match', async (t) => {
  const { env, db } = setup(t)
  await configureCards(env, { ...config, writes_enabled: true })
  mock(t, async () =>
    Response.json({
      code: 0,
      data: {
        id: 123,
        status: 'ACTIVE',
        product_code: 'P_TEST',
        card_number: '4111111111111111',
        cvv: '999',
        expire: '12/30',
      },
    }),
  )
  const result = await cardWrite(env, 'open', {
    confirmation: 'CHARGE',
    reference: 'open-card-test-001',
    product_code: 'P_TEST',
    first_name: 'Test',
    last_name: 'Owner',
    amount_minor: 2000,
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.card_id, 123)
  assert.doesNotMatch(
    JSON.stringify(db.prepare('SELECT * FROM card_operations').all()),
    /4111111111111111|999|12\/30|Test|Owner/,
  )
  assert.equal((await cardOperations(env, 0)).length, 1)
})
test('gateway request/response signatures bind body and upstream HTTP status', async (t) => {
  const { env } = setup(t)
  env.OUTBOUND_GATEWAY_URL = 'https://gateway.example.test'
  env.OUTBOUND_GATEWAY_SECRET = 'test-gateway-secret-123456789012345'
  await configureCards(env, { ...config, transport: 'gateway' })
  let tamper = false
  mock(t, async (url, init) => {
    assert.equal(String(url), 'https://gateway.example.test/v1/cards')
    const headers = new Headers(init?.headers),
      ts = headers.get('X-Timestamp')!,
      nonce = headers.get('X-Nonce')!,
      raw = String(init?.body)
    assert.equal(
      headers.get('X-Signature'),
      await hmac(
        env.OUTBOUND_GATEWAY_SECRET!,
        ['POST', '/v1/cards', ts, nonce, await sha256(raw)].join('\n'),
      ),
    )
    assert.equal(JSON.parse(raw).method, 'GET')
    const responseRaw = JSON.stringify({
      code: 0,
      data: { balance: 50, spendable_balance: 30 },
    })
    return new Response(responseRaw, {
      headers: {
        'X-Response-Signature': tamper
          ? 'bad'
          : await hmac(
              env.OUTBOUND_GATEWAY_SECRET!,
              [ts, nonce, '200', responseRaw].join('.'),
            ),
      },
    })
  })
  assert.equal(
    ((await cardRead(env, 'balance')) as Record<string, unknown>)
      .spendable_balance,
    30,
  )
  tamper = true
  await assert.rejects(cardRead(env, 'balance'), /未确认/)
})
test('card admin routes require session and same-origin writes and never return API secret', async (t) => {
  const { env } = setup(t)
  const request = (
    path: string,
    body?: unknown,
    cookie = '',
    origin = 'https://x-api.gptibo.com',
  ) =>
    worker.fetch(
      new Request('https://x-api.gptibo.com' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
    )
  assert.equal((await request('/api/admin/card-provider')).status, 401)
  const login = await request('/api/login', {
      email: 'admin',
      password: env.ADMIN_PASSWORD,
    }),
    cookie = login.headers.get('Set-Cookie')!.split(';')[0]
  assert.equal(
    (
      await request(
        '/api/admin/card-provider',
        config,
        cookie,
        'https://attacker.test',
      )
    ).status,
    403,
  )
  assert.equal(
    (await request('/api/admin/card-provider', config, cookie)).status,
    200,
  )
  const result = await request('/api/admin/card-provider', undefined, cookie)
  assert.equal(result.status, 200)
  assert.doesNotMatch(await result.text(), /sk_dummy/)
})
test('unknown opening blocks new opening; manual verification cannot change terminal operations', async (t) => {
  const { env } = setup(t)
  await configureCards(env, { ...config, writes_enabled: true })
  let count = 0
  mock(t, async () => {
    count++
    throw new Error('unknown')
  })
  const body = {
    confirmation: 'CHARGE',
    reference: 'open-ref-001',
    product_code: 'TEST',
    first_name: 'Test',
    last_name: 'Test',
    amount_minor: 1000,
  }
  const first = await cardWrite(env, 'open', body)
  await assert.rejects(
    cardWrite(env, 'open', { ...body, reference: 'open-ref-002' }),
  )
  assert.equal(count, 1)
  await assert.rejects(
    resolveCardOperation(env, String(first.id), {
      confirmation: '',
      status: 'failed',
      note: 'receipt checked',
    }),
  )
  await assert.rejects(
    resolveCardOperation(env, String(first.id), {
      confirmation: 'RESOLVE',
      status: 'succeeded',
      note: 'receipt checked',
    }),
  )
  const result = await resolveCardOperation(env, String(first.id), {
    confirmation: 'RESOLVE',
    status: 'succeeded',
    card_id: 321,
    note: 'card provider receipt test-001',
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.card_id, 321)
  await assert.rejects(
    resolveCardOperation(env, String(first.id), {
      confirmation: 'RESOLVE',
      status: 'failed',
      note: 'cannot change final',
    }),
  )
  assert.equal(count, 1)
})
