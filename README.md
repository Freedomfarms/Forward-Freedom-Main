# Forward Freedom Financial

Forward Freedom Financial is a React + Vite financial planning workspace with budgeting, income,
accounts, transactions, and Plaid-backed sync capabilities.

## Current production foundation

The repo now includes the first production-readiness scaffolding for:

- Firebase Authentication (Google + email/password)
- Firebase Admin token verification on the server
- Postgres data modeling through Prisma
- Vercel-compatible API route foundations

Plaid can run against `development` during testing and should be switched to `production` only after
deployment secrets, legal review, and production Plaid approval are in place.

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
- `POST /api/me`
- `GET /api/workspace`
- `PUT /api/workspace`
- `GET /api/plaid/status`
- `POST /api/plaid/link-token/create`
- `POST /api/plaid/exchange-public-token`
- `GET /api/plaid/sync`
- `DELETE /api/plaid/user`

`/api/me` expects a Firebase bearer token in the `Authorization` header and will upsert the user
into Postgres when `DATABASE_URL` is configured. `POST /api/me` records legal consent, taking
`{ "legalConsent": { "version": "<LEGAL_CONSENT_VERSION>", "method": "email-signup" } }`; the
acceptance timestamp is stamped with the server clock, the latest version is stored on `User`
(`legalConsentAt`/`legalConsentVersion`), and every acceptance is appended to the `LegalConsentEvent`
audit trail. `GET /api/me` returns `legalConsentAt`/`legalConsentVersion` so the client can detect a
version bump and re-prompt.

### Server-side legal-consent enforcement

Sensitive routes require current legal consent server-side, not just the client checkbox:
`PUT /api/workspace`, `POST /api/plaid/link-token/create`, `POST /api/plaid/exchange-public-token`,
and the live-refresh (`?refresh=1`) path of `GET /api/plaid/sync`. When consent is missing or the
accepted version is older than the deployed `LEGAL_CONSENT_VERSION`, the route responds with
`403 { "requiresLegalConsent": true, "requiredVersion": "<current>" }` and the client routes the user
back into the consent flow. Enforcement fails open only when the consent columns do not exist yet
(un-migrated database), consistent with the schema-capability tolerance used elsewhere.

### Workspace save concurrency (optimistic control)

`PUT /api/workspace` accepts an optional `baseSnapshotUpdatedAt` — the server `updatedAt` of the
snapshot the client's state is based on (`null` when the client believes none exists). The write is
applied atomically with a conditional `updateMany` (or a unique-constrained `create` guarded against
`P2002`) so only a write based on the current version lands; a stale write receives
`409` with the winning snapshot in the body so the client can reconcile without losing its draft.

`/api/workspace` stores a user-scoped workspace snapshot in Postgres so the app can start moving
away from browser-only persistence while the deeper normalized data migration is still in progress.

> **Legacy API callers:** a `PUT /api/workspace` request that omits `baseSnapshotUpdatedAt` entirely
> falls back to an ordering guard on `lastClientUpdatedAt` — a write stamped older than the stored
> value is rejected with `409`, but two writers that both omit the marker degrade to last-write-wins.
> New/first-party clients always send `baseSnapshotUpdatedAt` (the first-party web app sends it on
> every save) and should continue to do so for full conflict protection.

The Plaid endpoints expect an authenticated Firebase bearer token and store Plaid item records in
Postgres with encrypted access-token persistence. Connected-account consent is collected in the
authenticated UI before opening Plaid Link, and workspace snapshots intentionally omit synced Plaid
accounts and transactions so financial data is reloaded from the server-backed Plaid sync path.

## Encryption key rotation (ops runbook)

All sensitive data at rest (Plaid access tokens, balances, transaction details, the workspace blob)
uses **envelope encryption with versioned Key-Encryption-Keys** (`server/security/envelope.js` +
`server/security/keyProvider.js`). Every stored ciphertext records the KEK version that wrapped its
data key, so **rotating keys never invalidates stored data and never forces users to re-link Plaid**
as long as the old key stays in the keyring until re-encryption completes.

To rotate the encryption key:

1. Generate a new 32-byte key: `openssl rand -base64 32`.
2. **Append** it to `FFF_ENCRYPTION_KEYS` with a new version — do not remove the old entry yet:
   `FFF_ENCRYPTION_KEYS="1:<old-key>,2:<new-key>"` and set `FFF_ENCRYPTION_ACTIVE_VERSION="2"`
   (if unset, the highest version becomes active automatically). Redeploy. New writes now use v2;
   existing v1 ciphertexts keep decrypting.
3. Re-encrypt existing rows under the new key: `node scripts/encrypt-backfill.mjs --rotate`
   (it re-wraps every stored ciphertext — accounts, transactions, Plaid access tokens, and
   workspace snapshots — under the active version and prints per-table counts).
4. Only after that rotate run completes without errors, remove the old entry from
   `FFF_ENCRYPTION_KEYS`.

**Never** remove or replace a key version that still has ciphertexts in the database — decryption of
those rows will fail and affected users would have to re-link their banks. Legacy deployments that
only set `PLAID_TOKEN_ENCRYPTION_KEY` get a derived KEK (version `pk1`) automatically; migrate them
to `FFF_ENCRYPTION_KEYS` using the same append-then-backfill procedure.
