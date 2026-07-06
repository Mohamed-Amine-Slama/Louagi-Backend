// Parses the x-client-context header (client-claimed GPS + device
// fingerprint) and assembles the per-request client context recorded in the
// audit trail. Everything here is best-effort and hostile-input safe: any
// violation degrades to null, never to an error — audit enrichment must not
// be able to fail a request.
//
// Server-derived fields (ip, ipGeo, ua) and client-claimed fields (gps,
// device) are kept distinct downstream; a mismatch between them is itself a
// security signal.

import { lookupIpGeo } from './ipGeo.js';

const MAX_HEADER_BYTES = 1024;
const MAX_FIELD_CHARS = 64;
const DEVICE_FIELDS = [
  'id',
  'platform',
  'os',
  'model',
  'appVersion',
  'browser',
  'screen',
  'locale',
  'tz',
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inRangeNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function sanitizedGps(raw) {
  if (!isPlainObject(raw)) return null;
  if (!inRangeNumber(raw.lat, -90, 90) || !inRangeNumber(raw.lon, -180, 180)) return null;
  return {
    lat: raw.lat,
    lon: raw.lon,
    acc: inRangeNumber(raw.acc, 0, Number.MAX_SAFE_INTEGER) ? raw.acc : null,
    at: typeof raw.at === 'string' && raw.at.length <= 40 ? raw.at : null,
  };
}

function sanitizedDevice(raw) {
  if (!isPlainObject(raw)) return null;
  const device = {};
  for (const field of DEVICE_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'string') continue;
    const cleaned = value.trim().slice(0, MAX_FIELD_CHARS);
    if (cleaned) device[field] = cleaned;
  }
  return Object.keys(device).length > 0 ? device : null;
}

export function parseClientContext(header) {
  if (!header || typeof header !== 'string') return null;
  if (Buffer.byteLength(header, 'utf8') > MAX_HEADER_BYTES) return null;
  let raw;
  try {
    raw = JSON.parse(header);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  const gps = sanitizedGps(raw.gps);
  const device = sanitizedDevice(raw.device);
  if (!gps && !device) return null;
  return { gps, device };
}

export function buildClientContext(req) {
  const ip = req.ip || req.get?.('x-forwarded-for') || 'server';
  const parsed = parseClientContext(req.get?.('x-client-context')) ?? { gps: null, device: null };
  return {
    ip,
    client: {
      ipGeo: ip === 'server' ? null : lookupIpGeo(ip),
      gps: parsed.gps,
      device: parsed.device,
      ua: req.get?.('user-agent') || null,
    },
  };
}
