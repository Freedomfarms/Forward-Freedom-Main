# ADR-0026: Workforce observation is a two-source journal

- Status: accepted as the Phase B foundation
- Date: 2026-10-02
- Renumbered from 0023 when the settings-capabilities ADR kept that number.
- Scope: `server/chief/workforce/`, `WorkforceBinding`, `ObservedAgent`, `ActivityEvent`

## Context

CHIEF will observe the Grok Bot workforce. Cursor Enterprise OpenTelemetry is
the authoritative action feed when a deployment has it. Self-report is the feed
that works without Enterprise, and it stays useful beside OTEL for names,
missions, and findings the telemetry does not carry. The two sources must remain
distinguishable. CHIEF must be able to say when platform telemetry is absent.

Grok Bot still owns execution. This ADR does not connect either ingress, does
not add a CHIEF tool, and does not draw a flow map.

## Reuse check (mandatory)

- OpenJarvis traces and the CHIEF event journal are the pattern: append-only,
  correlated, projected into a read model. Workforce events are not written to
  `ChiefTrace` or `ChiefEventJournal`, because those records are CHIEF's own turns.
- möbius idempotent journal writes are the pattern for duplicate delivery.
  Storage is Postgres, matching the rest of CHIEF.
- Hermes delegation ledgers are not ported. The unique key
  `(userId, source, sourceEventId)` is the smaller rule that matches OTEL's
  at-least-once `cursor.event.id`.
- `ChiefAgent`, `ChiefAgentTask`, and `ChiefAgentMessage` are not reused. They
  mean an agent Freedom OS owns and ticks.
- BUILD NEW: the source/trust split and the kind namespaces. No audited agent
  runtime has an external Grok Bot feed.

## Decision

1. Three tables, forced RLS on `userId`: `WorkforceBinding` (one per user),
   `ObservedAgent`, `ActivityEvent`.
2. `source` is `OTEL` or `SELF_REPORT`. `trust` is derived, never accepted from
   the payload: `PLATFORM` or `UNTRUSTED`. A check constraint enforces the pair.
3. OTEL kinds start with `cursor.`. Self-report kinds are the four
   `freedom.report.*` names. Each source rejects the other namespace.
4. A self-report cannot claim provenance `server`. Payloads cannot carry
   `userId` or `trust`.
5. `appendObservation` is the only writer. The same source event id does not
   replace the stored payload. The other source may store its own row with the
   same id string.
6. A display name is projected only from a newer `freedom.report.agent` event.
   OTEL does not set it. Liveness is computed from `lastEventAt`. An older event
   does not move that timestamp backward.
7. `describeCoverage` is the wording for later briefings. Self-report only must
   produce: "Agent status is based on self-reported activity; platform telemetry
   is unavailable."
8. No ingest route, no `workforce:read` tool, no memory write, no command to
   Grok Bot.

## Consequences

- A deployment without Enterprise OTEL can store self-reports once Phase C adds
  the route. Until then the tables are empty.
- Phase C's OTEL adapter and self-report adapter both call `appendObservation`.
  They do not invent a second table.
- Names on `ObservedAgent` are self-reported. Briefings must not describe them
  as platform facts. The event's `trust` column is the record of that.
- Revoking a binding stops further appends. It does not delete history.
