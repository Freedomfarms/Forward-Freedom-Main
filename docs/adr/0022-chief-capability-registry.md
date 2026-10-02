# ADR-0022: CHIEF capability registry

- Status: accepted
- Date: 2026-10-02
- Scope: CHIEF (Module 03)

## Context

CHIEF executed a fixed list of tools built in `createChiefTools`. New Freedom OS
operations required another hand-written tool and another edit to the conversation
loop. The approved control-plane design puts a capability registry in front of the
existing runtime so a registered operation is another interface to an existing
service.

## Reuse check (mandatory)

- OpenJarvis `ToolSpec` and the ToolExecutor gate order stay the execution boundary.
- möbius `ApprovalCoordinator` stays the only confirmation lifecycle.
- BUILD NEW descriptor and registry modules, because neither upstream has Freedom OS
  subsystem metadata (effect, audit, exposure) or this server's user-scoped stores.
- No Module 01 registry is reused. `server/capabilities/registry.js` belongs to the
  retired CEO agent inventory.

## Decision

A capability is a frozen descriptor plus a server-side implementation. The model
receives the descriptor. `TurnMachine` still authorizes calls. `ToolExecutor` still
runs the gates. The implementation calls the existing schedule store, checkpoint
store, or Module 02 access store.

Effects `destructive` and `high_impact` require a fresh confirmation. Session-wide
approval and `full_access` do not skip them. An `approved` decision for the current
batch still grants the call. Those effects also write a `chief_audit_log` row
through the existing audit writer.

Schedule reads require `schedule:read`. Schedule writes keep `schedule:create`.
Conversation rename, archive, and restore require `conversation:write` and call
`PrismaCheckpointStore`. Conversation delete requires `conversation:delete` and
calls `deleteOwnedSession`.

## Consequences

- Empty capability-grant rows gain `schedule:read`, `conversation:write`, and
  `conversation:delete` on the baseline. A stored grant row still replaces the
  baseline entirely.
- `schedule_cancel` is destructive. `module02_access_set` is high impact.
- Code intelligence, Grok workforce ingestion, the operational graph, finance
  writes, and settings ports are not part of this decision.
- CHIEF still has no GitHub write credential, deploy credential, or shell.
