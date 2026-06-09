// Reservation commands.

import crypto from 'node:crypto';

import { sql } from '../../db.js';
import { dbBreaker } from '../../lib/supabase/CircuitBreaker.js';
import { withRetry } from '../../lib/supabase/withRetry.js';
import { safeQuery } from '../../lib/supabase/logger.js';
import { BookRideSchema } from '../../utils/validation.server.js';
import {
  appendAudit,
  assertCan,
  paymentFrom,
  toNumber,
} from '../../graphql/helpers.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

async function CreateReservation(input, ctx) {
  const parsed = BookRideSchema.parse({ rideId: input.rideId, seatsCount: Number(input.seats || 1) });
  const { rideId, seatsCount } = parsed;
  const paymentMethod = input.paymentMethod || 'card';
  const key = input.idempotencyKey || crypto.randomBytes(10).toString('hex');

  const actor = ctx.actor;
  const denied = assertCan(actor, 'rides:book');
  if (denied) return denied;

  const result = await dbBreaker.call(() =>
    withRetry(() =>
      safeQuery(
        async () => {
          try {
            const callRes = await sql`
              select public.create_reservation(
                ${actor.id}::uuid,
                ${rideId}::uuid,
                ${seatsCount}::int,
                ${paymentMethod}::text,
                ${key}::text
              ) as reservation_id
            `;

            const resId = callRes[0].reservation_id;
            const rows = await sql`select * from public.reservations where id = ${resId}::uuid limit 1`;
            const payRows = await sql`select * from public.payments where reservation_id = ${resId}::uuid limit 1`;

            await appendAudit({
              actor: { id: actor.id, role: actor.role },
              action: 'reservation.confirmed',
              targetEntity: 'reservation',
              targetId: resId,
              ip: ctx.ip,
            });

            return {
              ok: true,
              reservation: { ...rows[0], total_price: toNumber(rows[0].total_price) },
              payment: paymentFrom(payRows[0]),
              reservationId: resId,
            };
          } catch (err) {
            if (err.message.includes('DUPLICATE_BOOKING')) {
              return { ok: false, error: 'DUPLICATE_BOOKING' };
            }
            if (err.message.includes('Invalid seat count')) {
              return { ok: false, error: 'Invalid seat count (must be 1-4)' };
            }
            if (err.message.includes('Not enough seats')) {
              return { ok: false, error: 'Not enough seats' };
            }
            throw err;
          }
        },
        { operation: 'CreateReservation' }
      ),
      { label: 'CreateReservation' }
    ),
    'CreateReservation'
  );

  if (result.ok) {
    eventBus.emit(Events.reservation.Created, {
      reservationId: result.reservationId,
      userId: actor.id,
      rideId,
    }, ctx);
    delete result.reservationId;
  }
  return result;
}

async function CancelReservation({ id }, ctx) {
  const actor = ctx.actor;
  const result = await sql.begin(async (tx) => {
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
    return {
      ok: true,
      reservation: { ...updated[0], total_price: toNumber(updated[0].total_price) },
      ownerId: reservation.user_id,
      rideId: reservation.ride_id,
    };
  });

  if (result.ok) {
    eventBus.emit(Events.reservation.Cancelled, {
      reservationId: id,
      userId: result.ownerId,
      rideId: result.rideId,
    }, ctx);
    return { ok: true, reservation: result.reservation };
  }
  return result;
}

export const commands = { CreateReservation, CancelReservation };
export const meta = {};
