# ADR-0007: CHIEF reads Freedom OS finances through two governed tools

- Status: proposed with Phase 7
- Date: 2026-09-30

## Decision

1. CHIEF gets two read-only tools: `finance_summary` and `workspace_plan_summary`.
   Both require `finance:read`. Neither requires confirmation. Both return
   `sessionTaint: ["user_private"]`. A scheduled turn uses the same
   `ToolExecutor` path as a user turn.
2. `finance:read` is a CHIEF capability. It is not an OpenJarvis label, and it
   is not `memory:read`. An in-tree tool that is not in `CHIEF_TOOL_INVENTORY`
   still fails closed as `system:admin`.
3. Aggregation stays the function the finance agent already used. It now lives
   in `server/finance/aggregates.js` with the minimal Transaction and Account
   selects. The finance agent and the CEO world model call that module. CHIEF
   does not import `server/agents` or `server/brain`.
4. `finance_summary` returns that aggregate plus the existing Plaid connection
   counts (`itemCount`, `connectedCount`, `requiresAttentionCount`, `lastSyncAt`).
   When the caller's Module 02 read flag is on, it also returns `dashboard`:
   the Freedom Financial position computed by the dashboard utilities (spendable
   True Cash, liquid cash, credit card debt, reserves, gross True Cash, net
   worth, allocation, current-month budget and category spend, and the yearly
   outlook). It does not return merchants, account names, institution names,
   Plaid identifiers, tokens, or raw transactions. Net worth is the real sum.
   The chart's one-dollar floor is not applied.
5. The workspace slice stays the allowlist the CEO world model already returned.
   It now lives in `server/finance/workspaceSlice.js`. `workspace_plan_summary`
   decrypts `WorkspaceSnapshot.stateCiphertext`, sanitizes, and returns counts,
   capped labels, plan-year keys, and the stored-metric allowlist. It does not
   return the blob. Dashboard dollar amounts are on `finance_summary`, not on
   this slice.

## Consequences

There is still one executor and one turn loop. Queries run inside
`withUserContext`, so Postgres RLS applies. Dollar amounts are labeled
`user_private` by the tool result, not by regex. Outbound sink policy is
unchanged in this slice.
