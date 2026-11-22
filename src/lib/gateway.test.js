import { test } from 'node:test';
import assert from 'node:assert';
import { viaAdminGateway } from './gateway.js';

test('no secret configured: no gateway deployed, everything passes', () => {
  assert.strictEqual(viaAdminGateway(undefined, ''), true);
});

test('secret configured: only the exact stamp passes', () => {
  assert.strictEqual(viaAdminGateway('s3cret', 's3cret'), true);
  assert.strictEqual(viaAdminGateway(undefined, 's3cret'), false);
  assert.strictEqual(viaAdminGateway('s3creX', 's3cret'), false);
  assert.strictEqual(viaAdminGateway('s3cret-longer', 's3cret'), false);
});
