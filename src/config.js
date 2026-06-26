import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';

loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const env = process.env.NODE_ENV || 'development';
const devOtpCode = process.env.DEV_OTP_CODE || '123456';

export const config = {
  port: Number(process.env.PORT || 3000),
  env,
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET || '',
  appJwtSecret: process.env.APP_JWT_SECRET || process.env.SUPABASE_JWT_SECRET || required('APP_JWT_SECRET'),
  devOtpCode,
  adminImpersonationCode:
    process.env.ADMIN_IMPERSONATION_CODE ||
    (env === 'production' ? required('ADMIN_IMPERSONATION_CODE') : devOtpCode),
  databaseUrl: required('DATABASE_URL'),
  allowPrivilegedDatabaseUser: process.env.ALLOW_PRIVILEGED_DATABASE_USER === 'true',
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  redisSessionTtl: Number(process.env.REDIS_SESSION_TTL || 900),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 600),
  graphqlRateLimitMax: Number(process.env.GRAPHQL_RATE_LIMIT_MAX || 120),

  // PII at rest: 32-byte key (64 hex chars or base64) for AES-256-GCM field
  // encryption. Absent → fields are stored plaintext (dev convenience); see
  // src/lib/fieldCrypto.js and scripts/encrypt-pii.js.
  piiEncryptionKey: process.env.PII_ENCRYPTION_KEY || '',

  // OTP delivery. 'twilio' needs the three TWILIO_* vars; 'log' prints codes
  // to stdout (dev only); unset → codes are generated but not delivered.
  smsProvider: process.env.SMS_PROVIDER || '',
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
  },

  // Email delivery (password-change OTP + password-reset link). 'smtp' uses
  // the SMTP credentials configured for the Supabase project via nodemailer;
  // 'log' prints to stdout (dev only); unset → emails are generated but not
  // delivered (devOtp/devLink still surface in development).
  emailProvider: process.env.EMAIL_PROVIDER || (process.env.SMTP_HOST ? 'smtp' : ''),
  emailFrom: process.env.EMAIL_FROM || 'Louagi <no-reply@louagi.app>',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    // Implicit TLS (port 465). STARTTLS (587) is negotiated automatically.
    secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
  },

  // Deep link the password-reset email points at. The mobile app registers the
  // `louagi://` scheme and routes `reset-password` to the reset screen.
  passwordResetUrl: process.env.PASSWORD_RESET_URL || 'louagi://reset-password',
};

// Loud production misconfiguration warnings — none of these are fatal, but
// each one weakens a control the codebase otherwise provides.
if (env === 'production') {
  if (!config.smsProvider || config.smsProvider === 'log') {
    console.warn('[config] SMS_PROVIDER is not set — login OTPs cannot reach users');
  }
  if (!config.emailProvider || config.emailProvider === 'log') {
    console.warn('[config] EMAIL_PROVIDER/SMTP_* not set — password-change codes and reset links cannot reach users');
  }
  if (!config.piiEncryptionKey) {
    console.warn('[config] PII_ENCRYPTION_KEY is not set — driver ID/license/payout fields stored in plaintext');
  }
  if (config.corsOrigins.includes('*')) {
    console.warn('[config] CORS_ORIGINS is "*" — lock this down to the app origins');
  }
}
