// Reservation read paths.

import { listReservationsFor } from '../../graphql/helpers.js';
import { cacheKey } from '../../graphql/cache.js';

async function ListReservations({ status }, ctx) {
  return listReservationsFor(ctx.actor, status);
}

async function GetReservation({ id }, ctx) {
  const rows = await listReservationsFor(ctx.actor, null, id, { includePayment: true });
  return rows[0] ?? null;
}

export const queries = { ListReservations, GetReservation };

export const meta = {
  ListReservations: { cache: { key: ({ status }, ctx) => cacheKey.listReservations(ctx.actor.id, status), ttl: 30 } },
  GetReservation:   { cache: { key: ({ id }) => cacheKey.reservation(id),                                 ttl: 60 } },
};
