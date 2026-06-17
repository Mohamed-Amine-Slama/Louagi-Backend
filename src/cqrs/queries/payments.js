// Payment read paths.

import { sql } from '../../db.js';
import { paymentFrom } from '../../graphql/helpers.js';
import { cacheKey } from '../../graphql/cache.js';

async function ListPayments({ limit, offset } = {}, ctx) {
  const actor = ctx.actor;
  const lim = Math.min(Number(limit || 50), 500);
  const off = Math.max(Number(offset || 0), 0);
  const rows =
    actor.role === 'admin'
      ? await sql`
          select id, reservation_id, delivery_id, method, amount, status,
                 gateway_reference, flagged, flagged_reason, platform_fee,
                 driver_fee, reservation_fee, refunded_amount, refund_type,
                 paid_at, refunded_at
          from public.payments
          order by paid_at desc
          limit ${lim} offset ${off}
        `
      : await sql`
          select p.id, p.reservation_id, p.delivery_id, p.method, p.amount, p.status,
                 p.gateway_reference, p.flagged, p.flagged_reason, p.platform_fee,
                 p.driver_fee, p.reservation_fee, p.refunded_amount, p.refund_type,
                 p.paid_at, p.refunded_at
          from public.payments p
          left join public.reservations r on r.id = p.reservation_id
          left join public.delivery del on del.id = p.delivery_id
          where r.user_id = ${actor.id}::uuid or del.user_id = ${actor.id}::uuid
          order by p.paid_at desc
          limit ${lim} offset ${off}
        `;
  return rows.map(paymentFrom);
}

export const queries = { ListPayments };

export const meta = {
  ListPayments: {
    cache: {
      key: ({ limit, offset } = {}, ctx) => {
        const lim = Math.min(Number(limit || 50), 500);
        const off = Math.max(Number(offset || 0), 0);
        return ctx.actor.role === 'admin'
          ? `pay:list:admin:${lim}:${off}`
          : cacheKey.listPayments(ctx.actor.id, lim, off);
      },
      ttl: 60,
    },
  },
};
