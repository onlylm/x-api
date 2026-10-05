import {
  audit,
  booleanInt,
  constantEqual,
  fail,
  Failure,
  hmac,
  id,
  integer,
  readResponse,
  seal,
  secureEndpoint,
  sha256,
  text,
  unseal,
  type Env,
} from './core.ts'

const endpoints = {
  sandbox: 'https://sandbox.zovocard.com/openapi/v1',
  production: 'https://zovocard.com/openapi/v1',
} as const
interface Provider {
  environment: keyof typeof endpoints
  api_key: string
  app_id: string
  transport: 'direct' | 'gateway'
  writes_enabled: boolean
  revision: string
}
type Row = Record<string, unknown>
export async function cardConfiguration(env: Env) {
  const row = await env.DB.prepare(
    'SELECT environment,writes_enabled,revision,updated_at FROM card_provider WHERE id=1',
  ).first<Row>()
  if (!row)
    return {
      configured: false,
      environment: 'sandbox',
      writes_enabled: false,
      transport: env.CARD_DEFAULT_TRANSPORT ?? 'gateway',
      app_id: '',
      revision: null,
    }
  const provider = await configuration(env)
  return {
    configured: true,
    ...row,
    environment: provider.environment,
    revision: provider.revision,
    writes_enabled: !!row.writes_enabled,
    transport: provider.transport,
    app_id: provider.app_id,
  }
}
async function configuration(env: Env): Promise<Provider> {
  const row = await env.DB.prepare(
    'SELECT * FROM card_provider WHERE id=1',
  ).first<Row>()
  if (!row) return fail('card_provider_missing', '请先配置卡台 API。', 503)
  const secret = JSON.parse(
    await unseal(env, 'card-provider', String(row.payload)),
  )
  return {
    ...secret,
    environment: row.environment,
    writes_enabled: !!row.writes_enabled,
    revision: row.revision,
  }
}
export async function configureCards(env: Env, body: Row) {
  const environment = text(body.environment, '卡台环境', 16)
  if (!['sandbox', 'production'].includes(environment))
    fail('invalid_input', '请选择沙盒或正式环境。')
  const existing = await cardConfiguration(env)
  // Switching environments requires a new key; sandbox and production keys are isolated.
  const old = existing.configured ? await configuration(env) : null
  const api_key =
    body.api_key === '' && old?.environment === environment
      ? old.api_key
      : text(body.api_key, 'API 密钥', 256)
  const app_id = typeof body.app_id === 'string' ? body.app_id.trim() : ''
  const transport = body.transport ?? env.CARD_DEFAULT_TRANSPORT ?? 'gateway'
  if (!['direct', 'gateway'].includes(String(transport)))
    fail('invalid_input', '卡台出口方式无效。')
  if (
    !/^sk_[A-Za-z0-9_-]+$/.test(api_key) ||
    (app_id && !/^ak_[A-Za-z0-9_-]+$/.test(app_id))
  )
    fail('invalid_input', '密钥格式无效。')
  const writes = booleanInt(body.writes_enabled)
  const revision =
    old &&
    old.environment === environment &&
    old.api_key === api_key &&
    old.app_id === app_id &&
    old.transport === transport
      ? old.revision
      : id('cfg')
  const lock = `NOT EXISTS(SELECT 1 FROM orders WHERE status IN('queued','running','unknown'))
    AND NOT EXISTS(SELECT 1 FROM alipay_checkouts WHERE status IN('creating','pending','paid','attention'))
    AND NOT EXISTS(SELECT 1 FROM payment_settings WHERE enabled=1)`
  const changed = await env.DB.prepare(
    `INSERT INTO card_provider SELECT 1,?,?,?,?,? WHERE (${lock}) OR EXISTS(SELECT 1 FROM card_provider WHERE revision=?)
     ON CONFLICT(id) DO UPDATE SET environment=excluded.environment,payload=excluded.payload,writes_enabled=excluded.writes_enabled,revision=excluded.revision,updated_at=excluded.updated_at RETURNING id`,
  )
    .bind(
      environment,
      await seal(
        env,
        'card-provider',
        JSON.stringify({ api_key, app_id, transport }),
      ),
      writes,
      revision,
      Date.now(),
      revision,
    )
    .first()
  if (!changed) return fail('payment_orders_pending', '请先暂停付款并核对未结订单，再修改卡台连接配置。', 409)
  await audit(
    env,
    'admin',
    'configure_card_provider',
    environment,
    writes ? 'writes_enabled' : 'read_only',
  )
  return cardConfiguration(env)
}
class CardResponseError extends Error {
  code: string
  definitive: boolean
  constructor(code: string, definitive: boolean) {
    super('Card provider error')
    this.code = code
    this.definitive = definitive
  }
}
async function call(
  env: Env,
  provider: Provider,
  path: string,
  body?: Row,
  reference?: string,
) {
  const target = endpoints[provider.environment] + path
  const headers = {
    'X-API-Key': provider.api_key,
    ...(provider.app_id ? { 'X-App-Id': provider.app_id } : {}),
    ...(body
      ? { 'Content-Type': 'application/json', 'Idempotency-Key': reference! }
      : {}),
  }
  let response: Response
  if (provider.transport === 'gateway') {
    const endpoint = secureEndpoint(env.OUTBOUND_GATEWAY_URL)
    const gatewaySecret = env.OUTBOUND_GATEWAY_SECRET
    if (!gatewaySecret || gatewaySecret.length < 32)
      fail('card_gateway_missing', '固定出口网关尚未配置。', 503)
    const raw = JSON.stringify({
      url: target,
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : '',
    })
    const ts = String(Math.floor(Date.now() / 1000)),
      nonce = crypto.randomUUID(),
      route = '/v1/cards'
    response = await fetch(endpoint + route, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Timestamp': ts,
        'X-Nonce': nonce,
        'X-Signature': await hmac(
          gatewaySecret!,
          ['POST', route, ts, nonce, await sha256(raw)].join('\n'),
        ),
      },
      body: raw,
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    })
    const responseRaw = await readResponse(response, 524288)
    if (
      !constantEqual(
        response.headers.get('X-Response-Signature') ?? '',
        await hmac(
          gatewaySecret!,
          [ts, nonce, String(response.status), responseRaw].join('.'),
        ),
      )
    )
      throw new Error('Unverified gateway response')
    response = new Response(responseRaw, { status: response.status })
  } else
    response = await fetch(target, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    })
  const parsed = JSON.parse(await readResponse(response, 524288)) as Row
  if (!response.ok || parsed.code !== 0) {
    const code =
      typeof parsed.error_code === 'string' &&
      /^[a-z0-9_]{1,64}$/i.test(parsed.error_code)
        ? parsed.error_code
        : 'card_response_unconfirmed'
    // Only documented pre-charge rejections are definitive. A 400 with confirming text is ambiguous.
    const definitive =
      [400, 401, 403, 422, 503].includes(response.status) &&
      [
        'insufficient_balance',
        'channel_unavailable',
        'invalid_argument',
        'not_found',
        'forbidden',
        'RECHARGE_REQUIRED',
        'FORBIDDEN',
        'product_exclusive_access_required',
        'product_approval_required',
        'product_unavailable',
      ].includes(code)
    throw new CardResponseError(code, definitive)
  }
  if (body && response.status !== 200 && response.status !== 201)
    throw new CardResponseError('card_operation_pending', false)
  return parsed.data
}
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed card response')
  return value as Row
}
function rows(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Malformed card list')
  return value.map(object)
}
function safeString(value: unknown) {
  return typeof value === 'string'
    ? value.slice(0, 256).replace(/(?:\d[ -]?){12,19}/g, '[卡号已隐藏]')
    : null
}
function select(row: Row, keys: string[]) {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      typeof row[key] === 'string'
        ? safeString(row[key])
        : typeof row[key] === 'number' || typeof row[key] === 'boolean'
          ? row[key]
          : null,
    ]),
  )
}
function safeCard(row: Row) {
  const pan =
    typeof row.card_number === 'string'
      ? row.card_number.replace(/\D/g, '')
      : ''
  return {
    ...select(row, [
      'id',
      'issuer',
      'product_code',
      'product_name',
      'network',
      'issuing_area',
      'available_amount',
      'status',
      'created_at',
    ]),
    last_four: pan.length >= 4 ? pan.slice(-4) : '',
    restricted_merchants: Array.isArray(row.restricted_merchants)
      ? row.restricted_merchants.map(safeString)
      : [],
  }
}
export async function cardRead(
  env: Env,
  resource: string,
  page = 1,
  cardId?: number,
  options: { providerRevision?: string } = {},
) {
  const provider = await configuration(env)
  if (options.providerRevision !== undefined && options.providerRevision !== provider.revision)
    return fail('card_provider_changed', '卡台配置已变化，请刷新配置后重新获取列表。', 409)
  try {
    if (resource === 'card' && cardId)
      return safeCard(object(await call(env, provider, `/cards/${integer(cardId, '卡 ID')}?sync=1`)))
    if (resource === 'balance')
      return select(object(await call(env, provider, '/balance')), [
        'balance',
        'spendable_balance',
        'account_reserve_amount',
        'account_reserve_enabled',
        'minimum_deposit_amount',
        'currency',
      ])
    if (resource === 'products')
      return rows(await call(env, provider, '/products')).map((row) => ({
        ...select(row, [
          'product_code',
          'product_name',
          'issuer',
          'network',
          'issuing_area',
          'open_fee',
          'recharge_fee',
          'rtf_rate',
          'min_amount',
          'max_amount',
        ]),
        restricted_merchants: Array.isArray(row.restricted_merchants)
          ? row.restricted_merchants.map(safeString)
          : [],
      }))
    if (resource === 'cards') {
      integer(page, '页码', 1, 10000)
      const requestedAt = Date.now()
      const result = object(
        await call(env, provider, `/cards?page=${page}&page_size=30&sync=0`),
      )
      const list = rows(result.list).map(safeCard)
      const total = typeof result.total === 'string' && /^\d+$/.test(result.total) ? Number(result.total) : result.total
      if (!Number.isSafeInteger(total) || Number(total) < 0)
        throw new Error('Malformed card count')
      if ((await cardConfiguration(env)).revision !== provider.revision)
        return fail('card_provider_changed', '卡台配置已变化，已丢弃旧卡台的列表，请刷新后重试。', 409)
      return { total: Number(total), list, provider_revision: provider.revision,
        refresh: { mode: 'cached' as const, requested_at: requestedAt, completed_at: Date.now() } }
    }
    if (cardId && resource === 'transactions') {
      return rows(
        await call(
          env,
          provider,
          `/cards/${cardId}/transactions?page=${page}&page_size=30&sync=0`,
        ),
      ).map((row) =>
        select(row, [
          'auth_id',
          'auth_time',
          'auth_amount',
          'auth_currency',
          'settle_amount',
          'settle_currency',
          'status',
          'type',
          'merchant_name',
          'merchant_amount',
          'merchant_currency',
        ]),
      )
    }
    if (cardId && resource === 'recharges')
      return rows(await call(env, provider, `/cards/${cardId}/recharges`)).map(
        (row) =>
          select(row, [
            'id',
            'card_id',
            'amount',
            'fee',
            'status',
            'created_at',
          ]),
      )
    return fail('not_found', '卡台接口不存在。', 404)
  } catch (error) {
    if (error instanceof Failure) throw error
    if (error instanceof CardResponseError)
      return fail(error.code, '卡台请求未成功，请核对配置或稍后重查。', 502)
    return fail(
      'card_provider_unavailable',
      '卡台响应未确认，请稍后重查。',
      502,
    )
  }
}
/** Explicitly refetch the provider inventory. This is not an issuer-level sync;
 * the documented integration currently reads the provider's cached card data. */
export async function syncCardList(env: Env, body: Row, page = 1) {
  const providerRevision = text(body.provider_revision, '卡台配置版本', 64)
  return cardRead(env, 'cards', page, undefined, { providerRevision })
}
export async function cardWrite(
  env: Env,
  kind: 'open' | 'recharge',
  body: Row,
) {
  if (body.confirmation !== 'CHARGE')
    fail('confirmation_required', '请输入 CHARGE 确认卡台扣款。')
  const reference = text(body.reference, '操作凭证号', 128)
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(reference))
    fail('invalid_input', '操作凭证号需为 8–128 位字母、数字或 ._:-。')
  const amount = integer(body.amount_minor, '美元金额（分）', 1, 1000000)
  const cardId = kind === 'recharge' ? integer(body.card_id, '卡 ID') : null
  const product =
    kind === 'open' ? text(body.product_code, '卡产品代码', 64) : null
  const payload: Row =
    kind === 'open'
      ? {
          product_code: product,
          first_name: text(body.first_name, '名', 80),
          last_name: text(body.last_name, '姓', 80),
          init_amount: amount / 100,
        }
      : { card_id: cardId, amount: amount / 100 }
  if (kind === 'open' && body.max_transaction_usd_cents !== undefined) {
    const limit = integer(body.max_transaction_usd_cents, '卡片消费上限（美元分）', 1, 1000) / 100
    Object.assign(payload, { max_on_daily: limit, max_on_monthly: limit, max_on_percent: limit,
      transaction_limit: limit, transaction_limit_type: 'limited' })
  }
  const digest = await sha256(JSON.stringify({ kind, payload }))
  const existing = await env.DB.prepare(
    'SELECT * FROM card_operations WHERE reference=?',
  )
    .bind(reference)
    .first<Row>()
  if (existing) {
    if (existing.request_digest !== digest)
      fail('idempotency_conflict', '凭证号已用于其他操作。', 409)
    return publicOperation(existing)
  }
  const provider = await configuration(env)
  if (!provider.writes_enabled)
    fail(
      'card_writes_disabled',
      '卡台当前只读，请在配置中开启开卡／充值。',
      409,
    )
  if (provider.transport === 'gateway') {
    secureEndpoint(env.OUTBOUND_GATEWAY_URL)
    if (!env.OUTBOUND_GATEWAY_SECRET || env.OUTBOUND_GATEWAY_SECRET.length < 32)
      fail('card_gateway_missing', '固定出口网关尚未配置。', 503)
  }
  const operationId = id('cop'),
    now = Date.now()
  try {
    await env.DB.prepare(
      'INSERT INTO card_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        operationId,
        reference,
        digest,
        kind,
        cardId,
        product,
        amount,
        provider.environment,
        provider.revision,
        'submitting',
        null,
        now,
        now,
      )
      .run()
  } catch {
    const winner = await env.DB.prepare(
      'SELECT * FROM card_operations WHERE reference=?',
    )
      .bind(reference)
      .first<Row>()
    if (winner && winner.request_digest === digest)
      return publicOperation(winner)
    fail(
      'card_operation_conflict',
      '存在同凭证或同卡未确认操作，请先核对原操作。',
      409,
    )
  }
  let status = 'unknown',
    code: string | null = 'card_response_unconfirmed',
    newCard: number | null = null
  try {
    const result = await call(
      env,
      provider,
      kind === 'open' ? '/cards/open' : '/cards/recharge',
      payload,
      operationId,
    )
    if (kind === 'open') {
      const row = object(result)
      newCard = integer(row.id, '返回卡 ID')
      if (row.status !== 'ACTIVE' || row.product_code !== product)
        throw new Error('Unverified opened card')
    }
    status = 'succeeded'
    code = null
  } catch (error) {
    if (error instanceof CardResponseError) {
      code = error.code
      if (error.definitive) status = 'failed'
    }
  }
  await env.DB.prepare(
    "UPDATE card_operations SET status=?,failure_code=?,card_id=COALESCE(?,card_id),updated_at=? WHERE id=? AND status='submitting'",
  )
    .bind(status, code, newCard, Date.now(), operationId)
    .run()
  await audit(env, 'admin', 'card_' + kind, operationId, status)
  return publicOperation(
    (await env.DB.prepare('SELECT * FROM card_operations WHERE id=?')
      .bind(operationId)
      .first<Row>())!,
  )
}
/** Internal payment executor only. Never return this through an HTTP route or log it. */
export async function paymentCard(env: Env, cardId: number) {
  if (!env.LOCAL_EXECUTOR || env.PAYMENTS_ENABLED !== 'true')
    fail('execution_disabled', '自动支付未启用。', 503)
  const provider = await configuration(env)
  if (provider.environment !== 'production' || provider.transport !== 'direct')
    fail('invalid_configuration', '自动赠送需要正式卡台与固定服务器出口。', 503)
  return object(await call(env, provider, `/cards/${integer(cardId, '卡 ID')}?sync=1`))
}
function publicOperation(row: Row) {
  return Object.fromEntries(
    [
      'id',
      'reference',
      'kind',
      'card_id',
      'product_code',
      'amount_minor',
      'environment',
      'status',
      'failure_code',
      'created_at',
      'updated_at',
    ].map((key) => [key, row[key]]),
  )
}
export async function cardOperations(env: Env, offset: number) {
  return (
    await env.DB.prepare(
      'SELECT * FROM card_operations ORDER BY created_at DESC LIMIT 30 OFFSET ?',
    )
      .bind(offset)
      .all<Row>()
  ).results.map(publicOperation)
}
export async function resolveCardOperation(
  env: Env,
  operationId: string,
  body: Row,
) {
  if (body.confirmation !== 'RESOLVE')
    fail('confirmation_required', '请输入 RESOLVE 确认已在卡台核对。')
  const note = text(body.note, '卡台核对凭证与说明', 300)
  const status = String(body.status)
  if (!['succeeded', 'failed'].includes(status))
    fail('invalid_input', '请选择成功或明确未扣款。')
  const operation = await env.DB.prepare(
    'SELECT * FROM card_operations WHERE id=?',
  )
    .bind(operationId)
    .first<Row>()
  if (!operation) return fail('not_found', '操作不存在。', 404)
  const cardId =
    operation.kind === 'open' && status === 'succeeded'
      ? integer(body.card_id, '卡台实际生成的卡 ID')
      : (operation.card_id as number | null)
  const updated = await env.DB.prepare(
    "UPDATE card_operations SET status=?,failure_code='manually_verified',card_id=?,updated_at=? WHERE id=? AND (status='unknown' OR (status='submitting' AND created_at<=?)) RETURNING *",
  )
    .bind(status, cardId, Date.now(), operationId, Date.now() - 60000)
    .first<Row>()
  if (!updated)
    return fail(
      'cannot_resolve',
      '只能核对结果不明的操作；提交中需等待至少一分钟。',
      409,
    )
  await audit(
    env,
    'admin',
    'resolve_card_operation',
    operationId,
    status + ': ' + safeString(note),
  )
  return publicOperation(updated)
}
