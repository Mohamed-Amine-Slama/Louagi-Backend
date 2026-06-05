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

## Local setup

1. Install Node 20+ and the Supabase CLI.
2. Create `server/.env` from this folder's `.env.example`.
3. Fill in `DATABASE_URL`, `APP_JWT_SECRET`, and optionally `DEV_OTP_CODE`.
4. Apply migrations and seed data from the repo root:

```bash
supabase db reset
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
