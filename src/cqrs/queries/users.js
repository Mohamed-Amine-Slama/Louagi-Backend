// User read paths — GetProfile (with stats + preferences + payment_method)
// and RequestDataExport (GDPR data dump).

import { sql } from '../../db.js';
import { toNumber, appendAudit } from '../../graphql/helpers.js';
import { cacheKey } from '../../graphql/cache.js';
import { loyaltyPoints } from '../../lib/tiers.js';

async function GetProfile(_input, ctx) {
  const actor = ctx.actor;
  const [userRows, statsRows, favRows] = await Promise.all([
    sql`
      select id, full_name, email, phone_number, role, notifications,
             preferences, payment_account, created_at
      from public.users
      where id = ${actor.id}::uuid
      limit 1
    `,
    sql`
      select
        coalesce(count(*) filter (where res.status = 'confirmed'), 0)::int as trips,
        coalesce(sum(res.total_price) filter (where res.status <> 'cancelled'), 0) as spent,
        coalesce(count(distinct r.route_id) filter (where res.status <> 'cancelled'), 0)::int as distinct_routes
      from public.reservations res
      left join public.rides r on r.id = res.ride_id
      where res.user_id = ${actor.id}::uuid
    `,
    sql`
      select rt.origin_city, rt.destination_city
      from public.reservations res
      join public.rides r on r.id = res.ride_id
      join public.routes rt on rt.id = r.route_id
      where res.user_id = ${actor.id}::uuid
        and res.status <> 'cancelled'
      group by rt.origin_city, rt.destination_city
      order by count(*) desc
      limit 1
    `,
  ]);
  const user = userRows[0];
  if (!user) return null;
  const fav = favRows[0];

  const trips = statsRows[0]?.trips ?? 0;
  const spent = toNumber(statsRows[0]?.spent) ?? 0;
  const distinctRoutes = statsRows[0]?.distinct_routes ?? 0;

  // Louagi loyalty points: 100 per confirmed trip + 1 per TND spent.
  const points = loyaltyPoints({ trips, spent });

  // Seat-fare discount the current tier grants — read from the public.tiers
  // catalogue (same ladder public.create_reservation prices against).
  const tierRows = await sql`
    select discount_pct from public.tiers
    where min_points <= ${points}
    order by min_points desc
    limit 1
  `;
  const discountPct = toNumber(tierRows[0]?.discount_pct) ?? 0;

  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    phone_masked: user.phone_number,
    role: user.role,
    created_at: user.created_at,
    notifications: { sms: true, push: true, marketing: false, ...(user.notifications ?? {}) },
    preferences: user.preferences ?? {},
    // Client expects the legacy key `payment_method` for the account info.
    payment_method: user.payment_account ?? null,
    stats: {
      trips,
      spent,
      favouriteRoute: fav ? `${fav.origin_city} → ${fav.destination_city}` : null,
      points,
      // Seat-fare discount the passenger's current tier grants (whole percent).
      discountPct,
      achievements: await passengerAchievements({ trips, distinctRoutes }),
    },
  };
}

// The achievement catalogue — id, label key, icon and unlock threshold. Seeded
// into public.achievements (was a hard-coded array in src/components/Membership.js).
async function ListAchievements() {
  const rows = await sql`
    select id, i18n_key, icon, threshold_type, threshold, sort_order
    from public.achievements
    order by sort_order
  `;
  return rows;
}

// The loyalty tier ladder — code, label key, threshold, discount and perks.
// Seeded into public.tiers; the same rows price bookings (create_reservation).
async function ListTiers() {
  const rows = await sql`
    select id, i18n_key, min_points, discount_pct, perks, sort_order
    from public.tiers
    order by sort_order
  `;
  return rows.map((r) => ({
    id: r.id,
    i18n_key: r.i18n_key,
    min_points: r.min_points,
    discount_pct: toNumber(r.discount_pct) ?? 0,
    perks: r.perks ?? [],
    sort_order: r.sort_order,
  }));
}

// Achievements unlocked by real passenger activity. The thresholds live in the
// public.achievements catalogue so the rule and the badge stay in one place.
async function passengerAchievements({ trips, distinctRoutes }) {
  const rows = await sql`
    select id, threshold_type, threshold from public.achievements order by sort_order
  `;
  const metrics = { trips, distinct_routes: distinctRoutes };
  return rows
    .filter((r) => (metrics[r.threshold_type] ?? 0) >= r.threshold)
    .map((r) => r.id);
}

// Renamed from the legacy ExportMyData/REST `/my-data` op to match the client's
// call name. Includes support_tickets which the mock surfaced.
async function RequestDataExport(_input, ctx) {
  const actor = ctx.actor;
  const [userRows, reservations, rides, deliveries, supportTickets] = await Promise.all([
    sql`select id, full_name, role, created_at from public.users where id = ${actor.id}::uuid`,
    sql`
      select id, ride_id, seats_booked, total_price, status, booked_at, cancelled_at
      from public.reservations
      where user_id = ${actor.id}::uuid
    `,
    sql`
      select r.id, r.departure_time, r.status, r.created_at
      from public.rides r
      left join public.drivers d on d.id = r.driver_id
      where d.user_id = ${actor.id}::uuid
    `,
    sql`
      select id, ride_id, item_description as description, status, price, booked_at as created_at
      from public.delivery
      where user_id = ${actor.id}::uuid
    `,
    sql`
      select id, topic, status, created_at
      from public.support_tickets
      where user_id = ${actor.id}::uuid
    `,
  ]);
  await appendAudit({
    actor: { id: actor.id, role: actor.role },
    action: 'gdpr.export_data',
    targetEntity: 'user',
    targetId: actor.id,
    ip: ctx.ip,
  });
  return {
    ok: true,
    export: {
      generated_at: new Date().toISOString(),
      profile: userRows[0],
      reservations,
      rides,
      deliveries,
      support_tickets: supportTickets,
    },
  };
}

export const queries = { GetProfile, RequestDataExport, ListAchievements, ListTiers };

export const meta = {
  GetProfile: { cache: { key: (_, ctx) => cacheKey.profile(ctx.actor.id), ttl: 60 } },
  ListAchievements: { public: true, cache: { key: () => cacheKey.achievements(), ttl: 3600 * 24 } },
  ListTiers: { public: true, cache: { key: () => cacheKey.tiers(), ttl: 3600 * 24 } },
};
