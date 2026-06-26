// Admin control-center monitoring reads. These power the SIEM-style command
// center: system health, a normalized security/event stream over the audit
// log, and security + risk signal aggregates. All are admin:read gated and
// uncached (the control center wants fresh data on each poll).

import { sql, ping as pingDb } from '../../db.js';
import { isRedisReady, getRedis } from '../../cache/redis.js';
import { getLatencyReport } from '../../lib/latency.js';
import { assertCan, toNumber } from '../../graphql/helpers.js';

// ─── Event classification ───────────────────────────────────────────────────
// audit_log.action is a dotted string (e.g. 'login.success', 'payment.refund.
// full', 'admin.impersonate'). Map the leading segment to a category and the
// whole action to a severity so the UI can colour and filter the stream.
export function categorizeAction(action) {
  const a = String(action || '').toLowerCase();
  if (/^(login|register|auth|totp|otp)/.test(a)) return 'auth';
  if (a.startsWith('payment')) return 'payment';
  if (a.startsWith('admin')) return 'admin';
  if (a.startsWith('ride')) return 'ride';
  if (a.startsWith('driver')) return 'driver';
  if (a.startsWith('delivery')) return 'delivery';
  return 'system';
}

export function severityForAction(action) {
  const a = String(action || '').toLowerCase();
  if (/(fail|lock|delete|suspend|refund|revoke)/.test(a)) return 'danger';
  if (/(flag|cancel|reject|impersonat|disable|deactivat)/.test(a)) return 'warning';
  return 'info';
}

async function AdminSystemHealth(_input, ctx) {
  const denied = assertCan(ctx.actor, 'admin:read');
  if (denied) return null;

  const [dbOk, redisOk] = await Promise.all([
    pingDb().catch(() => false),
    (async () => {
      if (!isRedisReady()) return false;
      try {
        return (await getRedis().ping()) === 'PONG';
      } catch {
        return false;
      }
    })(),
  ]);

  const latency = getLatencyReport();
  const ops = Object.values(latency);
  const totalQueries = ops.reduce((sum, op) => sum + op.count, 0);
  const avgLatency =
    ops.reduce((sum, op) => sum + op.avg * op.count, 0) / (totalQueries || 1);

  const [counts] = await sql`
    select
      (select count(*)::int from public.users) as users,
      (select count(*)::int from public.drivers where status = 'verified') as verified_drivers,
      (select count(*)::int from public.driver_locations where updated_at >= now() - interval '5 minutes') as online_drivers,
      (select count(*)::int from public.rides where status in ('scheduled', 'in_progress')) as active_rides,
      (select count(*)::int from public.drivers where status = 'pending') as drivers_pending,
      (select count(*)::int from public.payments where flagged or status = 'failed') as open_alerts
  `;

  return {
    db: Boolean(dbOk),
    redis: Boolean(redisOk),
    uptimeSec: Math.round(process.uptime()),
    version: process.env.APP_VERSION || '0.1.0',
    avgLatencyMs: Number(avgLatency.toFixed(2)),
    totalQueries,
    counts: {
      users: counts.users,
      verifiedDrivers: counts.verified_drivers,
      onlineDrivers: counts.online_drivers,
      activeRides: counts.active_rides,
      driversPending: counts.drivers_pending,
      openAlerts: counts.open_alerts,
    },
  };
}

// Live tail of the audit log, normalized for the event-stream panel. `since`
// (ISO timestamp) lets the client fetch only events newer than the last seen
// one; `categories` filters to a subset of the derived categories.
async function AdminEventStream({ limit = 50, since = null, categories = null } = {}, ctx) {
  const denied = assertCan(ctx.actor, 'admin:read');
  if (denied) return [];
  const lim = Math.min(Number(limit) || 50, 200);

  const rows = await sql`
    select
      id, actor_id, actor_role, action,
      target_entity, target_id, metadata,
      coalesce(ip_address, 'server') as ip_address,
      created_at
    from public.audit_log
    where (${since ?? null}::timestamptz is null or created_at > ${since ?? null}::timestamptz)
    order by created_at desc
    limit ${lim}
  `;

  let events = rows.map((r) => ({
    id: r.id,
    ts: r.created_at,
    severity: severityForAction(r.action),
    category: categorizeAction(r.action),
    action: r.action,
    actor: r.actor_id ? { id: r.actor_id, role: r.actor_role } : null,
    target: r.target_entity ? { type: r.target_entity, id: r.target_id } : null,
    ip: r.ip_address,
    meta: r.metadata ?? {},
  }));

  if (Array.isArray(categories) && categories.length) {
    const set = new Set(categories);
    events = events.filter((e) => set.has(e.category));
  }
  return events;
}

async function AdminSecuritySignals(_input, ctx) {
  const denied = assertCan(ctx.actor, 'admin:read');
  if (denied) return null;

  const [agg] = await sql`
    select
      (select count(*)::int from public.audit_log
         where action = 'login.failed' and created_at >= now() - interval '24 hours') as failed_logins_24h,
      (select count(*)::int from (
         select actor_id from public.audit_log
         where action = 'login.failed' and created_at >= now() - interval '15 minutes' and actor_id is not null
         group by actor_id having count(*) >= 5
       ) locked) as active_lockouts,
      (select count(*)::int from public.audit_log
         where action ilike '%impersonat%' and created_at >= date_trunc('day', now())) as impersonations_today,
      (select count(*)::int from public.audit_log
         where actor_role = 'admin' and created_at >= date_trunc('day', now())) as admin_actions_today
  `;

  const series = await sql`
    with days as (
      select generate_series(
        date_trunc('day', now())::date - interval '6 days',
        date_trunc('day', now())::date,
        interval '1 day'
      )::date as day
    ),
    f as (
      select date_trunc('day', created_at)::date as day, count(*)::int as c
      from public.audit_log
      where action = 'login.failed' and created_at >= now() - interval '7 days'
      group by 1
    )
    select coalesce(f.c, 0) as c
    from days d left join f on f.day = d.day
    order by d.day
  `;

  return {
    failedLogins24h: agg.failed_logins_24h,
    activeLockouts: agg.active_lockouts,
    impersonationsToday: agg.impersonations_today,
    adminActionsToday: agg.admin_actions_today,
    series: { failedLogins: series.map((r) => r.c) },
  };
}

async function AdminRiskSignals(_input, ctx) {
  const denied = assertCan(ctx.actor, 'admin:read');
  if (denied) return null;

  const [agg] = await sql`
    select
      (select count(*)::int from public.payments where flagged) as flagged_count,
      coalesce((select sum(refunded_amount) from public.payments
                where status = 'refunded' and refunded_at >= now() - interval '7 days'), 0) as refund_7d,
      coalesce((select sum(refunded_amount) from public.payments
                where status = 'refunded' and refunded_at >= now() - interval '1 day'), 0) as refund_24h,
      coalesce((select sum(refunded_amount) from public.payments
                where status = 'refunded' and refunded_at >= now() - interval '8 days'
                  and refunded_at < now() - interval '1 day'), 0) as refund_prev7
  `;

  const top = await sql`
    select u.id as user_id, u.full_name, coalesce(sum(p.refunded_amount), 0) as refunded_sum
    from public.payments p
    join public.reservations r on r.id = p.reservation_id
    join public.users u on u.id = r.user_id
    where p.status = 'refunded' and p.refunded_amount is not null
    group by u.id, u.full_name
    order by refunded_sum desc
    limit 5
  `;

  const refund24h = toNumber(agg.refund_24h);
  const prev7avg = toNumber(agg.refund_prev7) / 7;

  return {
    flaggedCount: agg.flagged_count,
    refund7dSum: toNumber(agg.refund_7d),
    refundSpike: refund24h > 0 && refund24h > prev7avg * 2,
    topRefundedUsers: top.map((r) => ({
      userId: r.user_id,
      fullName: r.full_name,
      refundedSum: toNumber(r.refunded_sum),
    })),
  };
}

export const queries = {
  AdminSystemHealth,
  AdminEventStream,
  AdminSecuritySignals,
  AdminRiskSignals,
};

// No cache meta — the control center polls these and wants fresh values.
export const meta = {};
