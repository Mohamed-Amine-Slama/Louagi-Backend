// Email delivery abstraction — password-change OTP codes and password-reset
// links. Mirrors lib/sms.js.
//
// Providers (EMAIL_PROVIDER env, or 'smtp' implied when SMTP_HOST is set):
//   'smtp' — nodemailer over the SMTP credentials configured for the Supabase
//            project (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS). We send
//            our own templated content; Supabase Auth is not involved.
//   'log'  — print to stdout. Dev/staging only; never use in production.
//   unset  — no delivery. Callers still work (devOtp/devLink cover development);
//            production logs an error per send so the gap is visible.
//
// nodemailer is imported lazily so the dependency is only required when SMTP is
// actually selected — dev/log environments run without it installed.

import { config } from '../config.js';

let transportPromise = null;

async function getTransport() {
  if (!transportPromise) {
    transportPromise = (async () => {
      const { host, port, user, pass, secure } = config.smtp;
      if (!host) throw new Error('SMTP selected but SMTP_HOST is not set');
      const { default: nodemailer } = await import('nodemailer');
      return nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user ? { user, pass } : undefined,
      });
    })().catch((err) => {
      // Reset so a later send can retry once the dependency/config is fixed.
      transportPromise = null;
      throw err;
    });
  }
  return transportPromise;
}

async function sendViaSmtp({ to, subject, html, text }) {
  const transport = await getTransport();
  await transport.sendMail({ from: config.emailFrom, to, subject, html, text });
}

// Fire-and-log: callers must not fail a flow because the mail gateway hiccuped
// (the user can request another code/link). Returns true when handed off.
export async function sendEmail({ to, subject, html, text }) {
  try {
    switch (config.emailProvider) {
      case 'smtp':
        await sendViaSmtp({ to, subject, html, text });
        return true;
      case 'log':
        // eslint-disable-next-line no-console
        console.log(`[email:log] to=${to} subject="${subject}" text="${text || ''}"`);
        return true;
      default:
        if (config.env === 'production') {
          // eslint-disable-next-line no-console
          console.error(`[email] no EMAIL_PROVIDER configured — message to ${to} NOT delivered`);
        }
        return false;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[email] delivery failed:', err.message);
    return false;
  }
}

// ─── Templates ──────────────────────────────────────────────────────────────

export function passwordOtpEmail(code) {
  return {
    subject: 'Louagi — your password-change code',
    text: `Your Louagi password-change code is ${code}. It is valid for 5 minutes. If you didn't request this, ignore this email.`,
    html: `<p>Your Louagi password-change code is <strong style="font-size:18px;letter-spacing:2px">${code}</strong>.</p>`
      + `<p>It is valid for 5 minutes. If you didn't request this, you can safely ignore this email.</p>`,
  };
}

export function passwordResetEmail(link) {
  return {
    subject: 'Louagi — reset your password',
    text: `Reset your Louagi password by opening this link: ${link}\n\nThe link expires in 30 minutes. If you didn't request this, ignore this email.`,
    html: `<p>Tap the button below to reset your Louagi password.</p>`
      + `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#C8102E;color:#fff;border-radius:8px;text-decoration:none">Reset password</a></p>`
      + `<p>Or open this link: <br><a href="${link}">${link}</a></p>`
      + `<p>The link expires in 30 minutes. If you didn't request this, you can safely ignore this email.</p>`,
  };
}
