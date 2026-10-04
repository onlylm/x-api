const encoder = new TextEncoder()
export const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
export async function sha256(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}
export async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
export function canonicalQuery(params: URLSearchParams) {
  return Array.from(params, ([k, v]) => [encode(k), encode(v)])
    .sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}
export async function signature(
  secret: string,
  method: string,
  url: URL,
  timestamp: string,
  nonce: string,
  keyId: string,
  idempotency: string,
  rawBody: string,
) {
  return hmac(
    secret,
    [
      method,
      url.pathname,
      canonicalQuery(url.searchParams),
      timestamp,
      nonce,
      keyId,
      idempotency,
      await sha256(rawBody),
    ].join('\n'),
  )
}
export function constantEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++)
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}
