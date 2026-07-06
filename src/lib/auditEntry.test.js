import { test } from 'node:test';
import assert from 'node:assert';
import { auditEntry } from './auditEntry.js';

const actor = { id: 'a1b2', role: 'admin' };

test('auditEntry defaults ip to server when no ctx and no ip given', () => {
  const row = auditEntry({ actor, action: 'x' });
  assert.strictEqual(row.ip, 'server');
});

test('auditEntry uses explicit ip when given without ctx', () => {
  const row = auditEntry({ actor, action: 'x', ip: '1.2.3.4' });
  assert.strictEqual(row.ip, '1.2.3.4');
});

test('auditEntry prefers ctx.ip and merges ctx.client into metadata', () => {
  const ctx = {
    ip: '41.226.11.22',
    client: {
      ipGeo: { country: 'TN', city: 'Tunis', ll: [36.8, 10.18] },
      gps: { lat: 36.81, lon: 10.17, acc: 12, at: '2026-07-06T14:02:11Z' },
      device: { id: 'd1', platform: 'android' },
      ua: 'okhttp/4.12',
    },
  };
  const row = auditEntry({ actor, action: 'x', metadata: { reason: 'test' }, ctx });
  assert.strictEqual(row.ip, '41.226.11.22');
  assert.strictEqual(row.metadata.reason, 'test');
  assert.deepStrictEqual(row.metadata.client, ctx.client);
});

test('auditEntry with ctx but no client keeps metadata untouched', () => {
  const row = auditEntry({ actor, action: 'x', ctx: { ip: '1.1.1.1' } });
  assert.strictEqual(row.ip, '1.1.1.1');
  assert.strictEqual(row.metadata, null);
});

test('auditEntry maps actor and target fields, nulls when absent', () => {
  const row = auditEntry({
    actor,
    action: 'user.suspended',
    targetEntity: 'user',
    targetId: 'u9',
  });
  assert.strictEqual(row.actorId, 'a1b2');
  assert.strictEqual(row.actorRole, 'admin');
  assert.strictEqual(row.targetEntity, 'user');
  assert.strictEqual(row.targetId, 'u9');

  const bare = auditEntry({ action: 'system.tick' });
  assert.strictEqual(bare.actorId, null);
  assert.strictEqual(bare.actorRole, null);
  assert.strictEqual(bare.targetEntity, null);
  assert.strictEqual(bare.targetId, null);
  assert.strictEqual(bare.metadata, null);
});
