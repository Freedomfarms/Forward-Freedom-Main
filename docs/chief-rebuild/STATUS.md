# CHIEF rebuild — Assignment 1 status

Branch `cursor/chief-managed-agents-proof-1ece`, based on `32301c2`. Changes are committed locally when this file is current and are not pushed. No pull request is open.

## Implemented

- Authenticated run-start and run-status routes, plus webhook and drain routes.
- Managed Agents client boundary, with session and memory beta headers kept separate.
- Persisted job states, job leases, write leases with generations, and conflict rows.
- Idempotent `proof_ping` insert, with the tool result posted again until it succeeds.
- Resource rows saved as `creating` before the provider call. A later retry adopts one metadata match or stops in `needs_reconciliation`. A failed list does not create another resource.
- Write ownership is not released while the owning session can resume, and it is not stolen when the lease clock expires.
- Pinned ICM Architect packaging and a skill-read check that requires the tool result text from `SKILL.md`.
- Mocked same-store continuation and Postgres recovery into a fresh memory store and fresh session.
- Identity and readiness scripts. Both refuse to run without `DATABASE_URL` and `DIRECT_URL`. Neither migrates.
- Supervisor process and Fly.io config for app `freedom-os-chief-supervisor` in `iad`. Not provisioned.

## Not done

- No migration applied. No live Anthropic session. No Fly machine. No Vercel deployment of these routes.
- `served_model` is not recorded unless the provider returns that field. Configured model evidence is not independent serving proof.
- The supervisor on a Cursor cloud VM is a bounded experiment, not production hosting.
- Voice, financial integration, scheduled briefings, GitHub writes, and the production memory system are out of scope.

## Wiki updates

Shared wiki was available at `/ai-development-wiki` revision `8ffed7c`. No wiki pull request was opened. Proposed entries, to be filed in `ai-development-wiki` only:

- Freedom OS architecture: Assignment 1 adds an isolated proof runtime. `CHIEF_RUNTIME` stays legacy. Routes live under `/api/chief/managed`. Proof tables are separate from production chat. The supervisor config is not production hosting.
- Decision: database identity uses `pg_control_system().system_identifier` plus `pg_database.oid`, not the database name.
- Finding: Vercel preview builds run `prisma migrate deploy` when `DATABASE_URL` is set, and the Supabase Preview check on recent pull requests was skipped, so this branch was not pushed.
