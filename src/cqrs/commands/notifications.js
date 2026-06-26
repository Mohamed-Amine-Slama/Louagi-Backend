// Notification write-side: device-token registration, read receipts, and the
// admin broadcast (persist rows + Expo push + campaign log + audit).

import { sql } from '../../db.js';
import { assertCan, appendAudit } from '../../graphql/helpers.js';
import { sendExpoPush } from '../../lib/expoPush.js';

export const AUDIENCES = new Set([
  'all',
  'drivers',
  'passengers',
  'verified_drivers',
  'single',
]);

// Resolves an audience to the set of recipient user ids. Broadcast/segment
// sends respect each user's `notifications.push` opt-out (default opt-in);
// single-user sends always reach the chosen user.
export async function resolveAudienceIds(audience, userId) {
  const optedIn = sql`coalesce((u.notifications->>'push')::boolean, true)`;
  switch (audience) {
    case 'single':
      return (
        await sql`select id from public.users where id = ${userId ?? null}::uuid and is_active = true`
      ).map((r) => r.id);
    case 'drivers':
      return (
        await sql`
          select u.id from public.users u
          join public.drivers d on d.user_id = u.id
          where u.is_active = true and ${optedIn}`
      ).map((r) => r.id);
    case 'verified_drivers':
      return (
        await sql`
          select u.id from public.users u
          join public.drivers d on d.user_id = u.id
          where d.status = 'verified' and u.is_active = true and ${optedIn}`
      ).map((r) => r.id);
    case 'passengers':
      return (
        await sql`
          select u.id from public.users u
          where u.is_active = true
            and not exists (select 1 from public.drivers d where d.user_id = u.id)
            and ${optedIn}`
      ).map((r) => r.id);
    case 'all':
    default:
      return (
        await sql`select u.id from public.users u where u.is_active = true and ${optedIn}`
      ).map((r) => r.id);
  }
}

async function RegisterPushToken({ token, platform }, ctx) {
  const actor = ctx.actor;
  if (!actor?.id) return { ok: false, error: 'Unauthorized' };
  const t = String(token || '').trim();
  if (!t) return { ok: false, error: 'Token required' };
  // A physical device maps to exactly one user: if this token was registered to
  // someone else (shared device, account switch), reassign it to the current
  // user so broadcasts don't leak across the logout boundary.
  await sql`delete from public.push_tokens where token = ${t} and user_id <> ${actor.id}::uuid`;
  await sql`
    insert into public.push_tokens (user_id, token, platform)
    values (${actor.id}::uuid, ${t}, ${platform ?? null})
    on conflict (user_id, token) do update
      set updated_at = now(),
          last_seen_at = now(),
          platform = coalesce(${platform ?? null}, public.push_tokens.platform)
  `;
  return { ok: true };
}

async function UnregisterPushToken({ token }, ctx) {
  const actor = ctx.actor;
  if (!actor?.id) return { ok: false, error: 'Unauthorized' };
  const t = String(token || '').trim();
  if (!t) return { ok: true };
  await sql`delete from public.push_tokens where user_id = ${actor.id}::uuid and token = ${t}`;
  return { ok: true };
}

async function MarkNotificationRead({ notificationId, all }, ctx) {
  const actor = ctx.actor;
  if (!actor?.id) return { ok: false, error: 'Unauthorized' };
  if (all) {
    await sql`update public.notifications set read = true where user_id = ${actor.id}::uuid and read = false`;
    return { ok: true };
  }
  if (!notificationId) return { ok: false, error: 'notificationId required' };
  await sql`
    update public.notifications set read = true
    where id = ${notificationId}::uuid and user_id = ${actor.id}::uuid
  `;
  return { ok: true };
}

async function AdminSendNotification({ audience, userId, title, body, data }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:send-notification');
  if (denied) return denied;

  const aud = AUDIENCES.has(audience) ? audience : 'all';
  const ttl = String(title || '').trim();
  const bdy = String(body || '').trim();
  if (!ttl || !bdy) return { ok: false, error: 'Title and message are required' };
  if (aud === 'single' && !userId) return { ok: false, error: 'Select a user' };
  const payload = data && typeof data === 'object' ? data : {};

  const userIds = await resolveAudienceIds(aud, userId);
  if (userIds.length === 0) {
    return { ok: true, recipientCount: 0, pushed: 0, failed: 0 };
  }

  // 1. One in-app notification row per recipient (record + history).
  await sql`
    insert into public.notifications (user_id, title, body, data, category, sent_by)
    select uid, ${ttl}, ${bdy}, ${JSON.stringify(payload)}::jsonb, 'admin', ${actor.id}::uuid
    from unnest(${userIds}::uuid[]) as uid
  `;

  // 2. Deliver to each recipient's registered devices via Expo.
  const tokenRows = await sql`
    select token from public.push_tokens where user_id = any(${userIds}::uuid[])
  `;
  const messages = tokenRows.map((r) => ({
    to: r.token,
    title: ttl,
    body: bdy,
    data: payload,
  }));
  const result = await sendExpoPush(messages);

  if (result.invalidTokens.length) {
    await sql`delete from public.push_tokens where token = any(${result.invalidTokens}::text[])`;
  }

  // 3. Campaign log + immutable audit entry.
  await sql`
    insert into public.notification_campaigns
      (sent_by, title, body, audience, recipient_count, pushed_count, failed_count)
    values (
      ${actor.id}::uuid, ${ttl}, ${bdy},
      ${JSON.stringify({ type: aud, userId: aud === 'single' ? userId : null })}::jsonb,
      ${userIds.length}, ${result.pushed}, ${result.failed}
    )
  `;
  await appendAudit({
    actor,
    action: 'admin.notification.send',
    targetEntity: 'notification_campaign',
    targetId: aud === 'single' ? userId : null,
    metadata: {
      audience: aud,
      recipientCount: userIds.length,
      pushed: result.pushed,
      failed: result.failed,
    },
    ip: ctx.ip,
  });

  return {
    ok: true,
    recipientCount: userIds.length,
    pushed: result.pushed,
    failed: result.failed,
  };
}

export const commands = {
  RegisterPushToken,
  UnregisterPushToken,
  MarkNotificationRead,
  AdminSendNotification,
};

export const meta = {};
