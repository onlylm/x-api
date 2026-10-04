import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Generate once; reruns preserve the encryption key and existing login details.
const folder = resolve('.xgift-private')
await mkdir(folder, { recursive: true, mode: 0o700 })
const path = resolve(folder, 'deployment.json')
let data
try {
  data = JSON.parse(await readFile(path, 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  data = {
    url: 'https://x.aifu.me',
    admin_username: 'admin',
    admin_password: randomBytes(24).toString('base64url'),
    master_key: randomBytes(32).toString('hex'),
  }
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
}
await writeFile(
  resolve(folder, 'worker-secrets.json'),
  JSON.stringify({
    MASTER_KEY: data.master_key,
    ADMIN_PASSWORD: data.admin_password,
  }),
  { mode: 0o600 },
)
console.log(
  'Credentials saved to .xgift-private/deployment.json (Git ignored).',
)
console.log(
  'Upload .xgift-private/worker-secrets.json to the independent Worker with wrangler secret bulk.',
)
