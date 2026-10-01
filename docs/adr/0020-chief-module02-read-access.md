# ADR-0020: Per-user Module 02 read access for CHIEF

- Status: proposed with the Module 02 read-only slice
- Date: 2026-10-01

## Decision

1. `finance_summary` and `workspace_plan_summary` remain the only Module 02
   reads. They already return the aggregates and plan slice Module 02 computes.
   This slice does not add transaction, account, budget, or settings mutation
   tools, and it does not widen those reads.
2. Each user has one `chief_module_access` row. `module02Read` defaults to
   false, and a missing row is off. Existing and new users are off until that
   user turns it on. The flag is not a `chief_capability_grant` row, because
   any grant row replaces the whole baseline.
3. `finance:read` stays on the empty-grant baseline so the read tools can run
   and return "Module 02 read access is currently disabled." The data load
   happens only after `denyUnlessModule02Read` allows that user. `module:access`
   is a separate baseline capability for the status and set tools. It does not
   reveal financial data. `web:search` is unchanged.
4. The Module 02 sidebar control (`Module02ChiefAccess`) and
   `module02_access_set` both call the same store. The set tool requires
   confirmation because it is a permission mutation: the model cannot flip the
   flag by itself, and a question about Module 02 is not an enable request.
   The UI is the authenticated user writing their own row, so it does not go
   through the model. Neither path accepts another user's id, and neither path
   can grant a write.
5. Queries stay inside `withUserContext`. The new table uses the same
   `user_isolation` RLS policy as the other `chief_*` tables.

## Consequences

There is still one executor and one turn loop. Turning the flag off stops the
next read. Claude, GPT, and Grok do not own the flag. A migration must be
applied before the UI can save the row; until then a read fails closed.
