// Delivery read paths.

import { sql } from '../../db.js';
import {
  joinedRides,
  toNumber,
  toRideResult,
} from '../../graphql/helpers.js';
import { cacheKey } from '../../graphql/cache.js';

async function AvailableDeliveryRides({ origin, destination }) {
  const rows = await joinedRides({ status: 'scheduled' });
  return rows
    .map(toRideResult)
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
}

async function MyDeliveries(_input, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    select
      del.id, del.user_id, del.ride_id, del.severity_tier, del.severity_label,
      del.item_description, del.price, del.status, del.booked_at, del.cancelled_at,
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
}

async function RideDeliveries({ rideId }, ctx) {
  if (!rideId) return [];
  const actor = ctx.actor;
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
      del.id, del.severity_tier, del.severity_label, del.item_description,
      del.status, del.price,
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
}

export const queries = { AvailableDeliveryRides, MyDeliveries, RideDeliveries };

export const meta = {
  AvailableDeliveryRides: { cache: { key: ({ origin, destination }) => cacheKey.availableDeliveryRides(origin, destination), ttl: 30 } },
  MyDeliveries:           { cache: { key: (_, ctx) => cacheKey.myDeliveries(ctx.actor.id),                                  ttl: 30 } },
  RideDeliveries:         { cache: { key: ({ rideId }) => cacheKey.rideDeliveries(rideId),                                  ttl: 30 } },
};
