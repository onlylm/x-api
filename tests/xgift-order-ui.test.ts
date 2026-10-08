import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyPaymentStatus, manualPaymentRequest, orderActions, orderCloseConfirmation, orderNextStep, ordersHash, orderStateText, parseOrdersHash, safePaymentPage, type OrderRow } from '../services/xgift/web/order-ui.ts'

test('manual payment UI uses explicit server capability, typed acknowledgement and original price/card/recipient', () => {
  const row: OrderRow = { id: 'ord_fixture', merchant_order_no: 'fixture', recipient: 'receiver', product_code: 'x-premium-3m',
    mode: 'direct', points: 300, status: 'unknown', currency: 'bdt', amount_minor: 30000, created_at: 1,
    actions: { check: true, close: false, payment_page: false, reason_code: 'manual_payment_approval_required',
      message: '待确认', approve_payment: true, payment_card_id: 123 } }
  assert.deepEqual(manualPaymentRequest(row, 'CONFIRM_PAYMENT'), { confirmation: 'CONFIRM_PAYMENT', expected_card_id: 123,
    expected_amount_minor: 30000, expected_currency: 'bdt', expected_recipient: 'receiver' })
  assert.throws(() => manualPaymentRequest(row, ''))
  for (const patch of [{ status: 'queued' }, { status: 'succeeded' }, { status: 'failed' }, { actions: undefined }, { amount_minor: undefined }])
    assert.throws(() => manualPaymentRequest({ ...row, ...patch }, 'CONFIRM_PAYMENT'))
})

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
  assert.equal(legacyPaymentStatus('fulfilled', 123, null), '赠送付款已确认')
})

test('order state distinguishes queued, unresolved, success and admin closure', () => {
  assert.equal(orderStateText({ status: 'unknown', failure_code: 'manual_payment_approval_required' }), '待人工确认')
  assert.equal(orderStateText({ status: 'unknown', failure_code: 'manual_payment_approval_expired' }), '待人工确认')
  assert.equal(orderStateText({ status: 'unknown', failure_code: 'manual_payment_approved' }), '待提交付款')
  assert.equal(orderStateText({ status: 'queued' }), '排队中')
  assert.equal(orderStateText({ status: 'unknown' }), '待核对')
  assert.equal(orderStateText({ status: 'succeeded' }), '付款已确认')
  assert.equal(orderStateText({ status: 'failed', failure_code: 'cancelled_by_admin' }), '已关闭')
  assert.equal(orderStateText({ status: 'failed', failure_code: 'cancelled_before_execution' }), '已关闭')
  assert.equal(orderStateText({ status: 'failed', failure_code: 'cancelled_unconfirmed_creation' }), '已关闭')
  assert.equal(orderStateText({ status: 'failed', failure_code: 'card_declined' }), '已结束')
})

test('unresolved creation termination uses the explicit acknowledgement rather than normal close', () => {
  const row: OrderRow = { id: 'ord_fixture', merchant_order_no: 'fixture', recipient: 'receiver',
    product_code: 'x-premium-3m', mode: 'direct', points: 300, status: 'unknown', created_at: 1,
    actions: { check: true, payment_page: false, close: true, reason_code: 'unconfirmed_creation_not_submitted',
      message: '确认风险后终止本地订单', close_confirmation: 'CLOSE_UNCONFIRMED_CREATION' } }
  assert.equal(orderCloseConfirmation(row), 'CLOSE_UNCONFIRMED_CREATION')
  assert.equal(orderActions(row).payment_page, false)
  assert.equal(orderActions({ ...row, status: 'failed' }).close, false)
  assert.equal(orderCloseConfirmation({ ...row, actions: undefined }), 'CLOSE_ORDER')
})

test('order status alone cannot authorize financial actions, and terminal state invalidates stale hints', () => {
  const base: OrderRow = { id: 'ord_fixture', merchant_order_no: 'fixture', recipient: 'receiver',
    product_code: 'x-premium-3m', mode: 'direct', points: 300, status: 'unknown', created_at: 1 }
  for (const status of ['queued', 'running', 'unknown']) {
    const actions = orderActions({ ...base, status })
    assert.equal(actions.check, false); assert.equal(actions.payment_page, false); assert.equal(actions.close, false)
  }
  const proven = { ...base, actions: { check: true, payment_page: true, close: false, reason_code: 'payment_requires_action', message: '原付款需要验证' } }
  assert.equal(orderActions(proven).payment_page, true); assert.equal(orderActions(proven).close, false)
  for (const status of ['succeeded', 'failed', 'queued', 'unrecognized']) {
    const actions = orderActions({ ...proven, status })
    assert.equal(actions.check, false); assert.equal(actions.payment_page, false)
  }
  const running = { ...base, status: 'running', actions: { check: false, payment_page: false, close: false, reason_code: 'executing', message: '系统正在执行，请等待本笔结果。' } }
  assert.equal(orderNextStep(running), '系统正在执行，请等待本笔结果。')
  assert.doesNotMatch(orderNextStep(running), /关闭|重付|验证/)
  assert.equal(orderNextStep({ ...base, status: 'succeeded' }), '付款已确认，请到 X 核对权益')
})

test('order hash restores filters, search and pagination, preserving encoded query characters', () => {
  const view = { status: 'unknown', query: '@receiver & 原单#1', page: 3 }
  assert.deepEqual(parseOrdersHash(ordersHash(view)), view)
  assert.deepEqual(parseOrdersHash('#orders?status=&q=ord_123&page=2'), { status: '', query: 'ord_123', page: 2 })
  assert.deepEqual(parseOrdersHash('#orders'), { status: 'active', query: '', page: 1 })
  assert.deepEqual(parseOrdersHash('#payment?status=failed&page=3'), { status: 'active', query: '', page: 1 })
  assert.deepEqual(parseOrdersHash('#orders?status=not-valid&page=-1'), { status: 'active', query: '', page: 1 })
  for (const page of ['NaN', '1.5', 'Infinity', '100001', '0']) assert.equal(parseOrdersHash('#orders?page=' + page).page, 1)
  assert.equal(parseOrdersHash('#orders?q=' + 'a'.repeat(200)).query.length, 128)
})
