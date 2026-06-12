// Admin commands.

import { sql } from '../../db.js';
import { signAccessToken } from '../../auth/tokens.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../../auth/totp.js';
import { decryptField, encryptField } from '../../lib/fieldCrypto.js';
import {
  appendAudit,
  assertCan,
  validAdminImpersonationCode,
} from '../../graphql/helpers.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

// Step-up check for sensitive admin actions: per-admin TOTP once enrolled,
// the shared static ADMIN_IMPERSONATION_CODE as the un-enrolled fallback.
async function verifyAdminStepUp(actorId, code) {
  const rows = await sql`
    select admin_totp_secret, admin_totp_enabled
    from public.users
    where id = ${actorId}::uuid
    limit 1
  `;
  const mfa = rows[0];
  if (mfa?.admin_totp_enabled && mfa.admin_totp_secret) {
    const secret = decryptField(mfa.admin_totp_secret);
    return { method: 'totp', ok: !!secret && verifyTotp(secret, code) };
  }
  return { method: 'static', ok: validAdminImpersonationCode(code) };
}

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
  const stepUp = await verifyAdminStepUp(actor.id, mfaCode);
  if (!stepUp.ok) {
    await appendAudit({
      actor,
      action: 'admin.impersonate.step_up_failed',
      targetEntity: 'user',
      targetId: target.id,
      metadata: { targetRole: target.role, method: stepUp.method },
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

// ─── Per-admin TOTP enrollment ──────────────────────────────────────────────
// Two-step on purpose: setup stores the secret disabled; activation requires a
// working code first, so a mis-entered secret can never lock an admin out.

async function AdminSetupTotp(_input, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return denied;

  const secret = generateTotpSecret();
  const updated = await sql`
    update public.users
    set admin_totp_secret = ${encryptField(secret)}, admin_totp_enabled = false
    where id = ${actor.id}::uuid and role = 'admin'
    returning id
  `;
  if (!updated.length) return { ok: false, error: 'Not found' };
  await appendAudit({
    actor,
    action: 'admin.totp.setup',
    targetEntity: 'user',
    targetId: actor.id,
    ip: ctx.ip,
  });
  return { ok: true, secret, uri: totpUri(secret, actor.name || 'admin') };
}

async function AdminActivateTotp({ code }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return denied;

  const rows = await sql`
    select admin_totp_secret from public.users where id = ${actor.id}::uuid limit 1
  `;
  const secret = decryptField(rows[0]?.admin_totp_secret);
  if (!secret) return { ok: false, error: 'Run setup first' };
  if (!verifyTotp(secret, code)) return { ok: false, error: 'Code does not match — check your authenticator app' };

  await sql`
    update public.users set admin_totp_enabled = true where id = ${actor.id}::uuid
  `;
  await appendAudit({
    actor,
    action: 'admin.totp.enabled',
    targetEntity: 'user',
    targetId: actor.id,
    ip: ctx.ip,
  });
  return { ok: true };
}

async function AdminDisableTotp({ code }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return denied;

  const rows = await sql`
    select admin_totp_secret, admin_totp_enabled from public.users where id = ${actor.id}::uuid limit 1
  `;
  if (!rows[0]?.admin_totp_enabled) return { ok: false, error: 'TOTP is not enabled' };
  const secret = decryptField(rows[0].admin_totp_secret);
  // Disabling requires a live code — a stolen unlocked session can't silently
  // strip the second factor.
  if (!secret || !verifyTotp(secret, code)) {
    return { ok: false, error: 'Code does not match — check your authenticator app' };
  }

  await sql`
    update public.users
    set admin_totp_secret = null, admin_totp_enabled = false
    where id = ${actor.id}::uuid
  `;
  await appendAudit({
    actor,
    action: 'admin.totp.disabled',
    targetEntity: 'user',
    targetId: actor.id,
    ip: ctx.ip,
  });
  return { ok: true };
}

export const commands = {
  AdminSetUserActive,
  AdminImpersonate,
  AdminSetupTotp,
  AdminActivateTotp,
  AdminDisableTotp,
};
export const meta = {};
