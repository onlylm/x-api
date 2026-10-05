import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePlatformOrdersView, parsePlatformOrdersHash, platformGiftHref, platformMoney,
  platformOrderProduct, platformOrdersError, platformOrdersHash, platformOrdersPath,
  platformStatus, platformTime, type PlatformOrdersView,
} from '../services/xgift/web/platform-orders-model.ts'

const base: PlatformOrdersView = { payment: 'all', fulfillment: 'all', query: '', page: 1 }

test('platform route round trips both filters and encoded search without query injection', () => {
  const view: PlatformOrdersView = { payment: 'paid', fulfillment: 'review', query: '@receiver & #1?payment=closed', page: 4 }
  assert.deepEqual(parsePlatformOrdersHash(platformOrdersHash(view)), view)
  const path = new URL(platformOrdersPath(view), 'https://fixture.invalid')
  assert.equal(path.pathname, '/api/admin/platform-orders')
  assert.equal(path.searchParams.get('q'), view.query)
  assert.equal(path.searchParams.get('payment'), 'paid')
  assert.equal(path.searchParams.getAll('payment').length, 1)
  assert.deepEqual(parsePlatformOrdersHash('#platform-orders'), base)
  assert.deepEqual(parsePlatformOrdersHash('#orders?payment=paid&page=3'), base)
})

test('platform filters are allowlisted, page bounded, and search limited to 100 characters', () => {
  for (const value of ['0', '-1', 'NaN', '1.5', '1e2', 'Infinity', '100001', '99999999', '01', '+2']) {
    assert.equal(parsePlatformOrdersHash('#platform-orders?page=' + value).page, 1)
  }
  assert.equal(parsePlatformOrdersHash('#platform-orders?page=100000').page, 100000)
  assert.equal(parsePlatformOrdersHash('#platform-orders?page=2').page, 2)
  assert.equal(parsePlatformOrdersHash('#platform-orders?q=' + 'a'.repeat(200)).query.length, 100)
  assert.equal(parsePlatformOrdersHash('#platform-orders?q=%20abc%20').query, 'abc')
  assert.deepEqual(parsePlatformOrdersHash('#platform-orders?payment=success&fulfillment=paid'), base)
  assert.deepEqual(normalizePlatformOrdersView({ ...base, page: Infinity }), base)
  assert.equal(new URL(platformOrdersPath({ ...base, page: 0, query: 'a'.repeat(200) }), 'https://fixture.invalid').searchParams.get('q')?.length, 100)
})

test('gift links only navigate to the actual original order without monetary actions', () => {
  assert.equal(platformGiftHref('ord_fixture_123'), '#orders?status=&q=ord_fixture_123&page=1')
  for (const value of [null, '', 'pending', 'https://evil.invalid', 'javascript:alert(1)', 'ord_a&q=other', 'ord_', 'ord_' + 'x'.repeat(125)]) {
    assert.equal(platformGiftHref(value), null)
  }
})

test('CNY money preserves decimal strings and unknown supply price never becomes zero', () => {
  assert.equal(platformMoney('22'), '¥22.00')
  assert.equal(platformMoney('44.5'), '¥44.50')
  assert.equal(platformMoney('0'), '¥0.00')
  assert.equal(platformMoney('000022.00'), '¥22.00')
  assert.equal(platformMoney('9007199254740993.99'), '¥9,007,199,254,740,993.99')
  for (const value of [null, '', '-1', 'NaN', 'Infinity', '1e2', '22.001', '22 CNY']) assert.equal(platformMoney(value), '—')
})

test('timestamps always show Beijing time and reject invalid or timezone-less data', () => {
  assert.equal(platformTime('2026-10-05T02:03:04.000Z'), '2026/10/05 10:03:04')
  assert.equal(platformTime('2026-10-04T16:00:00Z'), '2026/10/05 00:00:00')
  assert.equal(platformTime(Date.parse('2026-10-05T02:03:04Z')), '2026/10/05 10:03:04')
  assert.equal(platformTime('2026-10-05T10:03:04+08:00'), '2026/10/05 10:03:04')
  for (const value of [null, '', 'invalid', '2026-10-05 02:03:04', '2026-10-05T02:03:04', Infinity]) assert.equal(platformTime(value), '—')
})

test('payment success does not imply fulfillment, and unexpected state stays unresolved', () => {
  assert.deepEqual(platformStatus('payment', 'paid'), { label: '已付款', tone: 'success' })
  assert.deepEqual(platformStatus('fulfillment', 'not_started'), { label: '未开始', tone: 'neutral' })
  assert.deepEqual(platformStatus('fulfillment', 'review'), { label: '待核对', tone: 'review' })
  assert.deepEqual(platformStatus('fulfillment', 'success'), { label: '赠送成功', tone: 'success' })
  assert.deepEqual(platformStatus('payment', 'refunded'), { label: '已退款', tone: 'neutral' })
  for (const value of ['paid', 'all', 'unexpected']) assert.deepEqual(platformStatus('fulfillment', value), { label: '状态待核对', tone: 'review' })
  assert.equal(platformOrderProduct('x_premium_3m'), 'X Premium · 3 个月')
  assert.equal(platformOrderProduct('x-premium-6m'), 'X Premium · 6 个月')
  assert.equal(platformOrderProduct('new_product'), 'new_product')
})

test('authentication, forbidden, unavailable and rate limit failures have safe guidance', () => {
  assert.equal(platformOrdersError({ status: 401 }).status, 401)
  assert.match(platformOrdersError({ status: 401 }).message, /重新登录/)
  assert.match(platformOrdersError({ status: 403 }).message, /仅管理员/)
  assert.match(platformOrdersError({ status: 503 }).message, /暂时不可用/)
  assert.match(platformOrdersError({ status: 429 }).message, /过于频繁/)
  const failure = platformOrdersError(new Error('internal raw sensitive message'))
  assert.equal(failure.status, null)
  assert.doesNotMatch(failure.message, /internal raw sensitive/)
  assert.match(failure.message, /刷新/)
})
