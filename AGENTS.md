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
2. If it is available, read `index.md` and `log.md` at the wiki root, then
   `wiki/projects/freedom-os/` and `wiki/projects/forward-freedom-financial/` (architecture pages
   for this repo) and the shared standards under `wiki/shared/`, before changing code.

Knowledge updates are PR-only. Cursor and Codex use the same check; do not start a second agent
to decide documentation impact.

- Never commit or push directly to the wiki's `main`, and never copy wiki content into this repo.
- On every pull request, run `node scripts/wiki-sync.mjs classify`. The path rules and the CI
  contract are in `docs/SHARED_WIKI.md`.
- A `neutral` result means the CI check records `no-update-required`. Leave routine bug fixes
  without a wiki edit.
- A `wiki-required` result means this diff changes architecture, integrations, agent capabilities,
  database or memory design, security or permissions, or development workflow. Update the shared
  wiki from the code you changed, preserve unrelated pages, and open or update a pull request in
  `ai-development-wiki`. Put this block in the project pull request body:

  ```markdown
  <!-- wiki-sync -->

  result: update-required
  wiki_pr: https://github.com/Freedomfarms/ai-development-wiki/pull/<number>
  reason: <which wiki pages changed and why>

  <!-- /wiki-sync -->
  ```

  The wiki pull request must name this project pull request
  (`Freedomfarms/Forward-Freedom-Main#<number>`) or this branch. Documentation is complete only
  after that wiki pull request is merged, or its head is already on the wiki default branch, and
  GitHub has an approving review on that exact head commit. The review can be from another user,
  or from the wiki repository owner (or a maintainer listed in the `WIKI_SYNC_MAINTAINERS`
  repository variable) submitting Approve on the wiki pull request. A sentence in the pull request
  body is not authorization. A new wiki commit needs a new review.

- If the classifier says `neutral` but the change is still something a future session would get
  wrong without a wiki note, use `result: update-required` anyway. That can raise the requirement.
  A `no-update-required` marker cannot lower it.
- If wiki write access is unavailable, do not claim the wiki was updated and do not treat a
  "Wiki updates" note as success. The documentation-sync check fails closed.
