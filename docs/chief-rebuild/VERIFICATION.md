# CHIEF rebuild — Assignment 1 verification

Checked on 22 October 2026. Times below are America/New_York. These results are mocked or local. None of them is live acceptance.

## Passed

| Command | Result |
| --- | --- |
| `node --test --experimental-test-module-mocks test/chief-managed-proof.test.js` | 19 passed, 0 failed. About 112 ms. |
| `npx prisma validate` | Schema valid. No migration. |
| `npm run prisma:generate` | Prisma Client 7.8.0 generated. No migration. |
| `npx eslint` on `server/chief/managed`, `api/chief/managed`, the new chief scripts, `test/chief-managed-proof.test.js`, and `server/index.js` | Passed after the two lint fixes. |
| `npm run lint` | Exit 1. Nine errors and three warnings, all in existing `src/` dashboard files (`ForwardFreedomDashboard.jsx`, orbit charts, `WorkspaceGuideAssistant.jsx`, `main.jsx`). None are in the proof files. |
| `npx vite build` | Client bundle built. This is not `npm run build`. |
| `node scripts/chief-managed-proof.mjs` | Exit 0. `acceptance` is `mocked_only`. |
| `node scripts/chief-proof-db-identity.mjs` | Exit 2. Failure: `DATABASE_URL` and `DIRECT_URL` are required. No connection was opened. |
| `node scripts/chief-proof-db-readiness.mjs` | Exit 2. Stage `identity`. `readiness` is null. No schema claim. |

The focused test covers identity stronger than a database name, forced RLS readiness, webhook lease decisions, write-lease generations, empty-list sync, `proof_ping` retry, resource adopt and list-failure reconciliation, a real `SKILL.md` tool result versus a description, the pinned zip, latency classes, transcript-free prompts, same-store read-only continuation, recovery into a new store seeded from Postgres, awaited run start, status that does not drain, duplicate webhook ignore, webhook fail-closed, model evidence without an invented served model, and drain secret refusal.

## Explicitly not run

- `npm run build` and `prisma migrate deploy`. The build applies migrations when `DATABASE_URL` is set.
- Treating `npm run lint` as a pass. It was run, and it fails on existing `src/` files that this assignment does not change.
- Any command with a live `DATABASE_URL`. Identity and readiness were not executed against Postgres.
- Anthropic, including `scripts/chief-managed-proof.mjs --live`. That flag exits 3. Live execution is not implemented.
- `fly apps create`, `fly deploy`, and `fly secrets set`.
- `git push` and pull request creation.

## Push isolation check

GitHub deployments for `Freedomfarms/Forward-Freedom-Main` include environment `Preview` (for example sha `3a63860`, created 20 October 2026, 3:55 PM America/New_York). Pull request 306 completed `Supabase Preview` as `SKIPPED` and has a Vercel status plus `Vercel Preview Comments`. `vercel.json` does not replace the build command. `scripts/prisma-migrate-deploy.mjs` runs `prisma migrate deploy` when `DATABASE_URL` is a non-placeholder value, and a migration failure still lets the deploy continue. Preview database identity was not readable from this session. Safe isolation is not established.
