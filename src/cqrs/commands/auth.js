// Auth commands — write-side of /auth.
// Each handler returns the same shape the legacy resolver returned so the
// mobile client sees no behavioral change.

import { sql } from '../../db.js';
import {
  delSession,
  getSession,
  setSession,
} from '../../cache/redis.js';
import {
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  signBiometricTicket,
  signRefreshToken,
  verifyToken,
} from '../../auth/tokens.js';
import {
  normalizeTunisianPhone,
  sanitize,
  validateEmail,
  validateName,
  validateOtp,
  validatePassword,
  validateTunisianPhone,
} from '../../utils/validation.js';
import { appendAudit, loadUserSession } from '../../graphql/helpers.js';
import { actorFromRequest } from '../../middleware/auth.js';
import { authAttemptsExceeded, recordAuthFailure } from '../../middleware/rateLimit.js';
import {
  consumeOtp,
  issueOtp,
  canIssueResetToken,
  issueResetToken,
  consumeResetToken,
} from '../../auth/otp.js';
import { sendEmail, passwordResetEmail } from '../../lib/email.js';
import { config } from '../../config.js';
import { eventBus } from '../event-bus.js';
import { Events } from '../events.js';

const TOO_MANY_ATTEMPTS = { ok: false, error: 'Too many attempts. Try again later.' };

async function StartLogin({ phone, password }, ctx) {
  const phoneErr = validateTunisianPhone(phone);
  if (phoneErr) return { ok: false, error: phoneErr };

  const normalizedPhone = normalizeTunisianPhone(phone);
  // Per-phone brute-force guard: failed attempts are counted below; once the
  // window is exhausted, reject before touching credentials at all.
  const attemptKey = `login:${normalizedPhone}`;
  if (await authAttemptsExceeded(attemptKey)) return TOO_MANY_ATTEMPTS;

  const rows = await sql`
    select
      u.id,
      u.role,
      u.full_name,
      u.is_active,
      u.password_hash = extensions.crypt(${password || ''}, u.password_hash) as password_ok
    from public.users u
    where u.phone_number = ${normalizedPhone}
    limit 1
  `;
  const user = rows[0];
  if (!user?.is_active || !user.password_ok) {
    const reason = !user ? 'no_account' : !user.is_active ? 'inactive' : 'bad_password';
    await Promise.all([
      recordAuthFailure(attemptKey),
      // Audited so the admin control center can surface failed-login volume,
      // lockouts, and brute-force patterns. Never store the password.
      appendAudit({
        actor: user ? { id: user.id, role: user.role } : null,
        action: 'login.failed',
        targetEntity: 'user',
        targetId: user?.id ?? null,
        metadata: { phone: normalizedPhone, reason },
        ip: ctx.ip,
      }),
    ]);
    return { ok: false, error: 'Phone or password is incorrect' };
  }

  const [issued] = await Promise.all([
    issueOtp(user.id, 'login', { phone: normalizedPhone }),
    appendAudit({
      actor: { id: user.id, role: user.role },
      action: 'login.credentials_ok',
      targetEntity: 'user',
      targetId: user.id,
      ip: ctx.ip,
    }),
  ]);

  return {
    ok: true,
    next: 'otp',
    userId: user.id,
    devOtp: issued.devOtp,
  };
}

async function VerifyOtp({ userId, purpose, otp }, ctx) {
  const otpErr = validateOtp(otp);
  if (otpErr) return { ok: false, error: otpErr };

  // The OTP is per-user, purpose-bound, single-use, and attempt-limited —
  // the store enforces all four. No static comparison.
  const verdict = await consumeOtp(userId, purpose === 'register' ? 'register' : 'login', otp);
  if (!verdict.ok) return verdict;

  const session = await loadUserSession(userId, { ctx });
  if (!session) return { ok: false, error: 'OTP failed' };

  await appendAudit({
    actor: { id: session.user.id, role: session.user.role },
    action: purpose === 'register' ? 'register.verified' : 'login.success',
    targetEntity: 'user',
    targetId: session.user.id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.user.LoggedIn, { userId: session.user.id, method: 'password' }, ctx);

  return { ok: true, ...session };
}

async function Register({ fullName, phone, email, password, role }, ctx) {
  const errors = {};
  const nameErr = validateName(fullName);
  if (nameErr) errors.fullName = nameErr;
  const phoneErr = validateTunisianPhone(phone);
  if (phoneErr) errors.phone = phoneErr;
  const emailErr = validateEmail(email);
  if (emailErr) errors.email = emailErr;
  const passwordErr = validatePassword(password);
  if (passwordErr) errors.password = passwordErr;
  if (!['passenger', 'driver'].includes(role)) errors.role = 'Choose passenger or driver';
  if (Object.keys(errors).length) return { ok: false, errors };

  const normalizedPhone = normalizeTunisianPhone(phone);
  const existing = await sql`
    select phone_number, email
    from public.users
    where phone_number = ${normalizedPhone}
       or lower(email) = lower(${email})
    limit 1
  `;
  if (existing.length) {
    const row = existing[0];
    return {
      ok: false,
      errors: {
        ...(row.phone_number === normalizedPhone ? { phone: 'Phone already registered' } : {}),
        ...(row.email?.toLowerCase() === email.toLowerCase() ? { email: 'Email already in use' } : {}),
      },
    };
  }

  const rows = await sql`
    insert into public.users (
      full_name,
      phone_number,
      email,
      role,
      password_hash,
      is_active
    ) values (
      ${sanitize(fullName)},
      ${normalizedPhone},
      ${email.toLowerCase()},
      ${role}::user_role,
      extensions.crypt(${password}, extensions.gen_salt('bf')),
      true
    )
    returning id, role
  `;
  const user = rows[0];
  const [issued] = await Promise.all([
    issueOtp(user.id, 'register', { phone: normalizedPhone }),
    appendAudit({
      actor: { id: user.id, role: user.role },
      action: 'register.created',
      targetEntity: 'user',
      targetId: user.id,
      ip: ctx.ip,
    }),
  ]);
  eventBus.emit(Events.user.Registered, { userId: user.id, role: user.role }, ctx);

  return {
    ok: true,
    userId: user.id,
    devOtp: issued.devOtp,
  };
}

async function Refresh({ refreshToken }, ctx) {
  const rotated = await rotateRefreshToken(refreshToken);
  if (!rotated) return { ok: false, error: 'Invalid refresh token' };
  const session = await loadUserSession(rotated.claims.sub, { includeRefreshToken: false, ctx });
  if (!session) return { ok: false, error: 'Invalid refresh token' };
  return {
    ok: true,
    accessToken: session.accessToken,
    refreshToken: rotated.refreshToken,
  };
}

async function Logout({ refreshToken }, ctx) {
  await revokeRefreshToken(refreshToken);
  // ctx.actor may be undefined here because Logout is currently called by the
  // client *before* the token is invalidated; resolve actor from the request
  // instead of relying on auth middleware (we mark this command public).
  const actor = await actorFromRequest(ctx.req);
  if (actor) {
    await delSession(actor.id);
    eventBus.emit(Events.user.LoggedOut, { userId: actor.id }, ctx);
  }
  return { ok: true };
}

async function EnrollBiometric({ userId }, ctx) {
  const actor = ctx.actor;
  if (actor.id !== userId && actor.role !== 'admin') return { ok: false, error: 'Forbidden' };
  const ticket = signBiometricTicket({
    sub: actor.id,
    role: actor.role,
    name: actor.name,
    driverStatus: actor.driverStatus,
  });
  await appendAudit({
    actor,
    action: 'biometric.enrolled',
    targetEntity: 'user',
    targetId: actor.id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.user.BiometricEnrolled, { userId: actor.id }, ctx);
  return { ok: true, ticket };
}

async function BiometricLogin({ ticket }, ctx) {
  const claims = verifyToken(ticket);
  if (!claims || claims.kind !== 'biometric') {
    return { ok: false, error: 'Biometric credential is no longer valid. Sign in with your phone and password.' };
  }

  const cached = await getSession(claims.sub);
  let session;
  if (cached) {
    const sessionClaims = {
      sub: cached.id,
      role: cached.role,
      name: cached.name,
      driverStatus: cached.driverStatus,
    };
    session = {
      accessToken: signAccessToken(sessionClaims),
      refreshToken: await signRefreshToken(sessionClaims),
      user: { id: cached.id, name: cached.name, role: cached.role, driverStatus: cached.driverStatus },
    };
  } else {
    session = await loadUserSession(claims.sub, { ctx });
    if (session) {
      await setSession(claims.sub, {
        id: session.user.id,
        role: session.user.role,
        name: session.user.name,
        driverStatus: session.user.driverStatus,
      });
    }
  }

  if (!session) return { ok: false, error: 'Account unavailable' };
  const nextTicket = signBiometricTicket({
    sub: session.user.id,
    role: session.user.role,
    name: session.user.name,
    driverStatus: session.user.driverStatus,
  });
  await appendAudit({
    actor: { id: session.user.id, role: session.user.role },
    action: 'login.biometric',
    targetEntity: 'user',
    targetId: session.user.id,
    ip: ctx.ip,
  });
  eventBus.emit(Events.user.LoggedIn, { userId: session.user.id, method: 'biometric' }, ctx);

  return { ok: true, ...session, ticket: nextTicket };
}

// ─── Password-change flow (knows current password) ─────────────────────────
// Profile → "Change password". The user proves they know the current password
// FIRST; only then do we email a 6-digit code to the address on file. Gating
// the code behind the password check means we never mail a code to someone who
// can't already authenticate.

async function StartPasswordChange({ currentPassword }, ctx) {
  const actor = ctx.actor;
  const rows = await sql`
    select email,
           password_hash = extensions.crypt(${currentPassword || ''}, password_hash) as password_ok
    from public.users
    where id = ${actor.id}::uuid
    limit 1
  `;
  if (!rows[0]?.password_ok) {
    return { ok: false, errors: { currentPassword: 'Current password incorrect' } };
  }
  const [issued] = await Promise.all([
    issueOtp(actor.id, 'password', { email: rows[0].email }),
    appendAudit({
      actor,
      action: 'password.otp_requested',
      targetEntity: 'user',
      targetId: actor.id,
      ip: ctx.ip,
    }),
  ]);
  return { ok: true, devOtp: issued.devOtp };
}

async function VerifyPasswordChangeOtp({ userId, otp }, ctx) {
  const actor = ctx.actor;
  if (actor.id !== userId) return { ok: false, error: 'Forbidden' };
  const otpErr = validateOtp(otp);
  if (otpErr) return { ok: false, error: otpErr };
  return consumeOtp(userId, 'password', otp);
}

// ─── Password-reset flow (forgot / wrong current password) ──────────────────
// Unauthenticated. The user enters an email; if it resolves to an account we
// email a single-use deep link. The response is identical whether or not the
// email exists, so it never confirms an account (no user enumeration).

async function RequestPasswordReset({ email }, ctx) {
  const generic = { ok: true };
  const emailErr = validateEmail(email);
  if (emailErr) return generic;

  const rows = await sql`
    select id from public.users
    where lower(email) = lower(${email}) and is_active = true
    limit 1
  `;
  const user = rows[0];
  if (user && (await canIssueResetToken(user.id))) {
    const token = await issueResetToken(user.id);
    const link = `${config.passwordResetUrl}?token=${encodeURIComponent(token)}`;
    await Promise.all([
      sendEmail({ to: email, ...passwordResetEmail(link) }),
      appendAudit({
        actor: { id: user.id, role: null },
        action: 'password.reset_requested',
        targetEntity: 'user',
        targetId: user.id,
        ip: ctx.ip,
      }),
    ]);
    // Surface the link in development only so the flow is testable end-to-end.
    if (config.env !== 'production') return { ok: true, devLink: link };
  }
  return generic;
}

async function ResetPasswordWithToken({ token, newPassword }, ctx) {
  const passwordErr = validatePassword(newPassword);
  if (passwordErr) return { ok: false, errors: { newPassword: passwordErr } };

  const userId = await consumeResetToken(token);
  if (!userId) return { ok: false, error: 'This reset link is invalid or has expired' };

  await sql`
    update public.users
    set password_hash = extensions.crypt(${newPassword}, extensions.gen_salt('bf'))
    where id = ${userId}::uuid
  `;
  await appendAudit({
    actor: { id: userId, role: null },
    action: 'password.reset_completed',
    targetEntity: 'user',
    targetId: userId,
    ip: ctx.ip,
  });
  eventBus.emit(Events.user.ProfileUpdated, { userId, fields: { password: true } }, ctx);
  return { ok: true };
}

export const commands = {
  StartLogin,
  VerifyOtp,
  Register,
  Refresh,
  Logout,
  EnrollBiometric,
  BiometricLogin,
  StartPasswordChange,
  VerifyPasswordChangeOtp,
  RequestPasswordReset,
  ResetPasswordWithToken,
};

// All auth commands are public — they take credentials, not a Bearer token.
// EnrollBiometric and the password-CHANGE commands are the exceptions: they act
// on ctx.actor, so they require a Bearer token. The password-RESET commands are
// for logged-out users (the token in the link is the credential), so public.
export const meta = {
  StartLogin:             { public: true },
  VerifyOtp:              { public: true },
  Register:               { public: true },
  Refresh:                { public: true },
  Logout:                 { public: true },
  BiometricLogin:         { public: true },
  EnrollBiometric:        {},
  StartPasswordChange:    {},
  VerifyPasswordChangeOtp: {},
  RequestPasswordReset:   { public: true },
  ResetPasswordWithToken: { public: true },
};
