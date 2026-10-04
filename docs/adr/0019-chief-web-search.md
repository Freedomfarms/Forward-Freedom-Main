# ADR-0019: CHIEF web search is one read-only governed tool

- Status: proposed with the governed web-search slice
- Date: 2026-09-30
- Scope: `server/chief/tools/web-search.js`, `server/chief/tools/builtin.js`,
  `server/chief/tools/inventory.js`, `server/chief/security/grants.js`,
  `server/chief/context/assemble.js`, `src/utils/chiefProtocol.js`

## Context

CHIEF can answer from memory, finance reads, and skills, and it can switch
among configured Claude, GPT, and Grok models in one session. It cannot look
up the public web. A production question ("any news on XRP today?") correctly
came back as no web access.

The CEO agent already calls Anthropic's provider-executed `web_search` tool.
That call never enters `ToolExecutor`, and it exists only when the model is
Claude.

## Reuse check (mandatory)

- OpenJarvis tool execution (`src/openjarvis/tools/_stubs.py`, `5e5f5ef`) is
  already ported. `web_search` is another `BaseTool` on that executor. The
  gate order is unchanged. The upstream sink policy already names `web_search`
  as a PII and SECRET sink; this slice registers the tool that policy covers.
- The boundary guard still blocks non-local tools (ADR-0004). `web_search` is
  local because the HTTP call is inside this process to one fixed host. A
  non-local flag would refuse every search. Result text is injection-scanned
  and fenced in the tool, because the executor's output scan skips local tools.
- Anthropic `webSearch_20250305` (`server/agents/llm.js`) stays on the CEO
  agent. CHIEF does not import `server/agents`. A provider-executed search
  would disappear when the session switches to GPT or Grok.
- Hermes browsing and möbius web-search events are not a second runtime. The
  existing `tool_call_begin` status is enough. The protocol tags
  `web_search_begin` and `web_search_end` stay unused.
- No search SDK is added. Node `fetch` calls Brave Search. Credentials follow
  the model-layer rule: a `CHIEF_`-prefixed variable wins, then the shared name.

## Decision

1. `web_search` is a read-only inventoried tool. `requiresConfirmation` is
   false. The capability is `web:search`, a CHIEF label. It is not
   `network:fetch`. The inventory floor is `web:search`, so an uninventoried
   alias still fails closed as `system:admin`.
2. `loadCapabilityPolicy` grants `web:search` on the empty-row baseline,
   beside the Phase 16 labels. `network:fetch` stays off that baseline. An
   explicit grant row is merged onto the baseline. An explicit deny still
   removes the named capability. A failed load stays deny-all.
3. The only network call is `GET https://api.search.brave.com/res/v1/web/search`
   with `redirect: "error"`. The model cannot supply a URL, host, or method.
   Result links are returned as text. They are not fetched.
4. The key is `CHIEF_BRAVE_SEARCH_API_KEY`, else `BRAVE_SEARCH_API_KEY`. It is
   sent only as `X-Subscription-Token`. Tool output, checkpoints, and the
   browser status line do not receive it. A missing key, or HTTP 401/403, is
   `web search is currently unavailable`. Any other provider failure is
   `web search failed`. Neither path fabricates results.
5. When `web_search` is in the turn's tool list, the system prompt tells the
   model to call it for current public facts, cite the returned sources, and
   admit an unavailable or failed search. The selected model does not decide
   whether the tool exists.
6. The CHIEF status line for this tool is "CHIEF is searching the web...".
   No other UI change.

## Consequences

A scheduled turn can call `web_search` through the same executor. This slice
does not add a news monitor, a browser, login, posting, or a new runtime.
`network:fetch` remains denied, so a future general HTTP tool is still closed.
Production search stays dark until one of the two Brave key variables is set
on the server. This slice does not set it.
