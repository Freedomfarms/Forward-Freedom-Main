# ADR-0033: CHIEF personality preferences

- Status: accepted
- Date: 2026-10-24
- Scope: CHIEF (Module 03)

## Context

CHIEF is one Claude Managed Agents agent, shared across users and keyed by the
tool fingerprint plus the protected-instruction revision. The agent `system`
text is identity, tools, and safety. Anthropic does not support a per-user
agent or a per-turn system-prompt override. Memory-store `instructions` are
attached when a session is created and are added to that session's system
prompt. They cannot be edited later. Session update can replace tools, not
that text.

Conversation, appearance, and voice delivery already live in browser
preferences. Personality has to follow the account across devices and must not
be the only copy in localStorage.

## Reuse check

No second reasoning engine and no per-preset Anthropic agent. The existing
`User` row was not extended: Prisma selects every scalar on an unscoped
`User` read, and a new `User` column would fail those reads before the
migration landed. `chief_personality` is a new one-row-per-user table with the
same `user_isolation` policy as the other CHIEF tables. Reads and writes go
through `withUserContext`.

## Decision

Settings → Personality stores preset, response length, three sliders, and
custom instructions on `chief_personality`. A missing row is the JARVIS
default for that user. Other settings are not written.

`src/utils/chiefPersonality.js` owns presets, stored fields, validation, and
`renderPersonalityGuidance`. Slider ranges become behavioral sentences. Raw
percentages are not sent to the model. Custom instructions are fenced as
lower-priority preferences. That module does not name a provider.

Claude delivery is `server/chief/managed/personalityDelivery.js`. It fits the
guidance into Anthropic's 4,096-character memory-store instruction field and
decides when an open session needs the one-time note. Another harness would
send `renderPersonalityGuidance` through its own channel. This change does
not add that channel.

On a turn, CHIEF writes `personality.md` in that user's memory store and, when
opening a provider session, sends the same guidance as the memory-store
`instructions`. An open provider session is kept. The next user message after
a saved change carries the guidance once. The transcript stores the user's
words, not that note. Later messages in the session do not repeat it.

`proposePersonalityAdjustment` is the extension point for a future confirmed
voice command. It does not persist. Settings is the only save path in this
change.

## Consequences

- One new shared agent is created the first time the protected system text
  (the sentence that preferences cannot override tools or safety) is deployed.
  Personality edits do not create agents.
- Apply `20261024180000_chief_personality` before expecting saves to stick.
  Until then, CHIEF uses the JARVIS default and a save returns 503.
- An in-flight provider session does not hot-swap its system prompt. The
  memory file updates immediately. The one-time note lands on the next user
  message. A new conversation gets the guidance in the session instructions.
