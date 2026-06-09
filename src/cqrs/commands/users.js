// User commands — profile updates, notification prefs, self-delete, GDPR
// account-wipe.

import { sql } from '../../db.js';
import {
  sanitize,
  validateEmail,
  validateName,
  validatePassword,
} from '../../utils/validation.js';
import { appendAudit } from '../../graphql/helpers.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

async function UpdateProfile({ fullName, email, currentPassword, newPassword }, ctx) {
  const actor = ctx.actor;
  const errors = {};
  if (fullName != null) {
    const err = validateName(fullName);
    if (err) errors.fullName = err;
  }
  if (email != null) {
    const err = validateEmail(email);
    if (err) errors.email = err;
    if (!err) {
      const existing = await sql`
        select id from public.users
        where lower(email) = lower(${email}) and id <> ${actor.id}::uuid
        limit 1
      `;
      if (existing.length) errors.email = 'Email already in use';
    }
  }
  if (newPassword) {
    const err = validatePassword(newPassword);
    if (err) errors.newPassword = err;
    const okRows = await sql`
      select password_hash = extensions.crypt(${currentPassword || ''}, password_hash) as ok
      from public.users
      where id = ${actor.id}::uuid
    `;
    if (!okRows[0]?.ok) errors.currentPassword = 'Current password incorrect';
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  await sql`
    update public.users
    set
      full_name = coalesce(${fullName != null ? sanitize(fullName) : null}, full_name),
      email = coalesce(${email != null ? email.toLowerCase() : null}, email),
      password_hash = case
        when ${newPassword || null}::text is null then password_hash
        else extensions.crypt(${newPassword || null}, extensions.gen_salt('bf'))
      end
    where id = ${actor.id}::uuid
  `;
  await appendAudit({
    actor,
    action: 'profile.updated',
    targetEntity: 'user',
    targetId: actor.id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.user.ProfileUpdated, { userId: actor.id, fields: { fullName: fullName != null, email: email != null, password: !!newPassword } }, ctx);
  return { ok: true };
}

async function UpdateNotificationPrefs({ sms, push }, ctx) {
  const actor = ctx.actor;
  await sql`
    update public.users
    set notifications = ${JSON.stringify({ sms: Boolean(sms), push: Boolean(push) })}::jsonb
    where id = ${actor.id}::uuid
  `;
  eventBus.emit(Events.user.NotificationsUpdated, { userId: actor.id }, ctx);
  return { ok: true };
}

async function DeleteAccount({ password }, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    select password_hash = extensions.crypt(${password || ''}, password_hash) as ok
    from public.users
    where id = ${actor.id}::uuid
  `;
  if (!rows[0]?.ok) return { ok: false, error: 'Password incorrect' };
  await sql`update public.users set is_active = false where id = ${actor.id}::uuid`;
  await appendAudit({
    actor,
    action: 'user.self_deleted',
    targetEntity: 'user',
    targetId: actor.id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.user.SelfDeleted, { userId: actor.id }, ctx);
  return { ok: true };
}

async function DeleteMyAccount(_input, ctx) {
  const actor = ctx.actor;
  await sql`
    update public.users
    set is_active = false,
        full_name = 'Deleted User',
        phone_number = null,
        email = null,
        password_hash = 'deleted'
    where id = ${actor.id}::uuid
  `;
  await sql`delete from public.user_sessions where user_id = ${actor.id}::uuid`;
  await appendAudit({
    actor: { id: actor.id, role: actor.role },
    action: 'gdpr.delete_account',
    targetEntity: 'user',
    targetId: actor.id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.user.Deleted, { userId: actor.id }, ctx);
  return { ok: true, message: 'Account deleted' };
}

export const commands = { UpdateProfile, UpdateNotificationPrefs, DeleteAccount, DeleteMyAccount };
export const meta = {};
