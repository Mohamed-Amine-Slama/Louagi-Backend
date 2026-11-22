// Postgres pool. Used for everything the backend writes — reservations,
// payments, seat locks, audit log — where we need transactions.
//
// Why postgres-js (vs pg)? Smaller surface, tagged-template SQL with
// automatic parameterisation, first-class transactions, and zero deps.

import postgres from 'postgres';
import { config } from './config.js';
import { decryptValue } from './lib/fieldCrypto.js';

const PRIVILEGED_DATABASE_USERS = new Set([
  'postgres',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
]);

function databaseUser(databaseUrl) {
  try {
    const username = new URL(databaseUrl).username;
    return decodeURIComponent(username).split('.')[0];
  } catch {
    return null;
  }
}

function assertRestrictedDatabaseUser() {
  if (config.env !== 'production' || config.allowPrivilegedDatabaseUser) return;
  const user = databaseUser(config.databaseUrl);
  if (!user || !PRIVILEGED_DATABASE_USERS.has(user)) return;

  console.error(
    `[db] Refusing to start production server with privileged database user "${user}". ` +
      'Create a least-privilege backend database role, or set ALLOW_PRIVILEGED_DATABASE_USER=true only for an explicitly accepted exception.'
  );
  process.exit(1);
}

assertRestrictedDatabaseUser();

// ✅ Use the Supavisor SESSION pooler (pooler host, port 5432). The transaction
// pooler (6543) re-pools a backend mid-pipeline: postgres.js pipelines under
// load, so queries strand in ClientRead and the API wedges (~250 users).
// Session mode pins one backend per connection, so `max` must stay below the
// project's pooler Pool Size.
export const sql = postgres(config.databaseUrl, {
  ssl: 'require',
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  // Safe in session mode; parameterized queries then take 1 round trip, not 2.
  prepare: true,
  connection: { search_path: 'public' },
  // PII is encrypted at the write sites; every enc:v1: value is decrypted here.
  transform: { value: { from: decryptValue } },
});

export async function ping() {
  const [{ ok }] = await sql`select 1 as ok`;
  return ok === 1;
}
