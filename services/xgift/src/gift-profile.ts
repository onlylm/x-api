import { audit, fail, seal, text, unseal, type Env } from './core.ts'

// These are the user's approved limits. Saving billing details never charges funds.
export const giftPolicy = {
  preferred_product: 'PP5583RC',
  initial_card_usd_cents: 2000,
  max_open_fee_usd_cents: 50,
  daily_funding_usd_cents: 2000,
  initial_order_max_usd_cents: 1000,
} as const

export interface GiftProfile {
  first_name: string
  last_name: string
  billing_email: string
  billing_country: string
  billing_line1: string
  billing_line2: string
  billing_city: string
  billing_state: string
  billing_postal_code: string
}
export async function giftProfile(env: Env) {
  const row = await env.DB.prepare('SELECT payload,updated_at FROM gift_profile WHERE id=1')
    .first<{ payload: string; updated_at: number }>()
  if (!row) return { configured: false, policy: giftPolicy }
  const profile: GiftProfile = JSON.parse(await unseal(env, 'gift-profile', row.payload))
  return {
    configured: true,
    first_name: profile.first_name,
    last_name: profile.last_name,
    billing_email: profile.billing_email,
    billing_country: profile.billing_country,
    billing_line1: profile.billing_line1 ?? '',
    billing_line2: profile.billing_line2 ?? '',
    billing_city: profile.billing_city ?? '',
    billing_state: profile.billing_state ?? '',
    billing_postal_code: profile.billing_postal_code ?? '',
    updated_at: row.updated_at,
    policy: giftPolicy,
  }
}
export async function configureGiftProfile(env: Env, body: Record<string, unknown>) {
  const first_name = text(body.first_name, '持卡人英文名', 80)
  const last_name = text(body.last_name, '持卡人英文姓', 80)
  if (![first_name, last_name].every(v => /^[A-Za-z][A-Za-z .'-]*$/.test(v)))
    fail('invalid_input', '持卡人姓名请填写真实英文或拼音姓名。')
  const billing_email = text(body.billing_email, '账单邮箱', 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billing_email))
    fail('invalid_input', '账单邮箱格式无效。')
  const billing_country = text(body.billing_country, '账单国家两位代码', 2).toUpperCase()
  // Validate ISO 3166-1 alpha-2, rather than assuming a region from the card BIN or proxy.
  const countries = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '))
  if (!countries.has(billing_country)) fail('invalid_input', '账单国家代码无效。')
  function address(key: string, maximum: number) {
    const value = body[key] ?? ''
    if (typeof value !== 'string' || value.trim().length > maximum || /[\x00-\x1f\x7f]/.test(value))
      return fail('invalid_input', '账单地址格式或长度无效。')
    return value.trim()
  }
  const profile: GiftProfile = {
    first_name, last_name, billing_email, billing_country,
    billing_line1: address('billing_line1', 200),
    billing_line2: address('billing_line2', 200),
    billing_city: address('billing_city', 100),
    billing_state: address('billing_state', 100),
    billing_postal_code: address('billing_postal_code', 20),
  }
  await env.DB.prepare('INSERT INTO gift_profile VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at')
    .bind(await seal(env, 'gift-profile', JSON.stringify(profile)), Date.now()).run()
  await audit(env, 'admin', 'configure_gift_profile', 'gift-profile')
  return { saved: true }
}
