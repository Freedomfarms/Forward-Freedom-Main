# ADR-0020: Per-user Freedom Financial read access for CHIEF

- Status: proposed with the Freedom Financial read-only slice
- Date: 2026-10-01

## Decision

1. `finance_summary` and `workspace_plan_summary` remain the only Freedom Financial
   reads. `finance_summary` returns the six-month aggregate and, when this
   user's `freedomFinancialRead` flag is on, the Freedom Financial dashboard position.
   `workspace_plan_summary` stays the label and count slice. This slice does
   not add transaction, account, budget, or settings mutation tools.
   `freedom_financial_access_set` changes only the permission flag.
2. Each user has one `chief_module_access` row. `freedomFinancialRead` defaults to
   false, and a missing row is off. Existing and new users are off until that
   user turns it on. The flag is not a `chief_capability_grant` row, because
   any grant row replaces the whole baseline.
3. `finance:read` stays on the empty-grant baseline so the read tools can run
   and return "Freedom Financial read access is currently disabled." The data load
   happens only after `denyUnlessFreedomFinancialRead` allows that user. `module:access`
   is a separate baseline capability for the status and set tools. It does not
   reveal financial data. `web:search` is unchanged.
4. The Freedom Financial sidebar control (`FreedomFinancialChiefAccess`) and
   `freedom_financial_access_set` both call the same store. The set tool requires
   confirmation because it is a permission mutation: the model cannot flip the
   flag by itself, and a question about Freedom Financial is not an enable request.
   The UI is the authenticated user writing their own row, so it does not go
   through the model. Neither path accepts another user's id, and neither path
   can grant a write.
5. Queries stay inside `withUserContext`. The new table uses the same
   `user_isolation` RLS policy as the other `chief_*` tables.

## Consequences

There is still one executor and one turn loop. Turning the flag off stops the
next read. Claude, GPT, and Grok do not own the flag. A migration must be
applied before the UI can save the row; until then a read fails closed.
