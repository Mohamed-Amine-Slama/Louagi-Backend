// Review commands — SubmitReview.

import { sql } from '../../db.js';
import { sanitize } from '../../utils/validation.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

async function SubmitReview({ rideId, driverId, rating, comment }, ctx) {
  const actor = ctx.actor;
  if (rating < 1 || rating > 5) return { ok: false, error: 'Invalid rating' };

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

  const result = await sql.begin(async (tx) => {
    await tx`
      insert into public.reviews (reservation_id, rating, comment)
      values (${reservationId}::uuid, ${rating}, ${comment ? sanitize(comment) : null})
      on conflict (reservation_id) do update set
        rating = excluded.rating,
        comment = excluded.comment,
        created_at = now()
    `;
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

  if (result.ok) {
    const driverUserRows = await sql`select user_id from public.drivers where id = ${driverId}::uuid limit 1`;
    const driverUserId = driverUserRows[0]?.user_id;
    eventBus.emit(Events.review.Submitted, {
      rideId,
      driverId,
      driverUserId,
      userId: actor.id,
    }, ctx);
  }
  return result;
}

export const commands = { SubmitReview };
export const meta = {};
