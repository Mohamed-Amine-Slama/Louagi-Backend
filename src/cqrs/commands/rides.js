// Ride commands — CreateRide, UpdateRideStatus, CancelRide.

import { sql } from '../../db.js';
import {
  appendAudit,
  assertCan,
  toNumber,
} from '../../graphql/helpers.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

async function CreateRide({ origin, destination, routeId, departureTime, pricePerSeat, availableSeats }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'rides:create');
  if (denied) return denied;

  const [driverRows, routeRows] = await Promise.all([
    sql`
      select id, status, seat_count
      from public.drivers
      where user_id = ${actor.id}::uuid
      limit 1
    `,
    routeId
      ? sql`select id, base_price from public.routes where id = ${routeId}::uuid limit 1`
      : origin && destination
        ? sql`
            select id, base_price
            from public.routes
            where lower(origin_city) = lower(${origin})
              and lower(destination_city) = lower(${destination})
            limit 1
          `
        : Promise.resolve([]),
  ]);
  const driver = driverRows[0];
  if (!driver) return { ok: false, error: 'Driver record not found' };
  if (driver.status !== 'verified') return { ok: false, error: 'Driver not verified' };
  const route = routeRows[0];
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
  eventBus.emit(Events.ride.Created, { rideId: rows[0].id, driverUserId: actor.id }, ctx);

  return { ok: true, ride: { ...rows[0], price_per_seat: toNumber(rows[0].price_per_seat) } };
}

async function UpdateRideStatus({ rideId, status }, ctx) {
  const actor = ctx.actor;
  if (!['scheduled', 'in_progress', 'completed', 'cancelled'].includes(status)) {
    return { ok: false, error: 'Invalid status' };
  }
  const rows = await sql`
    select r.id, r.status, d.user_id
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
  eventBus.emit(Events.ride.StatusChanged, { rideId, driverUserId: ride.user_id, status }, ctx);

  return { ok: true, ride: { ...updated[0], price_per_seat: toNumber(updated[0].price_per_seat) } };
}

async function CancelRide({ rideId, reason }, ctx) {
  const actor = ctx.actor;
  const result = await sql.begin(async (tx) => {
    const rows = await tx`
      select r.id, r.status, d.user_id
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
      returning id, user_id
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
    return {
      ok: true,
      cancelled: affected.length,
      driverUserId: ride.user_id,
      affectedUserIds: affected.map((r) => r.user_id),
    };
  });

  if (result.ok) {
    eventBus.emit(Events.ride.Cancelled, {
      rideId,
      driverUserId: result.driverUserId,
      affectedUserIds: result.affectedUserIds,
    }, ctx);
    return { ok: true, cancelled: result.cancelled };
  }
  return result;
}

export const commands = { CreateRide, UpdateRideStatus, CancelRide };
export const meta = {};
