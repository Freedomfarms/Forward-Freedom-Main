# ADR-0025: CHIEF reads broadly from one control plane

- Status: accepted
- Date: 2026-10-02
- Reconciled the capability-inventory ADR and the operation-catalog ADR, which
  had both been numbered 0025. The catalog note that it was renumbered from
  0022, when the capability-registry ADR kept that number, still applies.
- Scope: CHIEF (Module 03)

## Context

CHIEF is the intelligence and control layer for Freedom OS. New reads were
being added one tool, one grant, and one prompt paragraph at a time. Two
designs then described that control plane separately: a discoverable
capability inventory, and a catalog of live, reserved, and forbidden
operations. They disagreed about whether `code:read` is on the baseline and
whether a stored grant replaces that baseline.

Ordinary read access should not require another manual grant. Writes stay
governed.

## Reuse check (mandatory)

- OpenJarvis `CapabilityPolicy` and the ToolExecutor gate order stay the
  enforcement. The catalog does not replace them. `canonicalToolCapabilities`
  and `CHIEF_TOOL_INVENTORY` stay the floor for a tool name.
- möbius `ApprovalCoordinator` stays the only confirmation lifecycle. A
  catalog effect of `confirm` means the existing `requiresConfirmation` bit.
- Connector tools are descriptors plus server implementations. No generic
  invoke was added.
- Hermes toolsets are not ported.
- BUILD NEW: the catalog and the discovery inventory. Neither upstream knows
  which Freedom OS connectors are connected, or which repository writes are
  impossible.

## Decision

### Capability inventory

`server/chief/control/plane.js` is the list of built-in operations. Each entry
has a domain, an effect (`read`, `confirm`, `forbidden`), and a status
(`live`, `reserved`, `forbidden`). `discoverCapabilities` is the inventory the
model, the system prompt, and the access sheet read. `capability_discover`
is a live tool in that catalog and in `CHIEF_TOOL_INVENTORY`.
`assertControlPlane` requires those two lists to name the same local tools
and the same capability for each tool.

A new legitimate read is a catalog row with `baseline: true`, an inventory
floor, and a tool. It is not a separate grant list and not a custom CHIEF
task.

### Capability policy

`baselineCapabilities()` is the only built-in baseline. `loadCapabilityPolicy`
starts from that list. The order is:

1. canonical baseline,
2. grants contributed by connectors that are actually connected,
3. explicit stored grants,
4. explicit denies.

Stored rows do not replace the baseline. An explicit deny wins, including a
deny stored on `_default` after an agent has its own rows. `policyFromGrantRows`
stays a pure mapping and does not merge. A thrown load stays deny-all.

`capability:read` and `code:read` are on that baseline. `workforce:read` stays
reserved and off it. `file:read`, `network:fetch`, `code:execute`, and
`tool:invoke` stay off it. `finance:read` does not turn Freedom Financial data on.

### Governance

Broad read access is not write access. Confirm effects still stop in
`ToolExecutor` until approval. That includes `memory:write`,
`schedule:create`, `schedule:cancel`, `conversation:write`,
`conversation:delete`, `settings:write`, `module:access:set`, and connector
writes such as `email:send`. Destructive and high-impact calls keep their
existing fresh-confirmation rules. The catalog does not add an approver.

### Connector availability

Email, calendar, drive, GitHub account, filesystem, and later connectors
contribute capabilities and tools only while `connected === true`. A
disconnected connector is listed with a reason, registers no tool, and adds
no grant. A connected connector's read tools become available through the
same registry. Its writes stay on the confirmation path. Resend agent-run
delivery is not a mailbox.

### Code intelligence

`code_tree`, `code_read`, and `code_search` are live reads of the configured
Freedom OS repository. `code:read` is part of normal read access. When those
tools are available, the system prompt tells CHIEF to inspect the source for
questions about how Freedom OS works, and not to inspect it for ordinary
chat. The user does not have to say to search the code.

The codebase domain admits `read` or `forbidden` only. Forbidden operations
have a tool name and no capability. `defineToolSpec` rejects repository
write, commit, push, and deploy. There is no `codebase:write` label.
Protected paths are still refused before a fetch. `code:read` is not
`file:write`, `code:execute`, or a shell.

## Consequences

- An ordinary new read does not need a one-off grant task. A stored grant
  cannot erase `code:read` or `capability:read`. An explicit deny can.
- Source write, commit, push, and deploy cannot be granted, because they
  have no capability to grant.
- `file:write` remains an unused label. It is not repository write.
- `mcp_invoke` stays remote, capability `tool:invoke`, off the baseline.
- The transcript parses Markdown outside fenced code. That rendering is not
  a capability grant.
- No TurnMachine behavior change in this ADR.
