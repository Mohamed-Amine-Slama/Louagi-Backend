// Admin commands.

import { sql } from '../../db.js';
import { signAccessToken } from '../../auth/tokens.js';
import {
  appendAudit,
  assertCan,
  validAdminImpersonationCode,
} from '../../graphql/helpers.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

async function AdminSetUserActive({ userId, active }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:suspend-user');
  if (denied) return denied;
  const targetRows = await sql`select id, role from public.users where id = ${userId}::uuid limit 1`;
  const target = targetRows[0];
  if (!target) return { ok: false, error: 'Not found' };
  if (!active && target.role === 'admin') {
    const [{ count }] = await sql`
      select count(*)::int
      from public.users
      where role = 'admin' and is_active = true and id <> ${userId}::uuid
    `;
    if (count === 0) return { ok: false, error: 'Cannot suspend the last admin' };
  }
  await sql`update public.users set is_active = ${Boolean(active)} where id = ${userId}::uuid`;
  await appendAudit({
    actor,
    action: active ? 'user.reactivated' : 'user.suspended',
    targetEntity: 'user',
    targetId: userId,
    ip: ctx.ip,
  });
  eventBus.emit(
    active ? Events.user.Reactivated : Events.user.Suspended,
    { userId, byActorId: actor.id },
    ctx,
  );
  return { ok: true };
}

async function AdminImpersonate({ userId, mfaCode }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:impersonate');
  if (denied) return denied;
  const rows = await sql`
    select
      u.id,
      u.full_name,
      u.role,
      d.status as driver_status
    from public.users u
    left join public.drivers d on d.user_id = u.id
    where u.id = ${userId}::uuid
    limit 1
  `;
  const target = rows[0];
  if (!target) return { ok: false, error: 'Not found' };
  if (target.role === 'admin') return { ok: false, error: 'Cannot impersonate another admin' };
  if (!validAdminImpersonationCode(mfaCode)) {
    await appendAudit({
      actor,
      action: 'admin.impersonate.step_up_failed',
      targetEntity: 'user',
      targetId: target.id,
      metadata: { targetRole: target.role },
      ip: ctx.ip,
    });
    return { ok: false, error: 'Step-up verification required' };
  }
  const accessToken = signAccessToken({
    sub: target.id,
    role: target.role,
    name: target.full_name,
    driverStatus: target.driver_status ?? null,
    impersonatedBy: actor.id,
  });
  await appendAudit({
    actor,
    action: 'admin.impersonate',
    targetEntity: 'user',
    targetId: target.id,
    metadata: { targetRole: target.role },
    ip: ctx.ip,
  });
  eventBus.emit(Events.admin.Impersonated, { adminId: actor.id, targetUserId: target.id }, ctx);
  return {
    ok: true,
    accessToken,
    target: {
      id: target.id,
      full_name: target.full_name,
      role: target.role,
    },
  };
}

export const commands = { AdminSetUserActive, AdminImpersonate };
export const meta = {};
