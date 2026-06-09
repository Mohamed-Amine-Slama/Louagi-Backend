// Review read paths.

import { sql } from '../../db.js';
import { cacheKey } from '../../graphql/cache.js';

async function GetReviewForRide({ rideId }, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    select rev.id, rev.rating, rev.comment, rev.created_at
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
}

export const queries = { GetReviewForRide };

export const meta = {
  GetReviewForRide: { cache: { key: ({ rideId }, ctx) => cacheKey.reviewForRide(rideId, ctx.actor.id), ttl: 120 } },
};
