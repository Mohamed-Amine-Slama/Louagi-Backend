// Delivery read paths.

import { sql } from '../../db.js';
import {
  joinedRides,
  toNumber,
  toRideResult,
} from '../../graphql/helpers.js';
import { cacheKey } from '../../graphql/cache.js';

// A live fix older than this is treated as "driver offline" and withheld.
const LOCATION_STALE_MS = 2 * 60 * 1000;

// Flat delivery pricing, seeded into public.app_config (was the client/server
// `DELIVERY_PRICE`/price constants). Falls back to the seeded defaults if the
// config row is missing so a fresh/un-seeded DB never breaks a booking.
export const DELIVERY_PRICING_DEFAULT = { price: 10, driver_fee: 8, platform_fee: 2 };

export async function loadDeliveryPricing() {
  const rows = await sql`select value from public.app_config where key = 'delivery_pricing' limit 1`;
  const v = rows[0]?.value ?? {};
  return {
    price: toNumber(v.price) ?? DELIVERY_PRICING_DEFAULT.price,
    driver_fee: toNumber(v.driver_fee) ?? DELIVERY_PRICING_DEFAULT.driver_fee,
    platform_fee: toNumber(v.platform_fee) ?? DELIVERY_PRICING_DEFAULT.platform_fee,
  };
}

async function GetDeliveryPricing() {
  return loadDeliveryPricing();
}

// Plate numbers are stored in plaintext; reveal only the tail to the passenger.
function maskPlate(plate) {
  if (!plate) return null;
  const s = String(plate).trim();
  if (s.length <= 3) return s;
  return `•• ${s.slice(-3)}`;
}

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
      r.departure_time, r.status as ride_status,
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
      status: row.ride_status,
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

// Live tracking for a single parcel. The passenger who owns the delivery sees
// the carrying driver's position — but only while the ride is in_progress and
// the fix is fresh. Returns a small state machine the UI renders directly.
async function GetDeliveryTracking({ deliveryId }, ctx) {
  const actor = ctx.actor;
  if (!deliveryId) return { trackable: false, reason: 'not_found' };

  const rows = await sql`
    select
      del.id, del.user_id, del.status as delivery_status,
      r.status as ride_status, r.departure_time,
      rt.origin_city, rt.destination_city, rt.distance_km, rt.estimated_duration_min,
      u.full_name as driver_name,
      d.vehicle_brand, d.vehicle_model, d.plate_number, d.rating,
      loc.latitude, loc.longitude, loc.heading, loc.speed,
      loc.updated_at as location_updated_at
    from public.delivery del
    join public.rides r    on r.id = del.ride_id
    join public.drivers d  on d.id = r.driver_id
    join public.users u    on u.id = d.user_id
    join public.routes rt  on rt.id = r.route_id
    left join public.driver_locations loc on loc.driver_id = d.id
    where del.id = ${deliveryId}::uuid
    limit 1
  `;
  const row = rows[0];
  if (!row) return { trackable: false, reason: 'not_found' };
  // Only the sender (or an admin) may track a parcel.
  if (actor.role !== 'admin' && row.user_id !== actor.id) {
    return { trackable: false, reason: 'forbidden' };
  }

  const driver = {
    name: row.driver_name,
    vehicle: [row.vehicle_brand, row.vehicle_model].filter(Boolean).join(' '),
    plate_masked: maskPlate(row.plate_number),
    rating: row.rating != null ? toNumber(row.rating) : null,
  };
  const route = {
    origin_city: row.origin_city,
    destination_city: row.destination_city,
    distance_km: row.distance_km,
    estimated_duration_min: row.estimated_duration_min,
  };
  const base = { deliveryStatus: row.delivery_status, rideStatus: row.ride_status, driver, route };

  // Terminal states — nothing to track anymore.
  if (['delivered', 'cancelled'].includes(row.delivery_status) ||
      ['completed', 'cancelled'].includes(row.ride_status)) {
    return { trackable: false, reason: 'ended', ...base };
  }
  // The trip hasn't started — no live location yet.
  if (row.ride_status !== 'in_progress') {
    return { trackable: false, reason: 'not_started', departureTime: row.departure_time, ...base };
  }

  // In transit: expose the latest fix, but only if it's recent.
  let location = null;
  if (row.latitude != null && row.location_updated_at) {
    const ageMs = Date.now() - new Date(row.location_updated_at).getTime();
    if (ageMs <= LOCATION_STALE_MS) {
      location = {
        latitude: row.latitude,
        longitude: row.longitude,
        heading: row.heading,
        speed: row.speed,
        updatedAt: row.location_updated_at,
      };
    }
  }
  return { trackable: true, reason: 'live', location, ...base };
}

export const queries = { AvailableDeliveryRides, MyDeliveries, RideDeliveries, GetDeliveryTracking, GetDeliveryPricing };

export const meta = {
  AvailableDeliveryRides: { cache: { key: ({ origin, destination }) => cacheKey.availableDeliveryRides(origin, destination), ttl: 30 } },
  MyDeliveries:           { cache: { key: (_, ctx) => cacheKey.myDeliveries(ctx.actor.id),                                  ttl: 30 } },
  RideDeliveries:         { cache: { key: ({ rideId }) => cacheKey.rideDeliveries(rideId),                                  ttl: 30 } },
  GetDeliveryPricing:     { public: true, cache: { key: () => cacheKey.deliveryPricing(),                                   ttl: 3600 * 24 } },
};
