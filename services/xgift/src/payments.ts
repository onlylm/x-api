import { audit, booleanInt, fail, id, integer, seal, text, unseal, type Env } from './core.ts'
import { cardConfiguration, cardRead } from './cards.ts'
import { giftProfile, type GiftProfile } from './gift-profile.ts'
import { admissionView } from './admission.ts'

type Row = Record<string, unknown>
type StoredRow = { enabled: number; revision: string; payload: string; updated_at: number }
export interface PaymentSettings {
  enabled: boolean
  revision: string
  stripe_publishable_key: string
  card_id: number | null
  provider_revision: string | null
  selected_card: Row | null
  backup_card_ids: number[]
  backup_cards: Row[]
  card_checked_at: number | null
  updated_at: number
}
export interface PaymentBinding {
  revision: string
  card_id: number
  backup_card_ids?: number[]
  provider_revision: string
  stripe_publishable_key: string
  billing: GiftProfile
}
const keyValid = (key: string) => /^pk_live_[A-Za-z0-9]{1,240}$/.test(key)
const unsettled = "SELECT 1 FROM orders WHERE status IN('queued','running','unknown') UNION ALL SELECT 1 FROM alipay_checkouts WHERE status IN('creating','pending','paid','attention')"
const blank = { stripe_publishable_key: '', card_id: null, provider_revision: null, selected_card: null,
  backup_card_ids: [], backup_cards: [], card_checked_at: null }

export async function paymentSettings(env: Env): Promise<PaymentSettings | null> {
  const row = await env.DB.prepare('SELECT * FROM payment_settings WHERE id=1').first<StoredRow>()
  if (!row) return null
  const payload = JSON.parse(await unseal(env, 'payment-settings', row.payload))
  return { ...payload, backup_card_ids: payload.backup_card_ids ?? [], backup_cards: payload.backup_cards ?? [],
    enabled: !!row.enabled, revision: row.revision, updated_at: row.updated_at }
}

/** Resolve per request/tick; never mutate the long-lived environment captured at boot. */
export async function resolvePaymentEnv(env: Env): Promise<Env> {
  const settings = await paymentSettings(env)
  if (!settings) return env.PAYMENTS_LOCKED === 'true' ? { ...env, PAYMENTS_ENABLED: 'false' } : env
  const current = await cardConfiguration(env)
  const effective: Env = { ...env, PAYMENT_SETTINGS: settings,
    PAYMENTS_ENABLED: settings.enabled && env.PAYMENTS_LOCKED !== 'true' && !!settings.card_id &&
      settings.provider_revision === current.revision && current.environment === 'production' && current.transport === 'direct'
      ? 'true' : 'false',
    STRIPE_PUBLISHABLE_KEY: settings.stripe_publishable_key,
    LOCAL_EXECUTOR: undefined,
  }
  if (env.NATIVE_EXECUTOR) effective.LOCAL_EXECUTOR = (order, snapshot) => env.NATIVE_EXECUTOR!(effective, order, snapshot)
  return effective
}

function safeSelection(card: Row, cardId: number) {
  if (Number(card.id) !== cardId || card.status !== 'ACTIVE' ||
      !/^\d{4}$/.test(String(card.last_four ?? '')) ||
      !Number.isFinite(Number(card.available_amount)) || Number(card.available_amount) < 10)
    fail('payment_card_not_ready', '主卡及每张备用卡均须可用、尾号有效且余额不少于 10 USD；不会自动充值或选择未授权卡。', 409)
  return Object.fromEntries(['id', 'last_four', 'network', 'status', 'product_code', 'available_amount'].map(k => [k, card[k] ?? null]))
}

async function verifiedCard(env: Env, cardId: number, revision: string) {
  const config = await cardConfiguration(env)
  if (!config.configured || config.environment !== 'production' || config.transport !== 'direct')
    fail('payment_provider_not_ready', '请先配置正式环境、服务直连的卡台。无需开启开卡／充值。', 409)
  if (config.revision !== revision) fail('payment_provider_changed', '卡台配置已变化，请刷新并重新选择卡片。', 409)
  const selected = safeSelection(await cardRead(env, 'card', 1, cardId) as Row, cardId)
  if ((await cardConfiguration(env)).revision !== revision)
    fail('payment_provider_changed', '卡台配置已变化，请刷新并重新选择卡片。', 409)
  return selected
}

function backupCardIds(value: unknown, primary: number) {
  if (!Array.isArray(value) || value.length > 3)
    return fail('invalid_input', '备用卡须为最多 3 张指定卡 ID 的数组。')
  const ids = value.map(value => integer(value, '备用卡 ID'))
  if (new Set([primary, ...ids]).size !== ids.length + 1)
    return fail('invalid_input', '主卡与备用卡不可重复，备用卡之间也不可重复。')
  return ids
}

async function verifiedCardSet(env: Env, primary: number, backups: number[], revision: string) {
  // The caller validates at most three backups. Parallel reads remain bounded
  // to four cards; every read verifies the same provider revision before/after.
  const [selected, ...backupCards] = await Promise.all([primary, ...backups].map(card => verifiedCard(env, card, revision)))
  return { selected, backupCards }
}

export async function paymentView(env: Env) {
  const settings = await paymentSettings(env)
  const config = await cardConfiguration(env)
  const profile = await giftProfile(env)
  const counts = await env.DB.prepare(`SELECT
    ((SELECT COUNT(*) FROM orders WHERE status IN('queued','running','unknown')) +
     (SELECT COUNT(*) FROM alipay_checkouts WHERE status IN('creating','pending','paid','attention'))) pending,
    (SELECT COUNT(*) FROM secrets WHERE kind='account' AND enabled=1) accounts,
    (SELECT COUNT(*) FROM products WHERE enabled=1 AND currency='bdt' AND
      ((months=3 AND amount_minor=30000 AND stripe_product='prod_TJXJtpzqCpI36N') OR
       (months=6 AND amount_minor=60000 AND stripe_product='prod_TJXKKNJwZJIhCM'))) products`).first<{ pending: number; accounts: number; products: number }>()
  const native = !!env.NATIVE_EXECUTOR
  const card = settings?.selected_card ?? null
  const backups = settings?.backup_cards ?? [], backupIds = settings?.backup_card_ids ?? []
  const checks = [
    { code: 'configured', label: '已保存后台支付配置', ok: !!settings?.card_id },
    { code: 'native', label: '服务器支持原生支付执行器', ok: native },
    { code: 'unlocked', label: '服务器未设置紧急停付锁', ok: env.PAYMENTS_LOCKED !== 'true' },
    { code: 'public_key', label: 'X 支付公钥格式有效（仍需首单验收）', ok: keyValid(settings?.stripe_publishable_key ?? '') },
    { code: 'provider', label: '卡台为正式环境、服务直连', ok: !!config.configured && config.environment === 'production' && config.transport === 'direct' },
    { code: 'provider_revision', label: '指定卡所属卡台未变更', ok: !!settings?.provider_revision && settings.provider_revision === config.revision },
    { code: 'card', label: '上次检查指定卡可用且余额不少于 10 USD（启用时重查）', ok: !!card && card.status === 'ACTIVE' && Number(card.available_amount) >= 10 },
    { code: 'backup_cards', label: '指定备用卡上次检查可用且余额不少于 10 USD（未指定则不自动换卡，启用时重查）',
      ok: backups.length === backupIds.length && backupIds.every((cardId, index) => Number(backups[index]?.id) === cardId &&
        backups[index]?.status === 'ACTIVE' && Number(backups[index]?.available_amount) >= 10) },
    { code: 'billing', label: '已配置真实持卡人和账单资料', ok: profile.configured },
    { code: 'account', label: '已有启用的 X 赠送账号', ok: (counts?.accounts ?? 0) > 0 },
    { code: 'product', label: '已启用符合验收规则的 BDT 赠送套餐', ok: (counts?.products ?? 0) > 0 },
  ]
  const ready = checks.every(c => c.ok)
  const effective = await resolvePaymentEnv(env)
  const admission = await admissionView(effective)
  const execution = !!effective.LOCAL_EXECUTOR && effective.PAYMENTS_ENABLED === 'true' && keyValid(effective.STRIPE_PUBLISHABLE_KEY ?? '')
  return {
    configured: !!settings?.card_id, revision: settings?.revision ?? null,
    enabled: settings?.enabled ?? env.PAYMENTS_ENABLED === 'true',
    source: settings ? 'database' : 'environment', native_available: native,
    stripe_publishable_key: settings?.stripe_publishable_key ?? '', selected_card: card,
    backup_card_ids: backupIds, backup_cards: backups,
    card_checked_at: settings?.card_checked_at ?? null,
    provider_revision: config.revision, selected_provider_revision: settings?.provider_revision ?? null,
    checks, ready_to_enable: ready, execution_ready: execution,
    accepts_orders: execution && admission.accepts_orders,
    admission, has_unsettled_orders: (counts?.pending ?? 0) > 0,
  }
}

export async function configurePayments(env: Env, body: Row) {
  const current = await paymentSettings(env)
  if (body.revision !== (current?.revision ?? null)) fail('payment_config_conflict', '配置已更新，请刷新后再保存。', 409)
  if (current?.enabled || (!current && env.PAYMENTS_ENABLED === 'true'))
    fail('payments_must_be_paused', '请先暂停支付，再修改公钥或指定卡。', 409)
  if (await env.DB.prepare(unsettled + ' LIMIT 1').first())
    fail('payment_orders_pending', '仍有未结订单，请核对原订单后再修改支付配置。', 409)
  if (!env.NATIVE_EXECUTOR) fail('native_executor_unavailable', '当前运行环境不支持后台原生支付配置。', 409)
  const key = text(body.stripe_publishable_key, 'X 支付公钥', 248)
  if (!keyValid(key)) fail('invalid_input', '请填写从 X 官方客户端核实的 pk_live_ 公钥，不要填写私钥。')
  // HTML selects submit strings. Normalize only exact decimal IDs here; keep
  // strict numeric/range validation for card IDs and all other integer inputs.
  const rawCardId = body.card_id
  const numericCardId = typeof rawCardId === 'string' && /^[1-9][0-9]{0,9}$/.exec(rawCardId)?.[0] === rawCardId
    ? Number(rawCardId) : rawCardId
  const cardId = integer(numericCardId, '指定卡 ID')
  // An older admin client omitting this field must not silently revoke the
  // approved backup list; an explicit [] clears it.
  const backupIds = backupCardIds(Object.hasOwn(body, 'backup_card_ids') ? body.backup_card_ids : current?.backup_card_ids ?? [], cardId)
  const providerRevision = text(body.provider_revision, '卡台配置版本', 64)
  if (current?.backup_card_ids.length && current.provider_revision !== providerRevision && !Object.hasOwn(body, 'backup_card_ids'))
    return fail('payment_provider_changed', '卡台连接已变化，请重新明确选择备用卡；也可提交空列表清除原备用卡。', 409)
  const { selected, backupCards } = await verifiedCardSet(env, cardId, backupIds, providerRevision)
  const now = Math.max(Date.now(), (current?.updated_at ?? 0) + 1)
  const revision = id('paycfg')
  const payload = await seal(env, 'payment-settings', JSON.stringify({ stripe_publishable_key: key,
    card_id: cardId, backup_card_ids: backupIds, backup_cards: backupCards,
    provider_revision: providerRevision, selected_card: selected, card_checked_at: now }))
  const changed = current
    ? await env.DB.prepare(`UPDATE payment_settings SET revision=?,payload=?,updated_at=? WHERE id=1 AND enabled=0 AND revision=? AND updated_at=?
        AND NOT EXISTS(${unsettled}) AND EXISTS(SELECT 1 FROM card_provider WHERE id=1 AND revision=?) RETURNING id`)
      .bind(revision, payload, now, current.revision, current.updated_at, providerRevision).first()
    : await env.DB.prepare(`INSERT INTO payment_settings(id,enabled,revision,payload,updated_at) SELECT 1,0,?,?,?
        WHERE NOT EXISTS(SELECT 1 FROM payment_settings) AND NOT EXISTS(${unsettled})
        AND EXISTS(SELECT 1 FROM card_provider WHERE id=1 AND revision=?) ON CONFLICT(id) DO NOTHING RETURNING id`)
      .bind(revision, payload, now, providerRevision).first()
  if (!changed) fail('payment_config_conflict', '配置或订单状态刚发生变化，请刷新后重新核对。', 409)
  await audit(env, 'admin', 'configure_payments', revision, 'selected_existing_card')
  return paymentView(env)
}

export async function setPaymentsEnabled(env: Env, body: Row) {
  const enabled = booleanInt(body.enabled)
  if (!enabled) {
    // An emergency pause must work even when the provider is unreachable or the UI is stale.
    const payload = await seal(env, 'payment-settings', JSON.stringify(blank))
    await env.DB.prepare(`INSERT INTO payment_settings VALUES(1,0,?,?,?) ON CONFLICT(id)
      DO UPDATE SET enabled=0,updated_at=MAX(payment_settings.updated_at+1,excluded.updated_at)`)
      .bind(id('paycfg'), payload, Date.now()).run()
    await audit(env, 'admin', 'pause_payments', 'payments')
    // Do not turn a successful emergency pause into an error by contacting a broken provider.
    return { paused: true, enabled: false }
  }
  const current = await paymentSettings(env)
  const now = Math.max(Date.now(), (current?.updated_at ?? 0) + 1)
  if (body.confirmation !== 'ENABLE_PAYMENTS') fail('confirmation_required', '请输入 ENABLE_PAYMENTS 确认允许真实付款。')
  if (!current?.card_id || !current.provider_revision) return fail('payment_configuration_missing', '请先保存支付公钥和指定卡。', 409)
  if (body.revision !== current.revision) fail('payment_config_conflict', '配置已更新，请刷新后再启用。', 409)
  const view = await paymentView(env)
  if (!view.ready_to_enable) fail('payment_not_ready', '尚有支付前置条件未满足，请查看后台检查列表。', 409)
  const backupIds = backupCardIds(current.backup_card_ids, current.card_id)
  const { selected, backupCards } = await verifiedCardSet(env, current.card_id, backupIds, current.provider_revision)
  const payload = await seal(env, 'payment-settings', JSON.stringify({ stripe_publishable_key: current.stripe_publishable_key,
    card_id: current.card_id, backup_card_ids: backupIds, backup_cards: backupCards,
    provider_revision: current.provider_revision, selected_card: selected, card_checked_at: now }))
  const changed = await env.DB.prepare(`UPDATE payment_settings SET enabled=1,payload=?,updated_at=?
    WHERE id=1 AND revision=? AND updated_at=? AND EXISTS(SELECT 1 FROM card_provider WHERE id=1 AND revision=?) RETURNING id`)
    .bind(payload, now, current.revision, current.updated_at, current.provider_revision).first()
  if (!changed) fail('payment_config_conflict', '配置或启停状态刚发生变化，请刷新后重试。', 409)
  await audit(env, 'admin', 'enable_payments', current.revision, 'selected_existing_card')
  return paymentView(env)
}

export async function paymentBinding(env: Env): Promise<PaymentBinding | null> {
  const settings = await paymentSettings(env)
  if (!settings) return null
  if (!settings.card_id || !settings.provider_revision || !keyValid(settings.stripe_publishable_key))
    return fail('payment_configuration_missing', '指定卡支付配置不完整。', 503)
  const profile = await giftProfile(env)
  if (!profile.configured || !('first_name' in profile)) fail('billing_profile_missing', '请先配置账单资料。', 503)
  const billing = Object.fromEntries(['first_name', 'last_name', 'billing_email', 'billing_country', 'billing_line1',
    'billing_line2', 'billing_city', 'billing_state', 'billing_postal_code'].map(k => [k, (profile as unknown as Row)[k] ?? ''])) as unknown as GiftProfile
  const binding = { revision: settings.revision, card_id: settings.card_id, provider_revision: settings.provider_revision,
    backup_card_ids: [...settings.backup_card_ids], stripe_publishable_key: settings.stripe_publishable_key, billing }
  await assertPaymentAllowed(env, binding)
  return binding
}

/** Re-read before side effects, including after awaits. Submitted payments may only be polled. */
export async function assertPaymentAllowed(env: Env, binding?: PaymentBinding | null, orderId?: string) {
  if (env.PAYMENTS_LOCKED === 'true') fail('payments_paused', '服务器紧急停付锁已开启。', 503)
  if (orderId && await env.DB.prepare(`SELECT 1 FROM alipay_checkouts a JOIN orders o
      ON a.order_id=o.id OR (o.merchant_order_no='alipay:'||a.id AND o.user_id=?)
      WHERE o.id=? AND (a.paid_at IS NULL OR a.failure_code IN('payment_closed_unconfirmed','payment_late_success_unconfirmed','alipay_sandbox_no_fulfillment')) LIMIT 1`)
    .bind('usr_' + '0'.repeat(28) + 'a11a', orderId).first())
    fail('collection_requires_review', '支付宝收款状态需要核对，停止提交新的 X 付款。', 503)
  const current = await paymentSettings(env)
  if (!current) {
    if (binding || env.PAYMENTS_ENABLED !== 'true') fail('payments_paused', '支付已暂停。', 503)
    return
  }
  if (!current.enabled) fail('payments_paused', '支付已暂停。', 503)
  if (!binding || current.revision !== binding.revision || current.card_id !== binding.card_id ||
      JSON.stringify(current.backup_card_ids) !== JSON.stringify(binding.backup_card_ids ?? []) ||
      current.provider_revision !== binding.provider_revision || current.stripe_publishable_key !== binding.stripe_publishable_key)
    return fail('payment_configuration_changed', '原订单支付配置不匹配，停止处理并核对原订单。', 503)
  const provider = await cardConfiguration(env)
  if (provider.revision !== binding.provider_revision || provider.environment !== 'production' || provider.transport !== 'direct')
    fail('card_provider_changed', '指定卡所属卡台已变化，停止处理并核对原订单。', 503)
}
