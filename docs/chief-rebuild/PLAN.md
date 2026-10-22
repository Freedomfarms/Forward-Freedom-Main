# CHIEF rebuild — Assignment 1 plan

Assignment 1 is an isolated proof that a Managed Agents session can start, continue, and recover without replacing production chat. Production chat stays `POST /api/chief/chat`. `CHIEF_RUNTIME` defaults to `legacy`. Proof routes fail closed unless `CHIEF_MANAGED_PROOF=1`.

This assignment does not implement voice, financial integration, scheduled briefings, GitHub writes, or the production memory system. It does not deploy, provision paid resources, call Anthropic, migrate a database, or merge.

## Proof surface

- `POST /api/chief/managed/runs` authenticates, inserts a queued run and a pending job, then awaits `advanceRun` until the prompt is submitted or the slice yields. A self-POST runs only after that persist, and only when the slice yielded. The 30-second supervisor tick is recovery.
- `GET /api/chief/managed/runs/:runId` returns the public run and every latency sample. It does not drain.
- `POST /api/chief/managed/webhook` verifies a Standard Webhooks signature, dedupes on `webhook-id`, and wakes a drain job.
- `POST /api/chief/managed/drain` requires `CHIEF_DRAIN_SECRET` and advances claimable jobs.
- `server/chief/managed/client.js` is the only caller of the Anthropic Managed Agents, memory, and skills APIs.
- `scripts/chief-managed-supervisor.mjs` is the reusable recovery process. `deploy/chief-supervisor/` prepares a Fly.io machine and does not provision it.
- `prisma/migrations/20261022193000_chief_managed_proof/` is the isolated proof schema. It is not applied.
- `third_party/icm-architect/` is the pinned ICM Architect skill (`e16cafe6a664dcf6d787a726b452adba77d913f4`). The zip used for upload omits `VENDORED.md`.

## Goat-hay-feeder phases

`initial`, `close`, `continue_same_store`, `correct`, `confirm`, `recover`.

Continuation and recovery prompts do not include the prior transcript. Recovery creates a new memory store and seeds it only from Postgres documents. It does not attach or delete the original store. Same-store continuation is read-only while the earlier session can still resume writing.

Required workspace files: `requirements.md`, `decisions.md`, `open-questions.md`, `next-step.md`.

## Gates before any live step

1. Run `npm run chief:proof:identity`. It must show the same `system_identifier` and database oid for runtime, direct, and service connections, and a production system id that differs. A matching database name is not enough.
2. Apply `20261022193000_chief_managed_proof` only to that isolated database.
3. Run `npm run chief:proof:readiness`. Identity is checked again before any schema claim. Readiness requires the proof tables with forced row-level security.
4. Spend approval is separate. `scripts/chief-managed-proof.mjs --live` exits 3 until `CHIEF_PROOF_SPEND_APPROVED=1`, and even then this assignment does not execute the live call.

## Push gate

`npm run build` runs `prisma migrate deploy` whenever `DATABASE_URL` is set. `vercel.json` does not override that command. GitHub shows Vercel Preview deployments for this repository, and the Supabase Preview check on pull request 306 was skipped. Preview `DATABASE_URL` cannot be proven distinct from production. A push or draft pull request stays blocked until that isolation is established.
