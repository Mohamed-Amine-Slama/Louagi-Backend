import { test } from 'node:test';
import assert from 'node:assert';
import { lookupIpGeo } from './ipGeo.js';

test('lookupIpGeo resolves a known public ip to country + ll', () => {
  const geo = lookupIpGeo('8.8.8.8');
  assert.strictEqual(geo.country, 'US');
  assert.ok(Array.isArray(geo.ll) && geo.ll.length === 2);
  assert.ok('city' in geo);
});

test('lookupIpGeo returns null for private ip', () => {
  assert.strictEqual(lookupIpGeo('192.168.1.1'), null);
});

test('lookupIpGeo returns null for garbage and empty input', () => {
  assert.strictEqual(lookupIpGeo('not-an-ip'), null);
  assert.strictEqual(lookupIpGeo(''), null);
  assert.strictEqual(lookupIpGeo(null), null);
  assert.strictEqual(lookupIpGeo(undefined), null);
});

test('lookupIpGeo normalises empty city to null', () => {
  const geo = lookupIpGeo('8.8.8.8');
  assert.ok(geo.city === null || typeof geo.city === 'string');
  assert.notStrictEqual(geo.city, '');
});
