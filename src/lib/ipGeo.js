// Offline IP → geolocation lookup for the audit trail. geoip-lite bundles a
// MaxMind-derived database (city-level); swap this wrapper's internals if
// accuracy in production regions turns out insufficient.

import geoip from 'geoip-lite';

export function lookupIpGeo(ip) {
  if (!ip || typeof ip !== 'string') return null;
  let hit;
  try {
    hit = geoip.lookup(ip);
  } catch {
    return null;
  }
  if (!hit) return null;
  return {
    country: hit.country || null,
    city: hit.city || null,
    ll: Array.isArray(hit.ll) ? hit.ll : null,
  };
}
