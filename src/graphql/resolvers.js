import crypto from 'crypto';

import { sql } from '../db.js';
import { actorFromRequest } from '../middleware/auth.js';
import { delSession, getSession, setSession } from '../cache/redis.js';
import { config } from '../config.js';
import {
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  signBiometricTicket,
  signRefreshToken,
  verifyToken,
} from '../auth/tokens.js';
import { normalizeTunisianPhone, sanitize, validateEmail, validateFileSize, validateName, validateOtp, validatePassword, validatePlate, validateSeatCount, validateTunisianPhone } from '../utils/validation.js';
import { can } from '../utils/rbac.js';
import { logSupabaseError, safeQuery } from '../lib/supabase/logger.js';
import { dbBreaker } from '../lib/supabase/CircuitBreaker.js';
import { withRetry } from '../lib/supabase/withRetry.js';
import { withTimeout } from '../lib/supabase/withTimeout.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toNumber(value) {
  return value == null ? value : Number(value);
}

function paymentReference(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function safeEqualString(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const rightHash = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function validAdminImpersonationCode(code) {
  return Boolean(code) && safeEqualString(code, config.adminImpersonationCode);
}

function assertCan(actor, action) {
  if (!can(actor?.role, action)) return { ok: false, error: 'Forbidden' };
  return null;
}

async function requireActor(ctx) {
  const actor = await actorFromRequest(ctx.req);
  if (!actor) throw new HttpError(401, 'Invalid or expired token');
  return actor;
}

async function appendAudit({ actor, action, targetEntity, targetId, metadata, ip }) {
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

function routeFrom(row, prefix = 'route_') {
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

function rideFrom(row, prefix = 'ride_') {
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
    created_at: row[`${prefix}created_at`],
  };
}

function driverSummaryFrom(row) {
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

function driverFullFrom(row) {
  if (!row?.id) return null;
  return {
    ...row,
    rating: toNumber(row.rating),
    plate_number: row.plate_number,
    id_card_number: row.id_card_number,
    license_number: row.license_number,
  };
}

function paymentFrom(row) {
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

function reservationFrom(row) {
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

async function loadUserSession(userId, { includeRefreshToken = true } = {}) {
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
  const claims = {
    sub: user.id,
    role: user.role,
    name: user.full_name,
    driverStatus,
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

async function listReservationsFor(actor, status, id) {
  const rows = await withTimeout(
    sql`
      select
        res.id as reservation_id,
        res.user_id as reservation_user_id,
        res.ride_id as reservation_ride_id,
        res.seats_booked as reservation_seats_booked,
        res.total_price as reservation_total_price,
        res.status as reservation_status,
        res.idempotency_key as reservation_idempotency_key,
        res.booked_at as reservation_booked_at,
        res.cancelled_at as reservation_cancelled_at,
        r.id as ride_id,
        r.driver_id as ride_driver_id,
        r.route_id as ride_route_id,
        r.departure_time as ride_departure_time,
        r.available_seats as ride_available_seats,
        r.total_seats as ride_total_seats,
        r.price_per_seat as ride_price_per_seat,
        r.status as ride_status,
        r.created_at as ride_created_at,
        rt.id as route_id,
        rt.origin_city as route_origin_city,
        rt.destination_city as route_destination_city,
        rt.distance_km as route_distance_km,
        rt.estimated_duration_min as route_estimated_duration_min,
        rt.base_price as route_base_price,
        rt.created_at as route_created_at,
        d.id as driver_id,
        d.vehicle_brand as driver_vehicle_brand,
        d.vehicle_model as driver_vehicle_model,
        d.seat_count as driver_seat_count,
        d.status as driver_status,
        d.rating as driver_rating,
        d.trips_completed as driver_trips_completed,
        du.id as driver_user_id,
        du.full_name as driver_full_name,
        du.email as driver_email,
        p.id as payment_id,
        p.method as payment_method,
        p.amount as payment_amount,
        p.status as payment_status,
        p.gateway_reference as payment_gateway_reference,
        p.flagged as payment_flagged,
        p.paid_at as payment_paid_at,
        p.refunded_at as payment_refunded_at
      from public.reservations res
      join public.rides r on r.id = res.ride_id
      join public.routes rt on rt.id = r.route_id
      left join public.drivers d on d.id = r.driver_id
      left join public.users du on du.id = d.user_id
      left join public.payments p on p.reservation_id = res.id
      where (${id ?? null}::uuid is null or res.id = ${id ?? null}::uuid)
        and (${status ?? null}::reservation_status is null or res.status = ${status ?? null}::reservation_status)
        and (
          ${actor.role} = 'admin'
          or res.user_id = ${actor.id}::uuid
          or d.user_id = ${actor.id}::uuid
        )
      order by res.booked_at desc
    `,
    8000,
    'listReservationsFor'
  );

  return rows.map((row) => ({
    reservation: reservationFrom(row),
    ride: rideFrom(row),
    route: routeFrom(row),
    driver: driverFullFrom({
      id: row.driver_id,
      user_id: row.driver_user_id,
      vehicle_brand: row.driver_vehicle_brand,
      vehicle_model: row.driver_vehicle_model,
      seat_count: row.driver_seat_count,
      status: row.driver_status,
      rating: row.driver_rating,
      trips_completed: row.driver_trips_completed,
    }),
    driverUser: row.driver_user_id
      ? {
          id: row.driver_user_id,
          full_name: row.driver_full_name,
          email: row.driver_email,
        }
      : null,
    payment: row.payment_id
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

async function joinedRides() {
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
    `,
    8000,
    'joinedRides'
  );
}

function toRideResult(row) {
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
    created_at: ride.created_at,
  };
}

export const resolvers = {
  async StartLogin({ phone, password }, ctx) {
    const phoneErr = validateTunisianPhone(phone);
    if (phoneErr) return { ok: false, error: phoneErr };

    const normalizedPhone = normalizeTunisianPhone(phone);
    const rows = await sql`
      select
        u.id,
        u.role,
        u.full_name,
        u.is_active,
        u.password_hash = extensions.crypt(${password || ''}, u.password_hash) as password_ok
      from public.users u
      where u.phone_number = ${normalizedPhone}
      limit 1
    `;
    const user = rows[0];
    if (!user?.is_active || !user.password_ok) {
      return { ok: false, error: 'Phone or password is incorrect' };
    }

    await appendAudit({
      actor: { id: user.id, role: user.role },
      action: 'login.credentials_ok',
      targetEntity: 'user',
      targetId: user.id,
      ip: ctx.ip,
    });

    return {
      ok: true,
      next: 'otp',
      userId: user.id,
      devOtp: config.env === 'production' ? null : config.devOtpCode,
    };
  },

  async VerifyOtp({ userId, purpose, otp }, ctx) {
    const otpErr = validateOtp(otp);
    if (otpErr) return { ok: false, error: otpErr };
    if (otp !== config.devOtpCode) return { ok: false, error: 'OTP failed' };

    const session = await loadUserSession(userId);
    if (!session) return { ok: false, error: 'User not found' };

    await appendAudit({
      actor: { id: session.user.id, role: session.user.role },
      action: purpose === 'register' ? 'register.verified' : 'login.success',
      targetEntity: 'user',
      targetId: session.user.id,
      ip: ctx.ip,
    });

    return { ok: true, ...session };
  },

  async Register({ fullName, phone, email, password, role }, ctx) {
    const errors = {};
    const nameErr = validateName(fullName);
    if (nameErr) errors.fullName = nameErr;
    const phoneErr = validateTunisianPhone(phone);
    if (phoneErr) errors.phone = phoneErr;
    const emailErr = validateEmail(email);
    if (emailErr) errors.email = emailErr;
    const passwordErr = validatePassword(password);
    if (passwordErr) errors.password = passwordErr;
    if (!['passenger', 'driver'].includes(role)) errors.role = 'Choose passenger or driver';
    if (Object.keys(errors).length) return { ok: false, errors };

    const normalizedPhone = normalizeTunisianPhone(phone);
    const existing = await sql`
      select phone_number, email
      from public.users
      where phone_number = ${normalizedPhone}
         or lower(email) = lower(${email})
      limit 1
    `;
    if (existing.length) {
      const row = existing[0];
      return {
        ok: false,
        errors: {
          ...(row.phone_number === normalizedPhone ? { phone: 'Phone already registered' } : {}),
          ...(row.email?.toLowerCase() === email.toLowerCase() ? { email: 'Email already in use' } : {}),
        },
      };
    }

    const rows = await sql`
      insert into public.users (
        full_name,
        phone_number,
        email,
        role,
        password_hash,
        is_active
      ) values (
        ${sanitize(fullName)},
        ${normalizedPhone},
        ${email.toLowerCase()},
        ${role}::user_role,
        extensions.crypt(${password}, extensions.gen_salt('bf')),
        true
      )
      returning id, role
    `;
    const user = rows[0];
    await appendAudit({
      actor: { id: user.id, role: user.role },
      action: 'register.created',
      targetEntity: 'user',
      targetId: user.id,
      ip: ctx.ip,
    });

    return {
      ok: true,
      userId: user.id,
      devOtp: config.env === 'production' ? null : config.devOtpCode,
    };
  },

  async ResendOtp({ userId }) {
    const rows = await sql`select id from public.users where id = ${userId}::uuid limit 1`;
    if (!rows.length) return { ok: false, error: 'User not found' };
    return { ok: true, devOtp: config.env === 'production' ? null : config.devOtpCode };
  },

  async Refresh({ refreshToken }) {
    const rotated = await rotateRefreshToken(refreshToken);
    if (!rotated) return { ok: false, error: 'Invalid refresh token' };
    const session = await loadUserSession(rotated.claims.sub, { includeRefreshToken: false });
    if (!session) return { ok: false, error: 'Invalid refresh token' };
    return {
      ok: true,
      accessToken: session.accessToken,
      refreshToken: rotated.refreshToken,
    };
  },

  async Logout({ refreshToken }, ctx) {
    await revokeRefreshToken(refreshToken);
    const actor = await actorFromRequest(ctx.req);
    if (actor) {
      await delSession(actor.id);
    }
    return { ok: true };
  },

  async EnrollBiometric({ userId }, ctx) {
    const actor = await requireActor(ctx);
    if (actor.id !== userId && actor.role !== 'admin') return { ok: false, error: 'Forbidden' };
    const ticket = signBiometricTicket({
      sub: actor.id,
      role: actor.role,
      name: actor.name,
      driverStatus: actor.driverStatus,
    });
    await appendAudit({
      actor,
      action: 'biometric.enrolled',
      targetEntity: 'user',
      targetId: actor.id,
      ip: ctx.ip,
    });
    return { ok: true, ticket };
  },

  async BiometricLogin({ ticket }, ctx) {
    const claims = verifyToken(ticket);
    if (!claims || claims.kind !== 'biometric') {
      return { ok: false, error: 'Biometric credential is no longer valid. Sign in with your phone and password.' };
    }
    
    // Try Redis cache first for the user profile
    const cached = await getSession(claims.sub);
    let session;
    if (cached) {
      const sessionClaims = {
        sub: cached.id,
        role: cached.role,
        name: cached.name,
        driverStatus: cached.driverStatus,
      };
      session = {
        accessToken: signAccessToken(sessionClaims),
        refreshToken: await signRefreshToken(sessionClaims),
        user: { id: cached.id, name: cached.name, role: cached.role, driverStatus: cached.driverStatus },
      };
    } else {
      session = await loadUserSession(claims.sub);
      if (session) await setSession(claims.sub, { id: session.user.id, role: session.user.role, name: session.user.name, driverStatus: session.user.driverStatus });
    }

    if (!session) return { ok: false, error: 'Account unavailable' };
    const nextTicket = signBiometricTicket({
      sub: session.user.id,
      role: session.user.role,
      name: session.user.name,
      driverStatus: session.user.driverStatus,
    });
    await appendAudit({
      actor: { id: session.user.id, role: session.user.role },
      action: 'login.biometric',
      targetEntity: 'user',
      targetId: session.user.id,
      ip: ctx.ip,
    });
    return { ok: true, ...session, ticket: nextTicket };
  },

  async ListRoutes() {
    const rows = await sql`
      select id, origin_city, destination_city, distance_km, estimated_duration_min, base_price, created_at
      from public.routes
      order by origin_city, destination_city
    `;
    return rows.map((row) => ({ ...row, base_price: toNumber(row.base_price) }));
  },

  async ListCities() {
    const rows = await sql`
      select city
      from (
        select origin_city as city from public.routes
        union
        select destination_city as city from public.routes
      ) c
      order by city
    `;
    return rows.map((row) => row.city);
  },

  async SearchRides({ origin, destination, date, seats = 1, filters = {}, sort = 'departure' }) {
    const rows = await joinedRides();
    const startOfDay = date ? new Date(date) : null;
    if (startOfDay) startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = startOfDay ? new Date(startOfDay.getTime() + 86400 * 1000) : null;

    let results = rows
      .map(toRideResult)
      .filter((ride) => ride.status === 'scheduled')
      .filter((ride) => ride.available_seats >= Number(seats || 1))
      .filter((ride) => {
        if (origin && ride.route.origin_city.toLowerCase() !== origin.toLowerCase()) return false;
        if (destination && ride.route.destination_city.toLowerCase() !== destination.toLowerCase()) return false;
        if (startOfDay) {
          const t = new Date(ride.departure_time).getTime();
          if (t < startOfDay.getTime() || t >= endOfDay.getTime()) return false;
        }
        if (filters.priceMax && ride.price_per_seat > filters.priceMax) return false;
        if (filters.ratingMin && (ride.driver?.rating ?? 0) < filters.ratingMin) return false;
        if (
          filters.departureBefore &&
          new Date(ride.departure_time).getHours() > filters.departureBefore
        ) {
          return false;
        }
        return true;
      });

    if (sort === 'price') results.sort((a, b) => a.price_per_seat - b.price_per_seat);
    else if (sort === 'rating') results.sort((a, b) => (b.driver?.rating ?? 0) - (a.driver?.rating ?? 0));
    else results.sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time));
    return results;
  },

  async GetRideDetail({ rideId }) {
    const rows = await joinedRides();
    const row = rows.find((r) => r.ride_id === rideId);
    return row ? toRideResult(row) : null;
  },

  async CreateRide({ origin, destination, routeId, departureTime, pricePerSeat, availableSeats }, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'rides:create');
    if (denied) return denied;

    const driverRows = await sql`
      select * from public.drivers where user_id = ${actor.id}::uuid limit 1
    `;
    const driver = driverRows[0];
    if (!driver) return { ok: false, error: 'Driver record not found' };
    if (driver.status !== 'verified') return { ok: false, error: 'Driver not verified' };

    let route;
    if (routeId) {
      const routeRows = await sql`select * from public.routes where id = ${routeId}::uuid limit 1`;
      route = routeRows[0];
    } else if (origin && destination) {
      const routeRows = await sql`
        select * from public.routes
        where lower(origin_city) = lower(${origin})
          and lower(destination_city) = lower(${destination})
        limit 1`;
      route = routeRows[0];
    }
    if (!route) return { ok: false, error: 'Unknown route' };

    const departureMs = new Date(departureTime).getTime();
    if (!departureMs || departureMs < Date.now() + 30 * 60 * 1000) {
      return { ok: false, error: 'Must depart 30+ min from now' };
    }
    const seats = Number(availableSeats);
    if (seats < 1 || seats > driver.seat_count) {
      return { ok: false, error: `Seats must be 1-${driver.seat_count}` };
    }
    const min = Number(route.base_price) * 0.5;
    const max = Number(route.base_price) * 1.5;
    const price = Number(pricePerSeat);
    if (price < min || price > max) {
      return { ok: false, error: `Price must be ${min.toFixed(0)}-${max.toFixed(0)} TND` };
    }

    const rows = await sql`
      insert into public.rides (
        driver_id,
        route_id,
        departure_time,
        available_seats,
        total_seats,
        price_per_seat,
        status
      ) values (
        ${driver.id}::uuid,
        ${route.id}::uuid,
        ${new Date(departureTime).toISOString()},
        ${seats},
        ${seats},
        ${price},
        'scheduled'
      )
      returning *
    `;
    await appendAudit({
      actor,
      action: 'ride.created',
      targetEntity: 'ride',
      targetId: rows[0].id,
      ip: ctx.ip,
    });
    return { ok: true, ride: { ...rows[0], price_per_seat: toNumber(rows[0].price_per_seat) } };
  },

  async UpdateRideStatus({ rideId, status }, ctx) {
    const actor = await requireActor(ctx);
    if (!['scheduled', 'in_progress', 'completed', 'cancelled'].includes(status)) {
      return { ok: false, error: 'Invalid status' };
    }
    const rows = await sql`
      select r.*, d.user_id
      from public.rides r
      join public.drivers d on d.id = r.driver_id
      where r.id = ${rideId}::uuid
      limit 1
    `;
    const ride = rows[0];
    if (!ride) return { ok: false, error: 'Not found' };
    if (actor.role !== 'admin' && ride.user_id !== actor.id) return { ok: false, error: 'Forbidden' };

    const updated = await sql`
      update public.rides
      set status = ${status}::ride_status
      where id = ${rideId}::uuid
      returning *
    `;
    await appendAudit({
      actor,
      action: `ride.status.${status}`,
      targetEntity: 'ride',
      targetId: rideId,
      ip: ctx.ip,
    });
    return { ok: true, ride: { ...updated[0], price_per_seat: toNumber(updated[0].price_per_seat) } };
  },

  async CancelRide({ rideId, reason }, ctx) {
    const actor = await requireActor(ctx);
    return sql.begin(async (tx) => {
      const rows = await tx`
        select r.*, d.user_id
        from public.rides r
        join public.drivers d on d.id = r.driver_id
        where r.id = ${rideId}::uuid
        for update
      `;
      const ride = rows[0];
      if (!ride) return { ok: false, error: 'Not found' };
      if (actor.role !== 'admin' && ride.user_id !== actor.id) return { ok: false, error: 'Forbidden' };
      if (['completed', 'in_progress'].includes(ride.status)) {
        return { ok: false, error: 'Cannot cancel a ride already in progress or completed' };
      }

      await tx`update public.rides set status = 'cancelled' where id = ${rideId}::uuid`;
      const affected = await tx`
        update public.reservations
        set status = 'cancelled', cancelled_at = now()
        where ride_id = ${rideId}::uuid and status = 'confirmed'
        returning id
      `;
      if (affected.length) {
        await tx`
          update public.payments
          set status = 'refunded', refunded_at = now()
          where reservation_id in ${tx(affected.map((r) => r.id))} and status = 'succeeded'
        `;
      }
      await tx`
        insert into public.audit_log (
          actor_id, actor_role, action, target_entity, target_id, metadata, ip_address
        ) values (
          ${actor.id}::uuid,
          ${actor.role}::user_role,
          'ride.cancelled',
          'ride',
          ${rideId}::uuid,
          ${JSON.stringify({ reason, affectedReservations: affected.length })}::jsonb,
          ${ctx.ip ?? 'server'}
        )
      `;
      return { ok: true, cancelled: affected.length };
    });
  },

  async DriverRides({ status }, ctx) {
    const actor = await requireActor(ctx);
    const rows = await joinedRides();
    return rows
      .filter((row) => row.driver_user_id === actor.id)
      .filter((row) => (status ? row.ride_status === status : true))
      .map((row) => ({ ...rideFrom(row), route: routeFrom(row) }))
      .sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time));
  },

  async RidePassengers({ rideId }, ctx) {
    const actor = await requireActor(ctx);
    const rideRows = await sql`
      select r.id, d.user_id
      from public.rides r
      join public.drivers d on d.id = r.driver_id
      where r.id = ${rideId}::uuid
      limit 1
    `;
    const ride = rideRows[0];
    if (!ride) return [];
    if (actor.role !== 'admin' && ride.user_id !== actor.id) return [];

    const rows = await sql`
      select res.*, u.id as user_id, u.full_name, u.email, u.phone_number
      from public.reservations res
      join public.users u on u.id = res.user_id
      where res.ride_id = ${rideId}::uuid
      order by res.booked_at desc
    `;
    return rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      ride_id: row.ride_id,
      seats_booked: row.seats_booked,
      total_price: toNumber(row.total_price),
      status: row.status,
      booked_at: row.booked_at,
      cancelled_at: row.cancelled_at,
      user: {
        id: row.user_id,
        full_name: row.full_name,
        email: row.email,
        phone_number: row.phone_number,
      },
    }));
  },

  async DriverEarnings({ period = 'week' }, ctx) {
    const actor = await requireActor(ctx);
    const driverRows = await sql`
      select * from public.drivers where user_id = ${actor.id}::uuid limit 1
    `;
    const driver = driverRows[0];
    const empty = {
      period,
      today: 0,
      week: 0,
      month: 0,
      history: [],
      historyStart: null,
      tripsThisPeriod: 0,
      tripsPrevPeriod: 0,
      seatsSold: 0,
      seatsPrev: 0,
      seatsCapacity: 0,
      seatsCapacityPrev: 0,
      occupancyPct: 0,
      occupancyPrevPct: 0,
      avgFare: 0,
      avgFarePrev: 0,
      earningsPrev: 0,
      cancelRatePct: 0,
      topRoute: null,
      rating: null,
      tripsCompleted: 0,
    };
    if (!driver) return empty;

    const rows = await withTimeout(
      sql`
        select
          r.*,
          rt.origin_city,
          rt.destination_city
        from public.rides r
        join public.routes rt on rt.id = r.route_id
        where r.driver_id = ${driver.id}::uuid
      `,
      8000,
      'DriverEarnings'
    );

    const now = Date.now();
    const dayMs = 86400 * 1000;
    const bins = period === 'month' ? 30 : 7;
    const periodMs = bins * dayMs;
    const history = Array(bins).fill(0);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayStartMs = startOfToday.getTime();
    const historyStartMs = todayStartMs - (bins - 1) * dayMs;
    const endThis = todayStartMs + dayMs;
    const startThis = endThis - periodMs;
    const startPrev = startThis - periodMs;

    let today = 0;
    let week = 0;
    let month = 0;
    let tripsThisPeriod = 0;
    let tripsPrevPeriod = 0;
    let seatsSold = 0;
    let seatsPrev = 0;
    let seatsCapacity = 0;
    let seatsCapacityPrev = 0;
    let earningsThis = 0;
    let earningsPrev = 0;
    let cancelledThis = 0;
    const routeRevenue = new Map();
    const routeCount = new Map();

    const payments = await sql`
      select res.ride_id, sum(p.amount - coalesce(p.platform_fee, 0)) as net_revenue
      from public.payments p
      join public.reservations res on res.id = p.reservation_id
      where p.status = 'succeeded'
      group by res.ride_id
    `;
    const revenueByRide = new Map(payments.map(p => [p.ride_id, Number(p.net_revenue)]));

    rows.forEach((ride) => {
      const sold = Math.max(0, ride.total_seats - ride.available_seats);
      const revenue = revenueByRide.get(ride.id) || 0;
      const t = new Date(ride.departure_time).getTime();
      const counted = ride.status !== 'cancelled';

      if (counted) {
        if (t > now - dayMs && t <= now) today += revenue;
        if (t > now - 7 * dayMs && t <= now) week += revenue;
        if (t > now - 30 * dayMs && t <= now) month += revenue;
        if (t >= historyStartMs && t < todayStartMs + dayMs) {
          const idx = Math.floor((t - historyStartMs) / dayMs);
          if (idx >= 0 && idx < bins) history[idx] += revenue;
        }
      }

      if (t >= startThis && t < endThis) {
        if (counted) {
          tripsThisPeriod += 1;
          seatsSold += sold;
          seatsCapacity += ride.total_seats;
          earningsThis += revenue;
          routeRevenue.set(ride.route_id, (routeRevenue.get(ride.route_id) || 0) + revenue);
          routeCount.set(ride.route_id, (routeCount.get(ride.route_id) || 0) + 1);
        } else {
          cancelledThis += 1;
        }
      } else if (t >= startPrev && t < startThis && counted) {
        tripsPrevPeriod += 1;
        seatsPrev += sold;
        seatsCapacityPrev += ride.total_seats;
        earningsPrev += revenue;
      }
    });

    const occupancyPct = seatsCapacity > 0 ? Math.round((seatsSold / seatsCapacity) * 100) : 0;
    const occupancyPrevPct =
      seatsCapacityPrev > 0 ? Math.round((seatsPrev / seatsCapacityPrev) * 100) : 0;
    const avgFare = tripsThisPeriod > 0 ? earningsThis / tripsThisPeriod : 0;
    const avgFarePrev = tripsPrevPeriod > 0 ? earningsPrev / tripsPrevPeriod : 0;
    const totalThisWindow = tripsThisPeriod + cancelledThis;
    const cancelRatePct =
      totalThisWindow > 0 ? Math.round((cancelledThis / totalThisWindow) * 100) : 0;

    let topRoute = null;
    if (routeRevenue.size) {
      const [topId] = [...routeRevenue.entries()].sort((a, b) => b[1] - a[1])[0];
      const route = rows.find((r) => r.route_id === topId);
      if (route) {
        topRoute = {
          route_id: topId,
          origin_city: route.origin_city,
          destination_city: route.destination_city,
          count: routeCount.get(topId) || 0,
          revenue: routeRevenue.get(topId) || 0,
        };
      }
    }

    return {
      period,
      today,
      week,
      month,
      history,
      historyStart: new Date(historyStartMs).toISOString(),
      tripsThisPeriod,
      tripsPrevPeriod,
      seatsSold,
      seatsPrev,
      seatsCapacity,
      seatsCapacityPrev,
      occupancyPct,
      occupancyPrevPct,
      avgFare,
      avgFarePrev,
      earningsPrev,
      cancelRatePct,
      topRoute,
      rating: toNumber(driver.rating),
      tripsCompleted: driver.trips_completed,
    };
  },

  async AdminListRides({ filters = {} }, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:read');
    if (denied) return [];
    const rows = await joinedRides();
    return rows
      .filter((row) => (filters.status ? row.ride_status === filters.status : true))
      .filter((row) => (filters.driverId ? row.ride_driver_id === filters.driverId : true))
      .filter((row) => (filters.routeId ? row.ride_route_id === filters.routeId : true))
      .map((row) => ({ ...rideFrom(row), route: routeFrom(row), driver: driverSummaryFrom(row) }));
  },

  async CreateReservation({ rideId, seats, paymentMethod = 'card', idempotencyKey }, ctx) {
    const PLATFORM_FEE = 1.5; // TND
    const DRIVER_FEE   = 1.5; // TND

    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'rides:book');
    if (denied) return denied;
    const key = idempotencyKey || crypto.randomBytes(10).toString('hex');
    const seatCount = Number(seats || 1);

    return dbBreaker.call(() =>
      withRetry(() =>
        safeQuery(
          () =>
            sql.begin(async (tx) => {
              const replay = await tx`
                select *
                from public.reservations
                where user_id = ${actor.id}::uuid and idempotency_key = ${key}
                limit 1
              `;
              if (replay.length) {
                return {
                  ok: true,
                  reservation: { ...replay[0], total_price: toNumber(replay[0].total_price) },
                  replay: true,
                };
              }

              const rideRows = await tx`
                select *
                from public.rides
                where id = ${rideId}::uuid
                for update
              `;
              const ride = rideRows[0];
              if (!ride) return { ok: false, error: 'Ride not found' };
              if (ride.status !== 'scheduled') return { ok: false, error: 'Ride no longer accepting bookings' };
              if (ride.available_seats < seatCount) return { ok: false, error: 'Not enough seats' };

              const seatCost = Number(ride.price_per_seat) * seatCount;
              const totalPrice = seatCost + PLATFORM_FEE + DRIVER_FEE;
              const reservations = await tx`
                insert into public.reservations (
                  user_id,
                  ride_id,
                  seats_booked,
                  total_price,
                  status,
                  idempotency_key
                ) values (
                  ${actor.id}::uuid,
                  ${rideId}::uuid,
                  ${seatCount},
                  ${totalPrice},
                  'confirmed',
                  ${key}
                )
                returning *
              `;
              await tx`
                update public.rides
                set available_seats = available_seats - ${seatCount}
                where id = ${rideId}::uuid
              `;
              const prefix = paymentMethod === 'cash' ? 'CASH' : 'PAY';
              const payments = await tx`
                insert into public.payments (
                  reservation_id,
                  method,
                  amount,
                  platform_fee,
                  driver_fee,
                  status,
                  gateway_reference
                ) values (
                  ${reservations[0].id}::uuid,
                  ${paymentMethod}::payment_method,
                  ${totalPrice},
                  ${PLATFORM_FEE},
                  ${DRIVER_FEE},
                  'succeeded',
                  ${paymentReference(prefix)}
                )
                returning *
              `;
              const driverRows = await tx`
                select d.user_id
                from public.drivers d
                where d.id = ${ride.driver_id}::uuid
                limit 1
              `;
              if (driverRows[0]) {
                await tx`
                  insert into public.notifications (user_id, title, body)
                  values (
                    ${driverRows[0].user_id}::uuid,
                    'New booking',
                    ${`${seatCount} seat${seatCount > 1 ? 's' : ''} reserved on your ride.`}
                  )
                `;
              }
              await tx`
                insert into public.audit_log (
                  actor_id, actor_role, action, target_entity, target_id, metadata, ip_address
                ) values (
                  ${actor.id}::uuid,
                  ${actor.role}::user_role,
                  'reservation.confirmed',
                  'reservation',
                  ${reservations[0].id}::uuid,
                  ${JSON.stringify({ amount: totalPrice, seatCost, platformFee: PLATFORM_FEE, driverFee: DRIVER_FEE, gateway: payments[0].gateway_reference })}::jsonb,
                  ${ctx.ip ?? 'server'}
                )
              `;
              return {
                ok: true,
                reservation: { ...reservations[0], total_price: toNumber(reservations[0].total_price) },
                payment: paymentFrom(payments[0]),
              };
            }),
          { operation: 'CreateReservation' }
        ),
        { label: 'CreateReservation' }
      ),
      'CreateReservation'
    );
  },

  async ListReservations({ status }, ctx) {
    const actor = await requireActor(ctx);
    return listReservationsFor(actor, status);
  },

  async GetReservation({ id }, ctx) {
    const actor = await requireActor(ctx);
    const rows = await listReservationsFor(actor, null, id);
    return rows[0] ?? null;
  },

  async CancelReservation({ id }, ctx) {
    const actor = await requireActor(ctx);
    return sql.begin(async (tx) => {
      const rows = await tx`
        select res.*, r.departure_time, r.available_seats
        from public.reservations res
        join public.rides r on r.id = res.ride_id
        where res.id = ${id}::uuid
        for update
      `;
      const reservation = rows[0];
      if (!reservation) return { ok: false, error: 'Not found' };
      if (reservation.user_id !== actor.id && actor.role !== 'admin') {
        return { ok: false, error: 'Forbidden' };
      }
      if (reservation.status !== 'confirmed') return { ok: false, error: 'Already cancelled' };
      if (actor.role !== 'admin') {
        const minsLeft = (new Date(reservation.departure_time).getTime() - Date.now()) / 60000;
        if (minsLeft < 120) return { ok: false, error: 'Too close to departure to cancel' };
      }

      const updated = await tx`
        update public.reservations
        set status = 'cancelled', cancelled_at = now()
        where id = ${id}::uuid
        returning *
      `;
      await tx`
        update public.rides
        set available_seats = available_seats + ${reservation.seats_booked}
        where id = ${reservation.ride_id}::uuid
      `;
      // Only refund the seat cost — the 3 TND reservation fee is non-refundable
      await tx`
        update public.payments
        set status = 'refunded',
            refunded_at = now(),
            refunded_amount = amount - platform_fee - driver_fee
        where reservation_id = ${id}::uuid and status = 'succeeded'
      `;
      await tx`
        insert into public.audit_log (
          actor_id, actor_role, action, target_entity, target_id, ip_address
        ) values (
          ${actor.id}::uuid,
          ${actor.role}::user_role,
          'reservation.cancelled',
          'reservation',
          ${id}::uuid,
          ${ctx.ip ?? 'server'}
        )
      `;
      return { ok: true, reservation: { ...updated[0], total_price: toNumber(updated[0].total_price) } };
    });
  },

  async ListPayments(ctxVars, ctx) {
    const actor = await requireActor(ctx);
    const rows =
      actor.role === 'admin'
        ? await sql`select * from public.payments order by paid_at desc`
        : await sql`
            select p.*
            from public.payments p
            join public.reservations r on r.id = p.reservation_id
            where r.user_id = ${actor.id}::uuid
            order by p.paid_at desc
          `;
    return rows.map(paymentFrom);
  },

  async AdminRefund({ paymentId, amount }, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:refund');
    if (denied) return denied;
    const rows = await sql`select * from public.payments where id = ${paymentId}::uuid limit 1`;
    const payment = rows[0];
    if (!payment) return { ok: false, error: 'Not found' };
    if (payment.status === 'refunded') return { ok: false, error: 'Already refunded' };
    const value = Number(amount);
    if (value <= 0) return { ok: false, error: 'Invalid amount' };
    if (value > Number(payment.amount)) return { ok: false, error: 'Amount exceeds payment' };

    const updated = await sql`
      update public.payments
      set
        status = 'refunded',
        refunded_at = now(),
        refunded_amount = ${value},
        refund_type = ${value < Number(payment.amount) ? 'partial' : 'full'}
      where id = ${paymentId}::uuid
      returning *
    `;
    await appendAudit({
      actor,
      action: value < Number(payment.amount) ? 'payment.refund.partial' : 'payment.refund.full',
      targetEntity: 'payment',
      targetId: paymentId,
      metadata: { amount: value, original: Number(payment.amount) },
      ip: ctx.ip,
    });
    return { ok: true, payment: paymentFrom(updated[0]) };
  },

  async AdminFlagPayment({ paymentId, reason }, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:read');
    if (denied) return denied;
    const updated = await sql`
      update public.payments
      set status = 'flagged', flagged = true, flagged_reason = ${reason || 'flagged by admin'}
      where id = ${paymentId}::uuid
      returning *
    `;
    if (!updated.length) return { ok: false, error: 'Not found' };
    await appendAudit({
      actor,
      action: 'payment.flagged',
      targetEntity: 'payment',
      targetId: paymentId,
      metadata: { reason },
      ip: ctx.ip,
    });
    return { ok: true, payment: paymentFrom(updated[0]) };
  },

  async RegisterDriverApplication(
    { idCardNumber, licenseNumber, plateNumber, brand, model, seatCount, files = [] },
    ctx
  ) {
    const actor = await requireActor(ctx);
    const errors = {};
    if (!idCardNumber) errors.idCardNumber = 'ID required';
    if (!licenseNumber) errors.licenseNumber = 'License required';
    const plateErr = validatePlate(plateNumber);
    if (plateErr) errors.plateNumber = plateErr;
    if (!brand) errors.brand = 'Brand required';
    if (!model) errors.model = 'Model required';
    const seatErr = validateSeatCount(seatCount, 8);
    if (seatErr) errors.seatCount = seatErr;
    for (const file of files) {
      const limit = file.kind === 'vehicle' ? 3 : 5;
      const fileErr = validateFileSize(file.sizeBytes, limit);
      if (fileErr) errors[file.kind] = fileErr;
      if (file.mime && !['image/jpeg', 'image/png', 'application/pdf'].includes(file.mime)) {
        errors[file.kind] = 'Use JPEG, PNG, or PDF';
      }
    }
    if (Object.keys(errors).length) return { ok: false, errors };

    const plate = plateNumber.toUpperCase();
    const duplicate = await sql`
      select id
      from public.drivers
      where plate_number = ${plate} and user_id <> ${actor.id}::uuid
      limit 1
    `;
    if (duplicate.length) return { ok: false, errors: { plateNumber: 'Plate already registered' } };

    const rows = await sql`
      insert into public.drivers (
        user_id,
        plate_number,
        id_card_number,
        license_number,
        vehicle_brand,
        vehicle_model,
        seat_count,
        status,
        rating,
        trips_completed
      ) values (
        ${actor.id}::uuid,
        ${plate},
        ${idCardNumber},
        ${licenseNumber},
        ${sanitize(brand)},
        ${sanitize(model)},
        ${Number(seatCount)},
        'pending',
        0,
        0
      )
      on conflict (user_id) do update set
        plate_number = excluded.plate_number,
        id_card_number = excluded.id_card_number,
        license_number = excluded.license_number,
        vehicle_brand = excluded.vehicle_brand,
        vehicle_model = excluded.vehicle_model,
        seat_count = excluded.seat_count,
        status = 'pending'
      returning id
    `;
    for (const file of files) {
      const documentKind =
        file.kind === 'id'
          ? 'id_card'
          : ['license', 'vehicle', 'other'].includes(file.kind)
            ? file.kind
            : 'other';
      await sql`
        insert into public.documents (user_id, kind, name, mime, size_bytes)
        values (
          ${actor.id}::uuid,
          ${documentKind}::document_kind,
          ${file.name || 'document'},
          ${file.mime || 'application/octet-stream'},
          ${Number(file.sizeBytes || 1)}
        )
      `;
    }
    await appendAudit({
      actor,
      action: 'driver.application.submitted',
      targetEntity: 'driver',
      targetId: rows[0].id,
      ip: ctx.ip,
    });
    return { ok: true };
  },

  async GetDriverStatus(ctxVars, ctx) {
    const actor = await requireActor(ctx);
    const rows = await sql`
      select status, verified_at
      from public.drivers
      where user_id = ${actor.id}::uuid
      limit 1
    `;
    if (!rows.length) return { status: 'not_applied' };
    return rows[0];
  },

  async GetDriverProfile(ctxVars, ctx) {
    const actor = await requireActor(ctx);
    const rows = await sql`
      select
        d.*,
        u.full_name,
        u.email
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
  },

  async UpdateDriverVehicle({ brand, model, seatCount }, ctx) {
    const actor = await requireActor(ctx);
    const rows = await sql`select * from public.drivers where user_id = ${actor.id}::uuid limit 1`;
    if (!rows.length) return { ok: false, error: 'No driver record' };
    if (seatCount) {
      const seatErr = validateSeatCount(seatCount, 8);
      if (seatErr) return { ok: false, error: seatErr };
    }
    await sql`
      update public.drivers
      set
        vehicle_brand = coalesce(${brand ? sanitize(brand) : null}, vehicle_brand),
        vehicle_model = coalesce(${model ? sanitize(model) : null}, vehicle_model),
        seat_count = coalesce(${seatCount ? Number(seatCount) : null}, seat_count)
      where user_id = ${actor.id}::uuid
    `;
    await appendAudit({
      actor,
      action: 'driver.vehicle.updated',
      targetEntity: 'driver',
      targetId: rows[0].id,
      ip: ctx.ip,
    });
    return { ok: true };
  },

  async UpdateDriverPayout({ account }, ctx) {
    const actor = await requireActor(ctx);
    if (!account || account.length < 8) return { ok: false, error: 'Account too short' };
    const rows = await sql`
      update public.drivers
      set payout_account = ${sanitize(account)}
      where user_id = ${actor.id}::uuid
      returning id
    `;
    if (!rows.length) return { ok: false, error: 'No driver record' };
    await appendAudit({
      actor,
      action: 'driver.payout.updated',
      targetEntity: 'driver',
      targetId: rows[0].id,
      ip: ctx.ip,
    });
    return { ok: true };
  },

  async AdminListDrivers({ status }, ctx) {
    const actor = await requireActor(ctx);
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
  },

  async AdminVerifyDriver({ driverId, approve, reason }, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:verify-driver');
    if (denied) return denied;
    const rows = await sql`
      update public.drivers
      set
        status = ${approve ? 'verified' : 'rejected'}::driver_status,
        verified_at = ${approve ? new Date().toISOString() : null},
        rejection_reason = ${approve ? null : sanitize(reason || '')}
      where id = ${driverId}::uuid
      returning *
    `;
    if (!rows.length) return { ok: false, error: 'Not found' };
    await sql`
      insert into public.notifications (user_id, title, body)
      values (
        ${rows[0].user_id}::uuid,
        ${approve ? 'Driver application approved' : 'Driver application rejected'},
        ${approve ? 'Your account is now verified. You can start creating rides.' : reason || 'See your profile for next steps.'}
      )
    `;
    await appendAudit({
      actor,
      action: approve ? 'driver.verified' : 'driver.rejected',
      targetEntity: 'driver',
      targetId: driverId,
      metadata: { reason },
      ip: ctx.ip,
    });
    return { ok: true };
  },

  async GetProfile(ctxVars, ctx) {
    const actor = await requireActor(ctx);
    const rows = await sql`
      select id, full_name, email, phone_number, role, notifications, created_at
      from public.users
      where id = ${actor.id}::uuid
      limit 1
    `;
    const user = rows[0];
    if (!user) return null;
    return {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      phone_masked: user.phone_number,
      role: user.role,
      created_at: user.created_at,
      notifications: user.notifications ?? { sms: true, push: true },
    };
  },

  async UpdateProfile({ fullName, email, currentPassword, newPassword }, ctx) {
    const actor = await requireActor(ctx);
    const errors = {};
    if (fullName != null) {
      const err = validateName(fullName);
      if (err) errors.fullName = err;
    }
    if (email != null) {
      const err = validateEmail(email);
      if (err) errors.email = err;
      if (!err) {
        const existing = await sql`
          select id from public.users
          where lower(email) = lower(${email}) and id <> ${actor.id}::uuid
          limit 1
        `;
        if (existing.length) errors.email = 'Email already in use';
      }
    }
    if (newPassword) {
      const err = validatePassword(newPassword);
      if (err) errors.newPassword = err;
      const okRows = await sql`
        select password_hash = extensions.crypt(${currentPassword || ''}, password_hash) as ok
        from public.users
        where id = ${actor.id}::uuid
      `;
      if (!okRows[0]?.ok) errors.currentPassword = 'Current password incorrect';
    }
    if (Object.keys(errors).length) return { ok: false, errors };

    await sql`
      update public.users
      set
        full_name = coalesce(${fullName != null ? sanitize(fullName) : null}, full_name),
        email = coalesce(${email != null ? email.toLowerCase() : null}, email),
        password_hash = case
          when ${newPassword || null}::text is null then password_hash
          else extensions.crypt(${newPassword || null}, extensions.gen_salt('bf'))
        end
      where id = ${actor.id}::uuid
    `;
    await appendAudit({
      actor,
      action: 'profile.updated',
      targetEntity: 'user',
      targetId: actor.id,
      ip: ctx.ip,
    });
    return { ok: true };
  },

  async UpdateNotificationPrefs({ sms, push }, ctx) {
    const actor = await requireActor(ctx);
    await sql`
      update public.users
      set notifications = ${JSON.stringify({ sms: Boolean(sms), push: Boolean(push) })}::jsonb
      where id = ${actor.id}::uuid
    `;
    return { ok: true };
  },

  async DeleteAccount({ password }, ctx) {
    const actor = await requireActor(ctx);
    const rows = await sql`
      select password_hash = extensions.crypt(${password || ''}, password_hash) as ok
      from public.users
      where id = ${actor.id}::uuid
    `;
    if (!rows[0]?.ok) return { ok: false, error: 'Password incorrect' };
    await sql`update public.users set is_active = false where id = ${actor.id}::uuid`;
    await appendAudit({
      actor,
      action: 'user.self_deleted',
      targetEntity: 'user',
      targetId: actor.id,
      ip: ctx.ip,
    });
    return { ok: true };
  },

  async AdminStats(ctxVars, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:read');
    if (denied) return null;
    const [stats] = await sql`
      select
        (select count(*)::int from public.rides where status in ('scheduled', 'in_progress')) as active_rides,
        (select count(*)::int from public.reservations where booked_at >= date_trunc('day', now())) as bookings_today,
        (
          select coalesce(sum(amount), 0)
          from public.payments
          where status = 'succeeded' and paid_at >= date_trunc('day', now())
        ) as revenue_today,
        (
          select count(*)::int
          from public.users
          where created_at >= now() - interval '1 day'
        ) as new_users
    `;
    return {
      activeRides: stats.active_rides,
      bookingsToday: stats.bookings_today,
      revenueToday: toNumber(stats.revenue_today),
      newUsers: stats.new_users,
    };
  },

  async AdminAlerts(ctxVars, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:read');
    if (denied) return [];
    const payments = await sql`
      select id, amount, gateway_reference, paid_at, flagged, status
      from public.payments
      where status = 'failed' or flagged = true
      order by paid_at desc
      limit 5
    `;
    const drivers = await sql`
      select d.id, d.created_at, u.full_name
      from public.drivers d
      join public.users u on u.id = d.user_id
      where d.status = 'pending'
      order by d.created_at desc
      limit 5
    `;
    return [
      ...payments.map((payment) => ({
        id: payment.id,
        kind: payment.flagged ? 'flag' : 'fail',
        title: payment.flagged ? 'Payment flagged' : 'Failed payment',
        body: `${toNumber(payment.amount)} TND - ${payment.gateway_reference ?? 'n/a'}`,
        created_at: payment.paid_at,
      })),
      ...drivers.map((driver) => ({
        id: driver.id,
        kind: 'verification',
        title: 'Driver pending verification',
        body: driver.full_name ?? 'New applicant',
        created_at: driver.created_at,
      })),
    ];
  },

  async AdminSearchUsers({ q }, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:read');
    if (denied) return [];
    const query = (q || '').trim().toLowerCase();
    const rows = await withTimeout(
      sql`
        select
          u.*,
          d.id as driver_id,
          d.vehicle_brand,
          d.vehicle_model,
          d.status as driver_status
        from public.users u
        left join public.drivers d on d.user_id = u.id
        order by u.created_at desc
      `,
      8000,
      'AdminSearchUsers'
    );
    return rows
      .filter((row) => {
        if (!query) return true;
        return (
          row.full_name.toLowerCase().includes(query) ||
          row.email?.toLowerCase().includes(query) ||
          row.phone_number.includes(query)
        );
      })
      .map((row) => ({
        id: row.id,
        full_name: row.full_name,
        email: row.email,
        phone_number: row.phone_number,
        role: row.role,
        is_active: row.is_active,
        created_at: row.created_at,
        driver: row.driver_id
          ? {
              id: row.driver_id,
              vehicle_brand: row.vehicle_brand,
              vehicle_model: row.vehicle_model,
              status: row.driver_status,
            }
          : null,
      }));
  },

  async AdminSetUserActive({ userId, active }, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:suspend-user');
    if (denied) return denied;
    const targetRows = await sql`select * from public.users where id = ${userId}::uuid limit 1`;
    const target = targetRows[0];
    if (!target) return { ok: false, error: 'Not found' };
    if (!active && target.role === 'admin') {
      const [{ count }] = await sql`
        select count(*)::int
        from public.users
        where role = 'admin' and is_active = true and id <> ${userId}::uuid
      `;
      if (count === 0) return { ok: false, error: 'Cannot suspend the last admin' };
    }
    await sql`update public.users set is_active = ${Boolean(active)} where id = ${userId}::uuid`;
    await appendAudit({
      actor,
      action: active ? 'user.reactivated' : 'user.suspended',
      targetEntity: 'user',
      targetId: userId,
      ip: ctx.ip,
    });
    return { ok: true };
  },

  async AdminImpersonate({ userId, mfaCode }, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:impersonate');
    if (denied) return denied;
    const rows = await sql`
      select
        u.id,
        u.full_name,
        u.role,
        d.status as driver_status
      from public.users u
      left join public.drivers d on d.user_id = u.id
      where u.id = ${userId}::uuid
      limit 1
    `;
    const target = rows[0];
    if (!target) return { ok: false, error: 'Not found' };
    if (target.role === 'admin') return { ok: false, error: 'Cannot impersonate another admin' };
    if (!validAdminImpersonationCode(mfaCode)) {
      await appendAudit({
        actor,
        action: 'admin.impersonate.step_up_failed',
        targetEntity: 'user',
        targetId: target.id,
        metadata: { targetRole: target.role },
        ip: ctx.ip,
      });
      return { ok: false, error: 'Step-up verification required' };
    }
    const accessToken = signAccessToken({
      sub: target.id,
      role: target.role,
      name: target.full_name,
      driverStatus: target.driver_status ?? null,
      impersonatedBy: actor.id,
    });
    await appendAudit({
      actor,
      action: 'admin.impersonate',
      targetEntity: 'user',
      targetId: target.id,
      metadata: { targetRole: target.role },
      ip: ctx.ip,
    });
    return {
      ok: true,
      accessToken,
      target: {
        id: target.id,
        full_name: target.full_name,
        role: target.role,
      },
    };
  },

  async AdminListAudit({ filters = {} }, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:read');
    if (denied) return { total: 0, rows: [] };
    const rows = await sql`
      select
        id,
        actor_id,
        actor_role,
        action as action_type,
        target_entity,
        target_id,
        metadata,
        coalesce(ip_address, 'server') as ip_address,
        created_at
      from public.audit_log
      where (${filters.actorId ?? null}::uuid is null or actor_id = ${filters.actorId ?? null}::uuid)
        and (${filters.actionType ?? null}::text is null or action = ${filters.actionType ?? null})
        and (${filters.from ?? null}::timestamptz is null or created_at >= ${filters.from ?? null}::timestamptz)
        and (${filters.to ?? null}::timestamptz is null or created_at <= ${filters.to ?? null}::timestamptz)
      order by created_at desc
      limit ${Number(filters.limit || 200)}
      offset ${Number(filters.offset || 0)}
    `;
    const [{ count }] = await sql`
      select count(*)::int
      from public.audit_log
      where (${filters.actionType ?? null}::text is null or action = ${filters.actionType ?? null})
    `;
    return { total: count, rows };
  },

  async AdminAuditCount(ctxVars, ctx) {
    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'admin:read');
    if (denied) return 0;
    const [{ count }] = await sql`select count(*)::int from public.audit_log`;
    return count;
  },

  // ─── Delivery resolvers ─────────────────────────────────────────────────────

  async AvailableDeliveryRides({ origin, destination }, ctx) {
    const actor = await requireActor(ctx);
    const rows = await joinedRides();
    return rows
      .map(toRideResult)
      .filter((ride) => ride.status === 'scheduled')
      .filter((ride) => {
        if (origin && ride.route.origin_city.toLowerCase() !== origin.toLowerCase()) return false;
        if (destination && ride.route.destination_city.toLowerCase() !== destination.toLowerCase()) return false;
        return true;
      })
      .map((ride) => ({
        ...ride,
        accepts_delivery: true,
        max_delivery_slots: 3,
        delivery_slots_taken: 0,
      }))
      .sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time));
  },

  async MyDeliveries(ctxVars, ctx) {
    const actor = await requireActor(ctx);
    const rows = await sql`
      select
        del.*,
        r.departure_time,
        rt.origin_city,
        rt.destination_city
      from public.delivery del
      join public.rides r on r.id = del.ride_id
      join public.routes rt on rt.id = r.route_id
      where del.user_id = ${actor.id}::uuid
      order by del.booked_at desc
    `;
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      severity_tier: row.severity_tier,
      severity_label: row.severity_label,
      item_description: row.item_description,
      price: toNumber(row.price),
      booked_at: row.booked_at,
      cancelled_at: row.cancelled_at,
      ride: {
        departure_time: row.departure_time,
        origin_city: row.origin_city,
        destination_city: row.destination_city,
      },
    }));
  },

  async RideDeliveries({ rideId }, ctx) {
    if (!rideId) return [];
    const actor = await requireActor(ctx);
    // Verify the driver owns this ride
    const rideRows = await sql`
      select r.id, d.user_id
      from public.rides r
      join public.drivers d on d.id = r.driver_id
      where r.id = ${rideId}::uuid
      limit 1
    `;
    const ride = rideRows[0];
    if (!ride) return [];
    if (actor.role !== 'admin' && ride.user_id !== actor.id) return [];

    const rows = await sql`
      select
        del.*,
        u.full_name,
        u.phone_number
      from public.delivery del
      join public.users u on u.id = del.user_id
      where del.ride_id = ${rideId}::uuid
      order by del.booked_at desc
    `;
    return rows.map((row) => ({
      id: row.id,
      severity_tier: row.severity_tier,
      severity_label: row.severity_label,
      item_description: row.item_description,
      status: row.status,
      price: toNumber(row.price),
      user: {
        full_name: row.full_name,
        phone_number: row.phone_number,
      },
    }));
  },

  async CreateDelivery({ rideId, severityTier, description }, ctx) {
    const TIER_PRICES = { 1: 7, 2: 9, 3: 12 };
    const TIER_LABELS = { 1: 'Standard', 2: 'Sensitive', 3: 'Critical' };

    const actor = await requireActor(ctx);
    const denied = assertCan(actor, 'rides:book');
    if (denied) return denied;

    const tier = Number(severityTier);
    if (![1, 2, 3].includes(tier)) return { ok: false, error: 'Invalid severity tier' };
    const price = TIER_PRICES[tier];
    const label = TIER_LABELS[tier];

    return dbBreaker.call(() =>
      withRetry(() =>
        safeQuery(
          () =>
            sql.begin(async (tx) => {
              // Lock the ride and check slot availability
              const rideRows = await tx`
                select id, accepts_delivery, max_delivery_slots, delivery_slots_taken, driver_id
                from public.rides
                where id = ${rideId}::uuid and status = 'scheduled'
                for update
              `;
              const ride = rideRows[0];
              if (!ride) return { ok: false, error: 'Ride not found or not scheduled' };
              if (!ride.accepts_delivery) return { ok: false, error: 'This ride does not accept deliveries' };
              if (ride.delivery_slots_taken >= ride.max_delivery_slots) {
                return { ok: false, error: 'No delivery slots available' };
              }

              // Insert delivery
              const deliveries = await tx`
                insert into public.delivery (
                  user_id, ride_id, severity_tier, severity_label,
                  item_description, price, status
                ) values (
                  ${actor.id}::uuid,
                  ${rideId}::uuid,
                  ${tier},
                  ${label},
                  ${description ? sanitize(description) : null},
                  ${price},
                  'pending'
                )
                returning *
              `;

              // Increment slot counter
              await tx`
                update public.rides
                set delivery_slots_taken = delivery_slots_taken + 1
                where id = ${rideId}::uuid
              `;

              // Create payment for delivery
              const payments = await tx`
                insert into public.payments (
                  delivery_id,
                  method,
                  amount,
                  platform_fee,
                  driver_fee,
                  status,
                  gateway_reference
                ) values (
                  ${deliveries[0].id}::uuid,
                  'card'::payment_method,
                  ${price},
                  ${0},
                  ${0},
                  'succeeded',
                  ${paymentReference('DEL')}
                )
                returning *
              `;

              // Notify driver
              const driverRows = await tx`
                select d.user_id from public.drivers d where d.id = ${ride.driver_id}::uuid limit 1
              `;
              if (driverRows[0]) {
                await tx`
                  insert into public.notifications (user_id, title, body)
                  values (
                    ${driverRows[0].user_id}::uuid,
                    'New delivery booked',
                    ${`A ${label.toLowerCase()} delivery has been booked on your ride.`}
                  )
                `;
              }

              await tx`
                insert into public.audit_log (
                  actor_id, actor_role, action, target_entity, target_id, metadata, ip_address
                ) values (
                  ${actor.id}::uuid,
                  ${actor.role}::user_role,
                  'delivery.created',
                  'delivery',
                  ${deliveries[0].id}::uuid,
                  ${JSON.stringify({ price, tier, label })}::jsonb,
                  ${ctx.ip ?? 'server'}
                )
              `;

              return {
                ok: true,
                delivery: {
                  id: deliveries[0].id,
                  status: deliveries[0].status,
                  price: toNumber(deliveries[0].price),
                  severity_label: deliveries[0].severity_label,
                },
                payment: paymentFrom(payments[0]),
              };
            }),
          { operation: 'CreateDelivery' }
        ),
        { label: 'CreateDelivery' }
      ),
      'CreateDelivery'
    );
  },

  async UpdateDeliveryStatus({ id, status }, ctx) {
    const actor = await requireActor(ctx);
    const validStatuses = ['confirmed', 'picked_up', 'delivered'];
    if (!validStatuses.includes(status)) return { ok: false, error: 'Invalid status' };

    // Verify the driver owns the ride this delivery is on
    const rows = await sql`
      select del.*, d.user_id as driver_user_id
      from public.delivery del
      join public.rides r on r.id = del.ride_id
      join public.drivers d on d.id = r.driver_id
      where del.id = ${id}::uuid
      limit 1
    `;
    const delivery = rows[0];
    if (!delivery) return { ok: false, error: 'Not found' };
    if (actor.role !== 'admin' && delivery.driver_user_id !== actor.id) {
      return { ok: false, error: 'Forbidden' };
    }

    const updated = await sql`
      update public.delivery
      set status = ${status}
      where id = ${id}::uuid
      returning *
    `;

    // Notify sender on picked_up and delivered
    if (status === 'picked_up' || status === 'delivered') {
      const msg = status === 'picked_up'
        ? 'Your delivery has been picked up by the driver.'
        : 'Your delivery has been delivered successfully.';
      await sql`
        insert into public.notifications (user_id, title, body)
        values (
          ${delivery.user_id}::uuid,
          ${status === 'picked_up' ? 'Delivery picked up' : 'Delivery completed'},
          ${msg}
        )
      `;
    }

    await appendAudit({
      actor,
      action: `delivery.status.${status}`,
      targetEntity: 'delivery',
      targetId: id,
      ip: ctx.ip,
    });
    return { ok: true, delivery: { ...updated[0], price: toNumber(updated[0].price) } };
  },

  async CancelDelivery({ id }, ctx) {
    const actor = await requireActor(ctx);
    return sql.begin(async (tx) => {
      const rows = await tx`
        select * from public.delivery
        where id = ${id}::uuid
        for update
      `;
      const delivery = rows[0];
      if (!delivery) return { ok: false, error: 'Not found' };
      if (delivery.user_id !== actor.id && actor.role !== 'admin') {
        return { ok: false, error: 'Forbidden' };
      }
      if (['picked_up', 'delivered', 'cancelled'].includes(delivery.status)) {
        return { ok: false, error: 'Cannot cancel at this stage' };
      }

      await tx`
        update public.delivery
        set status = 'cancelled', cancelled_at = now()
        where id = ${id}::uuid
      `;
      // Decrement slot counter
      await tx`
        update public.rides
        set delivery_slots_taken = greatest(0, delivery_slots_taken - 1)
        where id = ${delivery.ride_id}::uuid
      `;
      // Refund the delivery payment
      await tx`
        update public.payments
        set status = 'refunded', refunded_at = now()
        where delivery_id = ${id}::uuid and status = 'succeeded'
      `;

      await tx`
        insert into public.audit_log (
          actor_id, actor_role, action, target_entity, target_id, ip_address
        ) values (
          ${actor.id}::uuid,
          ${actor.role}::user_role,
          'delivery.cancelled',
          'delivery',
          ${id}::uuid,
          ${ctx.ip ?? 'server'}
        )
      `;
      return { ok: true };
    });
  },

  async ListChats(variables, ctx) {
    const actor = await requireActor(ctx);
    const rows = await sql`
      with recent as (
        select
          case when sender_id = ${actor.id}::uuid then receiver_id else sender_id end as partner_id,
          max(created_at) as latest_msg
        from public.messages
        where sender_id = ${actor.id}::uuid or receiver_id = ${actor.id}::uuid
        group by 1
      )
      select
        u.id as partner_id,
        u.full_name as partner_name,
        u.role as partner_role,
        u.phone_number as partner_phone,
        m.content as last_message,
        m.created_at as last_message_time,
        (
          select count(*)
          from public.messages
          where sender_id = u.id and receiver_id = ${actor.id}::uuid and is_read = false
        ) as unread_count
      from recent r
      join public.users u on u.id = r.partner_id
      join public.messages m on m.created_at = r.latest_msg
        and (m.sender_id = u.id or m.receiver_id = u.id)
      order by m.created_at desc
    `;
    return rows.map((r) => ({
      partnerId: r.partner_id,
      partnerName: r.partner_name,
      partnerRole: r.partner_role,
      partnerPhone: r.partner_phone,
      lastMessage: r.last_message,
      lastMessageTime: r.last_message_time,
      unreadCount: Number(r.unread_count),
    }));
  },

  async GetMessages({ otherUserId }, ctx) {
    const actor = await requireActor(ctx);
    if (!otherUserId) {
      const err = new Error("otherUserId is required");
      err.status = 400;
      throw err;
    }
    // Mark as read
    await sql`
      update public.messages
      set is_read = true
      where sender_id = ${otherUserId}::uuid and receiver_id = ${actor.id}::uuid
    `;
    // Fetch
    const rows = await sql`
      select * from public.messages
      where (sender_id = ${actor.id}::uuid and receiver_id = ${otherUserId}::uuid)
         or (sender_id = ${otherUserId}::uuid and receiver_id = ${actor.id}::uuid)
      order by created_at asc
      limit 200
    `;
    return rows.map((m) => ({
      id: m.id,
      senderId: m.sender_id,
      receiverId: m.receiver_id,
      content: m.content,
      isRead: m.is_read,
      createdAt: m.created_at,
    }));
  },

  async SendMessage({ receiverId, text }, ctx) {
    const actor = await requireActor(ctx);
    const content = sanitize(text);
    if (!content) return { ok: false, error: 'Empty message' };
    const rows = await sql`
      insert into public.messages (sender_id, receiver_id, content)
      values (${actor.id}::uuid, ${receiverId}::uuid, ${content})
      returning *
    `;
    const m = rows[0];
    await appendAudit({
      actor,
      action: 'message.sent',
      targetEntity: 'message',
      targetId: m.id,
      ip: ctx.ip,
    });
    return {
      ok: true,
      message: {
        id: m.id,
        senderId: m.sender_id,
        receiverId: m.receiver_id,
        content: m.content,
        isRead: m.is_read,
        createdAt: m.created_at,
      },
    };
  },

  async SubmitReview({ rideId, driverId, rating, comment }, ctx) {
    const actor = await requireActor(ctx);
    if (rating < 1 || rating > 5) return { ok: false, error: 'Invalid rating' };

    // Find a confirmed reservation for this ride by this user
    const resRows = await sql`
      select r.id, ride.status as ride_status
      from public.reservations r
      join public.rides ride on ride.id = r.ride_id
      where r.user_id = ${actor.id}::uuid
        and r.ride_id = ${rideId}::uuid
        and r.status = 'confirmed'
      limit 1
    `;
    if (!resRows.length) return { ok: false, error: 'No confirmed reservation found for this ride' };
    if (resRows[0].ride_status !== 'completed') return { ok: false, error: 'Ride is not completed yet' };

    const reservationId = resRows[0].id;

    // Insert review
    return sql.begin(async (tx) => {
      // Upsert to prevent duplicate reviews per reservation
      await tx`
        insert into public.reviews (reservation_id, rating, comment)
        values (${reservationId}::uuid, ${rating}, ${comment ? sanitize(comment) : null})
        on conflict (reservation_id) do update set
          rating = excluded.rating,
          comment = excluded.comment,
          created_at = now()
      `;

      // Update driver's average rating
      await tx`
        update public.drivers
        set rating = (
          select avg(rev.rating)::numeric(3,2)
          from public.reviews rev
          join public.reservations res on res.id = rev.reservation_id
          join public.rides rd on rd.id = res.ride_id
          where rd.driver_id = ${driverId}::uuid
        )
        where id = ${driverId}::uuid
      `;

      return { ok: true };
    }).catch((e) => ({ ok: false, error: e.message || 'Failed to submit review' }));
  },

  async GetReviewForRide({ rideId }, ctx) {
    const actor = await requireActor(ctx);
    const rows = await sql`
      select rev.*
      from public.reviews rev
      join public.reservations res on res.id = rev.reservation_id
      where res.user_id = ${actor.id}::uuid and res.ride_id = ${rideId}::uuid
      limit 1
    `;
    if (!rows.length) return null;
    return {
      id: rows[0].id,
      rating: rows[0].rating,
      comment: rows[0].comment,
      createdAt: rows[0].created_at,
    };
  },
};
