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

## Shared wiki (Karpathy LLM Wiki)

Cross-project memory for Freedom OS and Forward Freedom Financial lives in the private repo
`Freedomfarms/ai-development-wiki`, expected as a sibling checkout at `../ai-development-wiki`
(`AI_DEV_WIKI_DIR` overrides the location). Setup details: `docs/SHARED_WIKI.md`.

Read before work:

1. Run `scripts/cloud-agent-wiki.sh check`. If it prints `WARNING`, the wiki is not available:
   state that explicitly in your summary, do not claim shared memory was loaded, and continue with
   this repo's own `README.md` and `docs/`.
2. If it is available, read `wiki/index.md`, then the project architecture page for this repo and
   the shared standards it links, before changing code.

Knowledge updates are PR-only:

- Never commit or push directly to the wiki's `main`, and never copy wiki content into this repo.
- Propose wiki changes as a branch + pull request in `ai-development-wiki`. If you cannot open one
  from the session, list the proposed entries under a "Wiki updates" heading in this repo's PR
  description so they can be filed separately.
