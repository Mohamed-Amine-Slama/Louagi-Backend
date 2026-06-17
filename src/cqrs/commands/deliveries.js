// Delivery commands — CreateDelivery, UpdateDeliveryStatus, CancelDelivery.

import { sql } from '../../db.js';
import { dbBreaker } from '../../lib/supabase/CircuitBreaker.js';
import { withRetry } from '../../lib/supabase/withRetry.js';
import { safeQuery } from '../../lib/supabase/logger.js';
import { sanitize } from '../../utils/validation.js';
import {
  appendAudit,
  assertCan,
  paymentFrom,
  paymentReference,
  toNumber,
} from '../../graphql/helpers.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';
import { loadDeliveryPricing } from '../queries/deliveries.js';

async function CreateDelivery({ rideId, description }, ctx) {
  // Delivery is a flat-rate add-on: fixed price, no severity tier selection.
  // The legacy severity_tier/severity_label columns are kept NOT NULL in the
  // schema, so we persist the Standard tier (1) to satisfy the constraint.
  // Pricing lives in public.app_config (seeded), not hard-coded here.
  const { price, driver_fee: driverFee, platform_fee: platformFee } = await loadDeliveryPricing();
  const tier = 1;
  const label = 'Standard';

  const actor = ctx.actor;
  const denied = assertCan(actor, 'rides:book');
  if (denied) return denied;

  const result = await dbBreaker.call(() =>
    withRetry(() =>
      safeQuery(
        () =>
          sql.begin(async (tx) => {
            const rideRows = await tx`
              select id, accepts_delivery, max_delivery_slots, delivery_slots_taken, driver_id
              from public.rides
              where id = ${rideId}::uuid and status = 'scheduled'
              for update
            `;
            const ride = rideRows[0];
            if (!ride) return { ok: false, error: 'Ride not found or not scheduled' };
            if (!ride.accepts_delivery) return { ok: false, error: 'This ride does not accept deliveries' };
            if (ride.delivery_slots_taken >= ride.max_delivery_slots) {
              return { ok: false, error: 'No delivery slots available' };
            }

            const deliveries = await tx`
              insert into public.delivery (
                user_id, ride_id, severity_tier, severity_label,
                item_description, price, status
              ) values (
                ${actor.id}::uuid,
                ${rideId}::uuid,
                ${tier},
                ${label},
                ${description ? sanitize(description) : null},
                ${price},
                'pending'
              )
              returning *
            `;

            await tx`
              update public.rides
              set delivery_slots_taken = delivery_slots_taken + 1
              where id = ${rideId}::uuid
            `;

            const payments = await tx`
              insert into public.payments (
                delivery_id, method, amount, platform_fee, driver_fee, status, gateway_reference
              ) values (
                ${deliveries[0].id}::uuid,
                'card'::payment_method,
                ${price},
                ${platformFee},
                ${driverFee},
                'succeeded',
                ${paymentReference('DEL')}
              )
              returning *
            `;

            const driverRows = await tx`
              select d.user_id from public.drivers d where d.id = ${ride.driver_id}::uuid limit 1
            `;
            if (driverRows[0]) {
              await tx`
                insert into public.notifications (user_id, title, body)
                values (
                  ${driverRows[0].user_id}::uuid,
                  'New delivery booked',
                  ${`A ${label.toLowerCase()} delivery has been booked on your ride.`}
                )
              `;
            }

            await tx`
              insert into public.audit_log (
                actor_id, actor_role, action, target_entity, target_id, metadata, ip_address
              ) values (
                ${actor.id}::uuid,
                ${actor.role}::user_role,
                'delivery.created',
                'delivery',
                ${deliveries[0].id}::uuid,
                ${JSON.stringify({ price, tier, label })}::jsonb,
                ${ctx.ip ?? 'server'}
              )
            `;

            return {
              ok: true,
              delivery: {
                id: deliveries[0].id,
                status: deliveries[0].status,
                price: toNumber(deliveries[0].price),
                severity_label: deliveries[0].severity_label,
              },
              payment: paymentFrom(payments[0]),
              driverUserId: driverRows[0]?.user_id,
            };
          }),
        { operation: 'CreateDelivery' }
      ),
      { label: 'CreateDelivery' }
    ),
    'CreateDelivery'
  );

  if (result.ok) {
    eventBus.emit(Events.delivery.Created, {
      deliveryId: result.delivery.id,
      userId: actor.id,
      rideId,
      driverUserId: result.driverUserId,
    }, ctx);
    delete result.driverUserId;
  }
  return result;
}

async function UpdateDeliveryStatus({ id, status }, ctx) {
  const actor = ctx.actor;
  const validStatuses = ['confirmed', 'picked_up', 'delivered'];
  if (!validStatuses.includes(status)) return { ok: false, error: 'Invalid status' };

  const rows = await sql`
    select del.id, del.user_id, del.ride_id, d.user_id as driver_user_id
    from public.delivery del
    join public.rides r on r.id = del.ride_id
    join public.drivers d on d.id = r.driver_id
    where del.id = ${id}::uuid
    limit 1
  `;
  const delivery = rows[0];
  if (!delivery) return { ok: false, error: 'Not found' };
  if (actor.role !== 'admin' && delivery.driver_user_id !== actor.id) {
    return { ok: false, error: 'Forbidden' };
  }

  const updated = await sql`
    update public.delivery
    set status = ${status}
    where id = ${id}::uuid
    returning *
  `;

  if (status === 'picked_up' || status === 'delivered') {
    const msg = status === 'picked_up'
      ? 'Your delivery has been picked up by the driver.'
      : 'Your delivery has been delivered successfully.';
    await sql`
      insert into public.notifications (user_id, title, body)
      values (
        ${delivery.user_id}::uuid,
        ${status === 'picked_up' ? 'Delivery picked up' : 'Delivery completed'},
        ${msg}
      )
    `;
  }

  await appendAudit({
    actor,
    action: `delivery.status.${status}`,
    targetEntity: 'delivery',
    targetId: id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.delivery.StatusChanged, {
    deliveryId: id,
    userId: delivery.user_id,
    rideId: delivery.ride_id,
    status,
  }, ctx);

  return { ok: true, delivery: { ...updated[0], price: toNumber(updated[0].price) } };
}

async function CancelDelivery({ id }, ctx) {
  const actor = ctx.actor;
  const result = await sql.begin(async (tx) => {
    const rows = await tx`
      select id, user_id, ride_id, status
      from public.delivery
      where id = ${id}::uuid
      for update
    `;
    const delivery = rows[0];
    if (!delivery) return { ok: false, error: 'Not found' };
    if (delivery.user_id !== actor.id && actor.role !== 'admin') {
      return { ok: false, error: 'Forbidden' };
    }
    if (['picked_up', 'delivered', 'cancelled'].includes(delivery.status)) {
      return { ok: false, error: 'Cannot cancel at this stage' };
    }

    await tx`
      update public.delivery
      set status = 'cancelled', cancelled_at = now()
      where id = ${id}::uuid
    `;
    await tx`
      update public.rides
      set delivery_slots_taken = greatest(0, delivery_slots_taken - 1)
      where id = ${delivery.ride_id}::uuid
    `;
    await tx`
      update public.payments
      set status = 'refunded', refunded_at = now()
      where delivery_id = ${id}::uuid and status = 'succeeded'
    `;

    await tx`
      insert into public.audit_log (
        actor_id, actor_role, action, target_entity, target_id, ip_address
      ) values (
        ${actor.id}::uuid,
        ${actor.role}::user_role,
        'delivery.cancelled',
        'delivery',
        ${id}::uuid,
        ${ctx.ip ?? 'server'}
      )
    `;
    return { ok: true, userId: delivery.user_id, rideId: delivery.ride_id };
  });

  if (result.ok) {
    eventBus.emit(Events.delivery.Cancelled, {
      deliveryId: id,
      userId: result.userId,
      rideId: result.rideId,
    }, ctx);
    return { ok: true };
  }
  return result;
}

export const commands = { CreateDelivery, UpdateDeliveryStatus, CancelDelivery };
export const meta = {};
