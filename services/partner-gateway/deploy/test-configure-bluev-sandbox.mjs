import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {parseEnv} from 'node:util';
import { sandboxValues, environmentText } from './configure-bluev-sandbox.mjs';

const pair = crypto.generateKeyPairSync('rsa', {modulusLength:1024});
const privatePem = pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
const publicPem = pair.publicKey.export({format:'pem',type:'spki'}).toString();

const original = {
  PAYMENT_PROVIDER:'alipay', X_API_MODE:'live', X_API_BASE_URL:'https://x.aifu.me',
  ALIPAY_GATEWAY:'https://openapi.alipay.com/gateway.do', ALIPAY_APP_ID:'1'.repeat(16),
  ALIPAY_SELLER_ID:'2'.repeat(16), ALIPAY_PRIVATE_KEY:privatePem, ALIPAY_PUBLIC_KEY:publicPem,
  X_API_PARTNER_ID:'usr_fixture', X_API_KEY_ID:'key_fixture', X_API_SECRET:'MERCHANT-FIXTURE',
  MASTER_KEY:'DO-NOT-COPY', ADMIN_TOKEN:'OLD-ADMIN', PLATFORM_API_KEY:'OLD-PLATFORM',
  DATABASE_PATH:'/srv/xgift/data/xgift.sqlite', QUEFA_WORKER_GATE_FILE:'/srv/old/workers.enabled',
  SESSION_ENCRYPTION_KEY:'OLD-ENCRYPTION', EMAIL_HMAC_KEY:'OLD-HMAC',
};
test('new configuration copies only payment and dedicated merchant whitelist', () => {
  const values = sandboxValues(original,'a'.repeat(48));
  assert.equal(values.ALIPAY_PRIVATE_KEY, original.ALIPAY_PRIVATE_KEY);
  assert.equal(values.X_API_SECRET, original.X_API_SECRET);
  assert.equal(values.BLUEV_SANDBOX_DB_PATH, '/srv/x-bluev-sandbox/bluev-sandbox.sqlite');
  assert.equal(values.PORT, '3112');
  assert.equal(values.PLATFORM_WEBHOOK_ENABLED, 'false');
  for (const forbidden of ['MASTER_KEY','ADMIN_TOKEN','PLATFORM_API_KEY','DATABASE_PATH','QUEFA_WORKER_GATE_FILE'])
    assert.equal(Object.hasOwn(values, forbidden), false);
  assert.equal(Buffer.from(values.SESSION_ENCRYPTION_KEY,'base64').length,32);
  assert.notEqual(values.SESSION_ENCRYPTION_KEY, original.SESSION_ENCRYPTION_KEY);
  assert.notEqual(values.EMAIL_HMAC_KEY, original.EMAIL_HMAC_KEY);
  assert.doesNotMatch(environmentText(values), /DO-NOT-COPY|OLD-ADMIN|OLD-PLATFORM|OLD-ENCRYPTION|OLD-HMAC/);
});
test('configuration rejects provider changes, absent credentials and injected keys', () => {
  for (const change of [{X_API_MODE:'mock'},{ALIPAY_PRIVATE_KEY:''},{X_API_BASE_URL:'https://evil.example'}])
    assert.throws(() => sandboxValues({...original,...change},'a'.repeat(48)));
  assert.throws(() => sandboxValues(original,'a'.repeat(48)+'\nINJECTED=bad'));
});
test('environment serialization preserves values and does not permit injected assignments', () => {
  const value = 'line 1\nline 2\\n"quoted"';
  const text = environmentText({KEY:value});
  assert.equal(text.split('\n').length,2);
  assert.equal(JSON.parse(text.slice(4).trim()),value);
  assert.throws(() => environmentText({KEY:'bad\0value'}));
});
test('old systemd doubled-newline escaping survives Node parseEnv and is normalized to valid PEM', () => {
  const encode = input => input.replace(/\n/g,'\\n').replace(/\\/g,'\\\\');
  const source = parseEnv('ALIPAY_PRIVATE_KEY="'+encode(privatePem)+'"\nALIPAY_PUBLIC_KEY="'+encode(publicPem)+'"\n');
  const values = sandboxValues({...original,...source}, 'a'.repeat(48));
  assert.equal(values.ALIPAY_PRIVATE_KEY,privatePem);
  assert.equal(values.ALIPAY_PUBLIC_KEY,publicPem);
  const freshEnvironment = environmentText({ALIPAY_PRIVATE_KEY:values.ALIPAY_PRIVATE_KEY});
  assert.equal(freshEnvironment.split('\n').length,2);
  assert.equal(parseEnv(freshEnvironment).ALIPAY_PRIVATE_KEY,privatePem);
});
