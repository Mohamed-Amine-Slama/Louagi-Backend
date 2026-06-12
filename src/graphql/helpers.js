// Shared helpers used by every resolver domain. Extracted from the old
// monolithic resolvers.js so each domain file only carries its own logic.

import crypto from 'crypto';

import { sql } from '../db.js';
import { actorFromRequest } from '../middleware/auth.js';
import { config } from '../config.js';
import { can } from '../utils/rbac.js';
import { withTimeout } from '../lib/supabase/withTimeout.js';
import { decryptField } from '../lib/fieldCrypto.js';

// ─── Errors ────────────────────────────────────────────────────────────────-
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ─── Primitives ─────────────────────────────────────────────────────────────
export function toNumber(value) {
  return value == null ? value : Number(value);
}

export function paymentReference(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

export function safeEqualString(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const rightHash = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

export function validAdminImpersonationCode(code) {
  return Boolean(code) && safeEqualString(code, config.adminImpersonationCode);
}

// ─── Auth / authz ───────────────────────────────────────────────────────────
export function assertCan(actor, action) {
  if (!can(actor?.role, action)) return { ok: false, error: 'Forbidden' };
  return null;
}

export async function requireActor(ctx) {
  const actor = await actorFromRequest(ctx.req);
  if (!actor) throw new HttpError(401, 'Invalid or expired token');
  return actor;
}

// ─── Audit log ──────────────────────────────────────────────────────────────
export async function appendAudit({ actor, action, targetEntity, targetId, metadata, ip }) {
  await sql`
    insert into public.audit_log (
      actor_id,
      actor_role,
      action,
      target_entity,
      target_id,
      metadata,
      ip_address
    ) values (
      ${actor?.id ?? null}::uuid,
      ${actor?.role ?? null}::user_role,
      ${action},
      ${targetEntity ?? null},
      ${targetId ?? null}::uuid,
      ${metadata ? JSON.stringify(metadata) : null}::jsonb,
      ${ip ?? 'server'}
    )
  `;
}

// ─── Row → JSON mappers ─────────────────────────────────────────────────────
export function routeFrom(row, prefix = 'route_') {
  if (!row?.[`${prefix}id`]) return null;
  return {
    id: row[`${prefix}id`],
    origin_city: row[`${prefix}origin_city`],
    destination_city: row[`${prefix}destination_city`],
    distance_km: row[`${prefix}distance_km`],
    estimated_duration_min: row[`${prefix}estimated_duration_min`],
    base_price: toNumber(row[`${prefix}base_price`]),
    created_at: row[`${prefix}created_at`],
  };
}

export function rideFrom(row, prefix = 'ride_') {
  if (!row?.[`${prefix}id`]) return null;
  return {
    id: row[`${prefix}id`],
    driver_id: row[`${prefix}driver_id`],
    route_id: row[`${prefix}route_id`],
    departure_time: row[`${prefix}departure_time`],
    available_seats: row[`${prefix}available_seats`],
    total_seats: row[`${prefix}total_seats`],
    price_per_seat: toNumber(row[`${prefix}price_per_seat`]),
    status: row[`${prefix}status`],
    accepts_delivery: row[`${prefix}accepts_delivery`],
    created_at: row[`${prefix}created_at`],
  };
}

export function driverSummaryFrom(row) {
  if (!row?.driver_id) return null;
  return {
    id: row.driver_id,
    full_name: row.driver_full_name ?? 'Driver',
    rating: toNumber(row.driver_rating),
    trips_completed: row.driver_trips_completed,
    vehicle_brand: row.driver_vehicle_brand,
    vehicle_model: row.driver_vehicle_model,
    seat_count: row.driver_seat_count,
    status: row.driver_status,
  };
}

export function driverFullFrom(row) {
  if (!row?.id) return null;
  return {
    ...row,
    rating: toNumber(row.rating),
    plate_number: row.plate_number,
    id_card_number: decryptField(row.id_card_number),
    license_number: decryptField(row.license_number),
    payout_account: decryptField(row.payout_account),
  };
}

export function paymentFrom(row) {
  if (!row?.id) return null;
  return {
    ...row,
    amount: toNumber(row.amount),
    platform_fee: toNumber(row.platform_fee),
    driver_fee: toNumber(row.driver_fee),
    reservation_fee: toNumber(row.reservation_fee),
    refunded_amount: toNumber(row.refunded_amount),
    flagged: Boolean(row.flagged),
    flag_reason: row.flagged_reason ?? null,
  };
}

export function reservationFrom(row) {
  if (!row?.reservation_id) return null;
  return {
    id: row.reservation_id,
    user_id: row.reservation_user_id,
    ride_id: row.reservation_ride_id,
    seats_booked: row.reservation_seats_booked,
    total_price: toNumber(row.reservation_total_price),
    status: row.reservation_status,
    idempotency_key: row.reservation_idempotency_key,
    booked_at: row.reservation_booked_at,
    cancelled_at: row.reservation_cancelled_at,
  };
}

// ─── Reservation list (shared by reservations + admin domains) ──────────────
export async function listReservationsFor(actor, status, id, { includePayment = false } = {}) {
  const isAdmin = actor.role === 'admin';
  const userFilter = isAdmin
    ? sql``
    : sql`and (res.user_id = ${actor.id}::uuid or r.driver_id in (select id from public.drivers where user_id = ${actor.id}::uuid))`;

  const paymentSelect = includePayment
    ? sql`,
        p.id as payment_id,
        p.method as payment_method,
        p.amount as payment_amount,
        p.status as payment_status,
        p.gateway_reference as payment_gateway_reference,
        p.flagged as payment_flagged,
        p.paid_at as payment_paid_at,
        p.refunded_at as payment_refunded_at`
    : sql``;
  const paymentJoin = includePayment
    ? sql`left join public.payments p on p.reservation_id = res.id`
    : sql``;

  const rows = await withTimeout(
    sql`
      select
        res.id as reservation_id,
        res.user_id as reservation_user_id,
        res.ride_id as reservation_ride_id,
        res.seats_booked as reservation_seats_booked,
        res.total_price as reservation_total_price,
        res.status as reservation_status,
        res.booked_at as reservation_booked_at,
        r.id as ride_id,
        r.driver_id as ride_driver_id,
        r.route_id as ride_route_id,
        r.departure_time as ride_departure_time,
        r.status as ride_status,
        rt.id as route_id,
        rt.origin_city as route_origin_city,
        rt.destination_city as route_destination_city,
        rt.estimated_duration_min as route_estimated_duration_min,
        d.id as driver_id,
        d.rating as driver_rating,
        du.id as driver_user_id,
        du.full_name as driver_full_name
        ${paymentSelect}
      from public.reservations res
      join public.rides r on r.id = res.ride_id
      join public.routes rt on rt.id = r.route_id
      left join public.drivers d on d.id = r.driver_id
      left join public.users du on du.id = d.user_id
      ${paymentJoin}
      where (${id ?? null}::uuid is null or res.id = ${id ?? null}::uuid)
        and (${status ?? null}::reservation_status is null or res.status = ${status ?? null}::reservation_status)
        ${userFilter}
      order by res.booked_at desc
      limit 50
    `,
    8000,
    'listReservationsFor'
  );

  return rows.map((row) => ({
    reservation: reservationFrom(row),
    ride: rideFrom(row),
    route: routeFrom(row),
    driver: row.driver_id
      ? { id: row.driver_id, rating: toNumber(row.driver_rating) }
      : null,
    driverUser: row.driver_user_id
      ? {
          id: row.driver_user_id,
          full_name: row.driver_full_name,
        }
      : null,
    payment: includePayment && row.payment_id
      ? paymentFrom({
          id: row.payment_id,
          method: row.payment_method,
          amount: row.payment_amount,
          status: row.payment_status,
          gateway_reference: row.payment_gateway_reference,
          flagged: row.payment_flagged,
          paid_at: row.payment_paid_at,
          refunded_at: row.payment_refunded_at,
        })
      : null,
  }));
}

// ─── Joined rides (shared by rides + deliveries domains) ────────────────────
export async function joinedRides({ driverId, rideId, status } = {}) {
  return withTimeout(
    sql`
      select
        r.id as ride_id,
        r.driver_id as ride_driver_id,
        r.route_id as ride_route_id,
        r.departure_time as ride_departure_time,
        r.available_seats as ride_available_seats,
        r.total_seats as ride_total_seats,
        r.price_per_seat as ride_price_per_seat,
        r.status as ride_status,
        r.accepts_delivery as ride_accepts_delivery,
        r.created_at as ride_created_at,
        rt.id as route_id,
        rt.origin_city as route_origin_city,
        rt.destination_city as route_destination_city,
        rt.distance_km as route_distance_km,
        rt.estimated_duration_min as route_estimated_duration_min,
        rt.base_price as route_base_price,
        rt.created_at as route_created_at,
        d.id as driver_id,
        d.user_id as driver_user_id,
        d.vehicle_brand as driver_vehicle_brand,
        d.vehicle_model as driver_vehicle_model,
        d.seat_count as driver_seat_count,
        d.status as driver_status,
        d.rating as driver_rating,
        d.trips_completed as driver_trips_completed,
        u.full_name as driver_full_name
      from public.rides r
      join public.routes rt on rt.id = r.route_id
      left join public.drivers d on d.id = r.driver_id
      left join public.users u on u.id = d.user_id
      where 1=1
        ${rideId ? sql`and r.id = ${rideId}::uuid` : sql``}
        ${driverId ? sql`and r.driver_id in (select id from public.drivers where user_id = ${driverId}::uuid)` : sql``}
        ${status ? sql`and r.status = ${status}::ride_status` : sql``}
    `,
    8000,
    'joinedRides'
  );
}

export function toRideResult(row) {
  const ride = rideFrom(row);
  return {
    id: ride.id,
    route: routeFrom(row),
    driver: driverSummaryFrom(row),
    departure_time: ride.departure_time,
    available_seats: ride.available_seats,
    total_seats: ride.total_seats,
    price_per_seat: ride.price_per_seat,
    status: ride.status,
    accepts_delivery: ride.accepts_delivery,
    created_at: ride.created_at,
  };
}

// ─── Session helper (auth domain) ───────────────────────────────────────────
// Issues an access + refresh token pair and records the row in user_sessions.
// Lives here because both StartLogin/VerifyOtp/Register (auth.js) and
// BiometricLogin (auth.js) need it without circular imports.

import { signAccessToken, signRefreshToken } from '../auth/tokens.js';

export async function loadUserSession(userId, { includeRefreshToken = true, ctx } = {}) {
  const rows = await sql`
    select
      u.id,
      u.full_name,
      u.role,
      u.is_active,
      d.status as driver_status
    from public.users u
    left join public.drivers d on d.user_id = u.id
    where u.id = ${userId}::uuid
    limit 1
  `;
  const user = rows[0];
  if (!user || user.is_active === false) return null;
  const driverStatus = user.driver_status ?? (user.role === 'driver' ? 'pending' : null);
  const ip = ctx?.ip || null;
  const ua = ctx?.req?.get('user-agent') || null;

  const sessionRow = await sql`
    insert into public.user_sessions (
      user_id,
      device_info,
      ip_address,
      expires_at
    ) values (
      ${user.id}::uuid,
      ${ua},
      ${ip}::inet,
      now() + interval '14 days'
    )
    returning session_id
  `;
  const sessionId = sessionRow[0].session_id;

  const claims = {
    sub: user.id,
    role: user.role,
    name: user.full_name,
    driverStatus,
    jti: sessionId,
  };
  const refreshToken = includeRefreshToken ? await signRefreshToken(claims) : null;
  return {
    accessToken: signAccessToken(claims),
    ...(includeRefreshToken ? { refreshToken } : {}),
    user: {
      id: user.id,
      name: user.full_name,
      role: user.role,
      driverStatus,
    },
  };
}
