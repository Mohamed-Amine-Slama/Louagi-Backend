// Cache-invalidation projection.
//
// Subscribes to every domain event and updates Redis caches accordingly. Every
// invalidation rule the app has lives here — search this file when chasing a
// "why is my cache stale?" question.
//
// Why centralize? Because invalidation rules are cross-cutting (a single
// command often invalidates 3–5 unrelated caches) and the rules will evolve.
// Centralizing them keeps command handlers focused on business logic.

import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';
import { invalidate, invalidatePattern, cacheKey } from '../../graphql/cache.js';
import { clearActorCache } from '../../middleware/auth.js';

function register() {
  // ─── User / profile ────────────────────────────────────────────────────────
  eventBus.on(Events.user.ProfileUpdated, async ({ userId }) => {
    await Promise.all([
      invalidate(cacheKey.profile(userId)),
      clearActorCache(userId),
    ]);
  });

  eventBus.on(Events.user.NotificationsUpdated, async ({ userId }) => {
    await invalidate(cacheKey.profile(userId));
  });

  eventBus.on(Events.user.LoggedOut, async ({ userId }) => {
    await clearActorCache(userId);
  });

  eventBus.on(Events.user.Suspended, async ({ userId }) => {
    await Promise.all([
      invalidate(cacheKey.profile(userId)),
      clearActorCache(userId),
      // Admin user search embeds is_active; the admin expects the toggle to
      // show immediately after acting.
      invalidatePattern('admin:users:*'),
    ]);
  });

  eventBus.on(Events.user.Reactivated, async ({ userId }) => {
    await Promise.all([
      invalidate(cacheKey.profile(userId)),
      clearActorCache(userId),
      invalidatePattern('admin:users:*'),
    ]);
  });

  eventBus.on(Events.user.SelfDeleted, async ({ userId }) => {
    await Promise.all([
      invalidate(cacheKey.profile(userId)),
      clearActorCache(userId),
    ]);
  });

  eventBus.on(Events.user.Deleted, async ({ userId }) => {
    await Promise.all([
      invalidate(cacheKey.profile(userId)),
      clearActorCache(userId),
    ]);
  });

  // ─── Driver ────────────────────────────────────────────────────────────────
  eventBus.on(Events.driver.ApplicationSubmitted, async ({ userId }) => {
    await Promise.all([
      invalidate(cacheKey.driverProfile(userId), cacheKey.driverStatus(userId)),
      invalidate(cacheKey.adminAlerts()),
    ]);
  });

  eventBus.on(Events.driver.Verified, async ({ userId }) => {
    await Promise.all([
      invalidate(cacheKey.driverProfile(userId), cacheKey.driverStatus(userId)),
      invalidate(cacheKey.adminAlerts()),
      clearActorCache(userId),
      // Admin user search embeds driver status.
      invalidatePattern('admin:users:*'),
    ]);
  });

  eventBus.on(Events.driver.Rejected, async ({ userId }) => {
    await Promise.all([
      invalidate(cacheKey.driverProfile(userId), cacheKey.driverStatus(userId)),
      invalidate(cacheKey.adminAlerts()),
      clearActorCache(userId),
      invalidatePattern('admin:users:*'),
    ]);
  });

  eventBus.on(Events.driver.VehicleUpdated, async ({ userId }) => {
    await invalidate(cacheKey.driverProfile(userId));
  });

  eventBus.on(Events.driver.PayoutUpdated, async ({ userId }) => {
    await invalidate(cacheKey.driverProfile(userId));
  });

  eventBus.on(Events.driver.TwoFAChanged, async ({ userId }) => {
    await invalidate(cacheKey.twoFAStatus(userId));
  });

  eventBus.on(Events.driver.TermsAccepted, async ({ userId }) => {
    await invalidate(cacheKey.driverProfile(userId));
  });

  eventBus.on(Events.driver.PrivacyAccepted, async ({ userId }) => {
    await invalidate(cacheKey.driverProfile(userId));
  });

  eventBus.on(Events.driver.SessionRevoked, async ({ userId }) => {
    await Promise.all([
      clearActorCache(userId),
      invalidate(cacheKey.driverSessions(userId)),
    ]);
  });

  // ─── Ride ──────────────────────────────────────────────────────────────────
  eventBus.on(Events.ride.Created, async ({ driverUserId }) => {
    await Promise.all([
      invalidatePattern(cacheKey.driverRidesAll(driverUserId)),
      invalidatePattern('search:rides:*'),
      invalidatePattern('deliveries:avail:*'),
      invalidatePattern('admin:rides:*'),
    ]);
  });

  eventBus.on(Events.ride.StatusChanged, async ({ rideId, driverUserId }) => {
    await Promise.all([
      invalidate(cacheKey.rideDetail(rideId)),
      invalidatePattern(cacheKey.driverRidesAll(driverUserId)),
      invalidatePattern('search:rides:*'),
      invalidatePattern('admin:rides:*'),
    ]);
  });

  eventBus.on(Events.ride.Cancelled, async ({ rideId, driverUserId, affectedUserIds = [] }) => {
    const tasks = [
      invalidate(cacheKey.rideDetail(rideId), cacheKey.ridePassengers(rideId)),
      invalidatePattern(cacheKey.driverRidesAll(driverUserId)),
      invalidatePattern('search:rides:*'),
      invalidatePattern('admin:rides:*'),
    ];
    for (const userId of new Set(affectedUserIds)) {
      tasks.push(invalidatePattern(cacheKey.listReservationsAll(userId)));
      tasks.push(invalidatePattern(cacheKey.listPaymentsAll(userId)));
    }
    await Promise.all(tasks);
  });

  // ─── Reservation ───────────────────────────────────────────────────────────
  eventBus.on(Events.reservation.Created, async ({ userId, rideId }) => {
    await Promise.all([
      invalidatePattern(cacheKey.listReservationsAll(userId)),
      invalidatePattern(cacheKey.listPaymentsAll(userId)),
      invalidate(cacheKey.rideDetail(rideId), cacheKey.ridePassengers(rideId)),
      invalidatePattern('search:rides:*'),
    ]);
  });

  eventBus.on(Events.reservation.Cancelled, async ({ reservationId, userId, rideId }) => {
    await Promise.all([
      invalidate(cacheKey.reservation(reservationId)),
      invalidatePattern(cacheKey.listReservationsAll(userId)),
      invalidatePattern(cacheKey.listPaymentsAll(userId)),
      invalidate(cacheKey.rideDetail(rideId), cacheKey.ridePassengers(rideId)),
      invalidatePattern('search:rides:*'),
    ]);
  });

  // ─── Payment ───────────────────────────────────────────────────────────────
  eventBus.on(Events.payment.Refunded, async ({ ownerId }) => {
    const tasks = [
      invalidatePattern('pay:list:admin:*'),
      invalidate(cacheKey.adminStats(), cacheKey.adminAlerts(), cacheKey.adminPaySummary()),
      // Refunds move payments out of 'succeeded', which feeds both aggregates.
      invalidatePattern('admin:payouts:*'),
      invalidatePattern('admin:series:*'),
    ];
    if (ownerId) tasks.push(invalidatePattern(cacheKey.listPaymentsAll(ownerId)));
    await Promise.all(tasks);
  });

  eventBus.on(Events.payment.Flagged, async () => {
    await Promise.all([
      invalidatePattern('pay:list:admin:*'),
      invalidate(cacheKey.adminStats(), cacheKey.adminAlerts(), cacheKey.adminPaySummary()),
    ]);
  });

  eventBus.on(Events.payment.Unflagged, async () => {
    await Promise.all([
      invalidatePattern('pay:list:admin:*'),
      invalidate(cacheKey.adminStats(), cacheKey.adminAlerts(), cacheKey.adminPaySummary()),
    ]);
  });

  // ─── Delivery ──────────────────────────────────────────────────────────────
  eventBus.on(Events.delivery.Created, async ({ userId, rideId }) => {
    await Promise.all([
      invalidate(cacheKey.myDeliveries(userId), cacheKey.rideDeliveries(rideId)),
      invalidatePattern('deliveries:avail:*'),
      invalidate(cacheKey.rideDetail(rideId)),
    ]);
  });

  eventBus.on(Events.delivery.StatusChanged, async ({ userId, rideId }) => {
    await invalidate(cacheKey.myDeliveries(userId), cacheKey.rideDeliveries(rideId));
  });

  eventBus.on(Events.delivery.Cancelled, async ({ userId, rideId }) => {
    await Promise.all([
      invalidate(
        cacheKey.myDeliveries(userId),
        cacheKey.rideDeliveries(rideId),
        cacheKey.rideDetail(rideId),
      ),
      invalidatePattern(cacheKey.listPaymentsAll(userId)),
      invalidatePattern('deliveries:avail:*'),
    ]);
  });

  // ─── Message ───────────────────────────────────────────────────────────────
  eventBus.on(Events.message.Sent, async ({ senderId, receiverId }) => {
    await Promise.all([
      invalidatePattern(cacheKey.listChatsAll(senderId)),
      invalidatePattern(cacheKey.listChatsAll(receiverId)),
    ]);
  });

  eventBus.on(Events.message.Read, async ({ readerId }) => {
    await invalidatePattern(cacheKey.listChatsAll(readerId));
  });

  eventBus.on(Events.message.Deleted, async ({ senderId, receiverId }) => {
    await Promise.all([
      invalidatePattern(cacheKey.listChatsAll(senderId)),
      invalidatePattern(cacheKey.listChatsAll(receiverId)),
    ]);
  });

  // ─── Review ────────────────────────────────────────────────────────────────
  eventBus.on(Events.review.Submitted, async ({ rideId, driverUserId, userId }) => {
    const tasks = [invalidate(cacheKey.reviewForRide(rideId, userId))];
    if (driverUserId) tasks.push(invalidate(cacheKey.driverProfile(driverUserId)));
    await Promise.all(tasks);
  });
}

export const cacheInvalidationProjection = { register };
