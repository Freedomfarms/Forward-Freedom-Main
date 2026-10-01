# Freedom OS — Operator runbook

Operational reference for the current Freedom OS deployment.

CHIEF (JARVIS) is the AI layer: conversation, history, model routing, web
search, tools, skills, traces, scheduling, and approvals. Freedom Financial
is the financial command center. CHIEF can read Freedom Financial only when
the user turns that access on, and that access stays read-only.

The CEO agent platform, Freedom Brain, and Module 01 have been retired. Do
not configure `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `FREEDOM_OS_DEBUG_CEO`,
`CEO_RUN_SYNC_BUDGET_MS`, or `FREEDOM_BRAIN_CHAT`. Those variables are unused.

Security and privacy: `docs/SECURITY.md`. Row-level security rollout:
`docs/RLS_ROLLOUT.md`. CHIEF design history: `docs/CHIEF_ARCHITECTURE.md`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Fallback key for CHIEF's Anthropic provider when `CHIEF_ANTHROPIC_API_KEY` is unset and `anthropic` is still listed in `CHIEF_MODEL_PROVIDERS`. Keep it until production CHIEF uses the CHIEF-specific key or Anthropic is removed from the provider list. |
| `CRON_SECRET` | Authenticates Vercel Cron calls to `/api/cron/chief-dispatch` (Bearer token). Dispatch fails closed (503 when unset, 401 on mismatch). |
| `XAI_API_KEY` | Grok (xAI) key. `CHIEF_XAI_API_KEY` takes precedence when both are set. |
| `DATABASE_URL` | `freedom_app` connection string — non-bypass role, subject to RLS. Supavisor pooler username format is `freedom_app.<project-ref>` (see `docs/RLS_ROLLOUT.md`). |
| `SERVICE_DATABASE_URL` | `freedom_service` connection string (`BYPASSRLS`) — used only by `server/db/servicePrisma.js` for the Plaid webhook owner lookup and the CHIEF scheduler tick. |
| `DIRECT_URL` | Owner-role direct connection — Prisma CLI migrations only. |
| `FFF_ENCRYPTION_KEYS` | Versioned KEKs for envelope encryption, formatted `"1:<base64-32-bytes>,2:<base64-32-bytes>"`. Optional `FFF_ENCRYPTION_ACTIVE_VERSION` selects the wrapping version (defaults to the highest). |

CHIEF model, web-search, and provider settings (`CHIEF_*`, `BRAVE_SEARCH_API_KEY`,
`OPENAI_API_KEY`) are documented in `.env.example`. None of them may use the
`VITE_` prefix.

`User.isAdmin` remains on the user row and is unused. There is no admin usage
API and no API that sets the flag.

## Cron dispatch

- Path: `GET /api/cron/chief-dispatch`, scheduled by `vercel.json` every 5
  minutes (`*/5 * * * *`).
- Auth: `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron sends when the
  `CRON_SECRET` env var is set), with `?secret=` as a fallback; comparison is
  timing-safe and fails closed when unconfigured.
- The service-role client enumerates due CHIEF tasks across users. Each run
  then executes inside the owning user's context.
