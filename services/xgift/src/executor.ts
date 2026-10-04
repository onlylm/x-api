import {
  constantEqual,
  fail,
  hmac,
  id,
  readResponse,
  seal,
  secureEndpoint,
  sha256,
  unseal,
  type Env,
} from './core.ts'
import { executionReady, type Order } from './orders.ts'
export interface Snapshot {
  endpoint: string
  secret: string
  account: Record<string, unknown>
  proxy: Record<string, unknown> | null
  account_id: string
}
export interface Result {
  order_id: string
  status: string
  financial_state?: string
  failure_code?: string
  evidence?: {
    payment_status: string
    gift_status: string
    recipient: string
    product_code: string
    currency: string
    amount_minor: number
    receipt_id: string
  }
}
const nowDay = () => new Date().toISOString().slice(0, 10)
async function provider(
  snapshot: Snapshot,
  order: Order,
  create: boolean,
): Promise<Result> {
  const path = '/v1/jobs' + (create ? '' : '/' + order.id),
    method = create ? 'POST' : 'GET'
  const raw = create
    ? JSON.stringify({
        order_id: order.id,
        recipient: order.recipient,
        product_code: order.product_code,
        months: order.months,
        stripe_product: order.stripe_product,
        currency: order.currency,
        amount_minor: order.amount_minor,
        account_id: snapshot.account_id,
        account: snapshot.account,
        proxy: snapshot.proxy,
      })
    : ''
  const ts = String(Math.floor(Date.now() / 1000)),
    nonce = crypto.randomUUID()
  const sig = await hmac(
    snapshot.secret,
    [method, path, ts, nonce, await sha256(raw)].join('\n'),
  )
  const response = await fetch(snapshot.endpoint + path, {
    method,
    body: create ? raw : undefined,
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': ts,
      'X-Nonce': nonce,
      'X-Signature': sig,
      'Idempotency-Key': order.id,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  })
  const responseRaw = await readResponse(response)
  const responseSig = response.headers.get('X-Response-Signature') ?? ''
  if (
    !constantEqual(
      responseSig,
      await hmac(snapshot.secret, ts + '.' + nonce + '.' + responseRaw),
    )
  )
    throw new Error('Unverified executor response')
  if (!response.ok) throw new Error('Executor unavailable')
  const result = JSON.parse(responseRaw) as Result
  if (
    result.order_id !== order.id ||
    !['queued', 'running', 'unknown', 'succeeded', 'failed'].includes(
      result.status,
    )
  )
    throw new Error('Executor order mismatch')
  return result
}
async function bindQueued(env: Env, order: Order) {
  if (!executionReady(env)) return null
  const candidates = (
    await env.DB.prepare(
      "SELECT s.id,s.payload FROM secrets s WHERE s.kind='account' AND s.enabled=1 AND NOT EXISTS(SELECT 1 FROM account_slots a WHERE a.account_id=s.id AND a.released=0) ORDER BY s.updated_at LIMIT 20",
    ).all<{ id: string; payload: string }>()
  ).results
  for (const candidate of candidates) {
    const account = JSON.parse(
      await unseal(env, 'secret:' + candidate.id, candidate.payload),
    ) as Record<string, unknown>
    let proxy: Record<string, unknown> | null = null
    if (account.proxy_id) {
      const row = await env.DB.prepare(
        "SELECT id,payload FROM secrets WHERE id=? AND kind='proxy' AND enabled=1",
      )
        .bind(String(account.proxy_id))
        .first<{ id: string; payload: string }>()
      if (!row) continue
      proxy = JSON.parse(await unseal(env, 'secret:' + row.id, row.payload))
    }
    const snapshot: Snapshot = {
      endpoint: env.LOCAL_EXECUTOR ? 'local:v1' : secureEndpoint(env.EXECUTOR_URL),
      secret: env.LOCAL_EXECUTOR ? '' : env.EXECUTOR_SECRET!,
      account,
      proxy,
      account_id: candidate.id,
    }
    const cipher = await seal(
        env,
        'execution:' + order.id,
        JSON.stringify(snapshot),
      ),
      work = id('work'),
      now = Date.now()
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO account_slots SELECT ?,?,?,0 WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND status='queued') AND (SELECT COUNT(*) FROM account_slots WHERE account_id=? AND day=?)<? ON CONFLICT(order_id) DO NOTHING`,
        ).bind(
          order.id,
          candidate.id,
          nowDay(),
          order.id,
          candidate.id,
          nowDay(),
          Number(account.daily_limit ?? 300),
        ),
        env.DB.prepare(
          "UPDATE orders SET status='running',execution_config=?,work_token=?,lease_until=?,updated_at=? WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM account_slots WHERE order_id=orders.id AND account_id=?)",
        ).bind(cipher, work, now + (env.LOCAL_EXECUTOR ? 180000 : 60000), now, order.id, candidate.id),
      ])
    } catch {
      continue
    }
    const owned = await env.DB.prepare(
      'SELECT * FROM orders WHERE id=? AND work_token=?',
    )
      .bind(order.id, work)
      .first<Order>()
    if (owned) return { order: owned, snapshot, create: true }
  }
  return null
}
async function claim(env: Env) {
  const now = Date.now(),
    work = id('work')
  const pending = await env.DB.prepare(
    "UPDATE orders SET work_token=?,lease_until=? WHERE id=(SELECT id FROM orders WHERE status IN('running','unknown') AND lease_until<=? AND next_check<=? ORDER BY next_check,created_at LIMIT 1) RETURNING *",
  )
    .bind(work, now + (env.LOCAL_EXECUTOR ? 180000 : 60000), now, now)
    .first<Order>()
  if (pending) {
    if (!pending.execution_config)
      return fail('missing_execution', '执行配置缺失，需要人工核对。', 503)
    return {
      order: pending,
      snapshot: JSON.parse(
        await unseal(env, 'execution:' + pending.id, pending.execution_config),
      ) as Snapshot,
      create: false,
    }
  }
  if (!executionReady(env)) return null
  const next = await env.DB.prepare(
    "SELECT * FROM orders WHERE status='queued' ORDER BY created_at LIMIT 1",
  ).first<Order>()
  return next ? bindQueued(env, next) : null
}
export async function reconcile(env: Env) {
  const work = await claim(env)
  if (!work) return { processed: false }
  const { order, snapshot, create } = work
  let status: Order['status'] = 'unknown',
    receipt: string | null = null,
    code: string | null = 'result_unconfirmed'
  try {
    const result = snapshot.endpoint === 'local:v1' && env.LOCAL_EXECUTOR
      ? await env.LOCAL_EXECUTOR(order, snapshot)
      : await provider(snapshot, order, create)
    if (result.status === 'succeeded') {
      const e = result.evidence
      if (
        !e ||
        e.payment_status !== 'paid' ||
        (e.gift_status !== 'completed' && !(snapshot.endpoint === 'local:v1' && e.gift_status === 'checkout_completed')) ||
        e.recipient !== order.recipient ||
        e.product_code !== order.product_code ||
        e.currency !== order.currency ||
        e.amount_minor !== order.amount_minor ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(e.receipt_id)
      )
        throw new Error('Unverified success evidence')
      status = 'succeeded'
      receipt = e.receipt_id
      code = null
    } else if (
      result.status === 'failed' &&
      result.financial_state === 'not_charged'
    ) {
      status = 'failed'
      code = /^[a-z0-9_]{1,64}$/.test(result.failure_code ?? '')
        ? result.failure_code!
        : 'execution_rejected'
    } else if (['queued', 'running'].includes(result.status)) {
      status = 'running'
      code = null
    } else if (result.failure_code && /^[a-z0-9_]{1,64}$/.test(result.failure_code)) {
      code = result.failure_code
    }
  } catch {
    /* Any ambiguous write or malformed response remains frozen; only query the original job next time. */
  }
  await env.DB.prepare(
    "UPDATE orders SET status=?,receipt=?,failure_code=?,lease_until=0,next_check=?,updated_at=? WHERE id=? AND work_token=? AND status IN('running','unknown')",
  )
    .bind(
      status,
      receipt,
      code,
      Date.now() + (snapshot.endpoint === 'local:v1' ? 5000 : 60000),
      Date.now(),
      order.id,
      order.work_token,
    )
    .run()
  return { processed: true, order_id: order.id, status }
}
export async function cleanup(env: Env) {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM nonces WHERE expires_at<=?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
    env.DB.prepare('DELETE FROM login_limits WHERE reset_at<=?').bind(now),
  ])
}
