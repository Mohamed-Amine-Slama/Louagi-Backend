// Admin read paths.

import { sql, ping as pingDb } from '../../db.js';
import { isRedisReady, getRedis } from '../../cache/redis.js';
import { withTimeout } from '../../lib/supabase/withTimeout.js';
import { getLatencyReport } from '../../lib/latency.js';
import { assertCan, toNumber } from '../../graphql/helpers.js';
import { cacheKey } from '../../graphql/cache.js';

async function AdminStats(_input, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return null;

  const [stats] = await sql`
    select
      (select count(*)::int from public.rides where status in ('scheduled', 'in_progress')) as active_rides,
      (select count(*)::int from public.reservations where booked_at >= date_trunc('day', now())) as bookings_today,
      (
        select coalesce(sum(amount), 0)
        from public.payments
        where status = 'succeeded' and paid_at >= date_trunc('day', now())
      ) as revenue_today,
      (
        select count(*)::int
        from public.users
        where created_at >= now() - interval '1 day'
      ) as new_users
  `;
  return {
    activeRides: stats.active_rides,
    bookingsToday: stats.bookings_today,
    revenueToday: toNumber(stats.revenue_today),
    newUsers: stats.new_users,
  };
}

async function AdminAlerts(_input, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return [];

  const [payments, drivers] = await Promise.all([
    sql`
      select id, amount, gateway_reference, paid_at, flagged, status
      from public.payments
      where status = 'failed' or flagged = true
      order by paid_at desc
      limit 5
    `,
    sql`
      select d.id, d.created_at, u.full_name
      from public.drivers d
      join public.users u on u.id = d.user_id
      where d.status = 'pending'
      order by d.created_at desc
      limit 5
    `,
  ]);
  return [
    ...payments.map((payment) => ({
      id: payment.id,
      kind: payment.flagged ? 'flag' : 'fail',
      title: payment.flagged ? 'Payment flagged' : 'Failed payment',
      body: `${toNumber(payment.amount)} TND - ${payment.gateway_reference ?? 'n/a'}`,
      created_at: payment.paid_at,
    })),
    ...drivers.map((driver) => ({
      id: driver.id,
      kind: 'verification',
      title: 'Driver pending verification',
      body: driver.full_name ?? 'New applicant',
      created_at: driver.created_at,
    })),
  ];
}

async function AdminSearchUsers({ q }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return [];
  const query = (q || '').trim();
  const rows = await withTimeout(
    sql`
      select
        u.id, u.full_name, u.email, u.phone_number, u.role, u.is_active, u.created_at,
        d.id as driver_id,
        d.vehicle_brand,
        d.vehicle_model,
        d.status as driver_status
      from public.users u
      left join public.drivers d on d.user_id = u.id
      where (
        ${query ? sql`u.full_name ilike ${'%' + query + '%'} or u.email ilike ${'%' + query + '%'} or u.phone_number ilike ${'%' + query + '%'}` : sql`true`}
      )
      order by u.created_at desc
      limit 100
    `,
    8000,
    'AdminSearchUsers'
  );
  return rows.map((row) => ({
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    phone_number: row.phone_number,
    role: row.role,
    is_active: row.is_active,
    created_at: row.created_at,
    driver: row.driver_id
      ? {
          id: row.driver_id,
          vehicle_brand: row.vehicle_brand,
          vehicle_model: row.vehicle_model,
          status: row.driver_status,
        }
      : null,
  }));
}

async function AdminListAudit({ filters = {} }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return { total: 0, rows: [] };
  const limit = Math.min(Number(filters.limit || 200), 500);
  const offset = Math.max(Number(filters.offset || 0), 0);
  const [rows, countRows] = await Promise.all([
    sql`
      select
        id, actor_id, actor_role,
        action as action_type,
        target_entity, target_id, metadata,
        coalesce(ip_address, 'server') as ip_address,
        created_at
      from public.audit_log
      where (${filters.actorId ?? null}::uuid is null or actor_id = ${filters.actorId ?? null}::uuid)
        and (${filters.actionType ?? null}::text is null or action = ${filters.actionType ?? null})
        and (${filters.from ?? null}::timestamptz is null or created_at >= ${filters.from ?? null}::timestamptz)
        and (${filters.to ?? null}::timestamptz is null or created_at <= ${filters.to ?? null}::timestamptz)
      order by created_at desc
      limit ${limit}
      offset ${offset}
    `,
    sql`
      select count(*)::int as count
      from public.audit_log
      where (${filters.actionType ?? null}::text is null or action = ${filters.actionType ?? null})
    `,
  ]);
  return { total: countRows[0].count, rows };
}

async function AdminAuditCount(_input, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return 0;
  const [{ count }] = await sql`select count(*)::int from public.audit_log`;
  return count;
}

async function AdminMetrics(_input, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return denied;

  const [dbOk, redisOk] = await Promise.all([
    pingDb().catch(() => false),
    (async () => {
      if (!isRedisReady()) return false;
      try { return (await getRedis().ping()) === 'PONG'; } catch { return false; }
    })(),
  ]);
  const latency = getLatencyReport();
  const totalQueries = Object.values(latency).reduce((sum, op) => sum + op.count, 0);
  const avgLatency =
    Object.values(latency).reduce((sum, op) => sum + op.avg * op.count, 0) / (totalQueries || 1);

  return {
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    db: dbOk,
    redis: redisOk,
    graphql: {
      totalQueries,
      averageLatencyMs: Number(avgLatency.toFixed(2)),
      operations: latency,
    },
  };
}

export const queries = {
  AdminStats,
  AdminAlerts,
  AdminSearchUsers,
  AdminListAudit,
  AdminAuditCount,
  AdminMetrics,
};

export const meta = {
  AdminStats:  { cache: { key: () => cacheKey.adminStats(),  ttl: 120 } },
  AdminAlerts: { cache: { key: () => cacheKey.adminAlerts(), ttl: 120 } },
};
