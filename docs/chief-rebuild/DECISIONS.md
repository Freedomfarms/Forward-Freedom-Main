# CHIEF rebuild — Assignment 1 decisions

## Normal start awaits the slice

`POST /api/chief/managed/runs` inserts the job, then awaits `advanceRun` before it responds. Self-POST is an awaited optimization after that persist, capped by chain depth. The 30-second supervisor reclaims `pending` jobs and expired job leases. It is not the chat-start delay. Unawaited work after the serverless response is not the processing path.

## Database identity is the cluster and the database oid

`scripts/chief-proof-db-identity.mjs` reads `pg_control_system().system_identifier`, `pg_database.oid`, and `current_database()` on the runtime and direct URLs. Hosts may differ. A missing system identifier fails closed. `CHIEF_PRODUCTION_DB_SYSTEM_ID` is required and must differ. `SERVICE_DATABASE_URL`, when set, must be the same cluster and database. The script prints host, port, and database name only. Readiness runs the identity check first and does not claim a schema when identity fails.

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

The prepared durable location is a Fly.io shared-cpu machine, app `freedom-os-chief-supervisor`, region `iad`, embedded mode, `min_machines_running = 1`. It is not created. A Cursor cloud VM may run the same script for one bounded experiment and must not be described as production hosting.

## This branch stays unpushed

Preview deployments exist for this repository. The Vercel build command is `npm run build`, which runs `prisma migrate deploy` when `DATABASE_URL` is set. Supabase Preview on pull request 306 was skipped. Isolation of the preview database was not established, so the branch is not pushed and no draft pull request is opened.
