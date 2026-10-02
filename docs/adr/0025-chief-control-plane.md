# ADR-0025: CHIEF control-plane capability inventory

- Status: accepted
- Date: 2026-10-02
- Scope: CHIEF (Module 03)

## Context

CHIEF already authorizes tools through `CapabilityPolicy`, `ToolExecutor`, and
`ApprovalCoordinator`. New Freedom OS surfaces were still added as separate
tools plus prompt paragraphs. The model could not ask the control plane what
the current user can read or change, and a missing connector looked the same
as a missing feature. Assistant Markdown was also inserted as plain text, so
escaped emphasis was shown literally.

## Reuse check (mandatory)

- OpenJarvis `CapabilityPolicy` and the ToolExecutor gate order stay the
  security boundary. New labels are CHIEF extensions, the same way
  `finance:read` and `code:read` already were.
- möbius `ApprovalCoordinator` stays the only confirmation lifecycle.
- Connector tools are descriptors plus server implementations, the same
  registry shape as ADR-0022. No generic invoke was added.
- BUILD NEW inventory and connector registry, because neither upstream knows
  which Freedom OS connectors are connected for a user.

## Decision

`discoverCapabilities` is the inventory for the model, the system prompt, and
the access sheet. `capability_discover` reads it. Canonical ids such as
`web:read` and `workspace:read` keep their existing grants (`web:search`,
`finance:read`). Disconnected connectors are listed with a reason and do not
register a tool. A connected connector registers its own tools and grants
through the same executor. `code:read` is on the empty-grant baseline.
`file:read`, `network:fetch`, and `code:execute` are not.

The transcript parses Markdown, including a leading backslash before emphasis,
outside fenced code.

## Consequences

- Empty grant rows gain `capability:read` and `code:read`. A stored grant row
  still replaces the baseline entirely.
- Email, calendar, drive, GitHub account, and filesystem connectors are
  unavailable until one is registered. Resend agent-run delivery is not a
  mailbox connector.
- Sensitive connector calls use the existing full audit record and now include
  session, model, capability, and approval state in that record.
- Finance writes, generic data query, shell, and deploy remain unregistered.
