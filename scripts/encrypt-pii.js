// One-time PII encryption backfill (run after seeding or after setting
// PII_ENCRYPTION_KEY on an existing database).
//
// Encrypts every column listed in COLUMNS in place and (re)computes the
// users.phone_hash / email_hash blind indexes. Idempotent: rows are read through
// db.js, which decrypts on the way out, then rewritten encrypted, so re-running
// (or running after a partial failure) is safe.
//
// audit_log is deliberately NOT backfilled: its rows are immutable by design
// (trigger), so historical rows keep what they were written with. New audit
// rows are encrypted at write time (graphql/helpers.js appendAudit + inline
// inserts in cqrs/commands).
//
// Usage:
//   PII_ENCRYPTION_KEY=<64-hex-or-base64-32-bytes> node scripts/encrypt-pii.js
//
// Run after every reseed: seed.sql inserts plaintext and no phone/email hashes.

import { sql } from '../src/db.js';
import { config } from '../src/config.js';
import { blindIndex, encryptField, encryptJson } from '../src/lib/fieldCrypto.js';

// No key (local dev): values stay plaintext, but the phone/email blind indexes
// are still filled so seeded users can log in after a reseed.
if (!config.piiEncryptionKey) {
  console.warn('[encrypt-pii] PII_ENCRYPTION_KEY is not set — computing blind indexes only (data stays plaintext).');
}

// Keep in sync with the "Encrypted:" list in src/lib/fieldCrypto.js.
const COLUMNS = {
  users: { text: ['full_name', 'phone_number', 'email', 'admin_totp_secret'], json: ['payment_account'] },
  drivers: { text: ['id_card_number', 'license_number', 'payout_account', 'rejection_reason'] },
  messages: { text: ['content'] },
  support_tickets: { text: ['message'] },
  reviews: { text: ['comment'] },
  delivery: { text: ['item_description', 'driver_notes'] },
  user_sessions: { pk: 'session_id', text: ['device_info', 'ip_address'] },
  driver_sessions: { text: ['device_name', 'ip_address'] },
  notifications: { text: ['title', 'body'] },
  notification_campaigns: { text: ['title', 'body'] },
};

try {
  const counts = await sql.begin(async (tx) => {
    const out = {};
    for (const [table, { pk = 'id', text = [], json = [] }] of Object.entries(COLUMNS)) {
      const rows = await tx`select ${tx(pk)} as pk, ${tx([...text, ...json])} from ${tx('public.' + table)}`;
      for (const row of rows) {
        const set = {};
        for (const c of text) if (row[c] != null) set[c] = encryptField(String(row[c]));
        if (table === 'users') {
          set.phone_hash = blindIndex(row.phone_number);
          set.email_hash = blindIndex(row.email);
        }
        if (Object.keys(set).length) {
          await tx`update ${tx('public.' + table)} set ${tx(set)} where ${tx(pk)} = ${row.pk}::uuid`;
        }
        for (const c of json) {
          if (row[c] == null) continue;
          await tx`update ${tx('public.' + table)} set ${tx(c)} = ${encryptJson(row[c])}::jsonb where ${tx(pk)} = ${row.pk}::uuid`;
        }
      }
      out[table] = rows.length;
    }
    return out;
  });
  for (const [table, n] of Object.entries(counts)) console.log(`[encrypt-pii] ${table}: ${n} rows encrypted`);
  process.exit(0);
} catch (err) {
  console.error('[encrypt-pii] failed:', err.message);
  process.exit(1);
}
