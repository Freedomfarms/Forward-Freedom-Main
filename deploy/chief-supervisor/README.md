# Prepared cloud supervisor

This process is the recovery loop for CHIEF proof drain jobs. It is not durable
production hosting until a machine is provisioned. This assignment does not
provision it and does not spend money.

## Proposed location

A Fly.io shared-cpu machine in `iad`, app name `freedom-os-chief-supervisor`,
running `node scripts/chief-managed-supervisor.mjs` in `embedded` mode. The
machine stays up, so a kick is a normal process, not work after a serverless
response. The 30-second loop reclaims `pending` jobs and expired `running`
leases. Normal run submission still awaits prompt processing in
`POST /api/chief/managed/runs` before that response returns.

Fly.io charges for the machine. Do not run `fly apps create`, `fly deploy`, or
`fly secrets set` until that spend and the isolated database are approved.

From the repository root, the future command would be:

```bash
fly deploy . --config deploy/chief-supervisor/fly.toml --dockerfile deploy/chief-supervisor/Dockerfile --ha=false
```

## Bounded experiment

A Cursor cloud VM can run the same process against a local API for one
experiment. That VM is temporary. Do not describe it as production hosting.

```bash
CHIEF_SUPERVISOR_MODE=http \
CHIEF_DRAIN_URL=http://127.0.0.1:3001/api/chief/managed/drain \
CHIEF_DRAIN_SECRET=<secret> \
node scripts/chief-managed-supervisor.mjs
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

The API can await `CHIEF_SUPERVISOR_URL/kick` after it has persisted the job.
That await is an optimization. The persisted job and this loop are the recovery
path.
