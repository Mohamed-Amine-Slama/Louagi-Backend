// Driver read paths.

import { sql } from '../../db.js';
import {
  assertCan,
  driverFullFrom,
  toNumber,
} from '../../graphql/helpers.js';
import { cacheKey } from '../../graphql/cache.js';

async function GetDriverStatus(_input, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    select status, verified_at
    from public.drivers
    where user_id = ${actor.id}::uuid
    limit 1
  `;
  if (!rows.length) return { status: 'not_applied' };
  return rows[0];
}

async function GetDriverProfile(_input, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    select
      d.id, d.user_id, d.rating, d.trips_completed,
      d.vehicle_brand, d.vehicle_model, d.seat_count,
      d.status, d.plate_number, d.license_expires_at,
      d.id_expires_at, d.payout_account,
      u.full_name, u.email
    from public.drivers d
    join public.users u on u.id = d.user_id
    where d.user_id = ${actor.id}::uuid
    limit 1
  `;
  const d = rows[0];
  if (!d) return null;
  return {
    id: d.id,
    full_name: d.full_name,
    email: d.email,
    rating: toNumber(d.rating),
    trips_completed: d.trips_completed,
    vehicle_brand: d.vehicle_brand,
    vehicle_model: d.vehicle_model,
    seat_count: d.seat_count,
    status: d.status,
    plate_number_masked: d.plate_number,
    license_expires_at: d.license_expires_at,
    id_expires_at: d.id_expires_at,
    payout_account: d.payout_account ?? '',
  };
}

async function AdminListDrivers({ status }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return [];
  if (status && !['pending', 'verified', 'rejected'].includes(status)) return [];
  const rows = await sql`
    select
      d.*,
      u.id as user_id,
      u.full_name,
      u.email,
      u.phone_number
    from public.drivers d
    join public.users u on u.id = d.user_id
    where (${status ?? null}::driver_status is null or d.status = ${status ?? null}::driver_status)
    order by d.created_at desc
  `;
  return rows.map((row) => ({
    ...driverFullFrom(row),
    user: {
      id: row.user_id,
      full_name: row.full_name,
      email: row.email,
      phone_number: row.phone_number,
    },
  }));
}

async function ListDriverSessions(_input, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    select id, device_name, os_name, ip_address, is_revoked, last_active_at, created_at
    from public.driver_sessions
    where driver_id = ${actor.id}::uuid
    order by last_active_at desc
  `;
  return rows.map((r) => ({
    id: r.id,
    deviceName: r.device_name,
    osName: r.os_name,
    ipAddress: r.ip_address,
    isRevoked: r.is_revoked,
    lastActiveAt: r.last_active_at,
    createdAt: r.created_at,
  }));
}

async function Get2FAStatus(_input, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    select two_fa_enabled from public.drivers where user_id = ${actor.id}::uuid limit 1
  `;
  return { enabled: rows.length > 0 && rows[0].two_fa_enabled };
}

export const queries = {
  GetDriverStatus,
  GetDriverProfile,
  AdminListDrivers,
  ListDriverSessions,
  Get2FAStatus,
};

export const meta = {
  GetDriverStatus:  { cache: { key: (_, ctx) => cacheKey.driverStatus(ctx.actor.id),  ttl: 30 } },
  GetDriverProfile: { cache: { key: (_, ctx) => cacheKey.driverProfile(ctx.actor.id), ttl: 60 } },
  Get2FAStatus:     { cache: { key: (_, ctx) => cacheKey.twoFAStatus(ctx.actor.id),   ttl: 60 } },
};
