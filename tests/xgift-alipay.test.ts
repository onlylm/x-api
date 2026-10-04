import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { AlipayError, createAlipayClient, type AlipayConfig, type AlipayPrecreate } from '../services/xgift/server/alipay.ts'

// Generated locally for each test process. No merchant credentials or live calls.
const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 })
const provider = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config: AlipayConfig = {
  app_id: '2021000000000001',
  seller_id: '2088000000000001',
  app_private_key: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  alipay_public_key: provider.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  environment: 'production',
}
const input: AlipayPrecreate = {
  out_trade_no: 'topup_fixture_0001',
  total_amount: '18.90',
  subject: '点数充值 & order=fixture + 100%',
  notify_url: 'https://x-api.example.test/api/alipay/notify',
  timeout_express: '15m',
  qr_code_timeout_express: '15m',
}
type Context = Parameters<Parameters<typeof test>[1]>[0]
function canonical(params: Record<string, string>, notification = false) {
  return Object.keys(params).filter(key => key !== 'sign' && (!notification || key !== 'sign_type') && params[key] !== '')
    .sort().map(key => key + '=' + params[key]).join('&')
}
function signedResponse(method: 'precreate' | 'query' | 'close', raw: string, options: { signature?: string; first?: boolean } = {}) {
  const signature = options.signature ?? sign('RSA-SHA256', Buffer.from(raw), provider.privateKey).toString('base64')
  const name = '"alipay_trade_' + method + '_response":'
  return new Response(options.first
    ? '{ "sign":' + JSON.stringify(signature) + ', ' + name + raw + ' }'
    : '{ ' + name + raw + ', "sign":' + JSON.stringify(signature) + ' }')
}
const precreateRaw = () => JSON.stringify({ code: '10000', msg: 'Success', out_trade_no: input.out_trade_no, qr_code: 'https://qr.alipay.com/fixture' })
const queryBody = (patch: Record<string, unknown> = {}) => ({
  code: '10000', msg: 'Success', out_trade_no: input.out_trade_no,
  trade_no: '2026100522000000000000000001', trade_status: 'TRADE_SUCCESS', total_amount: '18.90',
  ...patch,
})
function expectError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AlipayError)
    assert.equal(error.code, code)
    assert.doesNotMatch(String(error) + JSON.stringify(error), /BEGIN|PRIVATE|secret_payload|buyer@example|request_body/)
    assert.equal(error.cause, undefined)
    return true
  }
}
function mock(t: Context, handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    assert.match(String(url), /^https:\/\/(?:openapi\.alipay\.com|openapi-sandbox\.dl\.alipaydev\.com)\/gateway\.do$/)
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal)
    return handler(String(url), init)
  })
}

test('precreate signs the original UTF-8 sorted form, includes RSA2 and fixes the merchant', async t => {
  let calls = 0
  t.mock.method(Date, 'now', () => Date.parse('2026-10-05T00:00:00Z'))
  mock(t, (url, init) => {
    calls++
    assert.equal(url, 'https://openapi.alipay.com/gateway.do')
    assert.match(new Headers(init.headers).get('Content-Type')!, /^application\/x-www-form-urlencoded/)
    const params = Object.fromEntries(new URLSearchParams(String(init.body)))
    const business = JSON.parse(params.biz_content)
    assert.equal(params.app_id, config.app_id)
    assert.equal(params.method, 'alipay.trade.precreate')
    assert.equal(params.sign_type, 'RSA2')
    assert.equal(params.charset, 'utf-8')
    assert.equal(params.timestamp, '2026-10-05 08:00:00')
    assert.equal(params.notify_url, input.notify_url)
    assert.deepEqual(business, {
      out_trade_no: input.out_trade_no, total_amount: input.total_amount, subject: input.subject,
      seller_id: config.seller_id, timeout_express: input.timeout_express, qr_code_timeout_express: input.qr_code_timeout_express,
    })
    assert.equal(verify('RSA-SHA256', Buffer.from(canonical(params)), merchant.publicKey, Buffer.from(params.sign, 'base64')), true)
    assert.equal(verify('RSA-SHA256', Buffer.from(canonical(params, true)), merchant.publicKey, Buffer.from(params.sign, 'base64')), false)
    assert.doesNotMatch(String(init.body), /PRIVATE|MIIEv/)
    return signedResponse('precreate', precreateRaw())
  })
  assert.deepEqual(await createAlipayClient(config).precreate(input), {
    out_trade_no: input.out_trade_no, qr_code: 'https://qr.alipay.com/fixture',
  })
  assert.equal(calls, 1)
})

test('base64 PKCS8/SPKI keys work and sandbox uses only the official sandbox gateway', async t => {
  mock(t, (url, init) => {
    assert.equal(url, 'https://openapi-sandbox.dl.alipaydev.com/gateway.do')
    const params = Object.fromEntries(new URLSearchParams(String(init.body)))
    assert.equal(verify('RSA-SHA256', Buffer.from(canonical(params)), merchant.publicKey, Buffer.from(params.sign, 'base64')), true)
    return signedResponse('precreate', precreateRaw())
  })
  const client = createAlipayClient({
    ...config, environment: 'sandbox',
    app_private_key: merchant.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    alipay_public_key: provider.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  })
  assert.equal((await client.precreate(input)).out_trade_no, input.out_trade_no)
})

test('invalid identity, arbitrary gateway environment, certificate mode and weak keys are rejected locally', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  for (const patch of [
    { app_id: 'not-an-app' }, { app_id: 2021000000000001 }, { seller_id: '208800000000001' },
    { environment: 'https://attacker.test' }, { environment: 'toString' },
    { app_private_key: 'secret_payload' }, { alipay_public_key: config.app_private_key },
    { app_private_key: weak.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    { alipay_public_key: weak.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    { app_private_key: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  ]) assert.throws(() => createAlipayClient({ ...config, ...patch } as AlipayConfig), expectError('alipay_invalid_configuration'))
  for (const patch of [
    { alipay_public_key: '-----BEGIN CERTIFICATE-----\nsecret_payload\n-----END CERTIFICATE-----' },
    { app_cert_path: 'not-a-real-path' },
  ]) assert.throws(() => createAlipayClient({ ...config, ...patch }), expectError('alipay_certificate_unsupported'))
})

test('precreate rejects noncanonical money and malformed request fields before dispatch', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('invalid input must not reach a gateway'))
  const client = createAlipayClient(config)
  for (const value of ['18.9', '1e2', '0.00', '-1.00', '01.00', '18.901', ' 18.90', '100000000.01', 18.9, null])
    await assert.rejects(client.precreate({ ...input, total_amount: value } as AlipayPrecreate), expectError('alipay_invalid_request'))
  for (const patch of [
    { out_trade_no: '../bad' }, { out_trade_no: 'x'.repeat(65) }, { subject: '' }, { subject: 'bad\nsubject' },
    { notify_url: 'javascript:alert(1)' }, { notify_url: 'http://x-api.example.test/notify' },
    { notify_url: 'https://user:secret@x-api.example.test/notify' }, { notify_url: 'https://x-api.example.test/notify#fragment' },
    { timeout_express: '0m' }, { timeout_express: '2w' }, { timeout_express: '16d' },
  ]) await assert.rejects(client.precreate({ ...input, ...patch }), expectError('alipay_invalid_request'))
})

test('response verification preserves whitespace, escaped slash, brace characters and signature ordering', async t => {
  const raw = '{\n "code" : "10000", "msg":"brace } quote \\" sign text",\n' +
    '"out_trade_no":"' + input.out_trade_no + '", "qr_code" : "https:\\/\\/qr.alipay.com\\/fixture", "extra":[{"text":"{nested}"}]\n}'
  mock(t, () => signedResponse('precreate', raw, { first: true }))
  assert.equal((await createAlipayClient(config).precreate(input)).qr_code, 'https://qr.alipay.com/fixture')
})

test('precreate bounds and signs both matching scan and payment deadlines between one and fifteen minutes', async t => {
  const observed: string[] = []
  mock(t, (_url, init) => {
    const params = Object.fromEntries(new URLSearchParams(String(init.body)))
    const business = JSON.parse(params.biz_content)
    assert.equal(business.qr_code_timeout_express, business.timeout_express)
    observed.push(business.qr_code_timeout_express)
    assert.equal(verify('RSA-SHA256', Buffer.from(canonical(params)), merchant.publicKey, Buffer.from(params.sign, 'base64')), true)
    return signedResponse('precreate', precreateRaw())
  })
  const client = createAlipayClient(config)
  for (const deadline of ['1m', '7m', '15m'])
    await client.precreate({ ...input, timeout_express: deadline, qr_code_timeout_express: deadline })
  assert.deepEqual(observed, ['1m', '7m', '15m'])
  for (const patch of [
    { qr_code_timeout_express: undefined }, { qr_code_timeout_express: '14m' },
    { timeout_express: '16m', qr_code_timeout_express: '16m' },
    { timeout_express: '0m', qr_code_timeout_express: '0m' },
    { timeout_express: '1h', qr_code_timeout_express: '1h' },
    { timeout_express: '01m', qr_code_timeout_express: '01m' },
  ]) await assert.rejects(client.precreate({ ...input, ...patch } as AlipayPrecreate), expectError('alipay_invalid_request'))
  assert.equal(observed.length, 3)
})

test('close uses a signed fixed-gateway request and only accepts a signed matching success', async t => {
  mock(t, (_url, init) => {
    const params = Object.fromEntries(new URLSearchParams(String(init.body)))
    assert.equal(params.method, 'alipay.trade.close')
    assert.deepEqual(JSON.parse(params.biz_content), { out_trade_no: input.out_trade_no })
    assert.equal(verify('RSA-SHA256', Buffer.from(canonical(params)), merchant.publicKey, Buffer.from(params.sign, 'base64')), true)
    return signedResponse('close', '{ "code":"10000", "out_trade_no":"' + input.out_trade_no +
      '", "trade_no":"2026100522000000000000000001", "msg":"Success" }', { first: true })
  })
  assert.deepEqual(await createAlipayClient(config).close(input.out_trade_no), {
    closed: true, out_trade_no: input.out_trade_no, trade_no: '2026100522000000000000000001',
  })
})

test('close not-found needs an authentic response and other business results remain unknown', async t => {
  let payload: Record<string, unknown> = { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' }
  let signature: string | undefined
  mock(t, () => signedResponse('close', JSON.stringify(payload), { signature }))
  const client = createAlipayClient(config)
  assert.deepEqual(await client.close(input.out_trade_no), { closed: false, not_found: true, out_trade_no: input.out_trade_no })
  signature = 'invalid'
  await assert.rejects(client.close(input.out_trade_no), expectError('alipay_signature_invalid'))
  signature = undefined
  for (payload of [
    { code: '40004', sub_code: 'ACQ.TRADE_HAS_SUCCESS' }, { code: '20000', sub_code: 'ACQ.SYSTEM_ERROR' },
    { code: '40004', sub_code: 'ACQ.INVALID_PARAMETER' }, { code: '40004', sub_code: 'ACQ.TRADE_STATUS_ERROR' },
  ]) await assert.rejects(client.close(input.out_trade_no), expectError('alipay_result_unknown'))
  payload = { code: '10000', out_trade_no: 'different_order' }
  await assert.rejects(client.close(input.out_trade_no), expectError('alipay_response_mismatch'))
  payload = { code: '10000' }
  await assert.rejects(client.close(input.out_trade_no), expectError('alipay_response_invalid'))
})

test('close transport loss, redirects and unsigned responses cannot release an invoice', async t => {
  let response: () => Response = () => { throw new Error('secret_payload') }
  let calls = 0
  mock(t, () => { calls++; return response() })
  const client = createAlipayClient(config)
  await assert.rejects(client.close(input.out_trade_no), expectError('alipay_transport_unknown'))
  assert.equal(calls, 1)
  response = () => new Response('secret_payload', { status: 302, headers: { Location: 'https://attacker.test' } })
  await assert.rejects(client.close(input.out_trade_no), expectError('alipay_transport_unknown'))
  response = () => Response.json({ alipay_trade_close_response: { code: '10000', out_trade_no: input.out_trade_no } })
  await assert.rejects(client.close(input.out_trade_no), expectError('alipay_signature_invalid'))
  await assert.rejects(client.close('../invalid'), expectError('alipay_invalid_request'))
  assert.equal(calls, 3)
})

test('unsigned, tampered, wrong-key and SHA1 responses cannot provide a QR code', async t => {
  let response: () => Response = () => new Response(JSON.stringify({ alipay_trade_precreate_response: JSON.parse(precreateRaw()) }))
  mock(t, () => response())
  const client = createAlipayClient(config)
  await assert.rejects(client.precreate(input), expectError('alipay_signature_invalid'))
  const original = precreateRaw()
  response = () => signedResponse('precreate', original.replace('/fixture', '/changed'), {
    signature: sign('RSA-SHA256', Buffer.from(original), provider.privateKey).toString('base64'),
  })
  await assert.rejects(client.precreate(input), expectError('alipay_signature_invalid'))
  response = () => signedResponse('precreate', original, { signature: sign('RSA-SHA256', Buffer.from(original), merchant.privateKey).toString('base64') })
  await assert.rejects(client.precreate(input), expectError('alipay_signature_invalid'))
  response = () => signedResponse('precreate', original, { signature: sign('RSA-SHA1', Buffer.from(original), provider.privateKey).toString('base64') })
  await assert.rejects(client.precreate(input), expectError('alipay_signature_invalid'))
})

test('duplicate JSON members are rejected, including escaped duplicate keys and duplicate envelopes', async t => {
  let raw = '{"code":"10000","code":"10000","out_trade_no":"' + input.out_trade_no + '","qr_code":"https://qr.alipay.com/fixture"}'
  let response: () => Response = () => signedResponse('precreate', raw)
  mock(t, () => response())
  const client = createAlipayClient(config)
  await assert.rejects(client.precreate(input), expectError('alipay_response_invalid'))
  raw = raw.replace('"code":"10000","code"', '"code":"10000","co\\u0064e"')
  await assert.rejects(client.precreate(input), expectError('alipay_response_invalid'))
  response = () => new Response('{"alipay_trade_precreate_response":' + precreateRaw() +
    ',"alipay_trade_precreate_response":' + precreateRaw() + ',"sign":"anything"}')
  await assert.rejects(client.precreate(input), expectError('alipay_response_invalid'))
})

test('signed mismatched order and non-Alipay or unsafe QR URLs are rejected', async t => {
  let patch: Record<string, unknown> = { out_trade_no: 'different_order' }
  mock(t, () => signedResponse('precreate', JSON.stringify({ ...JSON.parse(precreateRaw()), ...patch })))
  const client = createAlipayClient(config)
  await assert.rejects(client.precreate(input), expectError('alipay_response_mismatch'))
  for (const qr_code of ['https://attacker.test/pay', 'javascript:alert(1)', 'https://user@qr.alipay.com/pay', 'https://qr.alipay.com.attacker.test/pay']) {
    patch = { qr_code }
    await assert.rejects(client.precreate(input), expectError('alipay_response_invalid'))
  }
})

test('query returns only signed allowlisted fields and does not invent absent app or seller identity', async t => {
  mock(t, (_url, init) => {
    const params = Object.fromEntries(new URLSearchParams(String(init.body)))
    assert.equal(params.method, 'alipay.trade.query')
    assert.deepEqual(JSON.parse(params.biz_content), { out_trade_no: input.out_trade_no })
    return signedResponse('query', JSON.stringify(queryBody({
      buyer_logon_id: 'buyer@example.test', buyer_user_id: '2088000000000002', extra: 'secret_payload',
    })))
  })
  const result = await createAlipayClient(config).query(input.out_trade_no)
  assert.deepEqual(result, {
    found: true, out_trade_no: input.out_trade_no, trade_no: '2026100522000000000000000001',
    trade_status: 'TRADE_SUCCESS', total_amount: '18.90',
  })
  assert.doesNotMatch(JSON.stringify(result), /buyer|secret_payload/)
  assert.equal(Object.hasOwn(result, 'app_id'), false)
  assert.equal(Object.hasOwn(result, 'seller_id'), false)
})

test('query preserves each authenticated trade state without promoting pending or closed orders', async t => {
  let trade_status = 'WAIT_BUYER_PAY'
  mock(t, () => signedResponse('query', JSON.stringify(queryBody({ trade_status, app_id: config.app_id, seller_id: config.seller_id }))))
  const client = createAlipayClient(config)
  for (trade_status of ['WAIT_BUYER_PAY', 'TRADE_CLOSED', 'TRADE_SUCCESS', 'TRADE_FINISHED']) {
    const result = await client.query(input.out_trade_no)
    assert.equal(result.found, true)
    if (!result.found) assert.fail('signed existing order expected')
    assert.equal(result.trade_status, trade_status)
    assert.equal(result.app_id, config.app_id)
    assert.equal(result.seller_id, config.seller_id)
    assert.equal(Object.hasOwn(result, 'paid'), false)
  }
  trade_status = 'UNKNOWN'
  await assert.rejects(client.query(input.out_trade_no), expectError('alipay_response_invalid'))
})

test('query normalizes original decimal tokens without floating-point arithmetic', async t => {
  let amount = '18.90'
  mock(t, () => signedResponse('query', JSON.stringify(queryBody()).replace('"18.90"', amount)))
  const client = createAlipayClient(config)
  for (const [raw, expected] of [['18.90', '18.90'], ['18.9', '18.90'], ['18', '18.00'], ['0.29', '0.29'], ['100000000', '100000000.00'], ['"18.9"', '18.90']]) {
    amount = raw
    const result = await client.query(input.out_trade_no)
    assert.ok(result.found)
    assert.equal(result.total_amount, expected)
  }
  for (amount of ['18.9000000000000001', '1.89e1', '"1.89e1"', '0', '-18.90', '100000000.01', 'true', 'null']) {
    await assert.rejects(client.query(input.out_trade_no), expectError('alipay_response_invalid'))
  }
})

test('not-found is returned only for a signed ACQ.TRADE_NOT_EXIST response', async t => {
  let raw = JSON.stringify({ code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST', sub_msg: 'secret_payload' })
  let signature: string | undefined
  mock(t, () => signedResponse('query', raw, { signature }))
  const client = createAlipayClient(config)
  assert.deepEqual(await client.query(input.out_trade_no), { found: false, out_trade_no: input.out_trade_no })
  signature = 'bad'
  await assert.rejects(client.query(input.out_trade_no), expectError('alipay_signature_invalid'))
  signature = undefined
  raw = JSON.stringify({ code: '40004', sub_code: 'ACQ.INVALID_PARAMETER', sub_msg: 'secret_payload' })
  await assert.rejects(client.query(input.out_trade_no), expectError('alipay_business_rejected'))
})

test('network failures, redirects, invalid, oversized and ambiguous responses stay errors without leaking payloads or retrying', async t => {
  let calls = 0
  let response: () => Response = () => { throw new Error('request_body secret_payload') }
  mock(t, () => { calls++; return response() })
  const client = createAlipayClient(config)
  await assert.rejects(client.precreate(input), expectError('alipay_transport_unknown'))
  assert.equal(calls, 1)
  response = () => new Response('secret_payload', { status: 302, headers: { Location: 'https://attacker.test' } })
  await assert.rejects(client.query(input.out_trade_no), expectError('alipay_transport_unknown'))
  response = () => new Response('secret_payload', { status: 500 })
  await assert.rejects(client.query(input.out_trade_no), expectError('alipay_transport_unknown'))
  response = () => new Response('{"bad":"secret_payload"')
  await assert.rejects(client.query(input.out_trade_no), expectError('alipay_response_invalid'))
  response = () => new Response(' '.repeat(256 * 1024 + 1))
  await assert.rejects(client.query(input.out_trade_no), expectError('alipay_response_invalid'))
  response = () => new Response(JSON.stringify({ error_response: { code: '20000', sub_msg: 'secret_payload' } }))
  await assert.rejects(client.query(input.out_trade_no), expectError('alipay_response_invalid'))
  assert.equal(calls, 6)
})

test('signed system failures and unknown business codes cannot be treated as definitive rejection or payment', async t => {
  let raw = JSON.stringify({ code: '20000', sub_code: 'ACQ.SYSTEM_ERROR', sub_msg: 'secret_payload' })
  mock(t, () => signedResponse('query', raw))
  const client = createAlipayClient(config)
  for (const patch of [
    { code: '20000', sub_code: 'ACQ.SYSTEM_ERROR' },
    { code: '10003', sub_code: 'ACQ.INPROCESS' },
    { code: '40004', sub_code: 'new-unknown-code' },
    { code: 'unknown' },
  ]) {
    raw = JSON.stringify({ ...patch, sub_msg: 'secret_payload' })
    await assert.rejects(client.query(input.out_trade_no), expectError('alipay_result_unknown'))
  }
})

test('notification uses decoded-once values, excludes sign/sign_type, and verifies all remaining fields', () => {
  const client = createAlipayClient(config)
  const unsigned: Record<string, string> = {
    app_id: config.app_id, seller_id: config.seller_id, out_trade_no: input.out_trade_no,
    trade_no: '2026100522000000000000000001', total_amount: '18.90', trade_status: 'TRADE_SUCCESS',
    sign_type: 'RSA2', charset: 'utf-8', subject: '点数充值 + 100% & token=%2B', notify_id: 'fixture-notify',
  }
  const params = { ...unsigned, sign: sign('RSA-SHA256', Buffer.from(canonical(unsigned, true)), provider.privateKey).toString('base64') }
  const decoded = Object.fromEntries(new URLSearchParams(new URLSearchParams(params).toString()))
  const before = JSON.stringify(decoded)
  assert.equal(client.verifyNotification(decoded), true)
  assert.equal(JSON.stringify(decoded), before)
  for (const patch of [
    { total_amount: '188.90' }, { trade_status: 'TRADE_FINISHED' }, { app_id: '2021000000000002' },
    { seller_id: '2088000000000002' }, { extra: 'injected' }, { subject: '点数充值   100% & token=+' },
    { sign_type: 'RSA' }, { sign: '' }, { charset: 'gbk' }, { sign: '%2Bmalformed' },
  ]) assert.equal(client.verifyNotification({ ...decoded, ...patch }), false)
  assert.equal(client.verifyNotification({
    ...decoded, sign: sign('RSA-SHA256', Buffer.from(canonical(unsigned)), provider.privateKey).toString('base64'),
  }), false)
  assert.equal(client.verifyNotification({
    ...decoded, sign: sign('RSA-SHA1', Buffer.from(canonical(unsigned, true)), provider.privateKey).toString('base64'),
  }), false)
  assert.equal(client.verifyNotification(null as unknown as Record<string, string>), false)
  assert.equal(client.verifyNotification({ ...decoded, extra: ['bad'] } as unknown as Record<string, string>), false)
})
