// Server-only setup. Copy only payment/merchant credentials, never old application secrets.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

export function sandboxValues(original, key) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(key)) throw new Error('invalid_test_key');
  if (original.PAYMENT_PROVIDER !== 'alipay' || original.X_API_MODE !== 'live' ||
      original.X_API_BASE_URL !== 'https://x.aifu.me' ||
      original.ALIPAY_GATEWAY !== 'https://openapi.alipay.com/gateway.do') throw new Error('unexpected_provider');
  const names = ['ALIPAY_APP_ID', 'ALIPAY_SELLER_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY',
    'X_API_PARTNER_ID', 'X_API_KEY_ID', 'X_API_SECRET'];
  for (const name of names) if (!original[name]) throw new Error('provider_config_missing');
  if (names.some(name => original[name] === key)) throw new Error('test_key_must_be_independent');
  const provider = Object.fromEntries(names.map(name => [name, original[name]]));
  // The old file uses systemd escaping. parseEnv decodes \\n inside a doubled
  // backslash into a remaining slash plus a newline; normalize PEM only, then
  // parse/export the key offline. Never use these decoded values without validation.
  const pem = value => value.replace(/\\*\r?\n/g, '\n').replace(/\\+n/g, '\n').trim();
  provider.ALIPAY_PRIVATE_KEY = crypto.createPrivateKey(pem(provider.ALIPAY_PRIVATE_KEY))
    .export({format: 'pem', type: 'pkcs8'}).toString();
  provider.ALIPAY_PUBLIC_KEY = crypto.createPublicKey(pem(provider.ALIPAY_PUBLIC_KEY))
    .export({format: 'pem', type: 'spki'}).toString();
  const random = () => crypto.randomBytes(36).toString('base64url');
  return {
    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3112', BLUEV_SANDBOX_ENABLED: 'true',
    BLUEV_SANDBOX_DB_PATH: '/srv/x-bluev-sandbox/bluev-sandbox.sqlite',
    BLUEV_SANDBOX_SALES_GATE_FILE: '/srv/x-bluev-sandbox/sales.enabled',
    BLUEV_TEST_KEY: key, PUBLIC_BASE_URL: 'https://x.aifu.me/bluev-sandbox',
    SESSION_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), EMAIL_HMAC_KEY: random(),
    PAYMENT_PROVIDER: 'alipay', X_API_MODE: 'live', X_API_BASE_URL: 'https://x.aifu.me',
    ALIPAY_GATEWAY: 'https://openapi.alipay.com/gateway.do',
    ALIPAY_NOTIFY_URL: 'https://x.aifu.me/bluev-sandbox/callbacks/alipay',
    PLATFORM_WEBHOOK_ENABLED: 'false',
    ...provider,
  };
}

export function protectedText(path) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077))
    throw new Error('protected_file_permissions');
  return fs.readFileSync(path, 'utf8');
}

export function environmentText(values) {
  return Object.entries(values).map(([key, value]) => {
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\r')) throw new Error('invalid_value');
    return `${key}=${JSON.stringify(value)}`;
  }).join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const original = parseEnv(protectedText('/etc/x-partner-gateway/service.env'));
    const key = protectedText(process.argv[2]).trim();
    const values = sandboxValues(original, key);
    fs.writeFileSync('/etc/x-bluev-sandbox/service.env', environmentText(values),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    process.stdout.write('{"configured":true,"old_secrets_exported":false}\n');
  } catch { process.stderr.write('sandbox_configuration_failed\n'); process.exitCode = 1; }
}
