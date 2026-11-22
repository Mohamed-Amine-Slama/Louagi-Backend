# louagi-server

GraphQL backend for the Louagi mobile app. It speaks the contract documented in
[`../docs/backend-contract.md`](../docs/backend-contract.md) and persists to
Supabase Postgres.

MVP auth is backend-owned: demo users/passwords come from
`../supabase/seed.sql`, tokens are minted by this server, and OTP verification
uses `DEV_OTP_CODE` until SMTP/SMS is wired.

## Architecture

```text
Expo RN client
  -> POST /graphql + Bearer token
  -> louagi-server (Express + postgres-js)
  -> Supabase Postgres
```

- The client signs in through `POST /graphql` and stores the backend-issued
  access token.
- Protected GraphQL operations verify that token, load the role from
  `public.users`, and run server-side business logic.
- RLS policies remain as a backstop, but the MVP client uses the backend for
  data access.

### Production

```text
mobile app      -> Cloudflare NGFW (WAF + rate limit) -> edge -> Tunnel -> louagi-server
admin dashboard -> Cloudflare NGFW (WAF + rate limit) -> edge -> API gateway Worker -> Tunnel -> louagi-server
```

- The server runs from `../infra/docker-compose.yml` (`api` + `redis` +
  `cloudflared`), with no published ports. Cloudflare is provisioned by
  Terraform in `../infra/`.
- `trust proxy 1` takes the client IP from the last `X-Forwarded-For` hop,
  which Cloudflare appends. `X-Forwarded-Proto: https` satisfies the
  production HTTPS check.
- With `GATEWAY_SECRET` set, `actorFromRequest` (`src/middleware/auth.js`)
  drops admin actors whose request lacks the gateway's `x-louagi-gateway`
  stamp (`src/lib/gateway.js`).

## Data protection

- Passwords: bcrypt in SQL (`extensions.crypt(…, gen_salt('bf'))`). OTPs and
  reset tokens are stored only as SHA-256 hashes.
- PII and user-authored text are AES-256-GCM encrypted before every write
  (`src/lib/fieldCrypto.js`: `encryptField` / `encryptJson`) and decrypted
  centrally on read (`transform` hook in `src/db.js`). Phone/email lookups use
  the `users.phone_hash` / `email_hash` HMAC blind indexes (`blindIndex`).
- New write paths must wrap personal or free-text values in `encryptField` /
  `encryptJson`. Bind JSONB as raw values: postgres-js JSON-serializes
  `::jsonb` params itself.
- `DATABASE_URL` uses the `louagi_backend` role (bypasses RLS like
  `service_role`, but owns no tables and can't run DDL), via the transaction
  pooler on port 6543.

## Local setup

1. Install Node 20+ and the Supabase CLI.
2. Create `server/.env` from this folder's `.env.example`.
3. Fill in `DATABASE_URL`, `APP_JWT_SECRET`, `PII_ENCRYPTION_KEY`
   (`openssl rand -hex 32`; back it up — encrypted data is unrecoverable
   without it), and optionally `DEV_OTP_CODE`.
4. Apply migrations and seed data from the repo root, then encrypt the seeded
   rows and fill the phone/email login hashes (seeded users cannot log in
   until this runs):

```bash
supabase db reset
cd server && node scripts/encrypt-pii.js
```

5. Run the backend:

```bash
cd server
npm install
npm run dev
```

The server listens on `http://localhost:3000`.

## Implemented

- `GET /health` - DB ping
- `GET /me` - echo `{ id, role }` extracted from the Bearer token
- `POST /graphql` - auth, rides, reservations, payments, drivers, users, admin

The GraphQL operation names map to the existing client API helper names.
