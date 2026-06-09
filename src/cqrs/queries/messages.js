// Message read paths.
//
// GetMessages has a side effect (marks unread → read). In strict CQRS that
// would be a MarkThreadRead command + GetMessages query. We emit a
// `message.read` event so the cache-invalidation projection drops the chat
// list cache for the reader; the side-effect itself stays inline to preserve
// the existing API contract.

import { sql } from '../../db.js';
import { cacheKey } from '../../graphql/cache.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

async function ListChats({ limit, offset } = {}, ctx) {
  const actor = ctx.actor;
  const lim = Math.min(Number(limit || 50), 100);
  const off = Math.max(Number(offset || 0), 0);
  const rows = await sql`
    with recent as (
      select
        case when sender_id = ${actor.id}::uuid then receiver_id else sender_id end as partner_id,
        max(created_at) as latest_msg_at,
        coalesce(sum(case when sender_id <> ${actor.id}::uuid and is_read = false then 1 else 0 end), 0)::int as unread_count
      from public.messages
      where (sender_id = ${actor.id}::uuid and deleted_by_sender = false)
         or (receiver_id = ${actor.id}::uuid and deleted_by_receiver = false)
      group by 1
      order by max(created_at) desc
      limit ${lim} offset ${off}
    )
    select
      u.id as partner_id,
      u.full_name as partner_name,
      u.role as partner_role,
      u.phone_number as partner_phone,
      last_msg.content as last_message,
      recent.latest_msg_at as last_message_time,
      recent.unread_count
    from recent
    join public.users u on u.id = recent.partner_id
    left join lateral (
      select content
      from public.messages
      where created_at = recent.latest_msg_at
        and (sender_id = recent.partner_id or receiver_id = recent.partner_id)
      limit 1
    ) last_msg on true
    order by recent.latest_msg_at desc
  `;
  return rows.map((r) => ({
    partnerId: r.partner_id,
    partnerName: r.partner_name,
    partnerRole: r.partner_role,
    partnerPhone: r.partner_phone,
    lastMessage: r.last_message,
    lastMessageTime: r.last_message_time,
    unreadCount: Number(r.unread_count),
  }));
}

async function GetMessages({ otherUserId }, ctx) {
  const actor = ctx.actor;
  if (!otherUserId) {
    const err = new Error('otherUserId is required');
    err.status = 400;
    throw err;
  }
  await sql`
    update public.messages
    set is_read = true
    where sender_id = ${otherUserId}::uuid and receiver_id = ${actor.id}::uuid
  `;
  eventBus.emit(Events.message.Read, { readerId: actor.id, partnerId: otherUserId }, ctx);

  const rows = await sql`
    select id, sender_id, receiver_id, content, is_read, created_at
    from public.messages
    where (sender_id = ${actor.id}::uuid and receiver_id = ${otherUserId}::uuid and deleted_by_sender = false)
       or (sender_id = ${otherUserId}::uuid and receiver_id = ${actor.id}::uuid and deleted_by_receiver = false)
    order by created_at asc
    limit 200
  `;
  return rows.map((m) => ({
    id: m.id,
    senderId: m.sender_id,
    receiverId: m.receiver_id,
    content: m.content,
    isRead: m.is_read,
    createdAt: m.created_at,
  }));
}

export const queries = { ListChats, GetMessages };

export const meta = {
  ListChats: {
    cache: {
      key: ({ limit, offset } = {}, ctx) => cacheKey.listChats(
        ctx.actor.id,
        Math.min(Number(limit || 50), 100),
        Math.max(Number(offset || 0), 0),
      ),
      ttl: 30,
    },
  },
};
