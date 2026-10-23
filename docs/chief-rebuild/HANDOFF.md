# Assignment 1 handoff

This branch was pushed to `origin` on 23 October 2026 as `cursor/chief-managed-agents-proof-1ece`. Fetch that branch. The bundle below remains a fallback if the remote branch is unavailable.

## Restore

The recovery copy is a git bundle of `32301c2..cursor/chief-managed-agents-proof-1ece`. It contains this branch’s new commits and does not contain `.env`, `.env.local`, or credential files. The new clone must already contain `32301c2` (it is on `main`).

From a checkout of `Freedomfarms/Forward-Freedom-Main`:

```bash
git fetch /absolute/path/to/chief-assignment-1.bundle cursor/chief-managed-agents-proof-1ece:cursor/chief-managed-agents-proof-1ece
git checkout cursor/chief-managed-agents-proof-1ece
git rev-parse HEAD
git merge-base --is-ancestor 32301c2 HEAD
```

`git rev-parse HEAD` must match the tip named in the handoff that was downloaded with the bundle. `git log --oneline 32301c2..HEAD` must show `903e5b8`, `a2f71e9`, and the handoff commit.

The push starts a Vercel Preview build, and `npm run build` runs `prisma migrate deploy` when `DATABASE_URL` is not the placeholder `postgresql://postgres:password@localhost:5432/forward_freedom`. Confirm the Preview database before treating that build as safe.

Do not deploy, migrate, provision Fly, or run `scripts/chief-managed-proof.mjs --live`.
