# ADR-0016: Empty capability grants use a five-label baseline

- Status: proposed with Phase 16
- Date: 2026-09-30
- Scope: `server/chief/security/grants.js`

## Context

`loadCapabilityPolicy` is what chat and the scheduler tick use when no policy
is injected. Zero `chief_capability_grant` rows became
`new CapabilityPolicy({ defaultDeny: true })` with no agents. `ToolExecutor`
checks that policy as agent `chief`. `CapabilityPolicy.check` already inherits
`_default` when the named agent has no explicit policy, and nothing populated
`_default`. Every inventoried tool was denied before confirmation. Nothing in
the server, API, or migrations inserts grant rows.

## Reuse check (mandatory)

- OpenJarvis `setup_security` (`src/openjarvis/security/__init__.py`,
  `5e5f5ef`) grants `_default` a narrow set when `default_deny` is on and no
  policy file is configured, so default-deny does not leave every tool
  unreachable. A configured policy file replaces that branch. Initialization
  failure does not become an open policy. CHIEF uses that empty-policy branch
  only. The upstream labels `file:read` and `network:fetch` are not granted.
  `DEFAULT_TOOL_CAPABILITIES` is not copied.
- Hermes toolsets and cron actions are not a capability policy. They are not
  ported.
- möbius `routine_run_preview` is not a capability policy. It is not ported.

## Decision

1. `policyFromGrantRows` stays a pure mapping of explicit rows. An empty list
   is still a closed policy with no `_default` grants.
2. `loadCapabilityPolicy` returns a `defaultDeny: true` policy with `_default`
   grants for `memory:read`, `memory:write`, `schedule:create`,
   `finance:read`, and `skill:read` only when the query returns zero rows.
3. A non-empty row set replaces that baseline. The loader does not merge
   `_default` into a user who already has explicit rows.
4. A thrown load is unchanged: `createChiefTooling` still substitutes
   `closedPolicy()`, which denies every capability.
5. The baseline does not include `file:read`, `file:write`, `network:fetch`,
   `code:execute`, `channel:send`, `tool:invoke`, or `system:admin`.
   `defaultDeny` stays true.
6. The loader does not insert, update, or delete grant rows. Confirmation,
   `BoundaryGuard`, `ToolExecutor`, `TurnMachine`, and the scheduler are
   unchanged. Granting `schedule:create` does not execute `schedule_create`.

## Consequences

- A user with no grant rows can call the existing read tools, and mutation
  tools still stop at confirmation.
- An explicit grant for one capability does not unlock the rest of the
  baseline.
- MCP stays blocked because `mcp_invoke` is non-local. The baseline does not
  grant `tool:invoke`.
