# Freedom OS — Operator runbook

Short operational reference for running the Freedom OS agent platform.
Security and privacy architecture: `docs/SECURITY.md` (§§9–14). Row-level
security rollout: `docs/RLS_ROLLOUT.md`.

## Required environment variables

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | The single platform LLM key every agent call uses (no BYOK). When missing, runs degrade cleanly to a recorded `LLM_NOT_CONFIGURED` failure instead of crashing. |
| `CRON_SECRET` | Authenticates Vercel Cron calls to `/api/cron/agent-dispatch` (Bearer token). Dispatch fails closed (503 when unset, 401 on mismatch). |
| `RESEND_API_KEY` | Resend key for reminder emails (self-notification only). When missing, email is skipped with an explanation and the in-app notification still delivers. |
| `DATABASE_URL` | `freedom_app` connection string — non-bypass role, subject to RLS. Supavisor pooler username format is `freedom_app.<project-ref>` (see `docs/RLS_ROLLOUT.md`). |
| `SERVICE_DATABASE_URL` | `freedom_service` connection string (`BYPASSRLS`) — used only by `server/db/servicePrisma.js` for the cron dispatcher, the Plaid webhook owner lookup, and admin usage reporting. |
| `DIRECT_URL` | Owner-role direct connection — Prisma CLI migrations only. |
| `FFF_ENCRYPTION_KEYS` | Versioned KEKs for envelope encryption, formatted `"1:<base64-32-bytes>,2:<base64-32-bytes>"`. Optional `FFF_ENCRYPTION_ACTIVE_VERSION` selects the wrapping version (defaults to the highest). |

Optional: `RESEND_FROM_EMAIL` overrides the default reminder sender
(`Freedom OS <notifications@forwardfreedomfinancial.com>`).

## Setting a platform admin (`isAdmin`)

`User.isAdmin` is DB-only by design — no API can set it. Grant it with SQL run
as a role that bypasses RLS (the Supabase SQL editor's `postgres` role does;
`freedom_app` cannot, because RLS is `FORCE`d):

```sql
UPDATE "User" SET "isAdmin" = true WHERE "email" = 'admin@example.com';
```

Set it back to `false` (or `NULL` — `NULL` means false; the column
deliberately has no default, see `prisma/schema.prisma`) to revoke. Admins get
the usage panel (`GET /api/admin/usage`), which returns cross-user aggregates
only — never another user's financial data or decrypted agent output.

## Cron dispatch

- Path: `GET /api/cron/agent-dispatch`, scheduled by `vercel.json` every 15
  minutes (`*/15 * * * *`).
- Auth: `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron sends when the
  `CRON_SECRET` env var is set), with `?secret=` as a fallback; comparison is
  timing-safe and fails closed when unconfigured.
- At most 20 due agents run per invocation (serverless timeout headroom); the
  remainder is picked up on the next 15-minute tick.
- The service-role client is used only to enumerate due agents across users;
  each run then executes inside `withUserContext(userId, ...)` with every
  safety gate re-checked per run (`server/agents/runner.js`).
- After successful runs, the dispatcher refreshes the owning users' CEO
  digests best-effort — a digest failure never fails the dispatch.

## Resend domain verification (reminder emails)

Reminder emails are sent from `RESEND_FROM_EMAIL` (default
`notifications@forwardfreedomfinancial.com`). The sending domain must be
verified in the Resend dashboard (DKIM + Return-Path DNS records) before
delivery works; an unverified domain surfaces as
`email delivery failed (...)` in the run summary while the in-app notification
still delivers. Recipients are always the user's own account email address —
there is no way to address anyone else (`server/agents/types/reminders.js`).
