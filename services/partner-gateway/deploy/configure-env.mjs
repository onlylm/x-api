// Executed only on the X server. Never logs credentials or the old master key.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const output = '/etc/x-partner-gateway/service.env';
const metadata = '/etc/x-partner-gateway/bootstrap-metadata.json';
function requireCondition(ok, code) { if (!ok) throw new Error(code); }
function readProtected(path) {
  const stat = fs.lstatSync(path);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o077) === 0,
    'protected_config_permissions');
  return parseEnv(fs.readFileSync(path, 'utf8'));
}
function valueLine(key, input) {
  requireCondition(typeof input === 'string' && !input.includes('\0'), 'invalid_environment_value');
  const value = input.replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return key + '="' + value + '"';
}
try {
  const rootPath = fs.realpathSync('/opt/xgift/current');
  requireCondition(!fs.existsSync(output) && !fs.existsSync(metadata), 'new_config_already_exists');
  const original = readProtected('/etc/xgift/service.env');
  const merchant = readProtected('/etc/xgift/integrations/aijd-x-api.env');
  requireCondition(original.MASTER_KEY && original.DATABASE_PATH === '/srv/xgift/data/xgift.sqlite',
    'unexpected_xgift_database');
  const database = new DatabaseSync(original.DATABASE_PATH, { readOnly: true });
  let row;
  try { row = database.prepare('SELECT payload FROM alipay_settings WHERE id=1').get(); }
  finally { database.close(); }
  requireCondition(row && typeof row.payload === 'string', 'alipay_configuration_missing');
  const { unseal } = await import(pathToFileURL(rootPath + '/services/xgift/src/core.ts').href);
  const alipay = JSON.parse(await unseal({ MASTER_KEY: original.MASTER_KEY }, 'alipay-settings', row.payload));
  const { createAlipayClient } = await import(pathToFileURL(rootPath + '/services/xgift/server/alipay.ts').href);
  requireCondition(alipay.environment === 'production', 'alipay_not_production');
  requireCondition(/^\d{16}$/.test(alipay.app_id) && /^\d{16}$/.test(alipay.seller_id)
    && alipay.app_private_key && alipay.alipay_public_key, 'alipay_fields_incomplete');
  createAlipayClient(alipay); // Offline key/config validation only.
  const privateObject = alipay.app_private_key.trim().startsWith('-----BEGIN ')
    ? crypto.createPrivateKey(alipay.app_private_key)
    : crypto.createPrivateKey({ key: Buffer.from(alipay.app_private_key.replace(/\s/g, ''), 'base64'),
      format: 'der', type: 'pkcs8' });
  const publicObject = alipay.alipay_public_key.trim().startsWith('-----BEGIN ')
    ? crypto.createPublicKey(alipay.alipay_public_key)
    : crypto.createPublicKey({ key: Buffer.from(alipay.alipay_public_key.replace(/\s/g, ''), 'base64'),
      format: 'der', type: 'spki' });
  const privatePem = privateObject.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicPem = publicObject.export({ format: 'pem', type: 'spki' }).toString();
  for (const name of ['X_API_PARTNER_ID', 'X_API_KEY_ID', 'X_API_SECRET'])
    requireCondition(typeof merchant[name] === 'string' && merchant[name].length > 0, 'merchant_config_incomplete');
  requireCondition(merchant.X_API_BASE_URL === 'https://x.aifu.me', 'merchant_destination_mismatch');
  const callback = process.argv[2] || '';
  if (callback) {
    const parsed = new URL(callback);
    requireCondition(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash,
      'platform_callback_invalid');
  }
  const secret = () => crypto.randomBytes(36).toString('base64url');
  const values = {
    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3110',
    PUBLIC_BASE_URL: 'https://api.quefa.cn/bluev',
    DATABASE_PATH: '/srv/x-partner-gateway/data/merchant-gateway.sqlite',
    PRODUCT_CATALOG_PATH: '/etc/x-partner-gateway/products.json',
    TRUST_PROXY: 'true', PLATFORM_ALLOWED_IPS: '127.0.0.1,::1,154.198.43.105',
    PLATFORM_API_KEY: secret(), PLATFORM_WEBHOOK_ENABLED: 'false',
    PLATFORM_WEBHOOK_URL: callback, PLATFORM_WEBHOOK_SECRET: secret(),
    ADMIN_TOKEN: secret(), SESSION_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    EMAIL_HMAC_KEY: secret(), PAYMENT_PROVIDER: 'alipay',
    ALIPAY_APP_ID: alipay.app_id, ALIPAY_SELLER_ID: alipay.seller_id,
    ALIPAY_PRIVATE_KEY: privatePem, ALIPAY_PUBLIC_KEY: publicPem,
    ALIPAY_GATEWAY: 'https://openapi.alipay.com/gateway.do',
    ALIPAY_NOTIFY_URL: 'https://api.quefa.cn/bluev/callbacks/alipay',
    ALIPAY_RETURN_URL: 'https://prodclub.xyz',
    ZOVO_MODE: 'mock', X_API_MODE: 'live', X_API_BASE_URL: 'https://x.aifu.me',
    X_API_PARTNER_ID: merchant.X_API_PARTNER_ID, X_API_KEY_ID: merchant.X_API_KEY_ID,
    X_API_SECRET: merchant.X_API_SECRET, X_API_REQUEST_TIMEOUT_MS: '15000',
    QUEFA_WORKER_GATE_FILE: '/srv/x-partner-gateway/control/workers.enabled',
    PARTNER_SALES_GATE_FILE: '/srv/x-partner-gateway/control/sales.enabled',
  };
  fs.writeFileSync(output, Object.entries(values).map(([key, value]) => valueLine(key, value)).join('\n') + '\n',
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.writeFileSync(metadata, JSON.stringify({ alipayProduction: true, alipayFieldsComplete: true,
    independentSecretsGenerated: true, masterKeyCopied: false, partnerDestination: 'https://x.aifu.me',
    canonicalBase: 'https://api.quefa.cn/bluev', productsEnabled: false, workersEnabled: false }) + '\n',
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ configured: true, alipay_production: true, independent_keys: true,
    master_key_copied: false, secrets_exported: false }));
} catch {
  console.error('isolated_gateway_configuration_failed');
  process.exitCode = 1;
}
