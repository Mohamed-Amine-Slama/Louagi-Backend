// Postgres pool. Used for everything the backend writes — reservations,
// payments, seat locks, audit log — where we need transactions.
//
// Why postgres-js (vs pg)? Smaller surface, tagged-template SQL with
// automatic parameterisation, first-class transactions, and zero deps.

import postgres from 'postgres';
import { config } from './config.js';

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

export const sql = postgres(config.databaseUrl, {
  ssl: 'require',
  // Supabase's session pooler closes idle connections aggressively — keep
  // the pool small so we don't churn through them.
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  // Defer prepared-statement caching: the transaction pooler (port 6543)
  // doesn't support it. We default to the session pooler (5432) where it
  // works, but flipping this off is the safer cross-config setting.
  prepare: false,
});

export async function ping() {
  const [{ ok }] = await sql`select 1 as ok`;
  return ok === 1;
}
