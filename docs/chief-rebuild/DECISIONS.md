# CHIEF rebuild — Assignment 1 decisions

## Run start returns after a dispatch acknowledgement

`POST /api/chief/managed/runs` inserts the durable job, then waits for the separate supervisor's `POST /kick` to return 202. The response carries the run id with `promptSubmitted: false`. Claude's response and the rest of the experiment continue in the supervisor process after the client can disconnect. The start route does not call `advanceRun`. The 30-second supervisor reclaims `pending` jobs and expired job leases when the kick did not land. Unawaited work after a serverless response is not the processing path. The Vercel drain route is not that supervisor.

## Database identity is the cluster and the database oid

`pg_control_system()` is granted to superusers and `pg_monitor` by default. This repo never grants that to `freedom_app` or `freedom_service`, so `DATABASE_URL` and `SERVICE_DATABASE_URL` can be denied with SQLSTATE `42501`. `DIRECT_URL` is the owner role and is the supported reader of `system_identifier`. A denied connection must still match database oid, database name, and the Supabase project ref parsed from `db.<ref>.supabase.co` or the pooler username `role.<ref>`. If every connection is denied, the check uses that project ref plus the database oid and records the limitation that this is not the Postgres system identifier. `SERVICE_DATABASE_URL`, when set, is probed. The live proof requires it. The script prints host, port, database name, role name, and access. It does not print credentials. Readiness runs identity first and does not claim a schema when identity fails.

The isolated database gets its shape from `npx prisma migrate deploy` against that `DIRECT_URL`. The command applies every migration from `20250604120000_init` through the proof migration. Applying only `20261022193000_chief_managed_proof` does not create `"User"`, which the proof foreign keys require.

## Leases

These durations are implementer choices. The accepted plan left them unspecified.

- Job lease: 90 seconds. A duplicate webhook ignores a `completed` job, wakes an expired `pending` or `running` lease, and does not start a second worker while a lease is valid.
- Write lease: 90 seconds. Expiry does not let another session take ownership while the owner can resume. A commit must match `writeSessionId`, `leaseGeneration`, and an unexpired `writeLeaseExpiresAt`.
- Slice budget: 25 seconds. A yielded slice leaves the job pending.
- Supervisor interval: 30 seconds. Samples from that actor use delay class `supervisor_recovery`. Every sample is kept.

Ownership is cleared only when the run is closed or the provider session is terminated, and no tool call is unfinished.

## Provider create can land before the id is stored

The resource row is `creating` before the provider call. On retry, list and adopt exactly one match on `metadata.freedom_os_key`, name, or display title. Zero identifiable matches and an empty list create. A list failure, multiple matches, or unidentified existing rows become `needs_reconciliation` and do not create. Retries are not claimed to prevent duplicates beyond that detection.

## Sync and conflicts

An empty or failed memory list does not delete Postgres documents. A hash mismatch stores the rejected bytes on a conflict row and leaves the current document. A read-only continuation does not apply writes. Changed incoming bytes are stored as conflicts.

## Skill and model evidence

A skill event description is not a read. The check requires a `read` tool call whose path ends in `SKILL.md`, paired with a non-error tool result whose text is not the description. Workspace inspection separately requires the four project files to be non-empty.

The configured model is `{ id: "claude-opus-5-5", effort: "medium" }`. `served_model` is stored only when the provider returns it. Otherwise the limitation is recorded and no served-model id is invented.

## Supervisor location

The first live experiment is a temporary Cursor cloud VM running `scripts/chief-managed-supervisor.mjs` in embedded mode on `127.0.0.1`. It is not production hosting. Fly.io app `freedom-os-chief-supervisor` in `iad` remains a later hosting option and is not created.

The proposed first-experiment cost cap is 5 provider sessions and 1000 cents ($10.00), because each session body carries a $2.00 budget. That spend is not approved. The runner stops at the cap.

## This branch stays unpushed

Preview deployments exist for this repository. The Vercel build command is `npm run build`, which runs `prisma migrate deploy` when `DATABASE_URL` is set. Supabase Preview on pull request 306 was skipped. Isolation of the preview database was not established, so the branch is not pushed and no draft pull request is opened.
