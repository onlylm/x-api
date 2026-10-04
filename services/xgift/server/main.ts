import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { database } from './database.ts'
import { assets } from './assets.ts'
import { proxyFetch } from './proxy.ts'
import { server } from './http.ts'
import worker from '../src/index.ts'
import type { Env } from '../src/core.ts'
import { executeNative } from './native-executor.ts'

const { MASTER_KEY, ADMIN_PASSWORD, PUBLIC_ORIGIN, DATABASE_PATH } = process.env
if (
  !MASTER_KEY ||
  !/^[a-f0-9]{64}$/i.test(MASTER_KEY) ||
  !ADMIN_PASSWORD ||
  ADMIN_PASSWORD.length < 16 ||
  !PUBLIC_ORIGIN ||
  !DATABASE_PATH
)
  throw new Error('Required server configuration is missing or invalid')
process.umask(0o077)
mkdirSync(dirname(DATABASE_PATH), { recursive: true, mode: 0o700 })
const { DB, sqlite } = database(
  DATABASE_PATH,
  fileURLToPath(new URL('../migrations/', import.meta.url)),
)
chmodSync(DATABASE_PATH, 0o600)
const env: Env = {
  DB,
  ASSETS: assets(fileURLToPath(new URL('../dist/', import.meta.url))),
  MASTER_KEY,
  ADMIN_PASSWORD,
  CARD_DEFAULT_TRANSPORT: 'direct',
  OUTBOUND_FETCH: proxyFetch,
  PAYMENTS_ENABLED: process.env.PAYMENTS_ENABLED ?? 'false',
  EXECUTOR_URL: process.env.EXECUTOR_URL,
  EXECUTOR_SECRET: process.env.EXECUTOR_SECRET,
  X_BEARER: process.env.X_BEARER,
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
}
if (process.env.NATIVE_EXECUTION === 'true')
  env.LOCAL_EXECUTOR = (order, snapshot) => executeNative(env, order, snapshot)
const http = server(env, PUBLIC_ORIGIN)
let task: Promise<void> | undefined
const timer = setInterval(() => {
  if (task) return
  task = worker
    .scheduled(undefined, env)
    .catch(() => {
      console.error('Scheduled reconciliation failed')
    })
    .finally(() => {
      task = undefined
    })
}, env.LOCAL_EXECUTOR ? 5000 : 60000)
http.listen(8791, '127.0.0.1', () =>
  console.log('X API server listening on loopback:8791'),
)
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    clearInterval(timer)
    const deadline = setTimeout(() => process.exit(1), 30000).unref()
    http.close(async () => {
      await task
      sqlite.close()
      clearTimeout(deadline)
    })
    http.closeIdleConnections()
  })
