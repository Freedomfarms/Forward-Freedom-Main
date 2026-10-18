Integrate the approved CHIEF Frontier prototype into the existing signed-in CHIEF interface in this Freedom OS repository.

The approved source is already in:

design-references/chief-frontier/

Read index.html, chief.css, chief.js, and README.md before making changes. The source corresponds to this visual prototype:

https://freedom-chief-frontier.navyowl11.chatgpt.site

Use the supplied source code as the visual authority. Work from the files even if the private preview URL cannot be opened.

GOAL

Make the existing CHIEF interface look and move like this exact prototype. Carry over its composition, near-black navy background, icy electric blue palette, typography, spacing, illuminated borders, glass panels, sphere, lightning, orbit traces, stars, horizon, and conversation dock. Reuse the provided rendering code instead of approximating the appearance from screenshots.

This is the signed-in CHIEF workspace. Keep it within one viewport with no page scrolling. Preserve mobile and short-height adaptations. Let conversation history scroll inside its own bounded panel when needed so the composer and essential controls remain reachable. Do not turn this into the homepage's scrolling journey.

SCOPE

Inspect the current routing, CHIEF components, shell, styles, and existing actions first. Apply the new presentation to the existing CHIEF route. Keep the approved homepage, login/signup experience, financial pages, auth infrastructure, APIs, memory, tools, model services, data models, and integrations intact. Preserve current fixes and user work. Avoid unrelated refactors, dependency upgrades, and backend changes.

Do not replace the root application index.html or routing with this standalone reference. Leave the reference files intact as the approved comparison target.

SPHERE AND MOTION

Reuse chief.js's seeded allocation order, all 52 sphere paths, projection, lightning bolt and branch coordinates, orbit traces, and colors. Retain the slow rotation, breathing, moving filament highlights, opposing outer orbits, pointer drift, and understated environmental motion. Keep the sphere legible and visually central at the reference scale.

Drive listening, reasoning, and responding from the application's actual states. Map existing processing, searching, tool use, and error states appropriately without changing their underlying behavior or inventing activity. Keep state transitions smooth. Do not trigger a demo timeline during real conversations.

Retain the pixel-ratio cap, adaptive rendering quality, pause control, reduced-motion support, and visibility-based suspension. Reduced motion must still show a complete static sphere and lightning. Avoid duplicate render loops, and ensure stopping a response cancels the existing real operation as well as updating the display.

REAL APPLICATION BEHAVIOR

Replace local demonstration handlers with the existing app's real conversation, microphone, voice, model-selection, and navigation handlers. Preserve input/output modes, actual speech playback, Stop, error recovery, transcript visibility, conversation history, and preference persistence.

Use the existing logged-in identity for the greeting. Use the real available model catalog and current selected model. Do not hardcode the prototype's user, sample conversations, model options, or scripted answers into the live experience.

Keep the existing real conversation history and rendering capabilities, including supported formatted answers, code, links, streaming, and errors. Fit that experience into this design without discarding existing features. Preserve the ability to start, open, rename, archive, search, or delete conversations wherever currently supported.

Connect the sidebar and context controls to existing supported destinations and permission settings. If a pictured extension has no existing implementation, keep it clearly unavailable rather than adding a new service or claiming a connection exists. Use real permissions and availability for status labels.

Remove prototype-only labels, sample conversations, scripted responses, demonstration toasts, and Play Demo from the production screen once real handlers are connected. Keep meaningful loading, empty, disabled, error, and accessibility states.

FRAMEWORK ADAPTATION

Scope all CSS to the CHIEF experience. The reference contains document-level selectors; adapt them so the homepage, login, and financial pages retain their styles. Use component refs or root-scoped selectors.

Initialize animation after mounting. On unmount, clean up animation frames, timers, the clock interval, event listeners, resize/visibility handling, and media-query subscriptions. Handle development remounts without duplicate callbacks. Reuse the existing framework and do not add an animation library just to recreate what the supplied canvas code already does.

VALIDATION AND HANDOFF

Run the build once after implementation and the relevant existing required checks. Repeat only when an actual failure requires a fix. Verify desktop and mobile layout, state changes, a real conversation, response modes, Stop, reduced motion, and navigation away from/back to CHIEF using the project's established approach. Compare against the supplied reference at matching viewport sizes. Report anything that cannot be verified.

Finish with the changed files, existing handlers reused, concise validation results, and screenshots of the integrated CHIEF screen if available. Make the change reviewable in a draft PR using the repository's normal workflow. Stop before merging or deploying.
