# Forward Freedom — Security & Privacy Architecture

This document describes how Forward Freedom (FFF) handles user financial data.
The guiding principle is **privacy over database convenience**: sensitive
financial data is encrypted at rest with per-record envelope encryption, and no
employee, developer, database administrator, or owner can casually read it.

It covers both the financial workspace (Plaid, encryption, §§1–8) and the
**Freedom OS agent platform** (§§9–14): the per-account CEO Agent and its
read-only sub-agents, Postgres row-level security, agent audit logging, the
living profile, and LLM data minimization. Operational details (env vars,
cron, admin setup) live in `docs/FREEDOM_OS.md`.

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

1. **Apply the database migration** with `npm run db:migrate`
   (`prisma migrate deploy`). This is required before deploying the code — the
   generated Prisma client references the new ciphertext columns, so an
   un-migrated database causes every workspace/Plaid read and write to fail.
2. Deploy this code (new writes are encrypted; reads prefer ciphertext and fall
   back to any remaining plaintext).
3. Run `node scripts/encrypt-backfill.mjs` to encrypt legacy rows and NULL the
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

Isolation is enforced at two independent layers: **Postgres row-level
security** (the database itself refuses to return or accept another user's
rows — see §10) **plus app-level scoping** (every handler filters by `userId`
and verifies ownership before returning or mutating data). Attempting to read,
sync, delete, or update-link another user's item returns 404/409 and touches
nothing; the same scoping applies to every agent-platform route.

Test coverage:

- `test/plaid-user-isolation.test.js` runs the real Plaid handlers against a
  real Postgres database and asserts one user can never reach another's data,
  and that financial columns are ciphertext at rest.
- `test/rls-isolation.test.js` proves the database-level guarantees against a
  real Postgres: two-user isolation, zero rows without a bound user context,
  `WITH CHECK` rejecting inserts for another user, and `FORCE` applying even
  to the table owner.
- `test/rls-policy-remediation.test.js` statically pins the exact per-table
  ENABLE/FORCE and single-policy inventory and rejects bypass, grant, or role
  mutations.
- `test/agent-chat-scoping.test.js` covers scoping inside the agent platform
  (a sub-agent chat may only see its own runs and messages).

The RLS design — roles, policies, and the narrowly-scoped service-role bypass
— is documented in §10 and `docs/RLS_ROLLOUT.md`.

## 8. Access controls summary

- Bank linking requires an authenticated **and email-verified** Firebase user.
- All Plaid/workspace routes require a valid Firebase ID token.
- Rate limits apply per route (`server/http/rateLimit.js`).
- Security headers + CSP are applied to every response.

## 9. Freedom OS agent platform

Freedom OS adds a per-account team of AI agents on top of the financial
workspace:

- **CEO Agent** — the per-account orchestrator (default name "CEO Agent",
  exactly one per user; `CeoAgentConfig`). It synthesizes a digest from
  sub-agent run summaries, hosts the main chat, and owns the living profile
  (§14). Personality is preset-driven (a fixed enum of server-side tone
  snippets) — there are no free-text system prompts, and avatars are preset
  keys, never uploaded or AI-generated images.
- **Sub-agents** (`AgentConfig`) — Finance, Research, and Reminders, all
  **read-only**. The runner's fail-closed gate (`server/agents/runner.js`)
  only executes agents whose permission level is `READ_ONLY` or `DRAFT_ONLY`;
  `ACTION_REQUIRED_APPROVAL` and `AUTONOMOUS` exist in the schema but are
  rejected until a later phase unlocks them. Any gate failure is recorded as a
  `SKIPPED` run in the audit log (§13).

**Agents never execute financial or third-party actions.** There is no code
path through which an agent can make transfers, trades, or payments, or
contact any third party. Allowed non-financial effects are:

- **Self-notification**: an in-app `Notification` row and, when email is
  enabled for that agent, an email sent via Resend exclusively to the user's
  own verified account address — the recipient is structurally hardcoded, with
  no parameter through which any other destination can be supplied
  (`server/agents/emailDelivery.js`, `server/agents/types/reminders.js`).
- **Task-scoped self-management** in a sub-agent's own chat: that agent may
  update its own schedule / instructions / definition of done / pause state /
  email toggle, or trigger its own manual run, via allowlisted server-side
  `taskAction` handling (`server/agents/chatActions.js`). It cannot edit other
  agents or CEO settings.

**Finance agent = observations only.** Its fixed system prompt limits it to
surfacing observations and patterns ("dining spend is 40% above your 3-month
average") and explicitly forbids prescriptive directives or investment
recommendations of any kind. It is **not** an investment adviser. §12 covers
what data it may see.

**Research agent** reads no user financial data at all — its topic comes from
the agent's own configuration — and its only tool is Anthropic's
provider-executed web search (read-only by construction; no code or network
access runs on our side).

## 10. Postgres row-level security (RLS)

On top of the app-level scoping (§7), every user-scoped table — including all
agent tables — has row-level security **enabled and forced**
(`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`; `FORCE` applies the
policies even to the table owner).

- Each request binds its user with a transaction-local
  `SELECT set_config('app.current_user_id', <uid>, true)` issued by
  `withUserContext(userId, ...)` (`server/db/prisma.js`). Transaction-local
  means it is safe behind Supabase's transaction-mode pooler.
- One `user_isolation` policy per table (`USING` + `WITH CHECK` on `"userId"`;
  `"id"` for `"User"`) means a query with **no** bound context returns zero
  rows and an insert for another user is rejected by the database itself — a
  forgotten `WHERE` clause can no longer leak data.
- A remediation migration performs full RLS state reconciliation: it restores
  enabled/forced flags, removes all policy drift, and recreates the sole
  intended policy on each user-scoped table.

Roles:

- The app connects as **`freedom_app`** (`DATABASE_URL`) — a non-bypass role
  fully subject to the policies.
- Migrations run as the table **owner** via `DIRECT_URL` (Prisma CLI only;
  owner credentials exist nowhere else in the runtime).
- **`freedom_service`** (`SERVICE_DATABASE_URL`) carries `BYPASSRLS` and is
  reachable only through `server/db/servicePrisma.js`. Its allowed call sites
  are exactly:
  1. the Plaid webhook resolving an incoming `item_id` to its owning user
     (Plaid sends no user token, so the owner is unknown until this lookup);
  2. the cron dispatcher enumerating due agents across users
     (`api/cron/agent-dispatch.js`) — the moment a due agent's owner is known,
     the run executes inside `withUserContext(userId, ...)`;
  3. admin usage/cost reporting (`api/admin/usage.js`, §13), gated on
     `User.isAdmin`.

  Every call site carries a comment justifying the bypass. Nothing else —
  handlers, agent runtime, UI-serving code — may import the service client.

Rollout order, role creation SQL, troubleshooting, and post-rollout
verification: `docs/RLS_ROLLOUT.md`. Covered by `test/rls-isolation.test.js`
and `test/rls-policy-remediation.test.js` (§7).

## 11. Agent data & encryption

Agent data follows the same envelope-encryption scheme as financial data (§4):
anything sensitive is ciphertext at rest, and only the non-financial metadata
needed for lookups, scheduling, and usage reporting stays queryable.

| Table | Encrypted | Plaintext (queryable) |
| --- | --- | --- |
| `CeoAgentConfig` | living profile (`profileCiphertext`), cached digest (`lastDigestCiphertext`) | name, personality preset, avatar key, timestamps |
| `AgentRun` | full run output (`outputCiphertext`) | `summary` (aggregates only — never merchant names or account identifiers), `status`, token counts, estimated cost, `dataAccessed` JSON |
| `AgentChatMessage` | message content (`contentCiphertext`) | role, timestamps, foreign keys |

`AgentRun.summary` is the one deliberately plaintext output: a short
human-readable line the CEO digest consumes cheaply. Every agent's system
prompt forbids merchant names, account names/numbers, and institution names in
its output, and the Finance agent structurally never sees them in the first
place (§12).

## 12. LLM data minimization

- **Finance agent aggregates only.** All aggregation happens server-side; only
  category/amount/date (month) aggregates and account-**type** balance totals
  are ever sent to Anthropic — never merchant names, account names/IDs, or
  institution names. Those columns are never even `SELECT`ed by the agent
  (`server/agents/types/finance.js`), so they structurally cannot reach a
  prompt, a run summary, or a digest. Asserted by
  `test/agent-finance-aggregates.test.js` against the exact prompt payload.
- **User content is data, not instructions.** System prompts are fixed
  server-side templates. Everything user-derived — the living profile, agent
  instructions, definition of done, chat messages, prior run outputs — is
  injected only through delimited, explicitly-labeled data sections inside the
  user message (`server/agents/prompts.js`); no code path concatenates user
  text into a system prompt, and delimiter look-alikes in user text are
  neutralized.
- **Platform key only, no BYOK.** Every model call goes through a single
  chokepoint (`server/agents/llm.js`) using the platform `ANTHROPIC_API_KEY`.
  Users never supply their own key and no per-user key is stored.

## 13. Audit & admin

Every agent run — including runs blocked by the fail-closed gate — is recorded
as an `AgentRun` row: `userId`, `agentType`, `dataAccessed` (a JSON
description of what data the run read), plaintext `summary` (aggregates only),
full output (encrypted), model, token counts, estimated cost, status
(`RUNNING` / `SUCCEEDED` / `FAILED` / `SKIPPED`), and start/completion
timestamps. The audit trail survives agent deletion: `agentConfigId` is
nullable with `SetNull`, and `agentType` is denormalized onto the run.

The admin usage panel is gated on `User.isAdmin`, which is DB-only — no API
can set it (`docs/FREEDOM_OS.md` documents how to grant it).
`GET /api/admin/usage` returns cross-user **aggregates only**: run counts,
token totals, and estimated cost per user and agent type. An admin has **no**
access to another user's financial data, decrypted agent output, chat, or
profile — those stay ciphertext behind RLS, and no admin endpoint reads them.

## 14. Living profile

The CEO Agent maintains an encrypted "living profile" — long-term shared
memory that all agents read and feed, stored on
`CeoAgentConfig.profileCiphertext` (§11):

- **Structured categories:** financial goals, known accounts & relationships,
  stated preferences, recurring concerns, and life context. Each entry records
  its text, source (onboarding, user edit, or the agent type that surfaced
  it), and timestamps.
- **Auto-updated:** after each run and chat, a cheap extraction pass proposes
  profile updates (`server/agents/profile.js`). Extraction is best-effort by
  contract — it can never fail the run it follows.
- **User-controlled:** the user can view, edit, and delete entries via
  `GET`/`PATCH` `/api/agents/ceo/profile` (and the profile view in the UI).
- **Tombstones make deletion durable:** deleting an entry records its id in a
  tombstone list, and automatic merging never re-adds an entry the user
  removed. Covered by `test/agent-profile-ops.test.js`.
