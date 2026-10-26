# Phase 1 release steps

These two steps are manual. Do them yourself after you merge the Phase 1 pulls, and not before. Nothing in CI, Vercel, or a laptop session does them.

Merge order: #319, then #320, then #321. Merge the next pull only after the previous one is on `main` and its check is green.

## How deploy and migrate stay apart

`npm run build` generates the Prisma client and builds the site. It does not migrate. Vercel’s Git integration deploys that build when `main` moves. It does not apply SQL.

Pushing `main` also starts `.github/workflows/production-migrate.yml`. That job classifies every pending migration, then runs `node scripts/prisma-migrate-deploy.mjs` with `CHIEF_MIGRATE_TARGET=production`. It does not call Vercel and it does not promote a deployment.

The Phase 1 migration only creates `chief_budget_hold`. If the site deploys before that table exists, a coding create returns `budget_unverified` and does not call Cursor. If the table exists before the new site is live, the previous site ignores it. A non-additive file never reaches Prisma. The job prints the directory, the sha256, and the authorization command, then exits non-zero.

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

No cap is seeded. A coding create stays `budget_unverified` and does not call Cursor until you insert one row for the user who may spend.

`chief_budget` has forced row-level security and a foreign key to `"User"`. The id must already exist. Run the insert as the GitHub migrate role. A superuser bypasses the policy. If the policy rejects the insert, set `app.current_user_id` to that same user id for the transaction. Do not run it as `freedom_app`.

```sql
INSERT INTO chief_budget (id, "userId", scope, "periodType", "capUsd", "spentUsd", "updatedAt")
VALUES (
  'cap_' || gen_random_uuid()::text,
  '<the user id>',
  'cursor',
  'run',
  10,
  0,
  CURRENT_TIMESTAMP
);
```

Replace `<the user id>` with that person’s id. `10` is the cap in US dollars for one open coding run. The reserve uses this row, not `spentUsd`. Pick the number you want before you insert it.

`chief_budget_hold` has no row-level policy. The additive classifier rejects `ENABLE ROW LEVEL SECURITY` on a new file, so this migration does not add one. Every reserve, release, and cost update includes that user id. One user cannot reuse, release, or reprice another user’s hold. Do not grant this table to a shared login unless you also add a policy through the separate authorization path.

## Still not run from here

Live ICM skill read, live Cursor create, paid provider calls, production cron, voice, and branch protection stay manual. Do not start them until you want those calls.
