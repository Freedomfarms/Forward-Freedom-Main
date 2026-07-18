# AGENTS.md

## Cursor Cloud specific instructions

### Verification policy: fast terminal checks only

For all edits, verify with direct terminal commands only — `npm run lint`, `npm run build`, `npm run dev` (just confirm it starts, then stop it; no need to keep it running), or equivalent checks. Default to the fastest, cheapest verification that still confirms the code is correct.

Do NOT use screen recording, browser automation, or simulated UI clicking to verify changes. The only exception is a change that specifically touches UI behavior that cannot be confirmed any other way — and even then, ask the user first before doing that kind of verification, since it is slow and token-heavy.

Do not (unless explicitly requested):
- Do manual/browser testing or computer-use/GUI-driven testing.
- Record videos, take screenshots, or produce walkthroughs.
- Re-test unrelated areas or narrate validation.

Keep responses concise:
- What changed (one or two lines).
- Brief verification result (e.g. "lint and build pass"), nothing more.
