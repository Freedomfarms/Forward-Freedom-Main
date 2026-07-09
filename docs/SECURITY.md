# Forward Freedom — Security & Privacy Architecture

This document describes how Forward Freedom (FFF) handles user financial data.
The guiding principle is **privacy over database convenience**: sensitive
financial data is encrypted at rest with per-record envelope encryption, and no
employee, developer, database administrator, or owner can casually read it.

## 1. What FFF never has access to

- **Bank usernames, passwords, or login credentials.** These are entered only
  inside **Plaid Link** (Plaid's hosted, tokenized flow). They never touch FFF
  servers, logs, or database.
- FFF only ever receives a short-lived Plaid `public_token`, which the server
  immediately exchanges for a long-lived `access_token`. The `access_token` is
  the only bank secret FFF holds, and it is encrypted at rest (see §4).

## 2. Data minimization

FFF requests only the Plaid products needed to build dashboards, charts,
budgets, and insights:

- Products: `transactions` (required), `liabilities` (optional).
- Investments/holdings and account/routing numbers are **not** requested.
- Account masks (last 4 digits) and raw Plaid payloads are **not** stored — the
  `Account.plaidMask` and `Transaction.raw` columns were removed entirely.

## 3. Data flow (single source of truth)

```
                 ┌────────────────────┐
   Bank login →  │   Plaid Link (UI)  │   credentials stay with Plaid
                 └─────────┬──────────┘
                           │ public_token
                           ▼
        POST /api/plaid/exchange-public-token  (Firebase-authenticated, email-verified)
                           │ access_token (encrypted immediately)
                           ▼
                 ┌────────────────────────────────┐
                 │  Normalized tables (Postgres)   │  ← the ONLY source of truth
                 │  PlaidItem / Account / Transaction  for Plaid financial data
                 │  sensitive fields = ciphertext  │
                 └─────────┬──────────────────────┘
                           │ decrypt-on-read, scoped to the owner (userId)
                           ▼
        GET /api/plaid/sync            → decrypted JSON to the authenticated owner
          • default: read stored data (no Plaid call, safe every login)
          • ?refresh=1: live pull from Plaid (Refresh button / webhook)
                           ▼
                     Browser (owner only, over HTTPS)
```

Plaid-derived accounts, balances, and transactions are **never** duplicated into
`WorkspaceSnapshot`. The workspace snapshot only stores manual (non-Plaid) data
and preferences, and that blob is itself encrypted at rest (§4). The client
reloads Plaid data from the encrypted normalized tables via `/api/plaid/sync`.

## 4. Encryption at rest — envelope encryption

Implemented in `server/security/`:

- `keyProvider.js` — resolves versioned **Key-Encryption-Keys (KEKs)**. Portable
  today (keys from env), shaped like a KMS so it can move to AWS/GCP KMS/Vault
  later without changing stored ciphertext.
- `envelope.js` — for each value: generates a random **Data-Encryption-Key
  (DEK)**, encrypts the value with the DEK (AES-256-GCM), then wraps the DEK with
  the active KEK. Stored format records the KEK version:
  `{ v, kek, wrap:{iv,tag,ct}, data:{iv,tag,ct} }`.
- `encryption.js` — backwards-compatible facade (`encryptSensitiveValue` /
  `decryptSensitiveValue`) used by the Plaid handlers.

### What is encrypted

| Location | Encrypted field(s) | Column |
| --- | --- | --- |
| `PlaidItem` | Plaid access token | `accessTokenCiphertext` |
| `Account` | balance | `balanceCiphertext` |
| `Account` | loan/liability metadata (interest rate, payment, category) | `metadataCiphertext` |
| `Transaction` | amount | `amountCiphertext` |
| `Transaction` | merchant name | `merchantCiphertext` |
| `Transaction` | category (spending behavior) | `categoryCiphertext` |
| `WorkspaceSnapshot` | manual financial blob | `stateCiphertext` |

### What stays queryable (plaintext, non-financial)

Dates (`postedAt`, `authorizedAt`), IDs (`plaidTransactionId`, `plaidAccountId`,
`itemId`), user/workspace relationships (`userId`, `workspaceUserId`), account
`name`/`type`/`institution`, and `status`/`syncSource`. None reveal balances,
amounts, merchants, or account numbers, and they are required for lookups,
ownership scoping, ordering by date, and duplicate-institution detection.

Because no calculation is done in SQL over financial columns (all budgeting,
charting, net-worth, reserve, and forecasting math happens in the client from
decrypted values delivered over HTTPS to the owner), encrypting these columns
does **not** affect the Budget Command Center, charts, or forecasting.

### Key rotation (no reconnection required)

Each ciphertext records the KEK version that wrapped its DEK, so old data keeps
decrypting after the active key changes. To rotate:

1. Add a new key version to `FFF_ENCRYPTION_KEYS`, set
   `FFF_ENCRYPTION_ACTIVE_VERSION` to it (keep the old version present).
2. Run `node scripts/encrypt-backfill.mjs --rotate` to re-wrap existing rows.

Users never need to reconnect Plaid.

### Migrating existing plaintext (online, no data loss)

1. Deploy this code (new writes are encrypted; reads prefer ciphertext and fall
   back to any remaining plaintext).
2. Run `node scripts/encrypt-backfill.mjs` to encrypt legacy rows and NULL the
   plaintext columns.
3. After backfill, run the follow-up migration that drops the now-empty
   plaintext columns (`balance`, `amount`, `merchant`, `category`, `metadata`,
   `state`).

## 5. Logging & error tracking

- `server/security/redaction.js` scrubs every server log line: access tokens,
  ciphertext, balances, amounts, merchants, emails, bearer tokens, and JWTs are
  replaced with `[REDACTED]` (by key name and by value pattern, recursively).
- Internal errors are logged as a redacted summary, never the raw error object
  (axios/Plaid errors carry secrets on `error.config` and financial data on
  `error.response.data`).
- Plaid event logs contain only non-financial diagnostics (item/institution/
  request IDs and counts). Per-account identifier lists were removed.
- The webhook is verified against the exact signed raw body; verification fails
  closed.

## 6. No casual access for staff / DBAs / admins

- A DBA browsing Postgres (including via `npm run db:studio` / Prisma Studio)
  sees only ciphertext for every financial field — no balances, amounts,
  merchants, tokens, or the workspace blob in plaintext.
- There is **no** admin API or tool that returns another user's financial data.
- Every read/write/delete is scoped to the authenticated Firebase `uid`; there
  is no cross-user query path.
- **Operational recommendation:** disable Prisma Studio and direct DB consoles
  in production, restrict Postgres to least-privilege roles, and keep encryption
  keys in a secrets manager (or a managed KMS) separate from the database.

## 7. Cross-user isolation

Every Plaid handler filters by `userId` and verifies ownership before returning
or mutating data. Attempting to read, sync, delete, or update-link another
user's item returns 404/409 and touches nothing. This is covered by
`test/plaid-user-isolation.test.js`, which runs the real handlers against a real
Postgres database and asserts one user can never reach another's data, and that
financial columns are ciphertext at rest.

## 8. Access controls summary

- Bank linking requires an authenticated **and email-verified** Firebase user.
- All Plaid/workspace routes require a valid Firebase ID token.
- Rate limits apply per route (`server/http/rateLimit.js`).
- Security headers + CSP are applied to every response.
