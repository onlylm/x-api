import test from 'node:test'
import assert from 'node:assert/strict'
import { xQuery, XQueryFailure } from '../services/xgift/src/network.ts'
import type { Env } from '../services/xgift/src/core.ts'

test('X diagnostics exclude all raw provider messages and string codes', () => {
  const error = new XQueryFailure('secret-operation', 'graphql', 200, { errors: [
    { code: 353, message: 'Cookie secret PAN 4242424242424242' }, { code: 'secret-code' },
    { code: 353 }, { code: 4242424242424242 }, null, { code: -1 }, { code: 1.5 },
  ] })
  assert.deepEqual(error.diagnostic, { operation: 'other', kind: 'graphql', http_status: 200, error_codes: [353] })
  assert.doesNotMatch(JSON.stringify(error), /secret|Cookie|PAN|4242424242424242/)
})

for (const [name, reply, kind, status] of [
  ['network', () => { throw new Error('proxy-user:proxy-password') }, 'network', null],
  ['HTML failure', () => new Response('<html>secret</html>', { status: 403 }), 'http', 403],
  ['bad JSON', () => new Response('secret'), 'invalid_json', 200],
  ['null JSON', () => Response.json(null), 'missing_data', 200],
  ['GraphQL', () => Response.json({ errors: [{ code: 32, message: 'secret' }] }), 'graphql', 200],
] as const) test(`X diagnostics classify ${name} without retrying`, async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return reply() })
  await assert.rejects(xQuery({} as Env, { auth_token: 'secret', ct0: 'secret' }, null,
    'useOneTimePurchaseGiftMutation', 'fixture', {}, true), error => {
    assert.ok(error instanceof XQueryFailure)
    assert.equal(error.diagnostic.kind, kind); assert.equal(error.diagnostic.http_status, status)
    assert.doesNotMatch(JSON.stringify(error), /secret|proxy-password/)
    return true
  })
  assert.equal(requests, 1)
})
