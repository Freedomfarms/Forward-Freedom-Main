# Forward Freedom Financial

Forward Freedom Financial is a React + Vite financial planning workspace with budgeting, income,
accounts, transactions, and Plaid-backed sync capabilities.

## Current production foundation

The repo now includes the first production-readiness scaffolding for:

- Firebase Authentication (Google + email/password)
- Firebase Admin token verification on the server
- Postgres data modeling through Prisma
- Vercel-compatible API route foundations

Plaid should remain in sandbox/development until the backend hardening work is complete.

## Local development

Install dependencies:

```bash
npm ci
```

Start the existing local client + Express prototype flow:

```bash
npm run dev
```

Build the frontend:

```bash
npm run build
```

Lint the repo:

```bash
npm run lint
```

## Environment variables

Copy `.env.example` to your local env file and fill in the required values.

### Firebase web config

Set these as Vite env vars for the browser:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_STORAGE_BUCKET` (optional)

### Firebase Admin

Provide either:

- `FIREBASE_ADMIN_PROJECT_ID`
- `FIREBASE_ADMIN_CLIENT_EMAIL`
- `FIREBASE_ADMIN_PRIVATE_KEY`

or:

- `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON`

### Database

- `DATABASE_URL`

### Plaid

- `PLAID_ENV`
- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_TOKEN_ENCRYPTION_KEY`
- `PLAID_WEBHOOK_URL` (later, once webhook handling is ready)

## Prisma

Validate the schema:

```bash
npm run prisma:validate
```

Generate the Prisma client:

```bash
npm run prisma:generate
```

Push the schema to a connected Postgres database:

```bash
npm run db:push
```

Open Prisma Studio:

```bash
npm run db:studio
```

## Vercel API foundations

The repo now includes starter Vercel-compatible routes:

- `GET /api/health`
- `GET /api/me`
- `GET /api/workspace`
- `PUT /api/workspace`
- `GET /api/plaid/status`
- `POST /api/plaid/link-token/create`
- `POST /api/plaid/exchange-public-token`
- `GET /api/plaid/sync`
- `DELETE /api/plaid/user`

`/api/me` expects a Firebase bearer token in the `Authorization` header and will upsert the user
into Postgres when `DATABASE_URL` is configured.

`/api/workspace` stores a user-scoped workspace snapshot in Postgres so the app can start moving
away from browser-only persistence while the deeper normalized data migration is still in progress.

The Plaid endpoints now expect an authenticated Firebase bearer token and store Plaid item records in
Postgres with encrypted access-token persistence. Keep Plaid on sandbox/development until the rest
of the server-backed data migration is complete.
