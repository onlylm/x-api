import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { database } from './database.ts'

// Run once against a new database with the service stopped. Never replay an import.
const [path, dump] = process.argv.slice(2)
if (!path || !dump)
  throw new Error('Usage: node import.ts NEW_DATABASE D1_DATA_ONLY_EXPORT')
const { sqlite } = database(
  path,
  fileURLToPath(new URL('../migrations/', import.meta.url)),
)
const tables = [
  'users',
  'wallets',
  'sessions',
  'login_limits',
  'api_keys',
  'nonces',
  'products',
  'user_prices',
  'secrets',
  'orders',
  'account_slots',
  'webhook_configs',
  'webhook_deliveries',
  'ledger',
  'audit',
  'card_provider',
  'card_operations',
  'gift_profile',
  'native_jobs',
  'native_funding',
  'vouchers',
]
try {
  for (const table of tables.filter((t) => t !== 'products')) {
    if (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n !== 0)
      throw new Error('Import destination is not empty')
  }
  const sql = readFileSync(dump, 'utf8')
  // D1 exports are generated SQL, not arbitrary user input; prohibit schema/transaction changes.
  if (/^\s*(?:CREATE|DROP|ALTER|BEGIN|COMMIT|END|ATTACH|DETACH)\b/im.test(sql))
    throw new Error('Expected a data-only export')
  const triggers = sqlite
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
    .all()
  sqlite.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;')
  try {
    for (const trigger of triggers)
      sqlite.exec(
        `DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`,
      )
    sqlite.exec('DELETE FROM products')
    sqlite.exec(sql)
    for (const trigger of triggers) sqlite.exec(String(trigger.sql))
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Imported foreign keys failed validation')
    if (
      sqlite
        .prepare(
          `SELECT w.user_id FROM wallets w LEFT JOIN ledger l ON w.user_id=l.user_id GROUP BY w.user_id HAVING w.available<>coalesce(sum(l.available_delta),0) OR w.frozen<>coalesce(sum(l.frozen_delta),0)`,
        )
        .all().length
    )
      throw new Error('Imported ledger does not match wallets')
    if (
      sqlite
        .prepare(
          'SELECT id FROM users WHERE NOT EXISTS(SELECT 1 FROM wallets WHERE user_id=users.id)',
        )
        .all().length
    )
      throw new Error('Imported user wallet is missing')
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
  console.log(
    JSON.stringify(
      Object.fromEntries(
        tables.map((t) => [
          t,
          sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n,
        ]),
      ),
    ),
  )
} finally {
  sqlite.close()
}
