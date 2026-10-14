# ADR-0032: Controlled cross-model context sharing

- Status: accepted for Phase 5
- Date: 2026-10-13
- Scope: `server/chief/context/share.js`, `api/chief/context-share.js`, Share context in CHIEF settings

## Context

Phases 1–3 keep Claude and ChatGPT transcripts in the encrypted archive, search them with CHIEF history, and derive durable notes only when the user asks. Phase 4 can capture a completed page into that same archive. The native chats stay in Claude and ChatGPT. The missing step is a reviewable way to hand a small selection back to one of those apps.

## Reuse check (mandatory)

- Retrieval uses `searchOwnedHistories`, `retrieveOwnedHistory`, and `selectPersonalFacts`. No new search index or vector store is added.
- Durable memory stays `ChiefFact`. A shared package is not written back as a fact.
- Excerpts pass the existing injection scanner, `fencesOutput`, and `redactSensitiveSpans`. The copied text is wrapped with `fenceUntrustedOutput`.
- Claude custom connectors and ChatGPT developer-mode MCP were checked as a possible native handoff. Claude custom connectors require a public remote MCP server and, on Team or Enterprise, an owner to add it ([Claude Help Center](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). ChatGPT custom MCP is not on every personal plan. This codebase cannot see that subscription, and a connector would still need a server holding Freedom OS credentials. Clipboard paste works in both native apps without those assumptions, so MCP is not required and is not implemented.

## Decision

1. Share context is a CHIEF settings action. It is off until the user searches, selects items, chooses Claude or ChatGPT, and confirms the copy.
2. A proposal may contain at most eight items: stored facts, historical statements, and uncertain notes. Each item names its provider, title, time, and message references when the archive has them. Items start unselected. The user can remove one before copying.
3. The server rebuilds the package from owned records. A body `userId` or a client-supplied excerpt is ignored. Archive excerpts come from the query-ranked historical block. Instruction-like lines and secret-like lines are left out, and a dropped secret stays marked even when other lines remain. Credential-shaped message and conversation ids are omitted; ordinary ids are not run through the recall redactor. The payload is capped.
4. Copy sends `action: "handoff"` plus the server-issued query seal and per-item content hashes. The server recomputes those hashes from current owned records. A changed record or a changed question returns a stale error and no package. The client hash is not the exported text.
5. A successful copy writes a counts-only `chief_audit_log` row. The row does not contain the package or the question.
6. Freedom OS does not send the package to Claude or ChatGPT. The user pastes it. Native histories are not imported by this action, and the package is not saved as a durable note.

## Consequences

The first accepted snapshot and the export archive are the historical sources this screen can see. Live Claude and ChatGPT connectors were not configured or called. Live Postgres RLS was not executed for this slice. A site or model may still treat pasted text as instructions; the fence tells it not to, and the scanner removes the lines CHIEF already treats as high-risk.
