import { readResponse, seal, unseal, type Env } from '../src/core.ts'
import type { Order } from '../src/orders.ts'
import type { Result, Snapshot } from '../src/executor.ts'
import { accountEligibility, quote, xQuery } from '../src/network.ts'
import { cardConfiguration, cardRead, cardWrite, paymentCard } from '../src/cards.ts'
import { giftProfile, giftPolicy } from '../src/gift-profile.ts'

// X merchant published by x_gift_bot setup.go. Validate every returned payment page against it.
export const X_MERCHANT = 'acct_1Ika5JA3KZ32dPo1'
type Json = Record<string, any>
interface Job { stage: string; session?: string; card_id?: number; method?: string; checksum?: string; submitted_at?: number; proof?: Json; key: string }
const sessionPattern = /^cs_live_[A-Za-z0-9]+$/
const successUrl = (o: Order) => `https://x.com/${o.recipient}/gift-premium/success`
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
async function save(env: Env, order: Order, job: Job) {
  await env.DB.prepare('INSERT INTO native_jobs VALUES(?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET stage=excluded.stage,payload=excluded.payload,updated_at=excluded.updated_at')
    .bind(order.id, job.stage, await seal(env, 'native:' + order.id, JSON.stringify(job)), Date.now()).run()
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
  // Reservation is durable before sending. An ambiguous operation consumes the budget until reconciled.
  await env.DB.prepare('INSERT INTO native_funding VALUES(?,?,?) ON CONFLICT(reference) DO NOTHING')
    .bind(reference, new Date().toISOString().slice(0, 10), 2000).run()
  const result = await cardWrite(env, 'open', { confirmation: 'CHARGE', reference,
    product_code: giftPolicy.preferred_product, amount_minor: 2000,
    first_name: profile.first_name, last_name: profile.last_name, max_transaction_usd_cents: 1000 })
  if (result.status !== 'succeeded' || !result.card_id) throw new Error('card_funding_unconfirmed')
  return Number(result.card_id)
}
export async function executeNative(env: Env, order: Order, snapshot: Snapshot): Promise<Result> {
  const unknown = (code = 'result_unconfirmed'): Result => ({ order_id: order.id, status: 'unknown', failure_code: code })
  const running = (): Result => ({ order_id: order.id, status: 'running' })
  const row = await env.DB.prepare('SELECT payload FROM native_jobs WHERE order_id=?').bind(order.id).first<{ payload: string }>()
  const job: Job = row ? JSON.parse(await unseal(env, 'native:' + order.id, row.payload)) : { stage: 'preflight', key: env.STRIPE_PUBLISHABLE_KEY ?? '' }
  if (env.PAYMENTS_ENABLED !== 'true' && !['submitted', 'paid'].includes(job.stage)) return unknown('payments_paused')
  if (!/^pk_live_[A-Za-z0-9]+$/.test(job.key) || !order.recipient_id) return unknown('execution_configuration_missing')
  // Only the two exact BDT products are authorized in this first release; never use a caller's price.
  if (order.currency !== 'bdt' || ![3, 6].includes(order.months) || order.amount_minor !== order.months * 10000 || order.stripe_product !== (order.months === 3 ? 'prod_TJXJtpzqCpI36N' : 'prod_TJXKKNJwZJIhCM')) return unknown('product_not_authorized')
  try {
    if (job.stage === 'preflight') {
      const check = await accountEligibility(env, snapshot.account, snapshot.proxy, order.recipient)
      if (!check.eligible || check.recipient_id !== order.recipient_id) return { order_id: order.id, status: 'failed', financial_state: 'not_charged', failure_code: 'recipient_not_eligible' }
      const price = await quote(env, snapshot.account_id, order.product_code)
      if (!price.matches_expected || price.currency !== order.currency || Math.round(price.amount * 100) !== order.amount_minor) return { order_id: order.id, status: 'failed', financial_state: 'not_charged', failure_code: 'price_changed' }
      job.stage = 'creating'; await save(env, order, job)
      const result = await xQuery(env, snapshot.account, snapshot.proxy, 'useOneTimePurchaseGiftMutation', 'GqTVJ4S1526tLkxj69xIZw', {
        cancel_url: successUrl(order).replace('/success', ''), success_url: successUrl(order), external_product_id: order.stripe_product, gift_recipient: order.recipient_id,
      }, true)
      const s = result.onetimepurchase_gift
      if (s?.session_status !== 'Unpaid' || !sessionPattern.test(s.session_id)) throw new Error('invalid_checkout')
      const url = new URL(s.session_url)
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password || !url.pathname.endsWith('/pay/' + s.session_id)) throw new Error('invalid_checkout_url')
      job.session = s.session_id; job.stage = 'session'; await save(env, order, job); return running()
    }
    if (job.stage === 'creating' || job.stage === 'tokenizing') return unknown('original_request_unconfirmed')
    if (!job.session || !sessionPattern.test(job.session)) return unknown('session_missing')
    if (job.stage === 'session') {
      const page = await stripe(job.key, 'POST', `payment_pages/${job.session}/init`, { browser_locale: 'en', redirect_type: 'url' })
      guardPage(page, order, job.session, true)
      job.proof = page; job.checksum = page.init_checksum; job.stage = 'funding'
      await save(env, order, job); return running()
    }
    if (job.stage === 'funding') {
      job.card_id = await fundCard(env); job.stage = 'funded'; await save(env, order, job); return running()
    }
    if (job.stage === 'funded') {
      const billing = await giftProfile(env)
      if (!billing.configured || !billing.billing_email || !billing.billing_country || !billing.first_name || !billing.last_name) throw new Error('billing_profile_missing')
      const config = await cardConfiguration(env)
      const operation = await env.DB.prepare("SELECT provider_revision FROM card_operations WHERE reference='xgift:initial-card:v1' AND card_id=? AND status='succeeded'").bind(job.card_id!).first<{ provider_revision: string }>()
      if (!operation || operation.provider_revision !== config.revision) throw new Error('card_provider_changed')
      const card = await paymentCard(env, job.card_id!)
      const expiry = String(card.expire ?? '').match(/^(\d{2})\/(\d{2}|\d{4})$/)
      if (Number(card.id) !== job.card_id || card.product_code !== giftPolicy.preferred_product || card.status !== 'ACTIVE' || !/^\d{12,19}$/.test(String(card.card_number)) || !/^\d{3,4}$/.test(String(card.cvv)) || !expiry || !Number.isFinite(Number(card.available_amount)) || Number(card.available_amount) < 10) throw new Error('card_not_ready')
      // Card limits enforce the approved 10 USD ceiling, including a total spend cap on this card.
      job.stage = 'tokenizing'; await save(env, order, job)
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
      job.proof = page; job.checksum = page.init_checksum; job.stage = 'submitted'; job.submitted_at = Date.now()
      await save(env, order, job)
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
  } catch {
    return unknown('execution_requires_reconciliation')
  }
}
