import { Failure, id, readResponse, seal, unseal, type Env } from '../src/core.ts'
import type { Order } from '../src/orders.ts'
import type { Result, Snapshot } from '../src/executor.ts'
import { accountEligibility, quote, xQuery, XQueryFailure, type XQueryDiagnostic } from '../src/network.ts'
import { cardConfiguration, cardRead, cardWrite, paymentCard } from '../src/cards.ts'
import { giftProfile, giftPolicy } from '../src/gift-profile.ts'
import { assertPaymentAllowed, type PaymentBinding } from '../src/payments.ts'

// X merchant published by x_gift_bot setup.go. Validate every returned payment page against it.
export const X_MERCHANT = 'acct_1Ika5JA3KZ32dPo1'
type Json = Record<string, any>
interface FirstError { at: number; stage: string; code: string; upstream?: XQueryDiagnostic }
interface Job { stage: string; session?: string; session_url?: string; card_id?: number; method?: string; checksum?: string; submitted_at?: number; proof?: Json; key: string; payment?: PaymentBinding
  candidate_index?: number; rejected_cards?: { card_id: number; reason: string }[]; candidates_exhausted?: boolean; tokenization_started?: boolean; first_error?: FirstError }
const sessionPattern = /^cs_live_[A-Za-z0-9]+$/
const successUrl = (o: Order) => `https://x.com/${o.recipient}/gift-premium/success`
export function validatedCheckoutUrl(value: unknown, session: unknown) {
  if (typeof value !== 'string' || value.length > 8192 || typeof session !== 'string' || !sessionPattern.test(session)) throw new Error('invalid_checkout_url')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port || url.username || url.password ||
      !['/c/pay/' + session, '/pay/' + session].includes(url.pathname)) throw new Error('invalid_checkout_url')
  return url.href
}
export function guardPage(p: Json, order: Order, session: string, before: boolean) {
  const amount = order.amount_minor, currency = order.currency
  if (p.session_id !== session || p.account_settings?.account_id !== X_MERCHANT || p.livemode !== true || p.mode !== 'payment' || p.currency !== currency || p.line_item_group?.currency !== currency || p.success_url !== successUrl(order) || p.cancel_url !== successUrl(order).replace('/success', '')) throw new Error('checkout_identity_mismatch')
  if (p.setup_future_usage != null || p.subscription_data != null || p.setup_intent != null) throw new Error('recurring_payment_forbidden')
  const total = p.total_summary, group = p.line_item_group
  if (total?.total !== amount || total?.subtotal !== amount || group.total !== amount || group.subtotal !== amount || group.line_items?.length !== 1) throw new Error('checkout_amount_mismatch')
  const item = group.line_items[0], name = `Premium Gift - ${order.months} months`
  if (item.name !== name || item.quantity !== 1 || item.total !== amount || item.subtotal !== amount || item.price?.currency !== currency || item.price.type !== 'one_time' || item.price.unit_amount !== amount || item.price.recurring != null || item.price.product?.id !== order.stripe_product || item.price.product.name !== name || item.price.product.livemode !== true) throw new Error('checkout_product_mismatch')
  if (before && (!Object.hasOwn(p, 'payment_intent') || p.payment_intent !== null || p.status !== 'open' || p.payment_status !== 'unpaid' || total.due !== amount || group.due !== amount || typeof p.init_checksum !== 'string' || !p.init_checksum)) throw new Error('checkout_not_unpaid')
  if (p.payment_intent && (p.payment_intent.currency !== currency || p.payment_intent.amount !== amount)) throw new Error('intent_amount_mismatch')
}
async function stripe(key: string, method: string, path: string, fields: Record<string, string> = {}, idem?: string) {
  const form = new URLSearchParams({ ...fields, key })
  const url = 'https://api.stripe.com/v1/' + path + (method === 'GET' ? '?' + form : '')
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(idem ? { 'Idempotency-Key': idem } : {}) },
    body: method === 'POST' ? form.toString() : undefined, redirect: 'manual', signal: AbortSignal.timeout(20000) })
  const data = JSON.parse(await readResponse(response, 2097152))
  if (!response.ok || data.error) throw new Error('stripe_result_unconfirmed')
  return data as Json
}
async function save(env: Env, order: Order, job: Job, change?: { from_card_id: number; to_card_id: number | null; reason: string }, error?: FirstError) {
  const now = Date.now()
  const payload = await seal(env, 'native:' + order.id, JSON.stringify(job))
  // Fence replaced workers: a closed order cannot persist another write-ahead stage.
  const update = env.DB.prepare(`INSERT INTO native_jobs SELECT ?,?,?,? WHERE EXISTS(
    SELECT 1 FROM orders WHERE id=? AND status IN('running','unknown') AND work_token IS ? AND lease_until>?)
    ON CONFLICT(order_id) DO UPDATE SET stage=excluded.stage,payload=excluded.payload,updated_at=excluded.updated_at`)
    .bind(order.id, job.stage, payload, now, order.id, order.work_token, now)
  if (change || error) await env.DB.batch([update, env.DB.prepare(`INSERT INTO audit SELECT ?,?,?,?,?,? WHERE EXISTS(
    SELECT 1 FROM native_jobs WHERE order_id=? AND payload=?)`)
    .bind(id('audit'), 'system', error ? 'native_execution_first_error' : change!.to_card_id === null ? 'payment_cards_exhausted' : 'payment_card_failover', order.id, JSON.stringify(error ?? change), now, order.id, payload)])
  else await update.run()
  if (!await env.DB.prepare('SELECT 1 FROM native_jobs WHERE order_id=? AND payload=?').bind(order.id, payload).first())
    throw new Failure('order_busy', '原订单已由其他操作接管，请刷新状态。', 409)
}
async function prepareWrite(env: Env, order: Order, job: Job, stage: string) {
  const previous = job.stage
  job.stage = stage
  // Once a method submission was prepared, this checkout stays bound to that
  // card even if a last-moment pause makes the phase roll back before sending.
  if (stage === 'tokenizing') job.tokenization_started = true
  await save(env, order, job)
  try {
    // Saving is asynchronous: a pause can arrive after the preceding guard.
    await assertPaymentAllowed(env, job.payment, order.id)
  } catch (error) {
    // No upstream request was sent, so resuming can safely retry the previous stage.
    job.stage = previous
    await save(env, order, job)
    throw error
  }
}
async function fundCard(env: Env) {
  const reference = 'xgift:initial-card:v1'
  const config = await cardConfiguration(env)
  if (!config.configured || config.environment !== 'production' || !config.writes_enabled) throw new Error('card_provider_not_ready')
  const existing = await env.DB.prepare('SELECT * FROM card_operations WHERE reference=?').bind(reference).first<Json>()
  if (existing) {
    if (existing.status !== 'succeeded' || !existing.card_id || existing.provider_revision !== config.revision) throw new Error('card_funding_unconfirmed')
    return Number(existing.card_id)
  }
  const profile = await giftProfile(env)
  if (!profile.configured || !('first_name' in profile)) throw new Error('billing_profile_missing')
  const products = await cardRead(env, 'products') as Json[]
  const product = products.find(p => p.product_code === giftPolicy.preferred_product)
  if (!product || product.issuer !== 'four' || typeof product.min_amount !== 'number' || product.min_amount > 20 || typeof product.open_fee !== 'number' || product.open_fee > 0.50 || product.open_fee < 0 || product.recharge_fee !== 0) throw new Error('card_product_price_changed')
  const balance = await cardRead(env, 'balance') as Json
  if (balance.currency !== 'USD' || !Number.isFinite(Number(balance.spendable_balance)) || Number(balance.spendable_balance) < 20 + product.open_fee) throw new Error('card_balance_insufficient')
  await assertPaymentAllowed(env)
  // Reservation is durable before sending. An ambiguous operation consumes the budget until reconciled.
  await env.DB.prepare('INSERT INTO native_funding VALUES(?,?,?) ON CONFLICT(reference) DO NOTHING')
    .bind(reference, new Date().toISOString().slice(0, 10), 2000).run()
  await assertPaymentAllowed(env)
  const result = await cardWrite(env, 'open', { confirmation: 'CHARGE', reference,
    product_code: giftPolicy.preferred_product, amount_minor: 2000,
    first_name: profile.first_name, last_name: profile.last_name, max_transaction_usd_cents: 1000 })
  if (result.status !== 'succeeded' || !result.card_id) throw new Error('card_funding_unconfirmed')
  return Number(result.card_id)
}
class CardCheckError extends Error {
  readonly reason: string
  readonly canFailover: boolean
  constructor(reason: string, canFailover = false) {
    super(reason); this.reason = reason; this.canFailover = canFailover
  }
}
function validateCard(card: Json, cardId: number, selected: boolean) {
  const expiry = String(card.expire ?? '').match(/^(\d{2})\/(\d{2}|\d{4})$/)
  const month = Number(expiry?.[1]), year = expiry ? Number(expiry[2]) + (expiry[2]!.length === 2 ? 2000 : 0) : 0
  const current = new Date()
  const balanceValid = typeof card.available_amount === 'number' ||
    (typeof card.available_amount === 'string' && /^\d+(?:\.\d+)?$/.test(card.available_amount))
  const identityValid = (typeof card.id === 'number' && Number.isSafeInteger(card.id)) ||
    (typeof card.id === 'string' && /^\d+$/.test(card.id))
  // Identity and malformed responses are not proof that a card is unavailable.
  // Never amplify a provider/API failure by trying further cards.
  if (!identityValid || Number(card.id) !== cardId || (!selected && card.product_code !== giftPolicy.preferred_product) ||
      !['ACTIVE', 'FROZEN', 'DELETED', 'CANCELLED'].includes(card.status) ||
      !/^\d{12,19}$/.test(String(card.card_number)) || !/^\d{3,4}$/.test(String(card.cvv)) ||
      !expiry || month < 1 || month > 12 || !balanceValid || !Number.isFinite(Number(card.available_amount)) ||
      Number(card.available_amount) < 0 || (card.currency !== undefined && String(card.currency).toUpperCase() !== 'USD'))
    throw new CardCheckError('payment_card_unverified')
  if (card.status !== 'ACTIVE') throw new CardCheckError('card_' + String(card.status).toLowerCase(), true)
  if (year < current.getUTCFullYear() || (year === current.getUTCFullYear() && month < current.getUTCMonth() + 1))
    throw new CardCheckError('card_expired', true)
  if (Number(card.available_amount) < 10) throw new CardCheckError('card_balance_insufficient', true)
  return expiry
}
async function unavailableCard(env: Env, order: Order, job: Job, error: CardCheckError): Promise<Result> {
  const unknown = (failure_code: string): Result => ({ order_id: order.id, status: 'unknown', failure_code })
  const payment = job.payment
  if (!error.canFailover || !payment?.backup_card_ids?.length || !['funding', 'funded'].includes(job.stage) ||
      job.method !== undefined || job.submitted_at !== undefined || job.tokenization_started)
    return unknown(error.reason)
  const candidates = [payment.card_id, ...payment.backup_card_ids], index = candidates.indexOf(job.card_id!)
  if (index < 0 || (job.candidate_index !== undefined && job.candidate_index !== index)) return unknown('payment_binding_mismatch')
  await assertPaymentAllowed(env, payment, order.id)
  // A single invocation reads one candidate only. Persist the next authorized
  // ID and its audit event atomically; restart never returns to rejected cards.
  const next = candidates[index + 1] ?? null, rejected = job.rejected_cards ?? []
  if (next === null && rejected.some(card => card.card_id === job.card_id))
    return unknown('payment_cards_exhausted')
  const previousCard = job.card_id!
  job.rejected_cards = [...rejected, { card_id: previousCard, reason: error.reason }]
  job.candidate_index = next === null ? index : index + 1
  job.candidates_exhausted = next === null
  if (next !== null) { job.card_id = next; job.stage = 'funding' }
  await save(env, order, job, { from_card_id: previousCard, to_card_id: next, reason: error.reason })
  await assertPaymentAllowed(env, payment, order.id)
  // Exhaustion does not cycle back. The last card alone may be read again so
  // an operator can restore it without creating another purchase or checkout.
  return next === null ? unknown('payment_cards_exhausted') : { order_id: order.id, status: 'running' }
}
export async function executeNative(env: Env, order: Order, snapshot: Snapshot): Promise<Result> {
  const unknown = (code = 'result_unconfirmed'): Result => ({ order_id: order.id, status: 'unknown', failure_code: code })
  const running = (): Result => ({ order_id: order.id, status: 'running' })
  const row = await env.DB.prepare('SELECT payload FROM native_jobs WHERE order_id=?').bind(order.id).first<{ payload: string }>()
  const job: Job = row ? JSON.parse(await unseal(env, 'native:' + order.id, row.payload)) : {
    stage: 'preflight', key: snapshot.payment?.stripe_publishable_key ?? env.STRIPE_PUBLISHABLE_KEY ?? '',
    ...(snapshot.payment ? { payment: snapshot.payment, card_id: snapshot.payment.card_id } : {}),
  }
  const payment = job.payment
  // A later configuration change cannot switch an existing job to another card.
  // Legacy submitted jobs remain queryable even after the admin configuration is introduced.
  if (env.PAYMENT_SETTINGS && !payment && !['submitted', 'paid'].includes(job.stage)) return unknown('payment_binding_missing')
  if (env.PAYMENTS_ENABLED !== 'true' && !['submitted', 'paid'].includes(job.stage)) return unknown('payments_paused')
  if (!/^pk_live_[A-Za-z0-9]+$/.test(job.key) || !order.recipient_id) return unknown('execution_configuration_missing')
  // Only the two exact BDT products are authorized in this first release; never use a caller's price.
  if (order.currency !== 'bdt' || ![3, 6].includes(order.months) || order.amount_minor !== order.months * 10000 || order.stripe_product !== (order.months === 3 ? 'prod_TJXJtpzqCpI36N' : 'prod_TJXKKNJwZJIhCM')) return unknown('product_not_authorized')
  try {
    if (!['submitted', 'paid'].includes(job.stage)) await assertPaymentAllowed(env, payment, order.id)
    if (payment) {
      const candidates = [payment.card_id, ...(payment.backup_card_ids ?? [])], index = candidates.indexOf(job.card_id!)
      if (index < 0 || (job.candidate_index !== undefined && job.candidate_index !== index) || job.key !== payment.stripe_publishable_key)
        return unknown('payment_binding_mismatch')
    }
    if (job.stage === 'preflight') {
      const check = await accountEligibility(env, snapshot.account, snapshot.proxy, order.recipient)
      if (!check.eligible || check.recipient_id !== order.recipient_id) return { order_id: order.id, status: 'failed', financial_state: 'not_charged', failure_code: 'recipient_not_eligible' }
      const price = await quote(env, snapshot.account_id, order.product_code)
      if (!price.matches_expected || price.currency !== order.currency || Math.round(price.amount * 100) !== order.amount_minor) return { order_id: order.id, status: 'failed', financial_state: 'not_charged', failure_code: 'price_changed' }
      await assertPaymentAllowed(env, payment, order.id)
      await prepareWrite(env, order, job, 'creating')
      const result = await xQuery(env, snapshot.account, snapshot.proxy, 'useOneTimePurchaseGiftMutation', 'GqTVJ4S1526tLkxj69xIZw', {
        cancel_url: successUrl(order).replace('/success', ''), success_url: successUrl(order), external_product_id: order.stripe_product, gift_recipient: order.recipient_id,
      }, true)
      const s = result.onetimepurchase_gift
      if (s?.session_status !== 'Unpaid' || !sessionPattern.test(s.session_id)) throw new Error('invalid_checkout')
      job.session_url = validatedCheckoutUrl(s.session_url, s.session_id)
      job.session = s.session_id; job.stage = 'session'; await save(env, order, job); return running()
    }
    if (job.stage === 'creating' || job.stage === 'tokenizing') return unknown('original_request_unconfirmed')
    if (!job.session || !sessionPattern.test(job.session)) return unknown('session_missing')
    if (job.stage === 'session') {
      await assertPaymentAllowed(env, payment, order.id)
      const page = await stripe(job.key, 'POST', `payment_pages/${job.session}/init`, { browser_locale: 'en', redirect_type: 'url' })
      guardPage(page, order, job.session, true)
      job.proof = page; job.checksum = page.init_checksum; job.stage = 'funding'
      await save(env, order, job); return running()
    }
    if (job.stage === 'funding') {
      await assertPaymentAllowed(env, payment, order.id)
      if (payment) {
        // Existing-card mode is read-only at the card provider: never open, top up or change limits.
        const card = await paymentCard(env, job.card_id!)
        try { validateCard(card, job.card_id!, true) }
        catch (error) { if (error instanceof CardCheckError) return await unavailableCard(env, order, job, error); throw error }
        job.candidates_exhausted = false
      } else job.card_id = await fundCard(env)
      job.stage = 'funded'; await save(env, order, job); return running()
    }
    if (job.stage === 'funded') {
      const billing = payment ? { configured: true, ...payment.billing } : await giftProfile(env)
      if (!billing.configured || !('billing_email' in billing) || !billing.billing_email || !billing.billing_country || !billing.first_name || !billing.last_name) throw new Error('billing_profile_missing')
      if (!payment) {
        const config = await cardConfiguration(env)
        const operation = await env.DB.prepare("SELECT provider_revision FROM card_operations WHERE reference='xgift:initial-card:v1' AND card_id=? AND status='succeeded'").bind(job.card_id!).first<{ provider_revision: string }>()
        if (!operation || operation.provider_revision !== config.revision) throw new Error('card_provider_changed')
      }
      const card = await paymentCard(env, job.card_id!)
      let expiry: RegExpMatchArray
      try { expiry = validateCard(card, job.card_id!, !!payment) }
      catch (error) { if (payment && error instanceof CardCheckError) return await unavailableCard(env, order, job, error); throw error }
      await assertPaymentAllowed(env, payment, order.id)
      // The USD balance threshold is conservative; an existing card's limits are not modified.
      await prepareWrite(env, order, job, 'tokenizing')
      const fields: Record<string, string> = { type: 'card', 'card[number]': String(card.card_number), 'card[cvc]': String(card.cvv), 'card[exp_month]': expiry[1]!, 'card[exp_year]': expiry[2]!,
        'billing_details[name]': `${billing.first_name} ${billing.last_name}`, 'billing_details[email]': billing.billing_email, 'billing_details[address][country]': billing.billing_country }
      for (const [name, value] of Object.entries({ line1: billing.billing_line1, line2: billing.billing_line2, city: billing.billing_city, state: billing.billing_state, postal_code: billing.billing_postal_code })) if (value) fields[`billing_details[address][${name}]`] = value
      const method = await stripe(job.key, 'POST', 'payment_methods', fields, 'xgift-method-' + order.id)
      if (method.livemode !== true || method.type !== 'card' || !/^pm_[A-Za-z0-9]+$/.test(method.id)) throw new Error('invalid_payment_method')
      job.method = method.id; job.stage = 'tokenized'; await save(env, order, job); return running()
    }
    if (job.stage === 'tokenized') {
      const check = await accountEligibility(env, snapshot.account, snapshot.proxy, order.recipient)
      if (!check.eligible || check.recipient_id !== order.recipient_id) return { order_id: order.id, status: 'failed', financial_state: 'not_charged', failure_code: 'recipient_changed_before_payment' }
      const page = await stripe(job.key, 'POST', `payment_pages/${job.session}/init`, { browser_locale: 'en', redirect_type: 'url' })
      guardPage(page, order, job.session, true)
      if (payment) validateCard(await paymentCard(env, job.card_id!), job.card_id!, true)
      await assertPaymentAllowed(env, payment, order.id)
      job.proof = page; job.checksum = page.init_checksum; job.submitted_at = Date.now()
      await prepareWrite(env, order, job, 'submitted')
      // Deliberately submit once. Every subsequent invocation only inspects the same checkout.
      await stripe(job.key, 'POST', `payment_pages/${job.session}/confirm`, { payment_method: job.method!, expected_amount: String(order.amount_minor), expected_payment_method_type: 'card', init_checksum: job.checksum!, return_url: successUrl(order) }, 'xgift-confirm-' + order.id)
      return running()
    }
    if (job.stage === 'submitted' || job.stage === 'paid') {
      guardPage(job.proof!, order, job.session, true)
      if (!job.submitted_at || !/^pm_[A-Za-z0-9]+$/.test(job.method ?? '')) throw new Error('submission_proof_missing')
      const poll = await stripe(job.key, 'GET', `payment_pages/${job.session}/poll`)
      if (poll.session_id !== job.session || poll.livemode !== true || poll.is_sandbox_merchant !== false || poll.mode !== 'payment' || poll.success_url !== successUrl(order) || (poll.currency !== undefined && poll.currency !== order.currency) || (poll.amount !== undefined && poll.amount !== order.amount_minor) || (poll.account_id !== undefined && poll.account_id !== X_MERCHANT)) throw new Error('payment_evidence_mismatch')
      if (poll.state !== 'succeeded' || poll.payment_object_status !== 'succeeded') return unknown(poll.payment_object_status === 'requires_action' ? 'payment_requires_action' : 'payment_pending')
      job.stage = 'paid'; await save(env, order, job)
      // This proves completion of X's gift checkout, not an independent read of the recipient's entitlement.
      return { order_id: order.id, status: 'succeeded', evidence: {
        payment_status: 'paid', gift_status: 'checkout_completed', recipient: order.recipient,
        product_code: order.product_code, currency: order.currency, amount_minor: order.amount_minor, receipt_id: job.session,
      } }
    }
    return unknown('execution_stage_unconfirmed')
  } catch (error) {
    if (!job.first_error) {
      // Fixed internal codes only. Unexpected exception messages may contain secrets.
      const code = error instanceof XQueryFailure ? error.code : error instanceof CardCheckError ? error.reason :
        error instanceof Error && ['invalid_checkout', 'invalid_checkout_url', 'stripe_result_unconfirmed',
          'checkout_identity_mismatch', 'checkout_amount_mismatch', 'checkout_product_mismatch', 'checkout_not_unpaid',
          'billing_profile_missing', 'payment_evidence_mismatch'].includes(error.message) ? error.message : 'execution_requires_reconciliation'
      job.first_error = { at: Date.now(), stage: job.stage, code,
        ...(error instanceof XQueryFailure ? { upstream: error.diagnostic } : {}) }
      // Same lease fence as payment stages: cancellation/replaced workers cannot write.
      // Logging failure must not change the original result or trigger another request.
      try { await save(env, order, job, undefined, job.first_error) } catch { /* preserve original outcome */ }
    }
    return unknown(error instanceof Failure ? error.code : error instanceof CardCheckError ? error.reason : 'execution_requires_reconciliation')
  }
}

/** Read-only admin reconciliation. Never advance preparation or submit payment. */
export async function queryNativeOrder(env: Env, order: Order, _snapshot: Snapshot): Promise<Result> {
  const unknown = (failure_code: string): Result => ({ order_id: order.id, status: 'unknown', failure_code })
  const row = await env.DB.prepare('SELECT payload FROM native_jobs WHERE order_id=?').bind(order.id).first<{ payload: string }>()
  if (!row) return { order_id: order.id, status: 'running', failure_code: 'payment_not_started' }
  try {
    const job = JSON.parse(await unseal(env, 'native:' + order.id, row.payload)) as Job
    if (job.stage === 'preflight' && !job.session) return { order_id: order.id, status: 'running', failure_code: 'payment_not_started' }
    if (!job.session || !sessionPattern.test(job.session)) return unknown('original_request_unconfirmed')
    if (!/^pk_live_[A-Za-z0-9]+$/.test(job.key)) return unknown('execution_configuration_missing')
    // URL alone is not proof: bind exact merchant, recipient, one-time product and price.
    if (!job.proof) return unknown('checkout_proof_missing')
    guardPage(job.proof, order, job.session, true)
    const poll = await stripe(job.key, 'GET', `payment_pages/${job.session}/poll`)
    if (poll.session_id !== job.session || poll.livemode !== true || poll.is_sandbox_merchant !== false || poll.mode !== 'payment' ||
        poll.success_url !== successUrl(order) || (poll.currency !== undefined && poll.currency !== order.currency) ||
        (poll.amount !== undefined && poll.amount !== order.amount_minor) || (poll.account_id !== undefined && poll.account_id !== X_MERCHANT))
      return unknown('payment_evidence_mismatch')
    if (poll.state !== 'succeeded' || poll.payment_object_status !== 'succeeded')
      return unknown(poll.payment_object_status === 'requires_action' ? 'payment_requires_action' : 'payment_pending')
    return { order_id: order.id, status: 'succeeded', evidence: {
      payment_status: 'paid', gift_status: 'checkout_completed', recipient: order.recipient, product_code: order.product_code,
      currency: order.currency, amount_minor: order.amount_minor, receipt_id: job.session,
    } }
  } catch { return unknown('payment_query_failed') }
}
