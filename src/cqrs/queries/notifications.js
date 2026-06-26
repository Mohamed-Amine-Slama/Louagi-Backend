// Notification read-side: a user's own notifications, plus admin helpers for
// the broadcast composer (live recipient count + campaign history).

import { sql } from '../../db.js';
import { assertCan } from '../../graphql/helpers.js';
import { resolveAudienceIds, AUDIENCES } from '../commands/notifications.js';

async function ListNotifications({ limit = 50 } = {}, ctx) {
  const actor = ctx.actor;
  if (!actor?.id) return [];
  const lim = Math.min(Number(limit) || 50, 100);
  return sql`
    select id, title, body, data, category, read, created_at
    from public.notifications
    where user_id = ${actor.id}::uuid
    order by created_at desc
    limit ${lim}
  `;
}

async function AdminRecipientCount({ audience, userId }, ctx) {
  const denied = assertCan(ctx.actor, 'admin:read');
  if (denied) return { count: 0 };
  const aud = AUDIENCES.has(audience) ? audience : 'all';
  if (aud === 'single') return { count: userId ? 1 : 0 };
  const ids = await resolveAudienceIds(aud, userId);
  return { count: ids.length };
}

async function AdminListCampaigns({ limit = 50 } = {}, ctx) {
  const denied = assertCan(ctx.actor, 'admin:read');
  if (denied) return [];
  const lim = Math.min(Number(limit) || 50, 200);
  return sql`
    select
      c.id, c.title, c.body, c.audience,
      c.recipient_count, c.pushed_count, c.failed_count, c.created_at,
      u.full_name as sent_by_name
    from public.notification_campaigns c
    left join public.users u on u.id = c.sent_by
    order by c.created_at desc
    limit ${lim}
  `;
}

export const queries = {
  ListNotifications,
  AdminRecipientCount,
  AdminListCampaigns,
};

export const meta = {};
