import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyPaymentStatus, orderStateText, safePaymentPage } from '../services/xgift/web/order-ui.ts'

test('admin payment links allow only live Stripe hosted checkout sessions', () => {
  const actual = 'https://checkout.stripe.com/c/pay/cs_live_abc123#original-fragment'
  assert.equal(safePaymentPage(actual), actual)
  assert.equal(safePaymentPage('https://checkout.stripe.com/pay/cs_live_abc123'), 'https://checkout.stripe.com/pay/cs_live_abc123')
  for (const unsafe of [
    null, '', 'javascript:alert(1)', 'http://checkout.stripe.com/c/pay/cs_live_abc',
    'https://checkout.stripe.com.evil.example/c/pay/cs_live_abc',
    'https://evil.example/checkout.stripe.com/c/pay/cs_live_abc',
    'https://user:password@checkout.stripe.com/c/pay/cs_live_abc',
    'https://checkout.stripe.com:444/c/pay/cs_live_abc',
    'https://checkout.stripe.com/c/pay/cs_test_abc',
    'https://checkout.stripe.com/c/pay/cs_live_abc/extra',
    'https://checkout.stripe.com/c/pay/%63s_live_abc',
  ]) assert.equal(safePaymentPage(unsafe), null)
})

test('closed historical payments are not mislabelled as waiting due to an audit reason', () => {
  assert.equal(legacyPaymentStatus('closed', null, 'payment_cancelled_by_admin'), '已关闭')
  assert.equal(legacyPaymentStatus('closed', null, 'payment_window_expired'), '已关闭')
  assert.equal(legacyPaymentStatus('attention', 123, 'unknown'), '已付款待处理')
  assert.equal(legacyPaymentStatus('attention', null, 'unknown'), '待核对')
  assert.equal(legacyPaymentStatus('fulfilled', 123, null), '赠送已完成')
})

test('order state distinguishes queued, unresolved, success and admin closure', () => {
  assert.equal(orderStateText({ status: 'queued' }), '排队中')
  assert.equal(orderStateText({ status: 'unknown' }), '待处理')
  assert.equal(orderStateText({ status: 'succeeded' }), '已完成')
  assert.equal(orderStateText({ status: 'failed', failure_code: 'cancelled_by_admin' }), '已关闭')
  assert.equal(orderStateText({ status: 'failed', failure_code: 'cancelled_before_execution' }), '已关闭')
  assert.equal(orderStateText({ status: 'failed', failure_code: 'card_declined' }), '已结束')
})
