// Admin read paths.

import { sql, ping as pingDb } from '../../db.js';
import { isRedisReady, getRedis } from '../../cache/redis.js';
import { withTimeout } from '../../lib/supabase/withTimeout.js';
import { getLatencyReport } from '../../lib/latency.js';
import { assertCan, toNumber } from '../../graphql/helpers.js';
import { decryptField } from '../../lib/fieldCrypto.js';
import { cacheKey, hashInput } from '../../graphql/cache.js';

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

// Daily platform series for the trends chart. One row per day for the last N
// days (today inclusive), zero-filled via generate_series so the client gets
// fixed-length arrays it can plot directly.
const SERIES_DAYS = [7, 14, 30];

async function AdminTimeSeries({ days }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return null;
  const span = SERIES_DAYS.includes(Number(days)) ? Number(days) : 14;

  const rows = await sql`
    with days as (
      select generate_series(
        date_trunc('day', now())::date - (${span - 1} * interval '1 day'),
        date_trunc('day', now())::date,
        interval '1 day'
      )::date as day
    ),
    ride_counts as (
      select date_trunc('day', created_at)::date as day, count(*)::int as c
      from public.rides
      where created_at >= date_trunc('day', now()) - (${span - 1} * interval '1 day')
      group by 1
    ),
    booking_counts as (
      select date_trunc('day', booked_at)::date as day, count(*)::int as c
      from public.reservations
      where booked_at >= date_trunc('day', now()) - (${span - 1} * interval '1 day')
      group by 1
    ),
    revenue as (
      select date_trunc('day', paid_at)::date as day, coalesce(sum(amount), 0) as v
      from public.payments
      where status = 'succeeded'
        and paid_at >= date_trunc('day', now()) - (${span - 1} * interval '1 day')
      group by 1
    ),
    user_counts as (
      select date_trunc('day', created_at)::date as day, count(*)::int as c
      from public.users
      where created_at >= date_trunc('day', now()) - (${span - 1} * interval '1 day')
      group by 1
    )
    select
      d.day,
      coalesce(rc.c, 0) as rides,
      coalesce(bc.c, 0) as bookings,
      coalesce(rev.v, 0) as revenue,
      coalesce(uc.c, 0) as new_users
    from days d
    left join ride_counts rc on rc.day = d.day
    left join booking_counts bc on bc.day = d.day
    left join revenue rev on rev.day = d.day
    left join user_counts uc on uc.day = d.day
    order by d.day
  `;
  return {
    days: span,
    start: rows[0]?.day ?? null,
    rides: rows.map((r) => r.rides),
    bookings: rows.map((r) => r.bookings),
    revenue: rows.map((r) => toNumber(r.revenue)),
    newUsers: rows.map((r) => r.new_users),
  };
}

// Reconciliation aggregates for the payments screen header.
async function AdminPaymentsSummary(_input, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return null;

  const [s] = await sql`
    select
      count(*) filter (where status = 'succeeded')::int as succeeded_count,
      coalesce(sum(amount) filter (where status = 'succeeded'), 0) as succeeded_sum,
      coalesce(sum(amount) filter (where status = 'succeeded' and paid_at >= now() - interval '7 days'), 0) as revenue_7d,
      count(*) filter (where status = 'failed')::int as failed_count,
      count(*) filter (where flagged)::int as flagged_count,
      count(*) filter (where status = 'refunded')::int as refunded_count,
      coalesce(sum(refunded_amount) filter (where status = 'refunded'), 0) as refunded_sum,
      coalesce(sum(driver_fee) filter (where status = 'succeeded'), 0) as driver_fees,
      coalesce(sum(platform_fee) filter (where status = 'succeeded'), 0) as platform_fees
    from public.payments
  `;
  return {
    succeededCount: s.succeeded_count,
    succeededSum: toNumber(s.succeeded_sum),
    revenue7d: toNumber(s.revenue_7d),
    failedCount: s.failed_count,
    flaggedCount: s.flagged_count,
    refundedCount: s.refunded_count,
    refundedSum: toNumber(s.refunded_sum),
    driverFees: toNumber(s.driver_fees),
    platformFees: toNumber(s.platform_fees),
  };
}

// Per-driver settlement of reservation fees: the platform collects the booking
// fee online and owes each driver their driver_fee share for succeeded
// payments. Seat fares are paid in cash and never flow through us.
async function AdminDriverPayouts({ limit }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return [];
  const lim = Math.min(Number(limit || 50), 200);

  const rows = await sql`
    select
      d.id as driver_id,
      u.full_name,
      d.payout_account,
      count(p.id)::int as payments_count,
      coalesce(sum(p.driver_fee), 0) as driver_fees,
      coalesce(sum(p.platform_fee), 0) as platform_fees,
      max(p.paid_at) as last_payment_at
    from public.payments p
    join public.reservations res on res.id = p.reservation_id
    join public.rides r on r.id = res.ride_id
    join public.drivers d on d.id = r.driver_id
    join public.users u on u.id = d.user_id
    where p.status = 'succeeded'
    group by d.id, u.full_name, d.payout_account
    order by driver_fees desc
    limit ${lim}
  `;
  return rows.map((row) => ({
    driver_id: row.driver_id,
    full_name: row.full_name,
    payout_account: decryptField(row.payout_account) ?? null,
    payments_count: row.payments_count,
    driver_fees: toNumber(row.driver_fees),
    platform_fees: toNumber(row.platform_fees),
    last_payment_at: row.last_payment_at,
  }));
}

// Uploaded verification documents for one user (driver applicant review).
async function AdminListUserDocuments({ userId }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return [];
  if (!userId) return [];
  const rows = await sql`
    select id, kind, name, mime, size_bytes, storage_path, uploaded_at
    from public.documents
    where user_id = ${userId}::uuid
    order by uploaded_at desc
  `;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    mime: r.mime,
    size_bytes: Number(r.size_bytes),
    storage_path: r.storage_path ?? null,
    uploaded_at: r.uploaded_at,
  }));
}

// TOTP enrollment state for the admin's own profile security section.
async function AdminTotpStatus(_input, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return null;
  const rows = await sql`
    select admin_totp_secret is not null as has_secret, admin_totp_enabled
    from public.users
    where id = ${actor.id}::uuid
    limit 1
  `;
  const row = rows[0];
  return {
    enabled: Boolean(row?.admin_totp_enabled),
    pending: Boolean(row?.has_secret && !row?.admin_totp_enabled),
  };
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
  AdminTimeSeries,
  AdminPaymentsSummary,
  AdminDriverPayouts,
  AdminListUserDocuments,
  AdminTotpStatus,
  AdminMetrics,
};

export const meta = {
  AdminStats:  { cache: { key: () => cacheKey.adminStats(),  ttl: 120, role: 'admin' } },
  AdminAlerts: { cache: { key: () => cacheKey.adminAlerts(), ttl: 120, role: 'admin' } },
  AdminSearchUsers: {
    cache: {
      key: ({ q } = {}) => cacheKey.adminUsersSearch(hashInput({ q: (q || '').trim().toLowerCase() })),
      ttl: 30,
      role: 'admin',
    },
  },
  // Audit is append-heavy — event-driven invalidation would fire on every
  // command, so these two rely on short TTLs alone.
  AdminListAudit: {
    cache: {
      key: ({ filters } = {}) => cacheKey.adminAudit(hashInput(filters || {})),
      ttl: 20,
      role: 'admin',
    },
  },
  AdminAuditCount: { cache: { key: () => cacheKey.adminAuditCount(), ttl: 30, role: 'admin' } },
  AdminTimeSeries: {
    cache: {
      key: ({ days } = {}) => cacheKey.adminSeries(SERIES_DAYS.includes(Number(days)) ? Number(days) : 14),
      ttl: 300,
      role: 'admin',
    },
  },
  AdminPaymentsSummary: { cache: { key: () => cacheKey.adminPaySummary(), ttl: 120, role: 'admin' } },
  AdminDriverPayouts: {
    cache: {
      key: ({ limit } = {}) => cacheKey.adminPayouts(Math.min(Number(limit || 50), 200)),
      ttl: 300,
      role: 'admin',
    },
  },
};
