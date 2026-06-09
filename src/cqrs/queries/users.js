// User read paths — GetProfile (with server-side stats aggregate) + ExportMyData.

import { sql } from '../../db.js';
import { toNumber, appendAudit } from '../../graphql/helpers.js';
import { cacheKey } from '../../graphql/cache.js';

async function GetProfile(_input, ctx) {
  const actor = ctx.actor;
  const [userRows, statsRows, favRows] = await Promise.all([
    sql`
      select id, full_name, email, phone_number, role, notifications, created_at
      from public.users
      where id = ${actor.id}::uuid
      limit 1
    `,
    sql`
      select
        coalesce(count(*) filter (where status = 'confirmed'), 0)::int as trips,
        coalesce(sum(total_price) filter (where status <> 'cancelled'), 0) as spent
      from public.reservations
      where user_id = ${actor.id}::uuid
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
  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    phone_masked: user.phone_number,
    role: user.role,
    created_at: user.created_at,
    notifications: user.notifications ?? { sms: true, push: true },
    stats: {
      trips: statsRows[0]?.trips ?? 0,
      spent: toNumber(statsRows[0]?.spent) ?? 0,
      favouriteRoute: fav ? `${fav.origin_city} → ${fav.destination_city}` : null,
    },
  };
}

async function ExportMyData(_input, ctx) {
  const actor = ctx.actor;
  const [userRows, reservations, rides] = await Promise.all([
    sql`select id, full_name, role, created_at from public.users where id = ${actor.id}::uuid`,
    sql`select id, ride_id, seats_booked, total_price, status, booked_at from public.reservations where user_id = ${actor.id}::uuid`,
    sql`
      select r.id, r.departure_time, r.status, r.created_at
      from public.rides r
      left join public.drivers d on d.id = r.driver_id
      where d.user_id = ${actor.id}::uuid
    `,
  ]);
  await appendAudit({
    actor: { id: actor.id, role: actor.role },
    action: 'gdpr.export_data',
    targetEntity: 'user',
    targetId: actor.id,
    ip: ctx.ip,
  });
  return { ok: true, data: { user: userRows[0], reservations, rides } };
}

export const queries = { GetProfile, ExportMyData };

export const meta = {
  GetProfile: { cache: { key: (_, ctx) => cacheKey.profile(ctx.actor.id), ttl: 60 } },
};
