# ADR-0031: Live capture of Claude and ChatGPT conversations

- Status: accepted for Phase 4
- Date: 2026-10-13
- Scope: `server/chief/archive/capture.js`, `api/chief/external-capture.js`, `api/chief/capture-token.js`, `extension/`, `external_capture_credential`

## Context

Phase 1 stores historical Claude and ChatGPT exports in the encrypted external archive. Phase 2 searches that archive with CHIEF history. Phase 3 can derive durable notes only when the user explicitly keeps them. Phase 4 needs a user-controlled way to capture a completed conversation the user already has open, without a second archive or a new memory service.

## Reuse check (mandatory)

- The archive upsert, envelope encryption, ownership, redacted `recallDocument`, and unified search stay the existing implementation. No new transcript table, vector index, or memory service is added.
- The capture token follows the workforce report-key pattern: one SHA-256 hash, an embedded user id, and `timingSafeEqual`. The prefix is `ffc`, and the hash lives on `external_capture_credential` rather than `workforce_binding`.
- Claude's Messages API completes a prompt. It does not read claude.ai history. Personal export remains Settings, Privacy, Export data. The Enterprise Compliance API is organization-scoped and is not a personal OAuth capture API.
- OpenAI's Conversations API covers API-created conversations. Public documentation does not offer a personal API for chatgpt.com history. The undocumented `chatgpt.com/backend-api` session endpoint and cookie exporters were rejected because they depend on provider cookies.
- No audited OpenJarvis, möbius, or cortex-map package provides a permitted personal live-read API for these two sites. The extension is new because the permitted interface is the page the user already opened, plus the existing Freedom OS archive.

## Decision

1. A Manifest V3 extension, off until the user enables Claude and ChatGPT separately, reads only `https://claude.ai/*` and `https://chatgpt.com/*`. It uploads a snapshot only when the URL contains a conversation id and the page exposes message nodes the extractor recognizes. Otherwise it does not upload. Chrome parses content scripts as classic scripts, so the page entry is the bundled file `extension/dist/content.js` from `npm run build:extension`, not `extension/content.js`. The service worker remains a module.
2. The extension stores a user-minted `ffc` token in `chrome.storage.local`. Freedom OS shows the plaintext once and stores only the hash. The extension requests permission for the Freedom OS origin the user enters. Service secrets and provider cookies are not part of the extension.
3. `POST /api/chief/external-capture` authenticates that token, ignores a body `userId`, and calls `finalizeConversation` plus the existing archive upsert. A snapshot with fewer messages than the stored conversation is rejected and does not write. The same content hash is a duplicate. A longer or edited snapshot updates that conversation.
4. Capture does not call durable-note derivation. Pausing, disabling a provider, or revoking the token stops new writes. Transient failures retry with backoff and remain visible. The client records success only after the server returns `imported`, `updated`, or `duplicate`.
5. Selectors (`data-message-author-role`, `data-message-id`, Claude `data-testid` user and assistant messages, and the stop control) are a fixture contract. Live claude.ai and chatgpt.com were not tested. A site change that removes those attributes stops capture instead of scraping unrelated markup.

## Sources checked on 2026-10-13

- [Export your Claude data](https://support.claude.com/en/articles/9450526-export-your-claude-data) (July 8, 2026): personal export from Settings, Privacy. It is not a live API.
- [Claude Compliance API](https://platform.claude.com/docs/en/manage-claude/compliance-api): Enterprise organization content, using a Compliance Access Key. It is not a personal third-party token.
- [Exporting your ChatGPT history and data](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data): Settings, Data controls, Export data.
- [OpenAI Conversations API](https://developers.openai.com/api/reference/resources/conversations/): conversations created through the API. It does not document chatgpt.com history.

The extension was not run against claude.ai or chatgpt.com.

## Consequences

The user installs the unpacked `extension/` directory after `npm run build:extension` has refreshed `extension/dist/content.js`, creates a token in Imported chats, pastes the token and Freedom OS origin, and enables each provider in both places. The first snapshot can contain only the messages the page rendered. Later longer snapshots can grow the archive. A shorter snapshot cannot replace a longer one. Live database RLS was not executed in this slice. The migration enables and forces `user_isolation` on `external_capture_credential`.
