// Driver commands — application, profile/vehicle/payout updates, admin
// verification, 2FA, session revocation, policy acceptance, GDPR.

import { sql } from '../../db.js';
import {
  sanitize,
  validateFileSize,
  validatePlate,
  validateSeatCount,
} from '../../utils/validation.js';
import { encryptField } from '../../lib/fieldCrypto.js';
import { appendAudit, assertCan } from '../../graphql/helpers.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

async function RegisterDriverApplication(
  { idCardNumber, licenseNumber, plateNumber, brand, model, seatCount, files = [] },
  ctx
) {
  const actor = ctx.actor;
  const errors = {};
  if (!idCardNumber) errors.idCardNumber = 'ID required';
  if (!licenseNumber) errors.licenseNumber = 'License required';
  const plateErr = validatePlate(plateNumber);
  if (plateErr) errors.plateNumber = plateErr;
  if (!brand) errors.brand = 'Brand required';
  if (!model) errors.model = 'Model required';
  const seatErr = validateSeatCount(seatCount, 8);
  if (seatErr) errors.seatCount = seatErr;
  for (const file of files) {
    const limit = file.kind === 'vehicle' ? 3 : 5;
    const fileErr = validateFileSize(file.sizeBytes, limit);
    if (fileErr) errors[file.kind] = fileErr;
    if (file.mime && !['image/jpeg', 'image/png', 'application/pdf'].includes(file.mime)) {
      errors[file.kind] = 'Use JPEG, PNG, or PDF';
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const plate = plateNumber.toUpperCase();
  const duplicate = await sql`
    select id
    from public.drivers
    where plate_number = ${plate} and user_id <> ${actor.id}::uuid
    limit 1
  `;
  if (duplicate.length) return { ok: false, errors: { plateNumber: 'Plate already registered' } };

  const rows = await sql`
    insert into public.drivers (
      user_id, plate_number, id_card_number, license_number,
      vehicle_brand, vehicle_model, seat_count,
      status, rating, trips_completed
    ) values (
      ${actor.id}::uuid,
      ${plate},
      ${encryptField(idCardNumber)},
      ${encryptField(licenseNumber)},
      ${sanitize(brand)},
      ${sanitize(model)},
      ${Number(seatCount)},
      'pending', 0, 0
    )
    on conflict (user_id) do update set
      plate_number = excluded.plate_number,
      id_card_number = excluded.id_card_number,
      license_number = excluded.license_number,
      vehicle_brand = excluded.vehicle_brand,
      vehicle_model = excluded.vehicle_model,
      seat_count = excluded.seat_count,
      status = 'pending'
    returning id
  `;
  for (const file of files) {
    const documentKind =
      file.kind === 'id'
        ? 'id_card'
        : ['license', 'vehicle', 'other'].includes(file.kind)
          ? file.kind
          : 'other';
    await sql`
      insert into public.documents (user_id, kind, name, mime, size_bytes)
      values (
        ${actor.id}::uuid,
        ${documentKind}::document_kind,
        ${file.name || 'document'},
        ${file.mime || 'application/octet-stream'},
        ${Number(file.sizeBytes || 1)}
      )
    `;
  }
  await appendAudit({
    actor,
    action: 'driver.application.submitted',
    targetEntity: 'driver',
    targetId: rows[0].id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.driver.ApplicationSubmitted, { userId: actor.id, driverId: rows[0].id }, ctx);

  return { ok: true };
}

async function UpdateDriverVehicle({ brand, model, seatCount }, ctx) {
  const actor = ctx.actor;
  const rows = await sql`select id from public.drivers where user_id = ${actor.id}::uuid limit 1`;
  if (!rows.length) return { ok: false, error: 'No driver record' };
  if (seatCount) {
    const seatErr = validateSeatCount(seatCount, 8);
    if (seatErr) return { ok: false, error: seatErr };
  }
  await sql`
    update public.drivers
    set
      vehicle_brand = coalesce(${brand ? sanitize(brand) : null}, vehicle_brand),
      vehicle_model = coalesce(${model ? sanitize(model) : null}, vehicle_model),
      seat_count = coalesce(${seatCount ? Number(seatCount) : null}, seat_count)
    where user_id = ${actor.id}::uuid
  `;
  await appendAudit({
    actor,
    action: 'driver.vehicle.updated',
    targetEntity: 'driver',
    targetId: rows[0].id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.driver.VehicleUpdated, { userId: actor.id }, ctx);
  return { ok: true };
}

async function UpdateDriverPayout({ account }, ctx) {
  const actor = ctx.actor;
  if (!account || account.length < 8) return { ok: false, error: 'Account too short' };
  const rows = await sql`
    update public.drivers
    set payout_account = ${encryptField(sanitize(account))}
    where user_id = ${actor.id}::uuid
    returning id
  `;
  if (!rows.length) return { ok: false, error: 'No driver record' };
  await appendAudit({
    actor,
    action: 'driver.payout.updated',
    targetEntity: 'driver',
    targetId: rows[0].id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.driver.PayoutUpdated, { userId: actor.id }, ctx);
  return { ok: true };
}

async function AdminVerifyDriver({ driverId, approve, reason }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:verify-driver');
  if (denied) return denied;
  const rows = await sql`
    update public.drivers
    set
      status = ${approve ? 'verified' : 'rejected'}::driver_status,
      verified_at = ${approve ? new Date().toISOString() : null},
      rejection_reason = ${approve ? null : sanitize(reason || '')}
    where id = ${driverId}::uuid
    returning user_id
  `;
  if (!rows.length) return { ok: false, error: 'Not found' };
  const targetUserId = rows[0].user_id;
  await sql`
    insert into public.notifications (user_id, title, body)
    values (
      ${targetUserId}::uuid,
      ${approve ? 'Driver application approved' : 'Driver application rejected'},
      ${approve ? 'Your account is now verified. You can start creating rides.' : reason || 'See your profile for next steps.'}
    )
  `;
  await appendAudit({
    actor,
    action: approve ? 'driver.verified' : 'driver.rejected',
    targetEntity: 'driver',
    targetId: driverId,
    metadata: { reason },
    ip: ctx.ip,
  });
  eventBus.emit(
    approve ? Events.driver.Verified : Events.driver.Rejected,
    { driverId, userId: targetUserId, reason },
    ctx,
  );
  return { ok: true };
}

async function Enable2FA(_input, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    update public.drivers
    set two_fa_enabled = true
    where user_id = ${actor.id}::uuid
    returning id
  `;
  if (!rows.length) return { ok: false, error: 'Driver record not found' };
  await appendAudit({ actor, action: 'driver.2fa.enabled', targetEntity: 'driver', targetId: actor.id, ip: ctx.ip });
  eventBus.emit(Events.driver.TwoFAChanged, { userId: actor.id, enabled: true }, ctx);
  return { ok: true };
}

async function Disable2FA(_input, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    update public.drivers
    set two_fa_enabled = false
    where user_id = ${actor.id}::uuid
    returning id
  `;
  if (!rows.length) return { ok: false, error: 'Driver record not found' };
  await appendAudit({ actor, action: 'driver.2fa.disabled', targetEntity: 'driver', targetId: actor.id, ip: ctx.ip });
  eventBus.emit(Events.driver.TwoFAChanged, { userId: actor.id, enabled: false }, ctx);
  return { ok: true };
}

async function RevokeDriverSession({ sessionId }, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    update public.driver_sessions
    set is_revoked = true
    where id = ${sessionId}::uuid and driver_id = ${actor.id}::uuid
    returning id
  `;
  if (!rows.length) return { ok: false, error: 'Session not found' };
  await appendAudit({ actor, action: 'session.revoked', targetEntity: 'session', targetId: sessionId, ip: ctx.ip });
  eventBus.emit(Events.driver.SessionRevoked, { userId: actor.id, sessionId }, ctx);
  return { ok: true };
}

async function AcceptTerms({ version }, ctx) {
  const actor = ctx.actor;
  await sql`
    update public.drivers
    set accepted_terms_version = ${version || '1.0'},
        accepted_terms_at = now()
    where user_id = ${actor.id}::uuid
  `;
  await appendAudit({ actor, action: 'policies.terms_accepted', targetEntity: 'driver', targetId: actor.id, metadata: { version }, ip: ctx.ip });
  eventBus.emit(Events.driver.TermsAccepted, { userId: actor.id, version }, ctx);
  return { ok: true };
}

async function AcceptPrivacy({ version }, ctx) {
  const actor = ctx.actor;
  await sql`
    update public.drivers
    set accepted_privacy_at = now()
    where user_id = ${actor.id}::uuid
  `;
  await appendAudit({ actor, action: 'policies.privacy_accepted', targetEntity: 'driver', targetId: actor.id, metadata: { version }, ip: ctx.ip });
  eventBus.emit(Events.driver.PrivacyAccepted, { userId: actor.id }, ctx);
  return { ok: true };
}

async function RequestDataDeletion({ reason }, ctx) {
  const actor = ctx.actor;
  await sql`
    update public.drivers
    set data_deletion_requested = true
    where user_id = ${actor.id}::uuid
  `;
  await appendAudit({ actor, action: 'gdpr.deletion_requested', targetEntity: 'user', targetId: actor.id, metadata: { reason }, ip: ctx.ip });
  eventBus.emit(Events.driver.DeletionRequested, { userId: actor.id, reason }, ctx);
  return { ok: true, message: 'Deletion request submitted. Our team will process it within 30 days.' };
}

export const commands = {
  RegisterDriverApplication,
  UpdateDriverVehicle,
  UpdateDriverPayout,
  AdminVerifyDriver,
  Enable2FA,
  Disable2FA,
  RevokeDriverSession,
  AcceptTerms,
  AcceptPrivacy,
  RequestDataDeletion,
};
export const meta = {};
