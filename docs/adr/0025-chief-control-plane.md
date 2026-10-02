# ADR-0025: CHIEF capabilities are one control-plane catalog

- Status: accepted with the workforce-observation foundation
- Date: 2026-10-02
- Renumbered from 0022 when the capability-registry ADR kept that number.
- Scope: `server/chief/control/plane.js`, grants, tool registration

## Context

CHIEF has accumulated capability labels one tool at a time (`finance:read`,
`skill:read`, `web:search`, `module:access`, `conversation:read`) on top of the
OpenJarvis label set. The next work is workforce observation and, later, governed
access to the rest of Freedom OS, including read-only source. That needs one
place that says which operations exist, which effect they have, and which
operations are impossible.

## Reuse check (mandatory)

- OpenJarvis `CapabilityPolicy` and the ToolExecutor gate order stay the
  enforcement. The catalog does not replace them. `canonicalToolCapabilities`
  and `CHIEF_TOOL_INVENTORY` stay the floor for a tool name.
- Hermes toolsets are not ported. They are a runtime's tool packages, and CHIEF
  is not growing a second runtime.
- möbius approval remains the confirmation gate. A catalog effect of `confirm`
  means the existing `requiresConfirmation` bit. It does not add a new approver.
- BUILD NEW: the catalog itself. No audited project has a Freedom OS domain list
  or a hard ban on repository mutation, because those are this product's boundary.

## Decision

1. `server/chief/control/plane.js` is the list of CHIEF operations. Each entry
   has a domain, an effect (`read`, `confirm`, `forbidden`), and a status
   (`live`, `reserved`, `forbidden`).
2. A live local tool appears in both the catalog and `CHIEF_TOOL_INVENTORY`,
   with the same single capability. `createChiefTools` checks that before
   returning tools.
3. The empty-grant baseline is the catalog's `baseline: true` capabilities, in
   catalog order. After reconciliation with the capability registry, that list
   includes the registry's schedule-read, conversation-write, conversation-delete,
   and settings labels. `workforce:read` stays reserved and off the baseline.
   Repository read is the live `code:read` tools, also off the baseline.
4. `mcp_invoke` stays remote, capability `tool:invoke`, off the baseline.
5. The codebase domain admits `read` or `forbidden` only. Forbidden operations
   have a tool name and no capability label. `defineToolSpec` and
   `assertToolAllowed` reject those names. There is no `codebase:write` label.
6. Reserved operations have no tool. They document workflows, files,
   system inspection, message read, and workforce observation so the next tool
   has a row to fill. They do not run. Settings and repository read are live.

## Consequences

- A new governed operation is a catalog row plus a tool plus an inventory floor.
  An unlisted local tool still fails closed as `system:admin`.
- Source write, commit, push, and deploy cannot be granted, because they have
  no capability to grant.
- `file:write` remains an unused label. It is not repository write.
- No HTTP API and no TurnMachine behavior change in this ADR.
