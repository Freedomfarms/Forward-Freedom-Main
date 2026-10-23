# CHIEF rebuild — Assignment 1 verification

Checked on 23 October 2026 (America/New_York). Mocked and local results are separate from live evidence. Nothing below is live acceptance.

## Passed

| Command | Result |
| --- | --- |
| `node --test --experimental-test-module-mocks test/chief-managed-proof.test.js` | 29 passed, 0 failed. |
| `npx eslint` on `server/chief/managed`, `api/chief/managed`, the chief scripts, and `test/chief-managed-proof.test.js` | Passed. |
| `node scripts/chief-managed-proof.mjs` | Exit 0. `acceptance` is `mocked_only`. |
| `env -i PATH="$PATH" node scripts/chief-managed-proof.mjs --live` | Exit 3. `acceptance` is `live_refused`, `implemented` is true, 13 missing prerequisites. The text does not say the runner is unimplemented. |
| `node scripts/chief-proof-db-identity.mjs` | Exit 2. `DATABASE_URL` and `DIRECT_URL` are required. No connection was opened. |
| `node scripts/chief-proof-db-readiness.mjs` | Exit 2. Stage `identity`. No schema claim. |

The focused tests cover the earlier proof behavior plus: run start returning a queued run id before provider work, a kick 202 that finishes after the client aborts, owner-role identity when `pg_control_system()` is denied, the project-ref fallback, the init-migration baseline, the live prerequisite list, the phase runner with an injected client, the 5-session cap, and the live command calling an injected executor only after those prerequisites pass.

The injected phase runner is `acceptance: runner_exercised_with_injected_client` and `mocked: true`. The injected command success is `acceptance: live` only because the test supplied the executor. No Anthropic call was made.

## Explicitly not run

- `npm run build`, `prisma migrate deploy`, and any command with a live `DATABASE_URL`.
- `npm run lint` across the whole repository. On 22 October 2026 it failed in existing `src/` dashboard files this work does not change. It was not repeated.
- `npx prisma validate`, `npm run prisma:generate`, and `npx vite build`. The schema and frontend were not changed in this pass. They passed on 22 October 2026 without a migration.
- A real `--live` execution. Spend is not approved, and no provider credentials were used.
- `fly apps create`, `fly deploy`, `git push`, and pull request creation.

## Push isolation check

Unchanged. GitHub deployments include Vercel Preview. Pull request 306 completed Supabase Preview as `SKIPPED`. `vercel.json` does not replace the build command. `scripts/prisma-migrate-deploy.mjs` migrates when `DATABASE_URL` is set to something other than `postgresql://postgres:password@localhost:5432/forward_freedom`. Preview database identity was not readable. The branch stays unpushed.
