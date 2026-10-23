# CHIEF rebuild — Assignment 1 status

Branch `cursor/chief-managed-agents-proof-1ece`, based on `32301c2`. Changes stay local. No pull request is open.

## Implemented

- Authenticated run-start and run-status routes, plus webhook and drain routes.
- Run start stores the job and waits only for the supervisor's 202 acknowledgement. It returns the run id with `promptSubmitted: false`. The supervisor process continues after the client disconnects.
- The live runner in `scripts/chief-managed-proof.mjs --live`. It queues `initial`, same-store continuation, correction, confirmation, close, and Postgres-to-new-store recovery, then polls the supervisor. Missing configuration exits 3 with the specific gap. Dry-run output stays `acceptance: mocked_only`.
- Managed Agents client boundary, used by the embedded supervisor when a live run is actually started.
- Persisted job states, job leases, write leases with generations, conflict rows, idempotent `proof_ping`, and resource reconciliation.
- Pinned ICM Architect packaging and a skill-read check that requires the tool result text from `SKILL.md`.
- Identity and readiness scripts. They do not migrate. `freedom_app` and `freedom_service` are not granted `pg_control_system()`. The owner `DIRECT_URL` is the supported reader. `SERVICE_DATABASE_URL` is probed when set, and the live proof requires it.
- Readiness requires `_prisma_migrations` to contain `20250604120000_init` and `20261022193000_chief_managed_proof`, plus `"User"`, plus forced RLS on the proof tables.
- Supervisor process. The first experiment is a temporary Cursor cloud VM. Fly.io config for `freedom-os-chief-supervisor` in `iad` is kept for later and is not provisioned.

## Not done

- No migration applied. No live Anthropic session. No Fly machine. No Vercel deployment. No push.
- The live runner has been exercised with an injected client and injected prerequisites. That result is `runner_exercised_with_injected_client`, not live acceptance.
- `served_model` is not recorded unless the provider returns that field.
- Voice, financial integration, scheduled briefings, GitHub writes, and the production memory system are out of scope.

## Review without a production migration

Keep this branch unpushed. A push creates a Vercel Preview deployment, and `npm run build` runs `prisma migrate deploy` when `DATABASE_URL` is a non-placeholder value. Supabase Preview on pull request 306 was skipped, so it is not a safety net.

The smallest review path that does not touch production settings:

1. Review `git diff main...HEAD` from this local branch.
2. Before any future push, set the Vercel **Preview** environment's `DATABASE_URL` to the placeholder `postgresql://postgres:password@localhost:5432/forward_freedom` (or unset it) and leave Preview `DIRECT_URL` unset. `scripts/prisma-migrate-deploy.mjs` then skips. Do not change the Production environment.
3. Do not disable Deployment Protection. Do not provision Fly. Do not approve spend as part of that preview change.

## Wiki updates

Shared wiki was available at `/ai-development-wiki` revision `8ffed7c`. No wiki pull request was opened. Proposed entries, for `ai-development-wiki` only:

- Freedom OS architecture: Assignment 1 adds an isolated proof runtime. `CHIEF_RUNTIME` stays legacy. Routes live under `/api/chief/managed`. Run start returns after a supervisor acknowledgement. The Cursor cloud supervisor is temporary.
- Decision: database identity uses `pg_control_system().system_identifier` from the owner role, plus `pg_database.oid`. `freedom_app` and `freedom_service` are not granted that function. A denied connection must match project ref and database oid.
- Finding: Vercel preview builds run `prisma migrate deploy` when `DATABASE_URL` is set, and the Supabase Preview check was skipped, so this branch was not pushed.
