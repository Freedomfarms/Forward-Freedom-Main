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
item resolution, future cron dispatcher, future admin usage queries).

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

Redeploy. Owner credentials now exist only in `DIRECT_URL`.

## Verifying after rollout

- Sign in and load the dashboard: data appears normally.
- In the SQL editor, as `freedom_app` without a context:
  `SET ROLE freedom_app; SELECT count(*) FROM "Transaction";` → `0` rows.
- `test/rls-isolation.test.js` covers the same guarantees against a local
  Postgres (two-user isolation, zero rows without context, `WITH CHECK`
  rejecting mismatched inserts, `FORCE` applying to the owner).

## Rollback

Config-only rollback: point `DATABASE_URL` back at the owner connection string
— but note `FORCE ROW LEVEL SECURITY` also restricts the owner, so a true
policy rollback requires `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` (or
`DISABLE ROW LEVEL SECURITY`) per table in the SQL editor. Keep this runbook's
table list handy; the migration file enumerates every affected table.
