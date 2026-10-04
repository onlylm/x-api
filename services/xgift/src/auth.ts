import { signature } from '../../../shared/xgift-signature.ts'
import {
  booleanInt,
  constantEqual,
  fail,
  id,
  json,
  limit,
  passwordHash,
  seal,
  sha256,
  text,
  token,
  unseal,
  type Env,
} from './core.ts'
export interface Principal {
  role: 'admin' | 'user'
  userId: string | null
}
const cookieName = (request: Request) =>
  new URL(request.url).protocol === 'https:' ? '__Host-xgift' : 'xgift_dev'
const cookie = (request: Request, value: string, seconds: number) =>
  `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`
const adminVersion = (env: Env) =>
  sha256('admin:' + env.ADMIN_PASSWORD + ':' + env.MASTER_KEY)
export async function session(request: Request, env: Env): Promise<Principal> {
  const value = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName(request) + '='))
    ?.split('=')[1]
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    return fail('unauthorized', '请先登录。', 401)
  const row = await env.DB.prepare(
    'SELECT s.*,u.enabled,u.password_hash FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',
  )
    .bind(await sha256(value), Date.now())
    .first<{
      role: 'admin' | 'user'
      user_id: string | null
      version: string
      enabled: number
      password_hash: string
    }>()
  if (
    !row ||
    (row.role === 'admin'
      ? row.version !== (await adminVersion(env))
      : !row.enabled || row.version !== row.password_hash)
  )
    return fail('unauthorized', '登录已过期或账户已停用。', 401)
  return { role: row.role, userId: row.user_id }
}
export async function login(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  await limit(
    env,
    'login-ip:' +
      (await sha256(request.headers.get('CF-Connecting-IP') ?? 'local')),
    10,
    900000,
  )
  const name = text(body.email, '邮箱或管理员名称', 254).toLowerCase(),
    password = text(body.password, '密码', 256)
  await limit(env, 'login-account:' + (await sha256(name)), 20, 900000)
  let principal: Principal, version: string
  if (name === 'admin') {
    if ((env.ADMIN_PASSWORD?.length ?? 0) < 24)
      return fail('not_configured', '管理员密码尚未初始化。', 503)
    if (
      !constantEqual(await sha256(password), await sha256(env.ADMIN_PASSWORD))
    )
      return fail('unauthorized', '账号或密码错误。', 401)
    principal = { role: 'admin', userId: null }
    version = await adminVersion(env)
  } else {
    const user = await env.DB.prepare(
      'SELECT id,password_hash,salt,enabled FROM users WHERE email=?',
    )
      .bind(name)
      .first<{
        id: string
        password_hash: string
        salt: string
        enabled: number
      }>()
    const actual = await passwordHash(
      password,
      user?.salt ?? 'unregistered-account-salt',
    )
    if (!user?.enabled || !constantEqual(actual, user.password_hash))
      return fail('unauthorized', '账号或密码错误。', 401)
    principal = { role: 'user', userId: user.id }
    version = user.password_hash
  }
  const value = token()
  await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)')
    .bind(
      await sha256(value),
      principal.userId,
      principal.role,
      version,
      Date.now() + 86400000,
    )
    .run()
  return json(principal, 200, { 'Set-Cookie': cookie(request, value, 86400) })
}
export async function logout(request: Request, env: Env) {
  const value = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName(request) + '='))
    ?.split('=')[1]
  if (value)
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?')
      .bind(await sha256(value))
      .run()
  return json({ loggedOut: true }, 200, {
    'Set-Cookie': cookie(request, '', 0),
  })
}
export async function createUser(env: Env, body: Record<string, unknown>) {
  const email = text(body.email, '邮箱', 254).toLowerCase(),
    name = text(body.name, '名称', 80),
    password = text(body.password, '初始密码', 256)
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email === 'admin' ||
    password.length < 12
  )
    fail('invalid_input', '请填写有效邮箱及至少 12 位的密码。')
  const salt = token(),
    userId = id('usr')
  await env.DB.prepare(
    'INSERT INTO users(id,name,email,password_hash,salt,created_at) VALUES(?,?,?,?,?,?)',
  )
    .bind(
      userId,
      name,
      email,
      await passwordHash(password, salt),
      salt,
      Date.now(),
    )
    .run()
  return { id: userId, email, name }
}
export async function createKey(env: Env, userId: string, label: unknown) {
  const keyId = id('key'),
    secret = token(),
    name = text(label, '密钥名称', 80),
    now = Date.now()
  const row = await env.DB.prepare(
    'INSERT INTO api_keys SELECT ?,?,?,?,0,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND enabled=1) AND (SELECT COUNT(*) FROM api_keys WHERE user_id=? AND revoked=0)<5 RETURNING id',
  )
    .bind(
      keyId,
      userId,
      name,
      await seal(env, 'key:' + keyId, secret),
      now,
      userId,
      userId,
    )
    .first<{ id: string }>()
  if (!row)
    return fail('key_limit', '用户不存在、已停用或有效密钥已达 5 个。', 409)
  return { user_id: userId, key_id: keyId, secret, label: name }
}
export async function signedUser(request: Request, env: Env, raw: string) {
  const url = new URL(request.url),
    keyId = request.headers.get('X-Key-Id') ?? '',
    userId = request.headers.get('X-Partner-Id') ?? '',
    timestamp = request.headers.get('X-Timestamp') ?? '',
    nonce = request.headers.get('X-Nonce') ?? '',
    sig = request.headers.get('X-Signature') ?? '',
    idem = request.headers.get('Idempotency-Key') ?? ''
  if (
    !/^key_[a-f0-9]{32}$/.test(keyId) ||
    !/^usr_[a-f0-9]{32}$/.test(userId) ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(sig)
  )
    return fail('invalid_signature', '签名或时间戳无效。', 401)
  if (request.method === 'POST' && !/^[A-Za-z0-9_.:-]{8,128}$/.test(idem))
    fail('invalid_idempotency', 'POST 请求需要 8–128 位幂等键。')
  const row = await env.DB.prepare(
    'SELECT k.secret FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.id=? AND k.user_id=? AND k.revoked=0 AND u.enabled=1',
  )
    .bind(keyId, userId)
    .first<{ secret: string }>()
  if (
    !row ||
    !constantEqual(
      sig,
      await signature(
        await unseal(env, 'key:' + keyId, row.secret),
        request.method,
        url,
        timestamp,
        nonce,
        keyId,
        idem,
        raw,
      ),
    )
  )
    return fail('invalid_signature', '签名无效或密钥已停用。', 401)
  const inserted = await env.DB.prepare(
    'INSERT INTO nonces VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING nonce',
  )
    .bind(keyId, nonce, Date.now() + 600000)
    .first<{ nonce: string }>()
  if (!inserted) return fail('replayed_request', '请求随机数已使用。', 409)
  await limit(env, 'api:' + userId, 120)
  return userId
}
export async function setUserEnabled(
  env: Env,
  userId: string,
  enabled: unknown,
) {
  const row = await env.DB.prepare(
    'UPDATE users SET enabled=? WHERE id=? RETURNING id',
  )
    .bind(booleanInt(enabled), userId)
    .first<{ id: string }>()
  if (!row) fail('not_found', '用户不存在。', 404)
}
