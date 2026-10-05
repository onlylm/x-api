import test from 'node:test'
import assert from 'node:assert/strict'
import { adminSections, merchantSections, hasOwnPagination, workspaceRoute, workspaceHref } from '../services/xgift/web/workspace-route.ts'

test('workspace route restores section and pagination without interpreting credentials', () => {
  assert.deepEqual(workspaceRoute('#orders?status=unknown&q=ord_123&page=3'), { section: 'orders', page: 3 })
  assert.deepEqual(workspaceRoute('#payment'), { section: 'payment', page: 1 })
  assert.equal(workspaceHref('vouchers', 2), '#vouchers?page=2')
})
test('workspace route rejects unknown sections and malformed pages', () => {
  for (const hash of ['', '#evil', '#https://example.com']) assert.equal(workspaceRoute(hash).section, 'overview')
  for (const value of ['0', '-1', 'NaN', '1e2', '99999999']) assert.equal(workspaceRoute('#orders?page=' + value).page, 1)
  assert.equal(workspaceRoute('#orders?page=999999').page, 100000)
})

test('merchant workspace includes owned vouchers without granting administrative settings', () => {
  assert.ok(merchantSections.includes('vouchers'))
  assert.ok(adminSections.includes('vouchers'))
  assert.deepEqual(workspaceRoute('#vouchers?status=redeemed&q=delivery&page=2'), { section: 'vouchers', page: 2 })
  for (const section of ['platform-orders', 'users', 'admission', 'payment', 'cards', 'secrets', 'products', 'audit', 'webhooks'])
    assert.ok(!(merchantSections as readonly string[]).includes(section))
})

test('voucher pagination stays inside the component for both roles to retain generated secrets', () => {
  assert.equal(hasOwnPagination('vouchers', false), true)
  assert.equal(hasOwnPagination('vouchers', true), true)
  assert.equal(hasOwnPagination('orders', false), false)
  assert.equal(hasOwnPagination('orders', true), true)
  assert.equal(hasOwnPagination('platform-orders', false), false)
  assert.equal(hasOwnPagination('platform-orders', true), true)
  assert.equal(hasOwnPagination('ledger', false), false)
})

test('platform orders is an administrative route with independent filtering and pagination', () => {
  assert.ok(adminSections.includes('platform-orders'))
  assert.deepEqual(workspaceRoute('#platform-orders?payment=paid&fulfillment=review&q=platform-order&page=2'), { section: 'platform-orders', page: 2 })
  assert.equal(workspaceHref('platform-orders'), '#platform-orders')
  assert.equal(workspaceHref('platform-orders', 100000), '#platform-orders?page=100000')
  assert.deepEqual(merchantSections, ['overview', 'orders', 'vouchers', 'keys', 'ledger', 'docs'])
})
