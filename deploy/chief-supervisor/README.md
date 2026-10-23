# Prepared cloud supervisor

This process is the recovery loop for CHIEF proof drain jobs. It is not durable
production hosting. This assignment does not provision it and does not spend money.

## First live experiment

Use a temporary Cursor cloud VM. Run the supervisor there as its own process.
That VM disappears with the session. Do not describe it as production hosting.
Fly.io is a later option and is not required for this experiment.

The start route stores the job, then waits only for `POST /kick` to return 202. The supervisor process continues the experiment after that response, so
the client can disconnect. The 30-second loop reclaims jobs if that kick is lost.

```bash
CHIEF_SUPERVISOR_MODE=embedded \
CHIEF_SUPERVISOR_LISTEN=1 \
CHIEF_SUPERVISOR_HOST=127.0.0.1 \
CHIEF_SUPERVISOR_PORT=8787 \
CHIEF_DRAIN_SECRET=<secret> \
node scripts/chief-managed-supervisor.mjs
```

Point `CHIEF_SUPERVISOR_URL` at `http://127.0.0.1:8787`. Do not start this until
the identity check, the full migration history, and spend approval are in place.

## Later hosting option

A Fly.io shared-cpu machine in `iad`, app name `freedom-os-chief-supervisor`,
can run the same embedded process. It is not created.

Fly.io charges for the machine. Do not run `fly apps create`, `fly deploy`, or
`fly secrets set` until that spend and the isolated database are approved.

From the repository root, the future command would be:

```bash
fly deploy . --config deploy/chief-supervisor/fly.toml --dockerfile deploy/chief-supervisor/Dockerfile --ha=false
```

## Configuration names

Set these on the worker. Do not put values in git.

- `CHIEF_SUPERVISOR_MODE` `embedded` or `http`
- `CHIEF_SUPERVISOR_INTERVAL_MS` default `30000`
- `CHIEF_SUPERVISOR_LISTEN` `1` to accept `POST /kick`
- `CHIEF_SUPERVISOR_PORT` default `8787`
- `CHIEF_DRAIN_SECRET`
- `CHIEF_DRAIN_URL` when mode is `http`
- `VERCEL_AUTOMATION_BYPASS_SECRET` when the drain is a protected preview
- `DATABASE_URL`, `DIRECT_URL`, `SERVICE_DATABASE_URL` for embedded mode
- `CHIEF_PRODUCTION_DB_SYSTEM_ID` and the identity check before any migration
- `ANTHROPIC_API_KEY` only after spend is approved
- `FFF_ENCRYPTION_KEYS`, `FFF_ENCRYPTION_ACTIVE_VERSION`
- `CHIEF_MANAGED_PROOF=1`

`POST /api/chief/managed/runs` waits for this process to accept `/kick`. It does
not wait for Claude. The 30-second loop is recovery when the kick did not land.
