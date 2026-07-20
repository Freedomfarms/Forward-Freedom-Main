# Row-Level Security rollout runbook

Freedom OS Phase 3 retrofits **database-enforced** per-user isolation onto
every user-scoped table: Postgres row-level security (RLS) with
`FORCE ROW LEVEL SECURITY`, so even a forgotten `WHERE "userId" = ...` clause
can never leak another user's rows. The application binds the user for each
transaction via `withUserContext()` (`server/db/prisma.js`), which runs
`SELECT set_config('app.current_user_id', <uid>, true)` as the first statement
— transaction-local, so it is safe behind Supabase's transaction-mode pooler.

Queries issued with **no** user context match zero rows (fail closed).
Cross-user work is restricted to the `freedom_service` role used by
`server/db/servicePrisma.js` at three justified call sites only (Plaid webhook
item resolution, the cron dispatcher `api/cron/agent-dispatch.js`, and admin
usage reporting `api/admin/usage.js`).

## Rollout order (do NOT collapse into one deploy)

FORCE RLS + un-wrapped code = instant production breakage. Old serverless
instances must already be wrapper-only before policies go live.

### 1. Deploy the wrapper refactor (no RLS yet)

Deploy the PR that routes every handler through `withUserContext` and adds
`server/db/servicePrisma.js`. Behavior is identical (the owner role is not
policy-restricted until the migration lands **and** `FORCE` applies to it).
Verify production works.

### 2. Create the database roles (manual, Supabase SQL editor)

Run the following with strong, generated passwords (never commit real values):

```sql
-- App role: subject to RLS, no bypass. Becomes DATABASE_URL after step 4.
CREATE ROLE freedom_app LOGIN PASSWORD '<GENERATE-A-STRONG-PASSWORD>';

-- Service role: BYPASSRLS, used ONLY by server/db/servicePrisma.js.
CREATE ROLE freedom_service LOGIN PASSWORD '<GENERATE-A-STRONG-PASSWORD>' BYPASSRLS;
```

The RLS migration's grants reference these roles; when a role is missing the
migration skips its grants with a warning, so create the roles **before**
deploying step 3 (or re-run the grant block afterwards).

`20260719010000_runtime_role_grant_remediation` repairs environments where the
original RLS migration ran before the roles were created. It conditionally
re-applies the same grants and future-object defaults on a later deploy, while
remaining a no-op for local and shadow databases without those roles.

`20260719011500_user_isolation_policy_remediation` then performs full RLS
state reconciliation in one transaction across all 17 user-scoped tables: it
explicitly enables and forces RLS, removes every existing policy regardless of
name or permissive/restrictive mode using safely quoted catalog identifiers,
and creates the sole intended `user_isolation` policy with the original
`id`/`userId` predicate. It introduces no bypass, grants, or role changes.

### 3. Deploy the RLS migration

Deploy the PR containing
`prisma/migrations/20260718200000_freedom_os_row_level_security`. The build's
`migrate deploy` (running as the owner via `DIRECT_URL`, unchanged) enables and
forces RLS, creates one `user_isolation` policy per table, and grants DML to
the two roles (plus `ALTER DEFAULT PRIVILEGES` so future migrations' tables
inherit the grants).

From this moment even the owner role is policy-restricted (`FORCE`), which the
wrapper-only code from step 1 already satisfies.

### 4. Switch the runtime connection strings (config only)

In Vercel:

- `DATABASE_URL` → the `freedom_app` connection string (Supavisor transaction
  pooler, port 6543, `?pgbouncer=true`).
- `SERVICE_DATABASE_URL` → the `freedom_service` connection string.
- `DIRECT_URL` stays on the owner role — the Prisma CLI keeps running
  migrations as the owner.

**Username format matters.** Supavisor routes tenants through the username, so
the pooler username is `<role>.<project-ref>` — e.g.
`freedom_app.abcdefghijklm`, NOT plain `freedom_app`. The connection string the
Supabase dashboard generates always prefills `postgres.<project-ref>`; when
building the `freedom_app` / `freedom_service` strings you must replace the
`postgres` part by hand and keep the `.<project-ref>` suffix.

Make sure each variable is saved for the **Production** environment, then
redeploy. Owner credentials now exist only in `DIRECT_URL`.

### SSL

The runtime clients (`server/db/prisma.js`, `server/db/servicePrisma.js`)
negotiate TLS automatically for any non-local database host — see
`server/db/pgPoolConfig.js`. No `sslmode` parameter is required on
`DATABASE_URL` / `SERVICE_DATABASE_URL`, though `sslmode=require` is accepted
and equivalent. Two optional upgrades:

- Set `DATABASE_SSL_CA_CERT` to the PEM contents of Supabase's root
  certificate (Database Settings → SSL Configuration → download
  `prod-ca-2021.crt`) to turn on full certificate verification.
- `sslmode=disable` opts a URL out (local tooling only — never production).

## Troubleshooting

### `(ESSLREQUIRED) SSL connection is required for user: postgres`

Two independent facts are visible in this error:

1. **`SSL connection is required`** — the connection reached Supabase's pooler
   without TLS. Older builds passed the connection string straight to `pg`,
   which never negotiates TLS on its own; `server/db/pgPoolConfig.js` now
   turns TLS on for remote hosts, so redeploying current `main` fixes this
   half regardless of the URL's query params.
2. **`for user: postgres`** — the pooler echoes the username from the startup
   packet with the `.<project-ref>` tenant suffix stripped. If it says
   `postgres` after the role switch, the runtime is still connecting as
   `postgres.<project-ref>`: either the Vercel env var kept the dashboard's
   prefilled username (see step 4), was saved to the wrong environment
   (Preview instead of Production), or the deployment predates the env change.
   When the switch is correct the error would have said `for user:
   freedom_app`.

To confirm what a deployed function actually sees, run
`vercel env pull .env.production --environment=production` locally (or check
Settings → Environment Variables) and inspect the username in `DATABASE_URL` —
never log the value from runtime code.

Note: this error used to surface in the app UI as a paused "secure sync" with
the raw pooler message, because a database failure during the auth-time
disabled-account lookup was misreported as a 401 sign-in problem.
`server/auth/verifyAuth.js` now reports database outages as 503 with a stable
message.

## Verifying after rollout

- Sign in and load the dashboard: data appears normally.
- In the SQL editor, as `freedom_app` without a context:
  `SET ROLE freedom_app; SELECT count(*) FROM "Transaction";` → `0` rows.
- `test/rls-policy-remediation.test.js` statically pins the exact 17-table
  ENABLE/FORCE, cleanup, and single-policy inventories and rejects bypass,
  grant, or role mutations.
- `test/rls-isolation.test.js` covers the runtime guarantees against a local
  Postgres (two-user isolation, zero rows without context, `WITH CHECK`
  rejecting mismatched inserts, `FORCE` applying to the owner, and removal of
  deliberately missing and arbitrarily named restrictive policy drift).

### `Unable to read or update the workspace snapshot` (after auth works)

Getting past the auth-time 503 means `DATABASE_URL` reaches Postgres as
`freedom_app` and can read `"User"`. A subsequent workspace 500 with this
message can report either of two distinct `42501` diagnostics:

- `permission denied for table …` means the runtime grants were skipped.
  Deploy `20260719010000_runtime_role_grant_remediation`, or re-run the grants
  below as the owner.
- `new row violates row-level security policy for table …` means policy state
  is missing or drifted. Deploy
  `20260719011500_user_isolation_policy_remediation` as the owner via
  `DIRECT_URL` to fully reconcile RLS flags and policies; do not disable RLS
  or `FORCE`.

```sql
GRANT USAGE ON SCHEMA public TO freedom_app, freedom_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO freedom_app, freedom_service;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO freedom_app, freedom_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO freedom_app, freedom_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO freedom_app, freedom_service;
```

No redeploy needed after the grants — click **Retry Secure Sync**.

## Rollback

Config-only rollback: point `DATABASE_URL` back at the owner connection string
— but note `FORCE ROW LEVEL SECURITY` also restricts the owner, so a true
policy rollback requires `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` (or
`DISABLE ROW LEVEL SECURITY`) per table in the SQL editor. Keep this runbook's
table list handy; the migration file enumerates every affected table.
