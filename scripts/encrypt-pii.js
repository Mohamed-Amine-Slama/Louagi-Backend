// One-time PII encryption migration.
//
// Encrypts existing plaintext driver PII (id_card_number, license_number,
// payout_account) and any plaintext admin TOTP secrets in place. Idempotent:
// already-encrypted values (enc:v1: prefix) are skipped, so it is safe to
// re-run after partial failures or after new plaintext rows appear.
//
// Usage:
//   PII_ENCRYPTION_KEY=<64-hex-or-base64-32-bytes> node scripts/encrypt-pii.js
//
// Refuses to run without a key (there would be nothing to do).

import { sql } from '../src/db.js';
import { config } from '../src/config.js';
import { encryptField, isEncrypted } from '../src/lib/fieldCrypto.js';

if (!config.piiEncryptionKey) {
  console.error('[encrypt-pii] PII_ENCRYPTION_KEY is not set — nothing to encrypt with. Aborting.');
  process.exit(1);
}

async function migrateDrivers() {
  const rows = await sql`
    select id, id_card_number, license_number, payout_account
    from public.drivers
  `;
  let updated = 0;
  for (const row of rows) {
    const next = {};
    if (row.id_card_number && !isEncrypted(row.id_card_number)) {
      next.id_card_number = encryptField(row.id_card_number);
    }
    if (row.license_number && !isEncrypted(row.license_number)) {
      next.license_number = encryptField(row.license_number);
    }
    if (row.payout_account && !isEncrypted(row.payout_account)) {
      next.payout_account = encryptField(row.payout_account);
    }
    if (!Object.keys(next).length) continue;
    await sql`
      update public.drivers
      set
        id_card_number = coalesce(${next.id_card_number ?? null}, id_card_number),
        license_number = coalesce(${next.license_number ?? null}, license_number),
        payout_account = coalesce(${next.payout_account ?? null}, payout_account)
      where id = ${row.id}::uuid
    `;
    updated += 1;
  }
  return { total: rows.length, updated };
}

async function migrateTotpSecrets() {
  const rows = await sql`
    select id, admin_totp_secret
    from public.users
    where admin_totp_secret is not null
  `;
  let updated = 0;
  for (const row of rows) {
    if (isEncrypted(row.admin_totp_secret)) continue;
    await sql`
      update public.users
      set admin_totp_secret = ${encryptField(row.admin_totp_secret)}
      where id = ${row.id}::uuid
    `;
    updated += 1;
  }
  return { total: rows.length, updated };
}

try {
  const drivers = await migrateDrivers();
  const totp = await migrateTotpSecrets();
  console.log(`[encrypt-pii] drivers: ${drivers.updated}/${drivers.total} rows encrypted`);
  console.log(`[encrypt-pii] totp secrets: ${totp.updated}/${totp.total} rows encrypted`);
  process.exit(0);
} catch (err) {
  console.error('[encrypt-pii] failed:', err.message);
  process.exit(1);
}
