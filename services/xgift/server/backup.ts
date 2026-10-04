import { backup, DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const [source, destination] = process.argv.slice(2)
if (!source || !destination)
  throw new Error('Usage: node backup.ts DATABASE BACKUP_DIRECTORY')
process.umask(0o077)
mkdirSync(destination, { recursive: true, mode: 0o700 })
const db = new DatabaseSync(source, { readOnly: true })
const name =
  'xgift-' + new Date().toISOString().replaceAll(':', '-') + '.sqlite'
try {
  await backup(db, resolve(destination, name))
} finally {
  db.close()
}
chmodSync(resolve(destination, name), 0o600)
const files = readdirSync(destination)
  .filter((n) => /^xgift-\d{4}-\d\d-\d\dT[\d.-]+Z\.sqlite$/.test(n))
  .sort()
  .reverse()
for (const old of files.slice(14)) unlinkSync(resolve(destination, old))
console.log('SQLite backup completed')
