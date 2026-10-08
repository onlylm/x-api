import test from 'node:test'
import assert from 'node:assert/strict'
import { adminGiftRequest } from '../services/xgift/web/admin-gift-flow.ts'

test('admin form binds immutable merchant scope and original order queries', async () => {
  const calls: unknown[] = []
  const request = async <T,>(path: string, body?: Record<string, unknown>) => { calls.push({ path, body }); return {} as T }
  const merchantId = 'usr_' + 'a'.repeat(32), scoped = adminGiftRequest(request, merchantId)
  await scoped('/api/capabilities')
  await scoped('/api/products')
  await scoped('/api/orders', { merchant_order_no: 'admin_test-001', confirmation: 'incorrect' })
  await scoped('/api/orders?merchant_order_no=admin_test-001')
  assert.deepEqual(calls, [
    { path: '/api/capabilities', body: undefined },
    { path: `/api/admin/users/${merchantId}/gift/products`, body: undefined },
    { path: `/api/admin/users/${merchantId}/gift/orders`, body: { merchant_order_no: 'admin_test-001', confirmation: 'GIFT' } },
    { path: `/api/admin/users/${merchantId}/gift/orders?merchant_order_no=admin_test-001`, body: undefined },
  ])
  await assert.rejects(scoped('/api/admin/users', {}))
  await assert.rejects(adminGiftRequest(request, 'other/../admin')('/api/orders', {}))
  assert.equal(calls.length, 4)
})
