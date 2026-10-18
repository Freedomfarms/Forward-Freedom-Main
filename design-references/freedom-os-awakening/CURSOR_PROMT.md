Integrate the approved Freedom OS — Awakening prototype into the existing application's signed-out homepage and login/signup experience.

First read AGENTS.md and applicable project instructions, then inspect the current public-page components, route selection, authentication, shared visual shell, and legal links. Start from the current application and preserve unrelated work. Do not merge or deploy.

SOURCE OF TRUTH

Use these files in `design-references/freedom-os-awakening/`:
- index.html
- frontier.css
- frontier.js
- README.md

This is the new six-second opening version, matching https://freedom-os-awakening.navyowl11.chatgpt.site. Use it instead of the older Frontier package or Draft 4 as the implementation reference. Read and port the actual code. Do not approximate it from a screenshot or redesign it.

If the files were uploaded with the download names `awakening-index.html.txt`, `awakening-frontier.css.txt`, or `awakening-frontier.js.txt`, locate and read those exact text files as source. Normalize their reference filenames as needed without discarding their contents.

VISUAL REQUIREMENTS

Preserve the palette, typography, copy, chapter dimensions, sphere geometry, seeded strand allocation, lightning, American flag, capability cards, dialogs, and scroll choreography. The opening forms the actual chapter 01 composition; it is not a separate splash screen followed by a replacement homepage.

Keep the single continuous journey: chapter 01 landing → chapter 02 capabilities → chapter 03 freedom → chapter 04 account entry. Enter Freedom OS should move to account entry within this journey.

OPENING REQUIREMENTS

Preserve the source's six-second clock and reveal timings. Play on a fresh document load at the top, then release scrolling. Scrolling back to chapter 01 must not restart it. Refreshing at the top may replay it. Direct entry links and restored pages should remain immediately usable.

Keep Skip intro, Escape, early navigation completion, motion pause/resume, hidden-tab suspension, and reduced-motion bypass. Preserve the separation between the one-time opening state and the scroll-driven scene state. Never restart the intro because of a component rerender, a hash change back to home, or an authentication state refresh.

Adapt lifecycle handling to the framework. Initialize after the public page mounts, keep one animation loop, scope DOM queries to the component, and clean up animation frames, listeners, subscriptions, and any pending timers on unmount. Prevent development remounts from creating duplicate renderers. Release scroll locking and inert states when the page unmounts or the opening is skipped. Preserve adaptive rendering quality and device-pixel-ratio limits.

REAL AUTHENTICATION AND ROUTING

Replace the local demo form, Google button handler, and placeholder legal dialogs with the existing application's real flows and legal links. Preserve current providers, required fields, consent rules, loading/error states, session restoration, return-to URLs, and post-login redirects. If real authentication needs additional fields or steps, use them within the reference's form styling.

Keep current login/signup deep links working, including the correct account-action tab, without imposing an intro delay. Preserve authenticated-user redirects. Inspect the actual routes rather than inventing new ones. Remove preview-only authentication labels/messages only after the real handlers are connected.

SCOPE

Limit changes to the public homepage and account-entry presentation and the wiring necessary to connect them. Scope the standalone CSS so it cannot change the signed-in application. Keep signed-in CHIEF, financial pages, settings, tools, memory, APIs, data models, voice behavior, and provider integrations intact. Do not replace the application root with the static prototype or perform unrelated refactors.

VALIDATION AND HANDOFF

Run one build and the relevant required project checks. Check the opening and scroll journey at desktop and mobile widths, including returning to chapter 01, skipping, pausing, reduced motion, and direct login/signup navigation. Compare actual integrated screenshots against the reference at matching viewport sizes. Verify existing authentication using the project's established test approach; do not create a real account or sign in to a personal account without authorization.

Report the files changed, existing authentication/routes reused, validation results, and anything not verified. Stop before merging or deploying.
