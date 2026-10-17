This is the approved visual prototype: Draft 1's animation and layout, lightning-blue colors, and Draft 2's sphere design. The sphere stays centered around the lightning bolt. Six panels unfold with staggered entrances and remain visible. The conversation dock appears at the end.
Take this to Cursor
1. Unzip this folder.
2. Put the entire folder inside your existing Freedom OS repository, for example at design-references/freedom-chief-draft-4-cursor/.
3. Open that repository in Cursor.
4. Paste the contents of CURSOR_PROMPT.md into Cursor's chat and attach/reference this folder.
Cursor should integrate the supplied visual code into the current application, keeping the real conversations, voice controls, permissions, model selection and module navigation.
Files
File	Purpose
index.html	Runnable markup that loads the separate CSS and JavaScript files.
chief-intro.css	All styles, colors, panel layouts and responsive breakpoints.
chief-intro.js	Exact animation and local interactions extracted from the approved HTML.
freedom-chief-prototype-draft-4.html	Original, unchanged all-in-one prototype; the visual reference.
CURSOR_PROMPT.md	Implementation instructions to paste into Cursor.
handoff.json	File inventory, checksums and design notes for the handoff; not runtime configuration.


Open index.html or freedom-chief-prototype-draft-4.html in a modern browser to preview. Keep the CSS and JS beside index.html. There is no installation, build step, font download, API key or npm dependency. There is no package.json because this is a plain browser prototype; use the existing application's package setup when integrating.
Exact design to preserve
- Centered, slowly rotating filament sphere with two tilted orbital contours and a small bright heart.
- Lightning-blue / ice-blue palette, luminous branching bolt, particles and traveling filament light.
- Draft 1's panel layout, staggered reveal, easing, depth, pointer drift and dock reveal.
- Six capabilities: Reasoning, Memory, Knowledge, System Intelligence, Execution and Live Status.
- Default duration: 5,800 ms (the selector calls this 6s). Optional slow duration: 8,000 ms.
- The sphere does not travel down the bolt. Panels do not disappear one by one. Those are earlier alternative drafts, not this design.
Integration notes
This package is a working standalone visual prototype, not an already integrated React component. chief-intro.js initializes once against #freedom-chief-draft-four. Cursor must adapt the markup and renderer lifecycle to the app; simply pasting a script tag into JSX is not sufficient.
The current controller is exposed on the root element as root.chiefPrototype with replay(), skip(), destroy(), inspect() and renderAt(ms). destroy() cancels the frame loop and disconnects observers and event listeners. renderAt(ms) is a diagnostic drawing hook; it does not pause or seek the live loop.
Use the existing CHIEF rendering infrastructure where practical, with one visual renderer and one animation loop. Avoid mounting this entire canvas on top of the existing core. In React, initialize after mount, clean up on unmount, and handle development Strict Mode remounts. Keep frame-by-frame updates out of React state.
This prototype autoplays on page initialization. For the real application, follow the existing activation lifecycle; if no policy exists, play once per signed-in user per browser-tab session after the renderer is ready, with manual Replay. Switching conversations, sending messages or returning to a module must not restart it. The existing conversation UI should remain usable during and after the intro.
The demo composer only displays a local preview message. Capability buttons open explanatory dialogs. Nothing is connected to a model, memory store, tool or API. Use real application handlers when available, and keep an honest informational placeholder otherwise. Do not import the demo submit handler as real chat behavior.
CSS is scoped to the prototype root except for the standalone body reset; a standalone page sizing rule also appears at the start of chief-intro.css. Do not copy those page-only rules globally into the app. If the root ID changes, update the CSS and renderer selectors together. The current prototype assumes one mounted instance.
Verification
The separated JavaScript is byte-for-byte identical to the original script. Both original style blocks are preserved in their original cascade order. The original all-in-one HTML is included byte-for-byte unchanged. Local script syntax and file references were checked during packaging.
Previous Draft 4 verification covered animation behavior in a mocked DOM and visual inspection of actual desktop/mobile canvas frames. Full browser layout and live Freedom OS integration still need to be tested in Cursor. The handoff does not claim that application tests or production integration have passed.
