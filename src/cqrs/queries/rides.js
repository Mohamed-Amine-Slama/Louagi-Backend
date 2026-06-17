// Ride read paths.

import { sql } from '../../db.js';
import { withTimeout } from '../../lib/supabase/withTimeout.js';
import { SearchSchema } from '../../utils/validation.server.js';
import {
  assertCan,
  driverSummaryFrom,
  joinedRides,
  rideFrom,
  routeFrom,
  toNumber,
  toRideResult,
} from '../../graphql/helpers.js';
import { cacheKey, hashInput } from '../../graphql/cache.js';

async function ListRoutes() {
  const rows = await sql`
    select id, origin_city, destination_city, distance_km, estimated_duration_min, base_price, created_at
    from public.routes
    order by origin_city, destination_city
  `;
  return rows.map((row) => ({ ...row, base_price: toNumber(row.base_price) }));
}

async function ListPopularRoutes() {
  const rows = await sql`
    select id, origin_city, destination_city, distance_km, estimated_duration_min, base_price
    from public.routes
    where is_popular = true
    order by origin_city, destination_city
  `;
  return rows.map((row) => ({ ...row, base_price: toNumber(row.base_price) }));
}

async function ListCities() {
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
}

async function SearchRides(input) {
  const parsed = SearchSchema.parse(input);
  const { origin, destination, date, seats, filters, sort } = parsed;

  let sortSql;
  if (sort === 'price') sortSql = sql`r.price_per_seat ASC, r.departure_time ASC`;
  else if (sort === 'rating') sortSql = sql`d.rating DESC NULLS LAST, r.departure_time ASC`;
  else sortSql = sql`r.departure_time ASC`;

  const startOfDay = date ? new Date(date) : null;
  if (startOfDay) startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = startOfDay ? new Date(startOfDay.getTime() + 86400 * 1000) : null;

  const rows = await sql`
    select
      r.id, r.departure_time, r.available_seats, r.total_seats,
      r.price_per_seat, r.status,
      rt.id as rt_id, rt.origin_city, rt.destination_city, rt.estimated_duration_min,
      d.id as d_id, d.rating, d.trips_completed, d.vehicle_brand, d.vehicle_model,
      u.full_name as driver_full_name
    from public.rides r
    join public.routes rt on rt.id = r.route_id
    left join public.drivers d on d.id = r.driver_id
    left join public.users u on u.id = d.user_id
    where r.status = 'scheduled'
      and r.available_seats >= ${seats || 1}
      ${origin ? sql`and lower(rt.origin_city) = lower(${origin})` : sql``}
      ${destination ? sql`and lower(rt.destination_city) = lower(${destination})` : sql``}
      ${startOfDay ? sql`and r.departure_time >= ${startOfDay.toISOString()}` : sql``}
      ${endOfDay ? sql`and r.departure_time < ${endOfDay.toISOString()}` : sql``}
      ${filters?.priceMax ? sql`and r.price_per_seat <= ${filters.priceMax}` : sql``}
      ${filters?.ratingMin ? sql`and d.rating >= ${filters.ratingMin}` : sql``}
      ${filters?.departureBefore ? sql`and EXTRACT(HOUR FROM r.departure_time) <= ${filters.departureBefore}` : sql``}
    order by ${sortSql}
    limit 100
  `;

  return rows.map((row) => ({
    id: row.id,
    departure_time: row.departure_time,
    available_seats: row.available_seats,
    total_seats: row.total_seats,
    price_per_seat: toNumber(row.price_per_seat),
    status: row.status,
    route: row.rt_id
      ? {
          id: row.rt_id,
          origin_city: row.origin_city,
          destination_city: row.destination_city,
          estimated_duration_min: row.estimated_duration_min,
        }
      : null,
    driver: row.d_id
      ? {
          id: row.d_id,
          full_name: row.driver_full_name ?? 'Driver',
          rating: toNumber(row.rating),
          trips_completed: row.trips_completed,
          vehicle_brand: row.vehicle_brand,
          vehicle_model: row.vehicle_model,
        }
      : null,
  }));
}

async function GetRideDetail({ rideId }) {
  const rows = await joinedRides({ rideId });
  const row = rows[0];
  return row ? toRideResult(row) : null;
}

async function DriverRides({ status }, ctx) {
  const actor = ctx.actor;
  const rows = await joinedRides({ driverId: actor.id, status });
  return rows
    .map((row) => ({ ...rideFrom(row), route: routeFrom(row) }))
    .sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time));
}

async function RidePassengers({ rideId }, ctx) {
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
    select res.id, res.user_id, res.ride_id, res.seats_booked, res.total_price, res.status,
           res.booked_at, res.cancelled_at,
           u.full_name, u.email, u.phone_number
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
}

async function DriverEarnings({ period = 'week' }, ctx) {
  const actor = ctx.actor;
  const driverRows = await sql`
    select id, rating, trips_completed
    from public.drivers
    where user_id = ${actor.id}::uuid
    limit 1
  `;
  const driver = driverRows[0];
  const empty = {
    period, today: 0, week: 0, month: 0, history: [], historyStart: null,
    tripsThisPeriod: 0, tripsPrevPeriod: 0,
    seatsSold: 0, seatsPrev: 0, seatsCapacity: 0, seatsCapacityPrev: 0,
    occupancyPct: 0, occupancyPrevPct: 0,
    avgFare: 0, avgFarePrev: 0, earningsPrev: 0,
    cancelRatePct: 0, topRoute: null, rating: null, tripsCompleted: 0,
  };
  if (!driver) return empty;

  const rows = await withTimeout(
    sql`
      select
        r.id, r.route_id, r.departure_time, r.total_seats, r.available_seats, r.status,
        rt.origin_city, rt.destination_city,
        coalesce(sum(p.amount - coalesce(p.platform_fee, 0)) filter (where p.status = 'succeeded'), 0) as net_revenue
      from public.rides r
      join public.routes rt on rt.id = r.route_id
      left join public.reservations res on res.ride_id = r.id
      left join public.payments p on p.reservation_id = res.id
      where r.driver_id = ${driver.id}::uuid
      group by r.id, rt.id
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

  let today = 0, week = 0, month = 0;
  let tripsThisPeriod = 0, tripsPrevPeriod = 0;
  let seatsSold = 0, seatsPrev = 0;
  let seatsCapacity = 0, seatsCapacityPrev = 0;
  let earningsThis = 0, earningsPrev = 0;
  let cancelledThis = 0;
  const routeRevenue = new Map();
  const routeCount = new Map();

  rows.forEach((ride) => {
    const sold = Math.max(0, ride.total_seats - ride.available_seats);
    const revenue = Number(ride.net_revenue);
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
  const occupancyPrevPct = seatsCapacityPrev > 0 ? Math.round((seatsPrev / seatsCapacityPrev) * 100) : 0;
  const avgFare = tripsThisPeriod > 0 ? earningsThis / tripsThisPeriod : 0;
  const avgFarePrev = tripsPrevPeriod > 0 ? earningsPrev / tripsPrevPeriod : 0;
  const totalThisWindow = tripsThisPeriod + cancelledThis;
  const cancelRatePct = totalThisWindow > 0 ? Math.round((cancelledThis / totalThisWindow) * 100) : 0;

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
    period, today, week, month, history,
    historyStart: new Date(historyStartMs).toISOString(),
    tripsThisPeriod, tripsPrevPeriod,
    seatsSold, seatsPrev, seatsCapacity, seatsCapacityPrev,
    occupancyPct, occupancyPrevPct,
    avgFare, avgFarePrev, earningsPrev,
    cancelRatePct, topRoute,
    rating: toNumber(driver.rating),
    tripsCompleted: driver.trips_completed,
  };
}

async function AdminListRides({ filters = {} }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return [];
  const rows = await joinedRides({ driverId: filters.driverId, status: filters.status });
  return rows
    .filter((row) => (filters.routeId ? row.ride_route_id === filters.routeId : true))
    .map((row) => ({ ...rideFrom(row), route: routeFrom(row), driver: driverSummaryFrom(row) }));
}

export const queries = {
  ListRoutes,
  ListPopularRoutes,
  ListCities,
  SearchRides,
  GetRideDetail,
  DriverRides,
  RidePassengers,
  DriverEarnings,
  AdminListRides,
};

export const meta = {
  ListRoutes:        { public: true, cache: { key: () => cacheKey.routes(),        ttl: 3600 * 24 } },
  ListPopularRoutes: { public: true, cache: { key: () => cacheKey.popularRoutes(), ttl: 3600 * 24 } },
  ListCities:        { public: true, cache: { key: () => cacheKey.cities(),        ttl: 3600 * 24 } },
  SearchRides:     { public: true, cache: { key: (input) => cacheKey.searchRides(hashInput(input)), ttl: 30 } },
  GetRideDetail:   {              cache: { key: ({ rideId }) => cacheKey.rideDetail(rideId),       ttl: 60 } },
  DriverRides:     {              cache: { key: ({ status }, ctx) => cacheKey.driverRides(ctx.actor.id, status), ttl: 30 } },
  RidePassengers:  {              cache: { key: ({ rideId }) => cacheKey.ridePassengers(rideId),   ttl: 30 } },
  DriverEarnings:  {              cache: { key: ({ period }, ctx) => cacheKey.driverEarnings(ctx.actor.id, period || 'week'), ttl: 300 } },
  AdminListRides:  {              cache: { key: ({ filters } = {}) => cacheKey.adminRides(hashInput(filters || {})), ttl: 30, role: 'admin' } },
};
