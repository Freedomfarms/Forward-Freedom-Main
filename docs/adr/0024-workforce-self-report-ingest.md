# ADR-0024: Phase C connects self-report because Enterprise OTEL is unavailable

- Status: accepted
- Date: 2026-10-02
- Scope: `server/chief/workforce/ingest.js`, `api/chief/workforce/report`, `api/chief/workforce/report-key`

## Context

Phase C connects the observation source this environment can actually use.
Both ingresses stay first-class in the journal. Only one can be connected now.

Checked 2026-10-02:

- The cloud environment source is Personal, not an Enterprise export destination.
- The process environment has no OTEL, OTLP, or workforce collector credential.
- The repo has no OpenTelemetry dependency and no collector URL.
- Cursor Enterprise Action Recording export is the only platform feed, and it is not configured here.

Self-report is the ingress that works without that feed. A report is an assertion. It is not platform telemetry.

## Decision

1. `POST /api/chief/workforce/report` accepts a per-user report key and writes only through `appendObservation`.
2. `POST`, `DELETE`, and `GET /api/chief/workforce/report-key` issue, revoke, and show whether a key is active. The plaintext key is returned once. The binding stores a SHA-256 hash.
3. The key embeds the Freedom OS user id so the lookup runs inside that user's row-level-security context. The service-role client is not used. The body cannot set `userId`, `trust`, or platform provenance.
4. Stored source is `SELF_REPORT`. Stored trust is `UNTRUSTED`. Kinds stay `freedom.report.*`.
5. There is no OTEL route. There is no `workforce_picture` tool, no briefing, no flow map, no memory writer, and no command path.

## Consequences

- A signed-in user can issue a key. A holder of that key can append untrusted observations for that user only.
- CHIEF still cannot read the journal. Phase D is the read tool.
- No Grok Bot is wired to this route by this change. Until something posts a report, the tables stay empty.
- A later Enterprise OTEL adapter calls the same writer with `source: otel`. It does not replace this route.
