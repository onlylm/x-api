import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { database } from '../services/xgift/server/database.ts'
import { assets } from '../services/xgift/server/assets.ts'
import { server } from '../services/xgift/server/http.ts'
import { request } from 'node:http'
import { createServer } from 'node:http'
import { proxyFetch } from '../services/xgift/server/proxy.ts'
import { spawnSync } from 'node:child_process'
import type { Env } from '../services/xgift/src/core.ts'

const migrations = fileURLToPath(
  new URL('../services/xgift/migrations/', import.meta.url),
)
test('Native HTTP proxy uses authenticated CONNECT and does not retry a rejected tunnel directly', async (t) => {
  const proxy = createServer()
  let connections = 0
  let authorization = '',
    target = ''
  proxy.on('connect', (request, socket) => {
    connections++
    authorization = request.headers['proxy-authorization'] ?? ''
    target = request.url ?? ''
    socket.end(
      'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    )
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  t.after(() => proxy.close())
  const address = proxy.address()
  assert(address && typeof address !== 'string')
  const result = await proxyFetch(
    'https://x.com/test',
    {},
    {
      protocol: 'http',
      host: '127.0.0.1',
      port: address.port,
      username: 'test-user',
      password: 'test:password@',
    },
  )
  assert.equal(result.status, 403)
  assert.equal(connections, 1)
  assert.equal(target, 'x.com:443')
  assert.equal(
    authorization,
    'Basic ' + Buffer.from('test-user:test:password@').toString('base64'),
  )
  await assert.rejects(
    proxyFetch(
      'https://attacker.example/',
      {},
      { protocol: 'http', host: '127.0.0.1', port: address.port },
    ),
  )
  assert.equal(connections, 1)
})
test('SQLite server batches roll back fully and migrations are repeatable', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'xgift-server-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'db.sqlite')
  const { DB, sqlite } = database(path, migrations)
  await assert.rejects(
    DB.batch([
      DB.prepare(
        "INSERT INTO users VALUES('u','Test','test@example.com','hash','salt',1,1)",
      ),
      DB.prepare(
        "INSERT INTO users VALUES('u','Duplicate','test2@example.com','hash','salt',1,1)",
      ),
    ]),
  )
  assert.equal(sqlite.prepare('SELECT count(*) n FROM wallets').get()?.n, 0)
  sqlite.close()
  const reopened = database(path, migrations)
  assert.equal(
    reopened.sqlite.prepare('SELECT count(*) n FROM products').get()?.n,
    2,
  )
  reopened.sqlite.close()
})
test('Static assets deny secrets, traversal and missing bundles while supporting SPA routes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'xgift-assets-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'index.html'), '<html>app</html>')
  writeFileSync(join(directory, '.env'), 'private')
  mkdirSync(join(directory, 'assets'))
  writeFileSync(join(directory, 'assets', 'app.js'), 'export {}')
  const store = assets(directory)
  assert.equal(
    (await store.fetch(new Request('https://test/.env'))).status,
    404,
  )
  assert.equal(
    (
      await store.fetch(
        new Request('https://test/%2e%2e%2fprivate', {
          headers: { Accept: 'text/html' },
        }),
      )
    ).status,
    404,
  )
  assert.equal(
    (
      await store.fetch(
        new Request('https://test/assets/missing.js', {
          headers: { Accept: 'text/html' },
        }),
      )
    ).status,
    404,
  )
  assert.equal(
    await (
      await store.fetch(
        new Request('https://test/dashboard', {
          headers: { Accept: 'text/html' },
        }),
      )
    ).text(),
    '<html>app</html>',
  )
  assert.match(
    (await store.fetch(new Request('https://test/assets/app.js'))).headers.get(
      'Cache-Control',
    )!,
    /immutable/,
  )
})
test('HTTP adapter rejects wrong hosts and preserves hostile Origins for CSRF checks', async (t) => {
  const { DB, sqlite } = database(':memory:', migrations)
  t.after(() => sqlite.close())
  const env: Env = {
    DB,
    MASTER_KEY: 'a'.repeat(64),
    ADMIN_PASSWORD: 'long-password-for-test',
    ASSETS: { fetch: async () => new Response('app') },
  }
  const http = server(env, 'https://x-api.example.com')
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  t.after(() => {
    http.closeAllConnections()
    http.close()
  })
  const address = http.address()
  assert(address && typeof address !== 'string')
  async function call(host: string, path: string, origin?: string) {
    return new Promise<{ status: number; body: string }>((resolve) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path,
          method: origin ? 'POST' : 'GET',
          headers: {
            Host: host,
            ...(origin
              ? { Origin: origin, 'Content-Type': 'application/json' }
              : {}),
          },
        },
        (res) => {
          let body = ''
          res.on('data', (b) => (body += b))
          res.on('end', () => resolve({ status: res.statusCode!, body }))
        },
      )
      if (origin) req.write('{}')
      req.end()
    })
  }
  assert.equal((await call('attacker.example', '/healthz')).status, 421)
  assert.equal((await call('x-api.example.com', '/healthz')).status, 200)
  assert.equal(
    (
      await call(
        'x-api.example.com',
        '/api/admin/login',
        'https://attacker.example',
      )
    ).status,
    403,
  )
})
test('D1 data import does not replay wallet triggers and refuses an occupied destination', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'xgift-import-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'db.sqlite'),
    dump = join(directory, 'dump.sql')
  writeFileSync(
    dump,
    "INSERT INTO users VALUES('u','Test','test@example.com','hash','salt',1,1);\nINSERT INTO wallets VALUES('u',0,0);\nINSERT INTO products VALUES('p','Test',3,'prod','bdt',300,300,0);",
  )
  const script = fileURLToPath(
    new URL('../services/xgift/server/import.ts', import.meta.url),
  )
  assert.equal(
    spawnSync(process.execPath, [script, path, dump], { encoding: 'utf8' })
      .status,
    0,
  )
  assert.notEqual(
    spawnSync(process.execPath, [script, path, dump], { encoding: 'utf8' })
      .status,
    0,
  )
  const { sqlite } = database(path, migrations)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM wallets').get()?.n, 1)
  assert.equal(
    sqlite
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='user_wallet'",
      )
      .get()?.n,
    1,
  )
  sqlite.close()
})
