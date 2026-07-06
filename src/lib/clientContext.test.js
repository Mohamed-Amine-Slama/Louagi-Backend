import { test } from 'node:test';
import assert from 'node:assert';
import { parseClientContext, buildClientContext } from './clientContext.js';

const validHeader = JSON.stringify({
  gps: { lat: 36.81, lon: 10.17, acc: 12, at: '2026-07-06T14:02:11Z' },
  device: {
    id: 'install-uuid-1',
    platform: 'android',
    os: 'Android 14',
    model: 'Pixel 7',
    appVersion: '1.4.2',
    screen: '412x915',
    locale: 'fr-TN',
    tz: 'Africa/Tunis',
  },
});

test('parseClientContext returns null for missing or empty header', () => {
  assert.strictEqual(parseClientContext(undefined), null);
  assert.strictEqual(parseClientContext(null), null);
  assert.strictEqual(parseClientContext(''), null);
});

test('parseClientContext returns null for oversized header', () => {
  const big = JSON.stringify({ device: { id: 'x'.repeat(2000) } });
  assert.strictEqual(parseClientContext(big), null);
});

test('parseClientContext returns null for malformed JSON', () => {
  assert.strictEqual(parseClientContext('{not json'), null);
});

test('parseClientContext returns null for non-object JSON', () => {
  assert.strictEqual(parseClientContext('[1,2]'), null);
  assert.strictEqual(parseClientContext('"hello"'), null);
  assert.strictEqual(parseClientContext('42'), null);
});

test('parseClientContext parses valid gps and device', () => {
  const out = parseClientContext(validHeader);
  assert.deepStrictEqual(out.gps, {
    lat: 36.81,
    lon: 10.17,
    acc: 12,
    at: '2026-07-06T14:02:11Z',
  });
  assert.strictEqual(out.device.id, 'install-uuid-1');
  assert.strictEqual(out.device.platform, 'android');
  assert.strictEqual(out.device.model, 'Pixel 7');
  assert.strictEqual(out.device.tz, 'Africa/Tunis');
});

test('parseClientContext strips unknown fields', () => {
  const header = JSON.stringify({
    gps: { lat: 1, lon: 2, evil: 'x' },
    device: { id: 'a', rooted: true },
    extra: { nested: 'ignored' },
  });
  const out = parseClientContext(header);
  assert.strictEqual(out.gps.evil, undefined);
  assert.strictEqual(out.device.rooted, undefined);
  assert.strictEqual(out.extra, undefined);
});

test('parseClientContext drops gps with out-of-range or non-numeric coordinates', () => {
  for (const gps of [
    { lat: 999, lon: 10 },
    { lat: 36, lon: -999 },
    { lat: 'x', lon: 10 },
    { lat: 36 }, // lon missing
    { lat: NaN, lon: 10 },
  ]) {
    const out = parseClientContext(JSON.stringify({ gps, device: { id: 'a' } }));
    assert.strictEqual(out.gps, null, `expected gps null for ${JSON.stringify(gps)}`);
    assert.strictEqual(out.device.id, 'a');
  }
});

test('parseClientContext drops invalid acc/at but keeps valid coordinates', () => {
  const out = parseClientContext(
    JSON.stringify({ gps: { lat: 36, lon: 10, acc: -5, at: 12345 } })
  );
  assert.strictEqual(out.gps.lat, 36);
  assert.strictEqual(out.gps.lon, 10);
  assert.strictEqual(out.gps.acc, null);
  assert.strictEqual(out.gps.at, null);
});

test('parseClientContext truncates over-long device strings and drops non-strings', () => {
  const out = parseClientContext(
    JSON.stringify({ device: { id: 'z'.repeat(200), model: 42, os: 'ok' } })
  );
  assert.strictEqual(out.device.id.length, 64);
  assert.strictEqual(out.device.model, undefined);
  assert.strictEqual(out.device.os, 'ok');
});

test('parseClientContext returns null when nothing valid remains', () => {
  assert.strictEqual(parseClientContext(JSON.stringify({ foo: 1 })), null);
  assert.strictEqual(parseClientContext(JSON.stringify({ gps: { lat: 999, lon: 999 } })), null);
  assert.strictEqual(parseClientContext(JSON.stringify({ device: { model: 99 } })), null);
});

test('buildClientContext assembles ip, ua and parsed header; private ip has null geo', () => {
  const req = {
    ip: '192.168.1.50',
    get(name) {
      const headers = {
        'x-client-context': validHeader,
        'user-agent': 'okhttp/4.12',
      };
      return headers[name.toLowerCase()];
    },
  };
  const ctx = buildClientContext(req);
  assert.strictEqual(ctx.ip, '192.168.1.50');
  assert.strictEqual(ctx.client.ua, 'okhttp/4.12');
  assert.strictEqual(ctx.client.ipGeo, null);
  assert.strictEqual(ctx.client.gps.lat, 36.81);
  assert.strictEqual(ctx.client.device.model, 'Pixel 7');
});

test('buildClientContext works with no header and no ua', () => {
  const req = { ip: '10.0.0.1', get: () => undefined };
  const ctx = buildClientContext(req);
  assert.strictEqual(ctx.ip, '10.0.0.1');
  assert.deepStrictEqual(ctx.client, { ipGeo: null, gps: null, device: null, ua: null });
});
