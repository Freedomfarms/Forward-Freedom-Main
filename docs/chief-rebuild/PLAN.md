# CHIEF rebuild — Assignment 1 plan

Assignment 1 is an isolated proof that a Managed Agents session can start, continue, and recover without replacing production chat. Production chat stays `POST /api/chief/chat`. `CHIEF_RUNTIME` defaults to `legacy`. Proof routes fail closed unless `CHIEF_MANAGED_PROOF=1`.

This assignment does not implement voice, financial integration, scheduled briefings, GitHub writes, or the production memory system. It does not deploy, provision paid resources, call Anthropic, migrate a database, or merge.

## Proof surface

- `POST /api/chief/managed/runs` authenticates, inserts a queued run and a pending job, then waits only for the separate supervisor to acknowledge `POST /kick` with 202. It returns the run id then. It does not wait for Claude or for the rest of the experiment. The supervisor process continues after the client disconnects. The 30-second tick reclaims a job if that acknowledgement was lost.
- `GET /api/chief/managed/runs/:runId` returns the public run and every latency sample. It does not drain.
- `POST /api/chief/managed/webhook` verifies a Standard Webhooks signature, dedupes on `webhook-id`, and wakes a drain job.
- `POST /api/chief/managed/drain` requires `CHIEF_DRAIN_SECRET` and advances claimable jobs.
- `server/chief/managed/client.js` is the only caller of the Anthropic Managed Agents, memory, and skills APIs.
- `scripts/chief-managed-supervisor.mjs` is the reusable recovery process. The first live experiment runs it on a temporary Cursor cloud VM. `deploy/chief-supervisor/` keeps a Fly.io config for later and does not provision it.
- `prisma/migrations/20261022193000_chief_managed_proof/` is the isolated proof schema. It is not applied.
- `third_party/icm-architect/` is the pinned ICM Architect skill (`e16cafe6a664dcf6d787a726b452adba77d913f4`). The zip used for upload omits `VENDORED.md`.

## Goat-hay-feeder phases

`initial`, `close`, `continue_same_store`, `correct`, `confirm`, `recover`.

Continuation and recovery prompts do not include the prior transcript. Recovery creates a new memory store and seeds it only from Postgres documents. It does not attach or delete the original store. Same-store continuation is read-only while the earlier session can still resume writing.

Required workspace files: `requirements.md`, `decisions.md`, `open-questions.md`, `next-step.md`.

## Gates before any live step

1. Run `npm run chief:proof:identity`. `DATABASE_URL` is `freedom_app` and `SERVICE_DATABASE_URL` is `freedom_service`. Neither role is granted `pg_monitor`, so `pg_control_system()` may return SQLSTATE `42501`. `DIRECT_URL` is the owner role and is the supported reader of `system_identifier`. The denied connections must still share database oid, database name, and Supabase project ref with that owner. If every connection is denied, isolation falls back to the project ref plus database oid, and the result says that this is not the Postgres system identifier. A matching database name is not enough. `SERVICE_DATABASE_URL` is probed whenever it is set.
2. On that isolated database only, run `npx prisma migrate deploy` with `DIRECT_URL` pointed at it. That applies the full history, beginning at `20250604120000_init`, including `20261022193000_chief_managed_proof`. The proof migration references `"User"`, so applying only the new SQL file to an empty database is not enough.
3. Run `npm run chief:proof:readiness`. Identity is checked again before any schema claim. Readiness then requires both migration names in `_prisma_migrations`, the `"User"` table, and forced row-level security on the proof tables.
4. Spend approval is separate. `scripts/chief-managed-proof.mjs --live` is implemented. Without the prerequisites it exits 3 and names each missing one. It does not run until those are present, including `CHIEF_PROOF_SPEND_APPROVED=1`. The proposed cap is 5 provider sessions and 1000 cents. That spend is not approved.

## Push gate

`npm run build` runs `prisma migrate deploy` whenever `DATABASE_URL` is set. `vercel.json` does not override that command. GitHub shows Vercel Preview deployments for this repository, and the Supabase Preview check on pull request 306 was skipped. Preview `DATABASE_URL` cannot be proven distinct from production. A push or draft pull request stays blocked until that isolation is established.
