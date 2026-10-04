import { constants, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'

export interface AlipayConfig {
  app_id: string
  seller_id: string
  app_private_key: string
  alipay_public_key: string
  environment: 'production' | 'sandbox'
}
export interface AlipayPrecreate {
  out_trade_no: string
  total_amount: string
  subject: string
  notify_url: string
  timeout_express: string
  qr_code_timeout_express: string
}
export type AlipayCloseResult = { closed: true; out_trade_no: string; trade_no?: string } |
  { closed: false; not_found: true; out_trade_no: string }
export type AlipayQueryResult = { found: false; out_trade_no: string } | {
  found: true
  out_trade_no: string
  trade_no: string
  trade_status: 'WAIT_BUYER_PAY' | 'TRADE_CLOSED' | 'TRADE_SUCCESS' | 'TRADE_FINISHED'
  total_amount: string
  app_id?: string
  seller_id?: string
}

const messages = {
  alipay_invalid_configuration: '支付宝配置格式无效，请核对应用、商户和 RSA2 密钥。',
  alipay_certificate_unsupported: '当前仅支持支付宝公钥模式，不支持证书模式。',
  alipay_invalid_request: '支付宝订单参数无效。',
  alipay_transport_unknown: '支付宝请求结果未确认，请使用原订单号查询。',
  alipay_response_invalid: '支付宝响应格式未确认，请使用原订单号查询。',
  alipay_signature_invalid: '支付宝响应验签未通过，请使用原订单号查询。',
  alipay_business_rejected: '支付宝未接受本次请求，请检查商户配置或查询原订单。',
  alipay_result_unknown: '支付宝尚未确认交易结果，请使用原订单号查询。',
  alipay_response_mismatch: '支付宝返回的订单信息不匹配，请查询原订单。',
} as const
export class AlipayError extends Error {
  readonly code: keyof typeof messages
  constructor(code: keyof typeof messages) {
    super(messages[code])
    this.name = 'AlipayError'
    this.code = code
  }
}
function fail(code: keyof typeof messages): never { throw new AlipayError(code) }

// Only these official gateways are reachable; callers cannot supply a URL.
const gateways = {
  production: 'https://openapi.alipay.com/gateway.do',
  sandbox: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
} as const
const maximumResponseBytes = 256 * 1024
const appIdPattern = /^[0-9]{16,32}$/
const sellerIdPattern = /^2088[0-9]{12}$/
const orderIdPattern = /^[A-Za-z0-9_-]{1,64}$/

function rsaKey(value: unknown, privateKey: boolean): KeyObject {
  if (typeof value !== 'string' || value.length > 32768 || !value.trim())
    return fail('alipay_invalid_configuration')
  if (value.includes('CERTIFICATE')) return fail('alipay_certificate_unsupported')
  try {
    const trimmed = value.trim()
    let key: KeyObject
    if (trimmed.startsWith('-----BEGIN ')) {
      const pattern = privateKey
        ? /^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----$/
        : /^-----BEGIN (?:RSA )?PUBLIC KEY-----[\s\S]+-----END (?:RSA )?PUBLIC KEY-----$/
      if (!pattern.test(trimmed)) return fail('alipay_invalid_configuration')
      key = privateKey ? createPrivateKey(trimmed) : createPublicKey(trimmed)
    } else {
      const raw = trimmed.replace(/\s/g, '')
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0)
        return fail('alipay_invalid_configuration')
      const der = Buffer.from(raw, 'base64')
      key = privateKey
        ? createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
        : createPublicKey({ key: der, format: 'der', type: 'spki' })
    }
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      return fail('alipay_invalid_configuration')
    return key
  } catch (error) {
    if (error instanceof AlipayError) throw error
    return fail('alipay_invalid_configuration')
  }
}

function canonical(params: Record<string, string>, notification = false) {
  return Object.keys(params).filter(key => key !== 'sign' && (!notification || key !== 'sign_type') && params[key] !== '')
    .sort().map(key => `${key}=${params[key]}`).join('&')
}
function checkSignature(content: string, signature: unknown, key: KeyObject) {
  if (typeof signature !== 'string' || signature.length > 2048 || signature.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false
  try {
    return verify('RSA-SHA256', Buffer.from(content, 'utf8'), { key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature, 'base64'))
  } catch { return false }
}

type JsonField = { raw: string; value: unknown }
// Preserve the signed substring, including whitespace, escapes and number tokens.
// Duplicate keys are rejected at every depth to avoid parser disagreements.
function objectFields(raw: string): Map<string, JsonField> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('alipay_response_invalid')
    let index = 0
    const fields = new Map<string, JsonField>()
    const whitespace = () => { while (index < raw.length && /\s/.test(raw[index])) index++ }
    const stringEnd = () => {
      index++
      while (index < raw.length) {
        if (raw[index] === '\\') index += 2
        else if (raw[index++] === '"') return
      }
      fail('alipay_response_invalid')
    }
    const valueEnd = (depth: number) => {
      if (depth > 64) return fail('alipay_response_invalid')
      whitespace()
      if (raw[index] === '"') return stringEnd()
      if (raw[index] === '{') {
        index++
        whitespace()
        const seen = new Set<string>()
        while (raw[index] !== '}') {
          const start = index
          stringEnd()
          const name = JSON.parse(raw.slice(start, index)) as string
          if (seen.has(name)) return fail('alipay_response_invalid')
          seen.add(name)
          whitespace()
          index++ // colon; full syntax was already validated by JSON.parse
          whitespace()
          const from = index
          valueEnd(depth + 1)
          if (depth === 0) {
            const content = raw.slice(from, index)
            fields.set(name, { raw: content, value: JSON.parse(content) })
          }
          whitespace()
          if (raw[index] !== ',') break
          index++
          whitespace()
        }
        index++
      } else if (raw[index] === '[') {
        index++
        whitespace()
        while (raw[index] !== ']') {
          valueEnd(depth + 1)
          whitespace()
          if (raw[index] !== ',') break
          index++
          whitespace()
        }
        index++
      } else {
        while (index < raw.length && !/[\s,}\]]/.test(raw[index])) index++
      }
    }
    valueEnd(0)
    return fields
  } catch (error) {
    if (error instanceof AlipayError) throw error
    return fail('alipay_response_invalid')
  }
}
async function responseText(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return fail('alipay_response_invalid')
  let size = 0, result = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumResponseBytes) {
        await reader.cancel()
        return fail('alipay_response_invalid')
      }
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } catch (error) {
    if (error instanceof AlipayError) throw error
    return fail('alipay_transport_unknown')
  } finally { reader.releaseLock() }
}
function amountString(value: string, request = false) {
  const pattern = request ? /^(0|[1-9][0-9]{0,8})\.([0-9]{2})$/ : /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,2}))?$/
  const match = pattern.exec(value)
  if (!match) return fail(request ? 'alipay_invalid_request' : 'alipay_response_invalid')
  const fraction = (match[2] ?? '').padEnd(2, '0')
  const cents = BigInt(match[1]) * 100n + BigInt(fraction)
  if (cents < 1n || cents > 10000000000n) return fail(request ? 'alipay_invalid_request' : 'alipay_response_invalid')
  return `${match[1]}.${fraction}`
}
function fieldString(fields: Map<string, JsonField>, name: string, pattern: RegExp) {
  const value = fields.get(name)?.value
  if (typeof value !== 'string' || !pattern.test(value)) return fail('alipay_response_invalid')
  return value
}
function checkBusinessResult(fields: Map<string, JsonField>) {
  const code = fields.get('code')?.value
  if (code === '10000') return
  // SYSTEM_ERROR and unrecognised results are not definitive rejections.
  const rejected = ['20001', '40001', '40002', '40006'].includes(String(code)) ||
    (code === '40004' && ['ACQ.INVALID_PARAMETER', 'ACQ.ACCESS_FORBIDDEN', 'ACQ.SELLER_NOT_EXIST'].includes(String(fields.get('sub_code')?.value)))
  fail(rejected ? 'alipay_business_rejected' : 'alipay_result_unknown')
}

export function createAlipayClient(config: AlipayConfig) {
  if (!config || typeof config !== 'object' || typeof config.app_id !== 'string' || !appIdPattern.test(config.app_id) ||
    typeof config.seller_id !== 'string' || !sellerIdPattern.test(config.seller_id) ||
    !Object.hasOwn(gateways, config.environment)) return fail('alipay_invalid_configuration')
  if (Object.keys(config).some(key => /cert/i.test(key))) return fail('alipay_certificate_unsupported')
  const appId = config.app_id, sellerId = config.seller_id, gateway = gateways[config.environment]
  const privateKey = rsaKey(config.app_private_key, true), publicKey = rsaKey(config.alipay_public_key, false)

  async function invoke(method: 'alipay.trade.precreate' | 'alipay.trade.query' | 'alipay.trade.close', business: Record<string, string>, notifyUrl?: string) {
    const params: Record<string, string> = {
      app_id: appId, method, format: 'JSON', charset: 'utf-8', sign_type: 'RSA2', version: '1.0',
      timestamp: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      biz_content: JSON.stringify(business), ...(notifyUrl ? { notify_url: notifyUrl } : {}),
    }
    try {
      params.sign = sign('RSA-SHA256', Buffer.from(canonical(params), 'utf8'), { key: privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64')
    } catch { return fail('alipay_invalid_configuration') }
    let response: Response
    try {
      response = await fetch(gateway, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', Accept: 'application/json' },
        body: new URLSearchParams(params).toString(), redirect: 'error', signal: AbortSignal.timeout(15000),
      })
    } catch { return fail('alipay_transport_unknown') }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      return fail('alipay_transport_unknown')
    }
    const fields = objectFields(await responseText(response))
    const envelopeKey = method.replaceAll('.', '_') + '_response'
    const content = fields.get(envelopeKey)
    if (!content || fields.has('error_response') || fields.has('alipay_cert_sn')) return fail('alipay_response_invalid')
    if (fields.has('sign_type') && fields.get('sign_type')?.value !== 'RSA2') return fail('alipay_signature_invalid')
    if (!checkSignature(content.raw, fields.get('sign')?.value, publicKey)) return fail('alipay_signature_invalid')
    return objectFields(content.raw)
  }

  return {
    async precreate(input: AlipayPrecreate): Promise<{ qr_code: string; out_trade_no: string }> {
      if (!input || typeof input !== 'object' || typeof input.out_trade_no !== 'string' || !orderIdPattern.test(input.out_trade_no) ||
        typeof input.total_amount !== 'string' || typeof input.subject !== 'string' || !input.subject.trim() ||
        input.subject.length > 256 || /[\x00-\x1f\x7f]/.test(input.subject) ||
        typeof input.timeout_express !== 'string' || !/^(?:[1-9]|1[0-5])m$/.test(input.timeout_express) ||
        input.qr_code_timeout_express !== input.timeout_express) return fail('alipay_invalid_request')
      if (typeof input.notify_url !== 'string' || input.notify_url.length > 256) return fail('alipay_invalid_request')
      try {
        const url = new URL(input.notify_url)
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) return fail('alipay_invalid_request')
      } catch { return fail('alipay_invalid_request') }
      const outTradeNo = input.out_trade_no
      const fields = await invoke('alipay.trade.precreate', {
        out_trade_no: outTradeNo, total_amount: amountString(input.total_amount, true), subject: input.subject,
        seller_id: sellerId, timeout_express: input.timeout_express, qr_code_timeout_express: input.qr_code_timeout_express,
      }, input.notify_url)
      checkBusinessResult(fields)
      const out_trade_no = fieldString(fields, 'out_trade_no', orderIdPattern)
      if (out_trade_no !== outTradeNo) return fail('alipay_response_mismatch')
      const qr_code = fieldString(fields, 'qr_code', /^https:\/\/[^\s\x00-\x1f\x7f]{1,1024}$/)
      try {
        const url = new URL(qr_code)
        if (url.username || url.password || url.port || url.hash || !['qr.alipay.com', 'qr.alipaydev.com'].includes(url.hostname)) return fail('alipay_response_invalid')
      } catch { return fail('alipay_response_invalid') }
      return { qr_code, out_trade_no }
    },
    async query(outTradeNo: string): Promise<AlipayQueryResult> {
      if (typeof outTradeNo !== 'string' || !orderIdPattern.test(outTradeNo)) return fail('alipay_invalid_request')
      const fields = await invoke('alipay.trade.query', { out_trade_no: outTradeNo })
      if (fields.get('code')?.value === '40004' && fields.get('sub_code')?.value === 'ACQ.TRADE_NOT_EXIST')
        return { found: false, out_trade_no: outTradeNo }
      checkBusinessResult(fields)
      const out_trade_no = fieldString(fields, 'out_trade_no', orderIdPattern)
      if (out_trade_no !== outTradeNo) return fail('alipay_response_mismatch')
      const trade_no = fieldString(fields, 'trade_no', /^[0-9]{16,64}$/)
      const trade_status = fieldString(fields, 'trade_status', /^(WAIT_BUYER_PAY|TRADE_CLOSED|TRADE_SUCCESS|TRADE_FINISHED)$/) as Extract<AlipayQueryResult, { found: true }>['trade_status']
      const amount = fields.get('total_amount')
      if (!amount || !['string', 'number'].includes(typeof amount.value)) return fail('alipay_response_invalid')
      const total_amount = amountString(typeof amount.value === 'string' ? amount.value : amount.raw)
      const result: AlipayQueryResult = { found: true, out_trade_no, trade_no, trade_status, total_amount }
      if (fields.has('app_id')) result.app_id = fieldString(fields, 'app_id', appIdPattern)
      if (fields.has('seller_id')) result.seller_id = fieldString(fields, 'seller_id', sellerIdPattern)
      return result
    },
    async close(outTradeNo: string): Promise<AlipayCloseResult> {
      if (typeof outTradeNo !== 'string' || !orderIdPattern.test(outTradeNo)) return fail('alipay_invalid_request')
      const fields = await invoke('alipay.trade.close', { out_trade_no: outTradeNo })
      if (fields.has('out_trade_no') && fields.get('out_trade_no')?.value !== outTradeNo)
        return fail('alipay_response_mismatch')
      if (fields.get('code')?.value === '40004' && fields.get('sub_code')?.value === 'ACQ.TRADE_NOT_EXIST')
        return { closed: false, not_found: true, out_trade_no: outTradeNo }
      // A failed close can mean already paid, still processing, or unavailable.
      // None of those results establishes closure or permission to release a slot.
      if (fields.get('code')?.value !== '10000') return fail('alipay_result_unknown')
      const out_trade_no = fieldString(fields, 'out_trade_no', orderIdPattern)
      const result: AlipayCloseResult = { closed: true, out_trade_no }
      if (fields.has('trade_no')) result.trade_no = fieldString(fields, 'trade_no', /^[0-9]{16,64}$/)
      return result
    },
    // Pass values decoded once by the form parser, with duplicate form keys rejected.
    // The caller must check order, app_id, seller_id, amount and terminal status.
    verifyNotification(params: Record<string, string>): boolean {
      try {
        if (!params || typeof params !== 'object' || Array.isArray(params) || params.sign_type !== 'RSA2' ||
          (params.charset !== undefined && params.charset.toLowerCase() !== 'utf-8')) return false
        const entries = Object.entries(params)
        if (entries.length > 256 || entries.some(([key, value]) => !/^[A-Za-z0-9_]{1,80}$/.test(key) || typeof value !== 'string') ||
          Buffer.byteLength(JSON.stringify(params), 'utf8') > maximumResponseBytes) return false
        return checkSignature(canonical(params, true), params.sign, publicKey)
      } catch { return false }
    },
  }
}
