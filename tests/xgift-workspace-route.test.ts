import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRoute, workspaceHref } from '../services/xgift/web/workspace-route.ts'

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
