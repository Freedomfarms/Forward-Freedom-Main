# CHIEF capability registry

CHIEF operates Freedom OS by naming a registered capability. The model does not
receive a handler, a database connection, or a credential. `TurnMachine` and
`ToolExecutor` remain the execution path. `ApprovalCoordinator` remains the only
approval lifecycle.

## Descriptor

Each capability has:

| Field                          | Values                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `name`                         | Stable tool name                                                                      |
| `description`                  | What the model is allowed to ask for                                                  |
| `inputSchema` / `outputSchema` | JSON schema. No executable code                                                       |
| `subsystem`                    | `memory`, `scheduler`, `finance`, `settings`, `skills`, `web`, `mcp`, `conversations` |
| `effect`                       | `read`, `write`, `destructive`, `external`, `high_impact`                             |
| `requiredCapabilities`         | Server grant labels                                                                   |
| `confirmation`                 | `none` or `required`                                                                  |
| `audit`                        | `deny_only` or `full`                                                                 |
| `exposure`                     | `baseline` or `on_demand`                                                             |

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
3. Add the grant label to `CHIEF_TOOL_INVENTORY` and, when it should be available
   with zero grant rows, to the baseline in `server/chief/security/grants.js`.
4. Register the tool through `createChiefCapabilityRegistry`.
5. Do not edit `TurnMachine` to special-case the feature.

Unknown names fail closed. The model cannot register a capability or change a grant.
There is no generic invocation that accepts a function, import, query, or shell command.

## What is registered now

Existing tools, plus conversation rename, archive, restore, and delete on
`PrismaCheckpointStore`. Schedule list, runs, and outcome require `schedule:read`.
Schedule create, update, pause, and resume require `schedule:create`.
`schedule_cancel` is destructive.

## Not implemented

- Code intelligence (`code_tree`, `code_read`, `code_search`) and any GitHub credential
- Grok Build hook ingestion and workforce status
- Operational events and the flow-map graph
- Freedom Diamond changes
- Finance writes, Plaid actions, and settings ports beyond the Module 02 switch
- Module 01

CHIEF still cannot commit, push, deploy, or run a shell.
