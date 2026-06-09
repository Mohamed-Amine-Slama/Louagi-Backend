// Payment commands (admin actions).

import { sql } from '../../db.js';
import {
  appendAudit,
  assertCan,
  paymentFrom,
} from '../../graphql/helpers.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

async function AdminRefund({ paymentId, amount }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:refund');
  if (denied) return denied;

  const rows = await sql`
    select p.*, r.user_id as owner_id
    from public.payments p
    left join public.reservations r on r.id = p.reservation_id
    where p.id = ${paymentId}::uuid
    limit 1
  `;
  const payment = rows[0];
  if (!payment) return { ok: false, error: 'Not found' };
  if (payment.status === 'refunded') return { ok: false, error: 'Already refunded' };
  const value = Number(amount);
  if (value <= 0) return { ok: false, error: 'Invalid amount' };
  if (value > Number(payment.amount)) return { ok: false, error: 'Amount exceeds payment' };

  const partial = value < Number(payment.amount);
  const updated = await sql`
    update public.payments
    set
      status = 'refunded',
      refunded_at = now(),
      refunded_amount = ${value},
      refund_type = ${partial ? 'partial' : 'full'}
    where id = ${paymentId}::uuid
    returning *
  `;
  await appendAudit({
    actor,
    action: partial ? 'payment.refund.partial' : 'payment.refund.full',
    targetEntity: 'payment',
    targetId: paymentId,
    metadata: { amount: value, original: Number(payment.amount) },
    ip: ctx.ip,
  });
  eventBus.emit(Events.payment.Refunded, {
    paymentId,
    ownerId: payment.owner_id,
    amount: value,
    partial,
  }, ctx);

  return { ok: true, payment: paymentFrom(updated[0]) };
}

async function AdminFlagPayment({ paymentId, reason }, ctx) {
  const actor = ctx.actor;
  const denied = assertCan(actor, 'admin:read');
  if (denied) return denied;
  const updated = await sql`
    update public.payments
    set status = 'flagged', flagged = true, flagged_reason = ${reason || 'flagged by admin'}
    where id = ${paymentId}::uuid
    returning *
  `;
  if (!updated.length) return { ok: false, error: 'Not found' };
  await appendAudit({
    actor,
    action: 'payment.flagged',
    targetEntity: 'payment',
    targetId: paymentId,
    metadata: { reason },
    ip: ctx.ip,
  });
  eventBus.emit(Events.payment.Flagged, { paymentId, reason }, ctx);

  return { ok: true, payment: paymentFrom(updated[0]) };
}

export const commands = { AdminRefund, AdminFlagPayment };
export const meta = {};
