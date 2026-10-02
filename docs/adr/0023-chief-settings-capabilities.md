# ADR-0023: CHIEF settings capabilities

- Status: accepted
- Date: 2026-10-02
- Scope: CHIEF (Module 03)

## Context

ADR-0022 left user settings unregistered. `PATCH /api/me` already persists one
user setting, `User.timezone`, through `withUserContext`. The Freedom OS client
calls that route from `updateUserTimezone` in `src/utils/api.js`. CEO agent
name, personality, avatar, and model are a separate retired agent API.

## Decision

`settings_read` and `settings_update` are capability descriptors. Their
implementations call `readUserSettings` and `updateUserTimezone` in
`server/platform/userSettings.js`. `api/me.js` calls that same update function
and still passes the Firebase profile columns on the HTTP path. CHIEF passes
only the authenticated `context.userId` and the timezone string.

`settings_read` is effect `read`, confirmation `none`, grant `settings:read`.
`settings_update` is effect `write`, confirmation `required`, grant
`settings:write`. Approval stays on `ApprovalCoordinator`. The model receives
no handler. Unknown fields and non-IANA values are rejected. The capability
output is `{ timezone }` only.

## Consequences

- Empty grant rows gain `settings:read` and `settings:write` on the baseline.
  A stored grant row still replaces the baseline entirely.
- No other profile, admin, consent, or financial field is writable from CHIEF.
- Code intelligence, Grok workforce ingestion, the operational graph, finance
  writes, and Module 01 remain out of scope.
