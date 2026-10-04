import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database, Statement, Value } from '../src/core.ts'

export function database(path: string, migrations: string) {
  const sqlite = new DatabaseSync(path)
  sqlite.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
  )
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS server_migrations(name TEXT PRIMARY KEY, checksum TEXT NOT NULL)',
  )
  for (const name of readdirSync(migrations)
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()) {
    const sql = readFileSync(join(migrations, name), 'utf8').replaceAll('\r\n', '\n')
    const checksum = createHash('sha256').update(sql).digest('hex')
    const applied = sqlite
      .prepare('SELECT checksum FROM server_migrations WHERE name=?')
      .get(name)
    if (applied) {
      if (applied.checksum !== checksum)
        throw new Error('Applied migration checksum changed: ' + name)
      continue
    }
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      sqlite.exec(sql)
      sqlite
        .prepare('INSERT INTO server_migrations VALUES(?,?)')
        .run(name, checksum)
      sqlite.exec('COMMIT')
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
  }
  const statements = new WeakMap<Statement, () => unknown>()
  const DB: Database = {
    prepare(sql) {
      const prepared = sqlite.prepare(sql)
      let values: Value[] = []
      const statement: Statement = {
        bind(...v) {
          values = v
          return statement
        },
        async first<T>() {
          return (prepared.get(...values) ?? null) as T | null
        },
        async all<T>() {
          return { results: prepared.all(...values) as T[] }
        },
        async run() {
          return prepared.run(...values)
        },
      }
      statements.set(statement, () => prepared.run(...values))
      return statement
    },
    async batch(batch) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const results = batch.map((s) => {
          const run = statements.get(s)
          if (!run) throw new Error('Statement belongs to another database')
          return run()
        })
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { DB, sqlite }
}
