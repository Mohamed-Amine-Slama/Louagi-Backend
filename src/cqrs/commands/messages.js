// Message commands.

import { sql } from '../../db.js';
import { sanitize } from '../../utils/validation.js';
import { DeleteMessageSchema } from '../../utils/validation.server.js';
import { appendAudit } from '../../graphql/helpers.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

async function SendMessage({ receiverId, text }, ctx) {
  const actor = ctx.actor;
  const content = sanitize(text);
  if (!content) return { ok: false, error: 'Empty message' };
  const rows = await sql`
    insert into public.messages (sender_id, receiver_id, content)
    values (${actor.id}::uuid, ${receiverId}::uuid, ${content})
    returning *
  `;
  const m = rows[0];
  await appendAudit({
    actor,
    action: 'message.sent',
    targetEntity: 'message',
    targetId: m.id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.message.Sent, { messageId: m.id, senderId: actor.id, receiverId }, ctx);

  return {
    ok: true,
    message: {
      id: m.id,
      senderId: m.sender_id,
      receiverId: m.receiver_id,
      content: m.content,
      isRead: m.is_read,
      createdAt: m.created_at,
    },
  };
}

async function DeleteMessage(input, ctx) {
  const actor = ctx.actor;
  const parsed = DeleteMessageSchema.parse(input);
  const { messageId, forEveryone } = parsed;

  const partners = await sql`
    select sender_id, receiver_id from public.messages where id = ${messageId}::uuid limit 1
  `;
  await sql`select public.delete_message(${actor.id}::uuid, ${messageId}::uuid, ${forEveryone}::boolean)`;

  await appendAudit({
    actor: { id: actor.id, role: actor.role },
    action: 'message.deleted',
    targetEntity: 'message',
    targetId: messageId,
    metadata: { forEveryone },
    ip: ctx.ip,
  });

  if (partners[0]) {
    eventBus.emit(Events.message.Deleted, {
      messageId,
      senderId: partners[0].sender_id,
      receiverId: partners[0].receiver_id,
      forEveryone,
    }, ctx);
  }
  return { ok: true };
}

export const commands = { SendMessage, DeleteMessage };
export const meta = {};
