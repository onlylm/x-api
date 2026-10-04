import {
  fail,
  hmac,
  seal,
  secureEndpoint,
  token,
  unseal,
  type Env,
} from './core.ts'
import { publicOrder, type Order } from './orders.ts'
export async function configureWebhook(
  env: Env,
  userId: string,
  value: unknown,
) {
  if (value === '') {
    await env.DB.prepare('DELETE FROM webhook_configs WHERE user_id=?')
      .bind(userId)
      .run()
    return { disabled: true }
  }
  if (typeof value !== 'string')
    return fail('invalid_input', '请填写 HTTPS 回调地址。')
  const endpoint = secureEndpoint(value),
    hostname = new URL(endpoint).hostname
  if (
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  )
    fail('invalid_input', '回调地址需要公开域名。')
  const secret = token()
  await env.DB.prepare(
    'INSERT INTO webhook_configs VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET url=excluded.url,secret=excluded.secret',
  )
    .bind(userId, endpoint, await seal(env, 'webhook:' + userId, secret))
    .run()
  return { url: endpoint, secret }
}
export async function deliverWebhook(env: Env) {
  const row = await env.DB.prepare(
    "UPDATE webhook_deliveries SET attempts=attempts+1,next_at=? WHERE order_id=(SELECT order_id FROM webhook_deliveries WHERE status='pending' AND next_at<=? ORDER BY next_at LIMIT 1) RETURNING *",
  )
    .bind(Date.now() + 120000, Date.now())
    .first<{
      order_id: string
      user_id: string
      event_id: string
      url: string
      secret: string
      attempts: number
    }>()
  if (!row) return
  let success = false
  try {
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id=?')
      .bind(row.order_id)
      .first<Order>()
    if (!order) throw new Error('Missing order')
    const raw = JSON.stringify({
        event_id: row.event_id,
        event_type: 'order.completed',
        data: publicOrder(order),
      }),
      timestamp = String(Math.floor(Date.now() / 1000))
    const response = await fetch(row.url, {
      method: 'POST',
      body: raw,
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Id': row.event_id,
        'X-Timestamp': timestamp,
        'X-Signature': await hmac(
          await unseal(env, 'webhook:' + row.user_id, row.secret),
          timestamp + '.' + raw,
        ),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
    success = response.ok
    await response.body?.cancel()
  } catch {
    /* Query APIs remain authoritative while notification delivery is retried. */
  }
  await env.DB.prepare(
    'UPDATE webhook_deliveries SET status=?,next_at=? WHERE order_id=? AND attempts=?',
  )
    .bind(
      success ? 'sent' : row.attempts >= 10 ? 'dead' : 'pending',
      Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts),
      row.order_id,
      row.attempts,
    )
    .run()
}
