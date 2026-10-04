# CHIEF capability registry

CHIEF operates Freedom OS by naming a registered capability. The model does not
receive a handler, a database connection, or a credential. `TurnMachine` and
`ToolExecutor` remain the execution path. `ApprovalCoordinator` remains the only
approval lifecycle.

## Descriptor

Each capability has:

| Field                          | Values                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `name`                         | Stable tool name                                                                              |
| `description`                  | What the model is allowed to ask for                                                          |
| `inputSchema` / `outputSchema` | JSON schema. No executable code                                                               |
| `subsystem`                    | `memory`, `scheduler`, `finance`, `settings`, `skills`, `web`, `mcp`, `conversations`, `code` |
| `effect`                       | `read`, `write`, `destructive`, `external`, `high_impact`                                     |
| `requiredCapabilities`         | Server grant labels                                                                           |
| `confirmation`                 | `none` or `required`                                                                          |
| `audit`                        | `deny_only` or `full`                                                                         |
| `exposure`                     | `baseline` or `on_demand`                                                                     |

The catalog of governance metadata is `server/chief/capabilities/catalog.js`.
The registry is `server/chief/capabilities/registry.js`. Implementations stay in
the existing stores and are registered from `server/chief/tools/builtin.js`.

## Governance

1. Firebase authentication sets `userId`.
2. The boundary guard rejects non-local tools.
3. `CapabilityPolicy` checks the grant. An explicit deny wins.
4. Taint policy runs.
5. Confirmation: reads run when authorized. Writes use the current approval policy.
   Destructive and high-impact calls always wait for this batch's approval.
   `approved_for_session` does not stick for those calls.
6. The call times out.
7. Output and injection scanning run.

A `userId` in the model's arguments is ignored. Module 02 data stays behind
`module02Read`. A `finance:read` grant does not turn that switch on.
`module02_access_set` is high impact and calls `PrismaModuleAccess.setModule02ReadEnabled`.

## How a new Freedom OS capability is registered

1. Call the service the UI already uses. Do not copy its logic.
2. Add one catalog row with effect, confirmation, audit, and exposure.
3. Add the grant label to `CHIEF_TOOL_INVENTORY` and a `baseline: true` row in
   `server/chief/control/plane.js`. `loadCapabilityPolicy` reads that catalog.
   Do not add a second baseline list.
4. Register the tool through `createChiefCapabilityRegistry`.
5. Do not edit `TurnMachine` to special-case the feature.

Unknown names fail closed. The model cannot register a capability or change a grant.
There is no generic invocation that accepts a function, import, query, or shell command.

`capability_discover` is the read-only inventory. It reports canonical capabilities,
the tools that implement them, the grant that enforces each one, whether confirmation
is required, and connectors that are not connected. Email, calendar, drive, GitHub
account, and filesystem access stay unavailable until a connector is registered.
Adding that connector registers its tools. It does not require a new CHIEF loop.
`web:read` is enforced by `web:search`. `workspace:read` is enforced by `finance:read`.
`code:read` is the configured repository, not a user GitHub account.

## What is registered now

Existing tools, plus conversation rename, archive, restore, and delete on
`PrismaCheckpointStore`. Schedule list, runs, and outcome require `schedule:read`.
Schedule create, update, pause, and resume require `schedule:create`.
`schedule_cancel` is destructive.

`settings_read` and `settings_update` call `server/platform/userSettings.js`, the
same timezone persistence `PATCH /api/me` uses. The only supported user setting
is `User.timezone`. `settings_read` is a read and requires `settings:read`.
`settings_update` is a write, requires `settings:write`, and waits for
`ApprovalCoordinator`. Both use `context.userId`. A model-supplied `userId` is
ignored. The result is `{ timezone }` only. Email, role, admin status, legal
consent, credentials, and tokens are not settings and are not returned.
CEO agent name, personality, avatar, and model stay on the retired agent API
and are not registered. Nickname values such as "Eastern" are not accepted by
the service; the model must send an IANA name (`America/New_York` for Eastern).

`code_tree`, `code_read`, and `code_search` read the configured Freedom OS
repository through `server/chief/codeintel/`. They require `code:read`, which
is on the empty-grant baseline. The effect is `read` and confirmation is
`none`. The credential is `CHIEF_CODE_READ_TOKEN`, a server-side contents-read
token. The repository is `CHIEF_CODE_REPOSITORY` (default
`Freedomfarms/Forward-Freedom-Main`). The model supplies a path, ref, query,
or line range. It cannot supply a URL or a repository name. Protected paths
such as `.env` files, private keys, and credential JSON are refused before
any bytes are returned. A file that is too large is not truncated; the tool
asks for `start_line` and `end_line`. File-body search uses the default
branch. Another ref can be listed and read, and path-name search still runs
there. There is no repository index yet.

CHIEF can inspect Freedom OS source and cannot modify, commit, push, or deploy it.

## Not implemented

- A repository symbol index for routes, APIs, and imports
- Grok Build hook ingestion and workforce status
- Operational events and the flow-map graph
- Freedom Diamond changes
- Finance writes and Plaid actions
- Settings other than timezone
- Generic `capability_invoke` that accepts a function, import, query, or shell command
- Module 01

CHIEF still cannot commit, push, deploy, or run a shell.
