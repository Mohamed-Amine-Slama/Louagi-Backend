import { test } from 'node:test';
import assert from 'node:assert';
import { chunk, sendExpoPush } from './expoPush.js';

test('chunk splits into fixed-size batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});

test('sendExpoPush counts ok/error and collects DeviceNotRegistered tokens', async () => {
  const messages = [
    { to: 'ExponentPushToken[A]', title: 'a' },
    { to: 'ExponentPushToken[B]', title: 'b' },
  ];
  const fakeFetch = async () => ({
    json: async () => ({
      data: [
        { status: 'ok' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
      ],
    }),
  });
  const r = await sendExpoPush(messages, { fetchImpl: fakeFetch });
  assert.equal(r.pushed, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.invalidTokens, ['ExponentPushToken[B]']);
});

test('sendExpoPush batches in groups of 100', async () => {
  const messages = Array.from({ length: 250 }, (_, i) => ({ to: `t${i}`, title: 'x' }));
  let calls = 0;
  const fakeFetch = async (_url, opts) => {
    calls += 1;
    const body = JSON.parse(opts.body);
    return { json: async () => ({ data: body.map(() => ({ status: 'ok' })) }) };
  };
  const r = await sendExpoPush(messages, { fetchImpl: fakeFetch });
  assert.equal(calls, 3);
  assert.equal(r.pushed, 250);
  assert.equal(r.failed, 0);
});

test('sendExpoPush treats a thrown fetch as a failed batch', async () => {
  const messages = [{ to: 'x', title: 'a' }];
  const fakeFetch = async () => {
    throw new Error('network down');
  };
  const r = await sendExpoPush(messages, { fetchImpl: fakeFetch });
  assert.equal(r.pushed, 0);
  assert.equal(r.failed, 1);
});

test('sendExpoPush is a no-op for an empty list', async () => {
  const r = await sendExpoPush([], { fetchImpl: async () => ({ json: async () => ({}) }) });
  assert.deepEqual(r, { pushed: 0, failed: 0, invalidTokens: [] });
});
