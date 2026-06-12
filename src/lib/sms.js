// SMS delivery abstraction for OTP codes.
//
// Providers (SMS_PROVIDER env):
//   'twilio' — Twilio Messages API via the three TWILIO_* env vars.
//   'log'    — print to stdout. Dev/staging only; never use in production.
//   unset    — no delivery. issueOtp still works (devOtp covers development);
//              production logs an error per send so the gap is visible.
//
// Adding a provider (e.g. a Tunisian gateway): add a case to sendSms and the
// matching config block — callers depend only on sendSms(phone, body).

import { config } from '../config.js';

async function sendViaTwilio(phone, body) {
  const { accountSid, authToken, from } = config.twilio;
  if (!accountSid || !authToken || !from) {
    throw new Error('Twilio selected but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM are not all set');
  }
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: from, Body: body }),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Twilio responded ${res.status}: ${detail.slice(0, 200)}`);
  }
}

// Fire-and-log: callers should not fail a login because the SMS gateway
// hiccuped — the user can hit "resend". Returns true when handed off.
export async function sendSms(phone, body) {
  try {
    switch (config.smsProvider) {
      case 'twilio':
        await sendViaTwilio(phone, body);
        return true;
      case 'log':
        // eslint-disable-next-line no-console
        console.log(`[sms:log] to=${phone} body="${body}"`);
        return true;
      default:
        if (config.env === 'production') {
          // eslint-disable-next-line no-console
          console.error(`[sms] no SMS_PROVIDER configured — message to ${phone} NOT delivered`);
        }
        return false;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sms] delivery failed:', err.message);
    return false;
  }
}
