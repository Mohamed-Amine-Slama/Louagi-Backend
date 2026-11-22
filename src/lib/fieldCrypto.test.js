import { test } from 'node:test';
import assert from 'node:assert';

// Key must be set before config.js is evaluated.
process.env.PII_ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
process.env.APP_JWT_SECRET ??= 'test';
const { blindIndex, decryptValue, encryptField, encryptJson, isEncrypted } = await import('./fieldCrypto.js');

const JSONB = { type: 3802 };
const TEXT = { type: 25 };

test('text round-trips through encryptField + decryptValue', () => {
  const enc = encryptField('+21698765432');
  assert.ok(isEncrypted(enc));
  assert.notStrictEqual(enc, encryptField('+21698765432')); // random IV
  assert.strictEqual(decryptValue(enc, TEXT), '+21698765432');
});

test('jsonb round-trips as an encrypted string scalar', () => {
  // postgres-js serializes/parses ::jsonb params itself, so the bound value is what comes back.
  const stored = encryptJson({ provider: 'flouci', account: 'FL-1' });
  assert.ok(isEncrypted(stored));
  assert.deepStrictEqual(decryptValue(stored, JSONB), { provider: 'flouci', account: 'FL-1' });
  assert.strictEqual(encryptJson(null), null);
});

test('plaintext and non-strings pass through decryptValue untouched', () => {
  assert.strictEqual(decryptValue('Sousse', TEXT), 'Sousse');
  assert.deepStrictEqual(decryptValue({ a: 1 }, JSONB), { a: 1 });
  assert.strictEqual(decryptValue(null, TEXT), null);
});

test('tampered ciphertext decrypts to null, never garbage', () => {
  const enc = encryptField('secret');
  const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A') + '=';
  assert.strictEqual(decryptValue(tampered, TEXT), null);
});

test('blindIndex is deterministic, keyed, and case/space-insensitive', () => {
  const h = blindIndex('Mariem@Example.tn ');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.strictEqual(h, blindIndex('mariem@example.tn'));
  assert.notStrictEqual(h, blindIndex('other@example.tn'));
  assert.strictEqual(blindIndex(''), null);
  assert.strictEqual(blindIndex(null), null);
});
