# CHIEF rebuild — Assignment 1 status

Branch `cursor/chief-managed-agents-proof-1ece`. Base `32301c2`. Not on `origin`. No upstream. No pull request.

Commits that contain the proof, oldest first:

- `903e5b8` Add the isolated CHIEF managed-agent proof for Assignment 1.
- `a2f71e9` Implement the CHIEF proof live runner and return run ids after supervisor ack.
- The branch tip is the handoff commit on top of `a2f71e9`. `git rev-parse HEAD` after restoring the bundle is the current commit. That hash is also written in the downloaded handoff next to the bundle.

A new cloud agent cannot read this VM’s unpushed commits. Recover them from `chief-assignment-1.bundle`. Instructions: `docs/chief-rebuild/HANDOFF.md`.

## Implemented

- Authenticated run-start and run-status routes, plus webhook and drain routes.
- Run start stores the job and waits only for the supervisor’s 202 acknowledgement. It returns the run id with `promptSubmitted: false`.
- `scripts/chief-managed-proof.mjs --live` is implemented. It queues initial, same-store continuation, correction, confirmation, close, and Postgres-to-new-store recovery. Missing configuration exits 3 with each gap named. Dry-run stays `acceptance: mocked_only`.
- Managed Agents client, persisted jobs, leases, generations, `proof_ping`, conflict rows, and resource reconciliation.
- Pinned ICM Architect skill `e16cafe6a664dcf6d787a726b452adba77d913f4`.
- Identity and readiness scripts. They do not migrate. `freedom_app` and `freedom_service` are not granted `pg_control_system()`. The owner `DIRECT_URL` is the supported reader. Live proof requires `SERVICE_DATABASE_URL` to be probed too.
- Readiness requires `20250604120000_init` and `20261022193000_chief_managed_proof` in `_prisma_migrations`, the `"User"` table, and forced RLS on the proof tables.
- Supervisor process. First experiment: a temporary Cursor cloud VM. Fly.io app `freedom-os-chief-supervisor` in `iad` is config only.

## Completed checks

Recorded in `docs/chief-rebuild/VERIFICATION.md`. Mocked or local only:

- Focused proof tests: 29 passed on 23 October 2026.
- ESLint on the proof files passed.
- Dry-run exited 0 with `acceptance: mocked_only`.
- `--live` with an empty environment exited 3 with `acceptance: live_refused` and 13 missing prerequisites.
- Identity and readiness exited 2 without opening a database connection.
- `ANTHROPIC_API_KEY` was MISSING in this VM’s process environment on 23 October 2026. The value was not printed. A secret saved after that check is not visible until a new agent boots.

## Blockers

- Do not push. Vercel Preview runs `npm run build`, which runs `prisma migrate deploy` unless Preview `DATABASE_URL` is unset or exactly `postgresql://postgres:password@localhost:5432/forward_freedom`. Supabase Preview on pull request 306 was skipped. Preview database identity was not proven.
- Do not migrate, deploy, provision Fly, or make a paid Anthropic call.
- Spend is not approved. Proposed cap: 5 provider sessions, 1000 cents ($10.00).
- No isolated database has been identity-checked or migrated.
- This VM does not have `ANTHROPIC_API_KEY`.

## Exact next steps

1. Download `chief-assignment-1.bundle` and the handoff from this chat before leaving this VM.
2. Save `ANTHROPIC_API_KEY` in the environment secrets dashboard, then start the new cloud agent. Attach the bundle. This VM will still show the key as MISSING.
3. In the new agent, restore the branch with `docs/chief-rebuild/HANDOFF.md`. Confirm `git rev-parse HEAD` matches the handoff tip.
4. Report each live prerequisite as PRESENT or MISSING. Do not print values. Do not connect, migrate, or call Anthropic in that check.
5. Push only after the Vercel Preview `DATABASE_URL` cannot migrate production. Run `--live` only after identity, the full migration history, readiness, and an explicit spend approval.
