import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readLocalPaymentConfig } from '../../scripts/local-payment-config.mjs';

const FILE_KEY_ID = 'rzp_test_FileFixtureOnly';
const FILE_KEY_SECRET = 'file-fixture-secret-not-a-real-credential';
const FILE_WEBHOOK_SECRET = 'file-fixture-webhook-not-a-real-credential';
const paymentFile = [
  `RAZORPAY_KEY_ID=${FILE_KEY_ID}`,
  `RAZORPAY_KEY_SECRET="${FILE_KEY_SECRET}"`,
  `RAZORPAY_WEBHOOK_SECRET='${FILE_WEBHOOK_SECRET}'`,
  'DATABASE_URL=postgres://fixture.invalid/unrelated',
  'OBSERVER_URL=https://fixture.invalid/observer',
  'DEMO_LOGIN_USERNAME=unrelated-fixture-user',
  'DEMO_LOGIN_PASSWORD=unrelated-fixture-password',
].join('\n');

async function temporaryFile(t: { after: (cleanup: () => Promise<void>) => void }, contents = paymentFile) {
  const directory = await mkdtemp(join(tmpdir(), 'bizplus-payment-config-'));
  const file = join(directory, 'synthetic.env');
  await writeFile(file, contents);
  t.after(async () => { await unlink(file); await rmdir(directory); });
  return file;
}

test('local payment configuration selects only the three commerce fields from a dotenv file', async t => {
  const file = await temporaryFile(t);
  const result = readLocalPaymentConfig({ environment: {}, file });
  assert.deepEqual(result, {
    keyId: FILE_KEY_ID,
    keySecret: FILE_KEY_SECRET,
    webhookSecret: FILE_WEBHOOK_SECRET,
  });
  assert.deepEqual(Object.keys(result).sort(), ['keyId', 'keySecret', 'webhookSecret']);
});

test('explicit environment values take precedence while absent values fall back to the file', async t => {
  const file = await temporaryFile(t);
  const environment = Object.freeze({
    RAZORPAY_KEY_ID: 'rzp_test_EnvironmentFixtureOnly',
    RAZORPAY_KEY_SECRET: undefined,
    RAZORPAY_WEBHOOK_SECRET: 'environment-fixture-webhook',
    DATABASE_URL: 'postgres://environment-fixture.invalid/unrelated',
  });
  assert.deepEqual(readLocalPaymentConfig({ environment, file }), {
    keyId: environment.RAZORPAY_KEY_ID,
    keySecret: FILE_KEY_SECRET,
    webhookSecret: environment.RAZORPAY_WEBHOOK_SECRET,
  });
});

test('reading payment configuration changes neither the supplied environment nor process.env', async t => {
  const sentinel = `BIZPLUS_PAYMENT_CONFIG_TEST_${randomUUID().replaceAll('-', '')}`;
  const file = await temporaryFile(t, `${paymentFile}\n${sentinel}=synthetic-unrelated-setting\n`);
  const environment = Object.freeze({ RAZORPAY_KEY_ID: 'rzp_test_FrozenFixtureOnly' });
  assert.equal(Object.hasOwn(process.env, sentinel), false);
  t.after(async () => { delete process.env[sentinel]; });
  readLocalPaymentConfig({ environment, file });
  assert.deepEqual(environment, { RAZORPAY_KEY_ID: 'rzp_test_FrozenFixtureOnly' });
  assert.equal(Object.hasOwn(process.env, sentinel), false, 'dotenv settings must not be activated globally');
});

test('a missing optional credential file still permits environment-only configuration', async t => {
  const existing = await temporaryFile(t, '');
  const file = join(dirname(existing), 'missing.env');
  const environment = Object.freeze({
    RAZORPAY_KEY_ID: 'rzp_test_EnvironmentOnlyFixture',
    RAZORPAY_KEY_SECRET: 'environment-only-fixture-secret',
    RAZORPAY_WEBHOOK_SECRET: 'environment-only-fixture-webhook',
  });
  assert.deepEqual(readLocalPaymentConfig({ environment, file }), {
    keyId: environment.RAZORPAY_KEY_ID,
    keySecret: environment.RAZORPAY_KEY_SECRET,
    webhookSecret: environment.RAZORPAY_WEBHOOK_SECRET,
  });
  assert.deepEqual(readLocalPaymentConfig({ environment: {}, file }), {
    keyId: undefined, keySecret: undefined, webhookSecret: undefined,
  });
});

test('explicit blank environment values keep checkout and webhooks disabled instead of falling back', async t => {
  const file = await temporaryFile(t);
  const environment = Object.freeze({
    RAZORPAY_KEY_ID: '',
    RAZORPAY_KEY_SECRET: '',
    RAZORPAY_WEBHOOK_SECRET: '',
  });
  assert.deepEqual(readLocalPaymentConfig({ environment, file }), {
    keyId: '', keySecret: '', webhookSecret: '',
  });
});
