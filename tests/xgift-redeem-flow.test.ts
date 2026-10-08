import test from 'node:test'
import assert from 'node:assert/strict'
import { closedGift, giftOrderPresentation, giftProductName, redeemStage, REDEEM_POLL_FAILURE_LIMIT, REDEEM_POLL_LIMIT, sameOriginalOrder, shouldPollRedeem, voucherRequest } from '../services/xgift/web/redeem-flow.ts'

test('an ambiguous redemption retry retains exactly the original card and recipient without a new request identity', () => {
  const checked = { eligible: true, username: 'receiver', recipient_id: '12345' }
  const original = voucherRequest(null, ' fixture-card ', checked)!
  assert.deepEqual(original, { code: 'fixture-card', recipient: 'receiver', recipient_id: '12345' })
  assert.deepEqual(voucherRequest(original, 'replacement-card', { ...checked, username: 'another', recipient_id: '99999' }), original)
  assert.deepEqual(voucherRequest(original, '', null), original, 'Even unavailable capabilities must not discard the original request')
  assert.deepEqual(Object.keys(original).sort(), ['code', 'recipient', 'recipient_id'])
  assert.equal(voucherRequest(null, 'fixture-card', null), null)
  assert.equal(voucherRequest(null, 'fixture-card', { ...checked, eligible: false }), null)
})

test('a valid voucher immediately advances to the recipient step before account eligibility', () => {
  assert.equal(redeemStage(null, false), 1)
  assert.equal(redeemStage({ state: 'available' }, false), 2)
  for (const state of ['expired', 'revoked', 'redeemed']) assert.equal(redeemStage({ state }, false), 1)
  assert.equal(redeemStage({ state: 'redeemed', order: { id: 'original' } }, false), 3)
})

test('an uncertain original submission stays on the order step even if status has not found an order yet', () => {
  assert.equal(redeemStage({ state: 'available' }, true), 3)
  assert.equal(redeemStage(null, true), 3)
  assert.equal(redeemStage({ state: 'redeemed', order: { status: 'failed' } }, true), 3)
})

test('gift products use friendly names without showing raw internal product codes', () => {
  assert.equal(giftProductName('x-premium-3m'), 'X Premium · 3 个月')
  assert.equal(giftProductName('x-premium-6m', 'x-premium-6m'), 'X Premium · 6 个月')
  assert.equal(giftProductName('x-premium-3m', ' 已保存的套餐名称 '), '已保存的套餐名称')
  assert.equal(giftProductName('internal-unrecognized', ' '), 'X 会员套餐')
})

test('safe admin closure differs from failed delivery and never describes restored voucher value', () => {
  for (const failure_code of ['cancelled_before_execution', 'cancelled_by_admin']) {
    const order = { status: 'failed', failure_code }
    assert.equal(closedGift(order), true)
    assert.equal(giftOrderPresentation(order).label, '订单已关闭')
    assert.match(giftOrderPresentation(order).description, /卡密仍保留原兑换记录/)
  }
  assert.equal(closedGift({ status: 'unknown', failure_code: 'cancelled_by_admin' }), false)
  assert.equal(giftOrderPresentation({ status: 'failed', failure_code: 'card_declined' }).label, '订单未完成')
})

test('confirmed payment does not claim independently verified X entitlement delivery', () => {
  assert.equal(giftOrderPresentation({ status: 'unknown', failure_code: 'manual_payment_approval_required' }).label, '待人工确认')
  assert.match(giftOrderPresentation({ status: 'unknown', failure_code: 'manual_payment_approval_required' }).description, /尚未提交扣款/)
  assert.equal(giftOrderPresentation({ status: 'unknown', failure_code: 'manual_payment_approved' }).label, '待提交付款')
  const result = giftOrderPresentation({ status: 'succeeded' })
  assert.equal(result.label, '付款已确认')
  assert.match(result.description, /不等于已独立核实权益到账/)
  assert.match(giftOrderPresentation({ status: 'unknown' }).description, /不要重复付款/)
  assert.match(giftOrderPresentation({ status: 'unexpected' }).description, /不要重新下单/)
})

test('only visible unsettled original orders are eligible for automatic read-only polling', () => {
  for (const status of ['queued', 'running', 'unknown']) {
    assert.equal(shouldPollRedeem(status, false, 0, 0, true), true)
    assert.equal(shouldPollRedeem(status, true, 0, 0, false), false)
  }
  for (const status of ['succeeded', 'failed', 'unexpected']) assert.equal(shouldPollRedeem(status, true, 0, 0, true), false)
  assert.equal(shouldPollRedeem(undefined, true, 0, 0, true), true)
  assert.equal(shouldPollRedeem(undefined, false, 0, 0, true), false)
})

test('automatic reads are bounded by both total attempts and consecutive errors, and may resume after a deliberate reset', () => {
  assert.equal(shouldPollRedeem('queued', true, REDEEM_POLL_LIMIT - 1, REDEEM_POLL_FAILURE_LIMIT - 1, true), true)
  assert.equal(shouldPollRedeem('queued', true, REDEEM_POLL_LIMIT, 0, true), false)
  assert.equal(shouldPollRedeem('unknown', true, 1, REDEEM_POLL_FAILURE_LIMIT, true), false)
  assert.equal(shouldPollRedeem('unknown', true, 0, 0, true), true)
})

test('a status reply cannot replace or remove a previously bound original order', () => {
  assert.equal(sameOriginalOrder(undefined, undefined), true)
  assert.equal(sameOriginalOrder(undefined, 'first-original-order'), true)
  assert.equal(sameOriginalOrder('first-original-order', 'first-original-order'), true)
  assert.equal(sameOriginalOrder('first-original-order', undefined), false)
  assert.equal(sameOriginalOrder('first-original-order', 'another-order'), false)
})
