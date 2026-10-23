# CHIEF rebuild — Assignment 1 status

On 23 October 2026 the proof is merged on `main` at `fecc0e0`. Production builds withhold pending proof migrations unless `CHIEF_PROOF_MIGRATE=1`. That flag is for an isolated database only and must not be set on Vercel. Whether production already applied `20261022193000_chief_managed_proof` was not visible from build logs or a production connection.

Branch `cursor/chief-managed-agents-proof-1ece`. Base `32301c2`. Pushed to `origin` on 23 October 2026 because the branch was requested for review. A new cloud agent can fetch this branch. `docs/chief-rebuild/HANDOFF.md` still describes the local bundle.

Commits that contain the proof, oldest first:

- `903e5b8` Add the isolated CHIEF managed-agent proof for Assignment 1.
- `a2f71e9` Implement the CHIEF proof live runner and return run ids after supervisor ack.
- `cdfd226` Record the Assignment 1 handoff and the unpushed recovery path.
- The status commit on top of `cdfd226` records this push.

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

- The branch is on `origin`. Vercel Preview still runs `npm run build`, which runs `prisma migrate deploy` unless Preview `DATABASE_URL` is unset or exactly `postgresql://postgres:password@localhost:5432/forward_freedom`. Supabase Preview on pull request 306 was skipped. Preview database identity was not proven. Confirm the Preview database before treating a preview deployment as safe.
- Do not migrate, deploy, provision Fly, or make a paid Anthropic call.
- Spend is not approved. Proposed cap: 5 provider sessions, 1000 cents ($10.00).
- No isolated database has been identity-checked or migrated.
- This VM does not have `ANTHROPIC_API_KEY`.

## Exact next steps

1. Fetch `origin/cursor/chief-managed-agents-proof-1ece`. The local bundle remains a fallback copy.
2. Save `ANTHROPIC_API_KEY` in the environment secrets dashboard, then start a new cloud agent. This VM will still show the key as MISSING.
3. Report each live prerequisite as PRESENT or MISSING. Do not print values. Do not connect, migrate, or call Anthropic in that check.
4. Confirm the Vercel Preview `DATABASE_URL` cannot migrate production before relying on the preview build. Run `--live` only after identity, the full migration history, readiness, and an explicit spend approval.
