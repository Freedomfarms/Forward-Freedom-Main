# CHIEF control plane and workforce journal — implementation plan

Status: approved direction, with the both-ingress amendment. Phase A and the Phase B
foundation are in place. Phase C connects the self-report ingress only.
Enterprise OpenTelemetry was checked on 2026-10-02 and is not available here:
the cloud environment is personal, and there is no OTEL collector credential.
The OTEL route is not built. CHIEF reads the journal through the read-only workforce_status tool.

Phase C in this change is the self-report ingress. Phases D through H are specified
here so later work has a place to land. They are not built.

Governing rules:

- Grok Bot owns the agents. Freedom OS does not create or host them.
- The activity journal is the operational record.
- Platform telemetry (OTEL) and self-report are both first-class ingresses. Neither
  is required for the other to function.
- OTEL is authoritative for actions it delivered. Self-report is contextual and
  untrusted. CHIEF names which one it is using.
- `ChiefAgent`, `ChiefAgentTask`, and `ChiefAgentMessage` stay unused.
- No flow-map UI, no memory writer, no command path back to Grok Bot.
- CHIEF reads Freedom OS source through the registry's `code:read` tools. That
  grant stays off the empty-grant baseline. The control plane makes source write,
  commit, push, and deploy impossible to register.

---

## 1. Files and tables

### This change

| Path                                                              | Change                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `server/chief/control/plane.js`                                   | Capability catalog. Live tools, reserved operations, forbidden repository mutations. |
| `server/chief/core/capabilities.js`                               | Add `workforce:read`. Repository read uses the registry's `code:read`.               |
| `server/chief/security/grants.js`                                 | Baseline comes from the catalog. The two new labels are not on it.                   |
| `server/chief/tools/inventory.js`                                 | Registration rejects forbidden control-plane tool names.                             |
| `server/chief/tools/spec.js`                                      | A tool spec cannot be constructed when registration would reject it.                 |
| `server/chief/tools/builtin.js`                                   | Building the tool list checks the catalog against the inventory.                     |
| `server/chief/workforce/journal.js`                               | Source, trust, kind namespaces, coverage wording, agent projection.                  |
| `server/chief/workforce/store.js`                                 | The only writer: binding, idempotent append, projection.                             |
| `prisma/schema.prisma`                                            | `WorkforceBinding`, `ObservedAgent`, `ActivityEvent`.                                |
| `prisma/migrations/20261002150000_workforce_observation_journal/` | Tables, trust check, RLS.                                                            |
| `docs/adr/0025-chief-control-plane.md`                            | Phase A decision. Renumbered so the registry ADR keeps 0022.                         |
| `docs/adr/0026-workforce-observation-journal.md`                  | Phase B decision. Renumbered so the settings ADR keeps 0023.                         |
| `test/chief-control-plane.test.js`                                | Catalog, baseline, forbidden repository tools.                                       |
| `test/chief-workforce-journal.test.js`                            | Both sources, trust, idempotency, coverage sentence.                                 |

### Later phases (not this change)

| Phase | Adds                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| C     | Self-report ingress calls `appendObservation`. OTEL waits until Enterprise export exists.                                       |
| D     | Read-only `workforce_picture` tool, capability `workforce:read`, still not on the empty-grant baseline until explicitly granted |
| E     | TurnMachine briefing that must include `describeCoverage`                                                                       |
| F     | Pure graph function over the journal. No canvas.                                                                                |
| G     | A memory consumer of `ActivityEvent`. It does not promote self-reports to trusted facts.                                        |
| H     | A written evaluation of a command path. No client until a real Grok Bot submit API exists.                                      |

---

## 2. Existing systems reused

TurnMachine, ToolExecutor and its gate order, `CapabilityPolicy`, confirmation,
the scheduler, traces, the xAI provider, Firebase auth, Postgres RLS,
`withUserContext`, sessions, and the current room UI stay as they are.

The catalog describes tools that already exist. It does not replace the executor.
`ChiefTrace` remains the trace of CHIEF's own turns. Workforce rows are separate.
`ChiefAgent*` is not read or written.

---

## 3. New abstractions

**Control plane.** One frozen list of operations. Each operation has a domain,
an effect (`read`, `confirm`, or `forbidden`), a status (`live`, `reserved`, or
`forbidden`), and, when it can run, exactly one capability label and one tool name.

Adding a capability later means adding one catalog row, one inventory floor, and
one tool. A tool that is not in both lists cannot be the live set. A forbidden
row has no capability label, so it cannot be granted.

**Observation journal.** `normalizeObservation` is the only way to shape an event.
Trust is derived from the source. OTEL events use the `cursor.*` kind namespace.
Self-reports use `freedom.report.*`. Each source rejects the other's kinds.
`appendObservation` is the only writer.

**Coverage.** `describeCoverage` is the sentence CHIEF must be able to say. The
self-report-only sentence is fixed: "Agent status is based on self-reported
activity; platform telemetry is unavailable."

---

## 4. Security boundaries

- Repository mutation is not a capability. `codebase:write`, `git:commit`,
  `git:push`, and `deploy` are not labels. Tool names `codebase_write`,
  `source_write`, `git_commit`, `git_push`, `git_add`, and `deploy` cannot be
  constructed. Repository read is `code:read` on `code_tree`, `code_read`, and
  `code_search`, on the baseline.
- `file:write` stays an unused OpenJarvis label for a future user-file operation.
  It is not source write, it is not granted, and it has no tool.
- `workforce:read` is off the baseline. Nothing in this change exposes a tool.
- Observation payloads cannot set `userId` or `trust`. A self-report cannot claim
  server provenance. An OTEL event cannot use a `freedom.report.*` kind.
- Bindings are one per Freedom OS user. A revoked binding accepts no events.
- Email is stored only as ciphertext the caller already sealed. The writer
  rejects a plaintext `email` field.
- New tables use forced RLS on `userId`, same predicate as `chief_*`.
- A database check constraint pairs `OTEL` with `PLATFORM` and `SELF_REPORT`
  with `UNTRUSTED`.
- Self-report text is sealed before insert. The writer does not persist plaintext.

---

## 5. API boundaries

Phase C adds the self-report routes. The OTEL route is not built.

| Route                                  | Caller                            | Writes                          |
| -------------------------------------- | --------------------------------- | ------------------------------- |
| `POST /api/chief/workforce/report`     | Per-user report key               | `source: self_report` only      |
| `POST /api/chief/workforce/report-key` | Signed-in Freedom OS user         | Key hash on that user's binding |
| OTEL `POST /v1/logs`                   | Not available in this environment | Not built                       |

The report body does not choose the user. The key does. CHIEF's chat API is
unchanged. `workforce_picture` is still Phase D.

---

## 6. Data flow

```
Catalog  ->  grants baseline  ->  CapabilityPolicy  ->  ToolExecutor
Live tools stay on that path. Reserved and forbidden rows have no executor entry.

Report key  ->  user id from the key, never from the body
        |
        v
shapeSelfReport  ->  source self_report, provenance report
        |
        v
normalizeObservation  ->  trust UNTRUSTED, freedom.report.* kinds
        |
        v
appendObservation(tx, userId)  ->  ActivityEvent
        |
        v
projectAgent  ->  ObservedAgent (name only from a self-report identity event)
        |
        v
describeCoverage  ->  later briefing (Phase E)

Enterprise OTEL has no route until a deployment actually has the export.
```

OTEL absence does not block a self-report, and a self-report does not overwrite
an OTEL event. Idempotency is `(userId, source, sourceEventId)`.

---

## 7. Migration strategy

One additive migration. No changes to `chief_agent`, `chief_agent_task`, or
`chief_agent_message`. No backfill. Existing sessions, grants, and tools keep
their rows and behavior.

The empty-grant baseline is the reconciled catalog. It includes the registry
labels for schedule read, conversation write and delete, and settings. Users
with an explicit grant row are unchanged. `workforce:read` and `code:read` stay
off that baseline until granted on purpose.

Deploy order is the usual Prisma migration. The journal has no reader in the
request path yet, so a migrate-forward is enough. Rollback is dropping the three
new tables; no old column is rewritten.

---

## 8. Testing strategy

Unit tests, no browser:

- Catalog covers every inventoried tool once, with the same capability.
- Baseline list is the catalog's baseline capabilities, and excludes `workforce:read`, `code:read`,
  `file:write`, `code:execute`, and `tool:invoke`.
- Constructing `git_commit`, `git_push`, `deploy`, or `codebase_write` throws.
- The codebase domain has no effect other than `read` or `forbidden`.
- OTEL and self-report both append. Trust is derived. Cross-namespace kinds throw.
- A self-report cannot set provenance `server` or `trust`.
- Duplicate source event id does not replace the first payload.
- A second source can record the same id string, because the unique key includes source.
- Coverage wording for self-report only, platform only, both, and neither.
- An agent display name is set only from `freedom.report.agent`, and an older
  event does not move `lastEventAt` backward.
- RLS migration enables and forces `user_isolation` on the three new tables.

`npm test` for the new files plus the capability, grant, tool, and RLS tests.
`npm run lint`.
