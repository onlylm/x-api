import {
  fail,
  hmac,
  integer,
  readResponse,
  seal,
  secureEndpoint,
  sha256,
  text,
  unseal,
  type Env,
} from './core.ts'
const publicBearer =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
export async function saveSecret(
  env: Env,
  secretId: string,
  kind: string,
  body: Record<string, unknown>,
) {
  const name = text(body.name, '名称', 80)
  let payload: Record<string, unknown>
  if (kind === 'proxy') {
    const host = text(body.host, '代理地址', 253),
      port = integer(body.port, '端口', 1, 65535)
    if (
      !/^[A-Za-z0-9.-]+$/.test(host) ||
      !['http', 'socks5'].includes(String(body.protocol))
    )
      fail('invalid_input', '代理协议或主机格式无效。')
    payload = {
      protocol: body.protocol,
      host,
      port,
      username: typeof body.username === 'string' ? body.username : '',
      password: typeof body.password === 'string' ? body.password : '',
    }
  } else if (kind === 'account') {
    const auth = text(body.auth_token, 'auth_token', 512),
      csrf = text(body.ct0, 'ct0', 512),
      proxyId = body.proxy_id ? text(body.proxy_id, '代理编号', 64) : null
    if (/[\s;\r\n]/.test(auth + csrf))
      fail('invalid_input', 'Cookie 格式无效。')
    if (
      proxyId &&
      !(await env.DB.prepare(
        "SELECT id FROM secrets WHERE id=? AND kind='proxy' AND enabled=1",
      )
        .bind(proxyId)
        .first())
    )
      fail('invalid_input', '请选择有效代理。')
    payload = {
      auth_token: auth,
      ct0: csrf,
      proxy_id: proxyId,
      daily_limit: integer(body.daily_limit ?? 300, '每日上限', 1, 300),
    }
  } else return fail('invalid_input', '配置类型无效。')
  const cipher = await seal(env, 'secret:' + secretId, JSON.stringify(payload))
  await env.DB.prepare(
    'INSERT INTO secrets VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,payload=excluded.payload,updated_at=excluded.updated_at WHERE secrets.kind=excluded.kind',
  )
    .bind(secretId, kind, name, cipher, Date.now())
    .run()
  return { id: secretId, name, kind }
}
export async function updateAccountLimit(
  env: Env,
  accountId: string,
  value: unknown,
) {
  const limit = integer(value, '每日上限', 1, 300)
  const row = await env.DB.prepare(
    "SELECT payload FROM secrets WHERE id=? AND kind='account'",
  )
    .bind(accountId)
    .first<{ payload: string }>()
  if (!row) return fail('not_found', '账号不存在。', 404)
  const payload = JSON.parse(
    await unseal(env, 'secret:' + accountId, row.payload),
  )
  payload.daily_limit = limit
  const cipher = await seal(env, 'secret:' + accountId, JSON.stringify(payload))
  const changed = await env.DB.prepare(
    "UPDATE secrets SET payload=?,updated_at=? WHERE id=? AND kind='account' AND payload=? RETURNING id",
  )
    .bind(cipher, Date.now(), accountId, row.payload)
    .first()
  if (!changed) fail('conflict', '账号配置刚被更新，请刷新后重试。', 409)
  return { saved: true, daily_limit: limit }
}
export async function secretList(env: Env) {
  const rows = (
    await env.DB.prepare('SELECT * FROM secrets ORDER BY updated_at DESC').all<{
      id: string
      kind: string
      name: string
      enabled: number
      payload: string
      updated_at: number
    }>()
  ).results
  return Promise.all(
    rows.map(async (row) => {
      const p = JSON.parse(await unseal(env, 'secret:' + row.id, row.payload))
      return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        enabled: row.enabled,
        updated_at: row.updated_at,
        ...(row.kind === 'proxy'
          ? {
              protocol: p.protocol,
              host: p.host,
              port: p.port,
              has_auth: !!p.username,
            }
          : { proxy_id: p.proxy_id, daily_limit: p.daily_limit }),
      }
    }),
  )
}
export async function outbound(
  env: Env,
  proxy: Record<string, unknown> | null,
  target: string,
  headers: Record<string, string> = {},
  init?: { method?: string; body?: string },
) {
  if (!proxy)
    return fetch(target, {
      headers,
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    })
  if (env.OUTBOUND_FETCH) return env.OUTBOUND_FETCH(target, headers, proxy, init)
  if (init?.method === 'POST') fail('proxy_gateway_missing', '此操作需要服务器原生代理。', 503)
  if (!env.OUTBOUND_GATEWAY_URL || !env.OUTBOUND_GATEWAY_SECRET)
    fail(
      'proxy_gateway_missing',
      '代理已保存。出口网关尚未配置，不能使用该代理执行检测。',
      503,
    )
  const raw = JSON.stringify({ url: target, headers, proxy }),
    ts = String(Math.floor(Date.now() / 1000)),
    nonce = crypto.randomUUID()
  return fetch(secureEndpoint(env.OUTBOUND_GATEWAY_URL) + '/v1/request', {
    method: 'POST',
    body: raw,
    redirect: 'manual',
    signal: AbortSignal.timeout(25000),
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': ts,
      'X-Nonce': nonce,
      'X-Signature': await hmac(
        env.OUTBOUND_GATEWAY_SECRET!,
        ['POST', '/v1/request', ts, nonce, await sha256(raw)].join('\n'),
      ),
    },
  })
}
export async function secret(env: Env, secretId: string, kind: string) {
  const row = await env.DB.prepare(
    'SELECT payload FROM secrets WHERE id=? AND kind=? AND enabled=1',
  )
    .bind(secretId, kind)
    .first<{ payload: string }>()
  if (!row) return fail('not_found', '配置不存在或已停用。', 404)
  return JSON.parse(
    await unseal(env, 'secret:' + secretId, row.payload),
  ) as Record<string, unknown>
}
export function normalizeRecipient(value: unknown) {
  const username = text(value, 'X 用户名', 16).replace(/^@/, '').toLowerCase()
  if (!/^[a-z0-9_]{1,15}$/.test(username))
    fail('invalid_input', '请填写 1–15 位 X 用户名，不是显示名称。')
  return username
}
export async function xQuery(
  env: Env, account: Record<string, unknown>, proxy: Record<string, unknown> | null,
  operation: string, queryId: string, variables: Record<string, string>, mutation = false,
) {
  const url = new URL(`https://x.com/i/api/graphql/${queryId}/${operation}`)
  const features = { subscriptions_marketing_page_fetch_promotions: true }
  if (!mutation) {
    url.searchParams.set('variables', JSON.stringify(variables))
    url.searchParams.set('features', JSON.stringify(features))
  }
  const response = await outbound(env, proxy, url.href, {
    Authorization: env.X_BEARER ?? publicBearer,
    Cookie: `auth_token=${account.auth_token}; ct0=${account.ct0}`,
    'X-Csrf-Token': String(account.ct0), 'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Active-User': 'yes', 'X-Twitter-Client-Language': 'en',
    'Content-Type': 'application/json', Origin: 'https://x.com',
    Referer: 'https://x.com/', 'User-Agent': 'Mozilla/5.0', Accept: 'application/json',
  }, mutation ? { method: 'POST', body: JSON.stringify({ variables, features, queryId }) } : undefined)
  if (!response.ok) fail('x_query_failed', `X 查询失败（HTTP ${response.status}）。`, 503)
  const result = JSON.parse(await readResponse(response))
  if (result.errors?.length || !result.data) fail('x_query_failed', 'X 查询结果暂未确认。', 503)
  return result.data
}
export async function accountEligibility(
  env: Env, account: Record<string, unknown>, proxy: Record<string, unknown> | null, value: unknown,
) {
  const username = normalizeRecipient(value)
  const data = await xQuery(env, account, proxy, 'PremiumGiftingQuery', 'kn8hCE6bHstQV2MtfYDTKg', { screenName: username })
  const user = data.user?.result
  if (data.user === null || user === null || user?.__typename === 'UserUnavailable') return { username, eligible: false, reason: 'user_not_found', checked_at: Date.now() }
  if (!user?.rest_id) return fail('x_query_failed', 'X 查询结果不完整，请稍后再试。', 503)
  if (!/^\d{1,25}$/.test(user.rest_id) || user.core?.screen_name?.toLowerCase() !== username || typeof user.premium_gifting_eligible !== 'boolean')
    fail('x_query_failed', '无法核实接收账号身份与赠送资格。', 503)
  return { username, recipient_id: user.rest_id as string, eligible: user.premium_gifting_eligible as boolean,
    reason: user.premium_gifting_eligible ? null : 'not_eligible', checked_at: Date.now() }
}
export async function eligibility(env: Env, value: unknown) {
  normalizeRecipient(value)
  const account = await env.DB.prepare("SELECT id FROM secrets WHERE kind='account' AND enabled=1 ORDER BY updated_at LIMIT 1").first<{ id: string }>()
  if (!account) return fail('no_account', '暂无可用赠送账号。', 503)
  const config = await secret(env, account.id, 'account')
  const proxy = config.proxy_id ? await secret(env, String(config.proxy_id), 'proxy') : null
  return accountEligibility(env, config, proxy, value)
}
export async function proxyTest(env: Env, proxyId: string) {
  const response = await outbound(
    env,
    await secret(env, proxyId, 'proxy'),
    'https://ipinfo.io/json',
  )
  if (!response.ok) return fail('upstream_failed', '出口检测失败。', 502)
  const value = JSON.parse(await readResponse(response))
  if (typeof value.ip !== 'string' || typeof value.country !== 'string')
    fail('upstream_failed', '出口检测响应无效。', 502)
  return {
    ip: value.ip,
    country: value.country,
    region: value.region,
    checked_at: Date.now(),
  }
}
export async function quote(env: Env, accountId: string, productCode: unknown) {
  const account = await secret(env, accountId, 'account'),
    proxy = account.proxy_id
      ? await secret(env, String(account.proxy_id), 'proxy')
      : null
  const product = await env.DB.prepare('SELECT * FROM products WHERE code=?')
    .bind(text(productCode, '商品代码', 64))
    .first<{ stripe_product: string; currency: string; amount_minor: number }>()
  if (!product) return fail('not_found', '商品不存在。', 404)
  const target = new URL(
    'https://x.com/i/api/graphql/Se1Bp6zcNnuXYXRecV2qLA/useSubscriptionProductDetailsByRestIdQuery',
  )
  target.searchParams.set(
    'variables',
    JSON.stringify({ stripeId: product.stripe_product }),
  )
  target.searchParams.set(
    'features',
    JSON.stringify({ subscriptions_marketing_page_fetch_promotions: true }),
  )
  const response = await outbound(env, proxy, target.href, {
    Authorization: env.X_BEARER ?? publicBearer,
    Cookie: `auth_token=${account.auth_token}; ct0=${account.ct0}`,
    'X-Csrf-Token': String(account.ct0),
    'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Client-Language': 'en',
    Referer: 'https://x.com/',
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json',
  })
  if (!response.ok)
    return fail(
      'x_query_failed',
      `X 报价查询失败（HTTP ${response.status}）。`,
      502,
    )
  const value = JSON.parse(await readResponse(response)),
    p = value.data?.web_subscription_product_details_by_rest_id
  if (
    value.errors?.length ||
    p?.rest_id !== product.stripe_product ||
    !Array.isArray(p.prices) ||
    p.prices.length !== 1
  )
    return fail('x_query_failed', 'X 商品报价响应无效。', 502)
  const price = p.prices[0]
  if (
    typeof price.currency_code !== 'string' ||
    !Number.isSafeInteger(price.amount_local_micro) ||
    price.price_type !== 'OneTime'
  )
    fail('x_query_failed', 'X 返回的价格类型无效。', 502)
  return {
    currency: price.currency_code.toLowerCase(),
    amount: price.amount_local_micro / 1000000,
    matches_expected:
      price.currency_code.toLowerCase() === product.currency &&
      price.amount_local_micro === product.amount_minor * 10000,
    uses_proxy: !!proxy,
    checked_at: Date.now(),
  }
}
