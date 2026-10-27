# Phase 1 release steps

These two steps are manual. Do them yourself after you merge the Phase 1 pulls, and not before. Nothing in CI, Vercel, or a laptop session does them.

Merge order: #319, then #320, then #321. Merge the next pull only after the previous one is on `main` and its check is green.

## How deploy and migrate stay apart

`npm run build` generates the Prisma client and builds the site. It does not migrate. Vercel’s Git integration deploys that build when `main` moves. It does not apply SQL.

Pushing `main` also starts `.github/workflows/production-migrate.yml`. That job classifies every pending migration, then runs `node scripts/prisma-migrate-deploy.mjs` with `CHIEF_MIGRATE_TARGET=production`. It does not call Vercel and it does not promote a deployment.

The Phase 1 migration creates `chief_budget_hold`, forces row-level security on it, and grants DML to the runtime roles when they exist. A missing `cursor` / `run` cap does not block a coding create: Cursor's own account limits apply. If a cap row exists and this table is missing, or the budget tables cannot be read, the create returns `budget_unverified` and does not call Cursor. If the table exists before the new site is live, the previous site ignores it. A non-additive file never reaches Prisma. The job prints the directory, the sha256, and the authorization command, then exits non-zero.

Confirm in the Vercel project that the build command is `npm run build` (or `vite build`) and that no deploy hook runs `prisma migrate deploy`.

## 1. Production migration identity

The migrate job refuses to start until `freedom_migration_identity` has one row whose environment, database name, and role match the session. This repository does not create that row.

Run this once, in the production database, as the same role stored in the GitHub `DATABASE_URL` / `DIRECT_URL` secrets. Do not run it from a laptop with `CHIEF_MIGRATE_TARGET=production`.

```sql
CREATE TABLE IF NOT EXISTS freedom_migration_identity (
  environment text NOT NULL,
  database_name text NOT NULL,
  migrate_role text NOT NULL
);

INSERT INTO freedom_migration_identity (environment, database_name, migrate_role)
SELECT 'production', current_database(), current_user
WHERE NOT EXISTS (SELECT 1 FROM freedom_migration_identity);
```

Then check the single row:

```sql
SELECT environment, database_name, migrate_role, current_database(), current_user
FROM freedom_migration_identity;
```

`environment` must be `production`. `database_name` must equal `current_database()`. `migrate_role` must equal `current_user`, and that user must be the role the GitHub secret uses. If a row already exists and any value is wrong, stop and correct it by hand. Do not add a second row.

After the next push to `main`, the migrate job is allowed to apply additive files. Until this row exists, that job fails closed on purpose.

## 2. Cursor spending cap

No cap is required. Leave this row out unless you want CHIEF to enforce a dollar ceiling in addition to the Cursor account. With no `cursor` / `run` row, a coding create uses Cursor's subscription, credits, and account limits. CHIEF does not invent a dollar estimate for that path.

`chief_budget` has forced row-level security and a foreign key to `"User"`. The id must already exist. Run an optional insert as the GitHub migrate role. A superuser bypasses the policy. If the policy rejects the insert, set `app.current_user_id` to that same user id for the transaction. Do not run it as `freedom_app`.

```sql
INSERT INTO chief_budget (id, "userId", scope, "periodType", "capUsd", "spentUsd", "updatedAt")
SELECT
  'cap_' || gen_random_uuid()::text,
  '<the user id>',
  'cursor',
  'run',
  10,
  0,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM chief_budget
  WHERE "userId" = '<the user id>' AND scope = 'cursor' AND "periodType" = 'run'
);
```

Replace `<the user id>` with that person’s id, and replace `10` with the ceiling you want before you insert it. That number is not Cursor's price. The reserve uses this row, not `spentUsd`, and only when the caller supplies a real per-run dollar cost. Without that cost, the create stays `budget_unverified` and does not call Cursor. A database error does the same. Do not insert this row if you want Cursor's own limits to be the only control.

`chief_budget_hold` enables and forces row-level security. The only policy is `user_isolation`: `"userId"` must equal `app.current_user_id`. With no setting, a query sees no rows. The migration grants `SELECT`, `INSERT`, `UPDATE`, and `DELETE` to `freedom_app` and `freedom_service` when those roles exist. Every reserve, release, and cost update also includes that user id, so one user cannot reuse, release, or reprice another user’s hold. The table has no foreign key. A finished or failed run releases its hold so a later task is not blocked by a stale reservation.

## Still not run from here

Live ICM skill read, live Cursor create, paid provider calls, production cron, voice, and branch protection stay manual. Do not start them until you want those calls.
