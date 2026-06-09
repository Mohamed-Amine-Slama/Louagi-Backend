// Event-name catalog. Importing constants from here prevents typo-driven
// silent failures (a misspelled emit() name has no subscribers and looks fine).
//
// Convention: <aggregate>.<past-tense-verb>.
//
// Payload shapes are documented inline. They're soft contracts; we don't run a
// schema validator at emit time because the perf cost outweighs the safety in
// a single-binary deployment. If we ever federate handlers across processes,
// reach for zod here.

export const Events = {
  // ─── User / auth ─────────────────────────────────────────────────────────-
  user: {
    Registered:          'user.registered',           // { userId, role }
    LoggedIn:            'user.logged_in',            // { userId, method: 'password' | 'biometric' }
    LoggedOut:           'user.logged_out',           // { userId }
    BiometricEnrolled:   'user.biometric_enrolled',   // { userId }
    ProfileUpdated:      'user.profile_updated',      // { userId, fields }
    NotificationsUpdated:'user.notifications_updated',// { userId }
    Suspended:           'user.suspended',            // { userId, byActorId }
    Reactivated:         'user.reactivated',          // { userId, byActorId }
    SelfDeleted:         'user.self_deleted',         // { userId }
    Deleted:             'user.deleted',              // { userId } (GDPR full)
  },

  // ─── Driver ──────────────────────────────────────────────────────────────-
  driver: {
    ApplicationSubmitted:'driver.application_submitted', // { userId, driverId }
    Verified:            'driver.verified',              // { driverId, userId }
    Rejected:            'driver.rejected',              // { driverId, userId, reason }
    VehicleUpdated:      'driver.vehicle_updated',       // { userId }
    PayoutUpdated:       'driver.payout_updated',        // { userId }
    TwoFAChanged:        'driver.two_fa_changed',        // { userId, enabled }
    TermsAccepted:       'driver.terms_accepted',        // { userId, version }
    PrivacyAccepted:     'driver.privacy_accepted',      // { userId }
    DeletionRequested:   'driver.deletion_requested',    // { userId, reason }
    SessionRevoked:      'driver.session_revoked',       // { userId, sessionId }
  },

  // ─── Ride ────────────────────────────────────────────────────────────────-
  ride: {
    Created:       'ride.created',         // { rideId, driverUserId }
    StatusChanged: 'ride.status_changed',  // { rideId, driverUserId, status }
    Cancelled:     'ride.cancelled',       // { rideId, driverUserId, affectedUserIds }
  },

  // ─── Reservation ─────────────────────────────────────────────────────────-
  reservation: {
    Created:   'reservation.created',     // { reservationId, userId, rideId }
    Cancelled: 'reservation.cancelled',   // { reservationId, userId, rideId }
  },

  // ─── Payment ─────────────────────────────────────────────────────────────-
  payment: {
    Refunded: 'payment.refunded',  // { paymentId, ownerId, amount, partial }
    Flagged:  'payment.flagged',   // { paymentId, ownerId, reason }
  },

  // ─── Delivery ────────────────────────────────────────────────────────────-
  delivery: {
    Created:       'delivery.created',         // { deliveryId, userId, rideId, driverUserId }
    StatusChanged: 'delivery.status_changed',  // { deliveryId, userId, rideId, status }
    Cancelled:     'delivery.cancelled',       // { deliveryId, userId, rideId }
  },

  // ─── Message ─────────────────────────────────────────────────────────────-
  message: {
    Sent:    'message.sent',     // { messageId, senderId, receiverId }
    Read:    'message.read',     // { readerId, partnerId }
    Deleted: 'message.deleted',  // { messageId, senderId, receiverId, forEveryone }
  },

  // ─── Review ──────────────────────────────────────────────────────────────-
  review: {
    Submitted: 'review.submitted', // { rideId, driverId, driverUserId, userId }
  },

  // ─── Admin ───────────────────────────────────────────────────────────────-
  admin: {
    Impersonated:  'admin.impersonated', // { adminId, targetUserId }
  },
};

// Flat list for introspection and metrics dashboards.
export const ALL_EVENTS = Object.values(Events).flatMap((domain) => Object.values(domain));
