import { constantEqual, hmac, sha256 } from '../../../shared/xgift-signature.ts'
export { constantEqual, hmac, sha256 }
export type Value = string | number | null
export interface Statement {
  bind(...values: Value[]): Statement
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}
export interface Database {
  prepare(sql: string): Statement
  batch(statements: Statement[]): Promise<unknown[]>
}
export interface Env {
  NATIVE_EXECUTOR?: (env: Env, order: import('./orders.ts').Order, snapshot: import('./executor.ts').Snapshot) => Promise<import('./executor.ts').Result>
  PAYMENT_SETTINGS?: import('./payments.ts').PaymentSettings
  PAYMENTS_LOCKED?: string
  PUBLIC_ORIGIN?: string
  ALIPAY_CLIENT?: typeof import('../server/alipay.ts').createAlipayClient
  LOCAL_EXECUTOR?: (order: import('./orders.ts').Order, snapshot: import('./executor.ts').Snapshot) => Promise<import('./executor.ts').Result>
  STRIPE_PUBLISHABLE_KEY?: string
  DB: Database
  ASSETS: { fetch(request: Request): Promise<Response> }
  MASTER_KEY: string
  ADMIN_PASSWORD: string
  PAYMENTS_ENABLED?: string
  EXECUTOR_URL?: string
  EXECUTOR_SECRET?: string
  OUTBOUND_GATEWAY_URL?: string
  OUTBOUND_GATEWAY_SECRET?: string
  X_BEARER?: string
  CARD_DEFAULT_TRANSPORT?: 'direct' | 'gateway'
  OUTBOUND_FETCH?: (
    target: string,
    headers: Record<string, string>,
    proxy: Record<string, unknown>,
    init?: { method?: string; body?: string },
  ) => Promise<Response>
  /** Local preview only: Wrangler may rewrite Host to the custom domain. */
  LOCAL_ORIGIN?: string
}
export class Failure extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}
export const fail = (code: string, message: string, status = 400): never => {
  throw new Failure(code, message, status)
}
export const token = () =>
  crypto.randomUUID().replaceAll('-', '') +
  crypto.randomUUID().replaceAll('-', '')
export const id = (prefix: string) =>
  prefix + '_' + crypto.randomUUID().replaceAll('-', '')
export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(
    { data },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } },
  )
}
export function text(value: unknown, label: string, maximum = 120) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > maximum
  )
    fail('invalid_input', `请填写${label}（最多 ${maximum} 字）。`)
  return (value as string).trim()
}
export function integer(
  value: unknown,
  label: string,
  min = 1,
  max = 1000000000,
) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail('invalid_input', `${label}必须是 ${min}–${max} 的整数。`)
  return value as number
}
export const booleanInt = (value: unknown) => {
  if (typeof value !== 'boolean') fail('invalid_input', '状态必须为布尔值。')
  return value ? 1 : 0
}
export async function rawBody(request: Pick<Request, 'body'>, limit = 16384) {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0,
    result = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        fail('too_large', '请求内容过长。', 413)
      }
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } catch (e) {
    if (e instanceof Failure) throw e
    return fail('invalid_input', '请求编码无效。')
  }
}
export function parseBody(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error()
    return value
  } catch {
    return fail('invalid_input', '请求必须为 JSON 对象。')
  }
}
export function browserWrite(request: Request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin)
    fail('origin_rejected', '请从本站提交。', 403)
  if (
    !request.headers
      .get('Content-Type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    fail('invalid_content_type', '请提交 JSON。', 415)
}
export function secureEndpoint(value: string | undefined) {
  if (!value) return fail('not_configured', '外部服务未配置。', 503)
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail('invalid_configuration', '外部服务地址无效。', 503)
  return url.origin + url.pathname.replace(/\/$/, '')
}
async function master(env: Env) {
  if (!/^[a-f0-9]{64}$/.test(env.MASTER_KEY ?? ''))
    fail('not_configured', '凭据加密密钥未配置。', 503)
  const bytes = Uint8Array.from(env.MASTER_KEY.match(/../g)!, (s) =>
    parseInt(s, 16),
  )
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}
export async function seal(env: Env, context: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(context),
      },
      await master(env),
      new TextEncoder().encode(value),
    ),
  )
  return (
    btoa(String.fromCharCode(...iv)) +
    '.' +
    btoa(String.fromCharCode(...ciphertext))
  )
}
export async function unseal(env: Env, context: string, value: string) {
  const [a, b] = value.split('.'),
    bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes(a),
        additionalData: new TextEncoder().encode(context),
      },
      await master(env),
      bytes(b),
    ),
  )
}
export async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const data = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: 100000,
      salt: new TextEncoder().encode(salt),
    },
    key,
    256,
  )
  return Array.from(new Uint8Array(data), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
export async function audit(
  env: Env,
  actor: string,
  action: string,
  target: string,
  note = '',
) {
  await env.DB.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)')
    .bind(id('audit'), actor, action, target, note, Date.now())
    .run()
}
export async function limit(
  env: Env,
  key: string,
  max: number,
  duration = 60000,
) {
  const now = Date.now()
  const row = await env.DB.prepare(
    'INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING attempts',
  )
    .bind(key, now + duration, now, now)
    .first<{ attempts: number }>()
  if (!row || row.attempts > max)
    fail('rate_limited', '请求过于频繁，请稍后重试。', 429)
}
export async function readResponse(response: Response, maximum = 256000) {
  return rawBody(response, maximum)
}
