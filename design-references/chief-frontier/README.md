# CHIEF Frontier: GitHub handoff

These are the exact HTML, CSS, and JavaScript files used by the approved CHIEF prototype:

https://freedom-chief-frontier.navyowl11.chatgpt.site

The three source files are unchanged. This README and the Cursor prompt explain how to integrate them into your existing Freedom OS application.

## Add the files to GitHub

In your existing Freedom OS repository, choose Add file > Create new file. For each download, copy its entire contents into the corresponding file below. Include the folder path when naming each file. Save without the final `.txt` extension.

| Download | GitHub filename |
| --- | --- |
| index.html.txt | design-references/chief-frontier/index.html |
| chief.css.txt | design-references/chief-frontier/chief.css |
| chief.js.txt | design-references/chief-frontier/chief.js |
| README.md.txt | design-references/chief-frontier/README.md |
| CURSOR_PROMPT.md.txt | design-references/chief-frontier/CURSOR_PROMPT.md |

Keep all five files together. The HTML expects `chief.css` and `chief.js` in the same folder. If using GitHub's Upload files instead, rename the downloaded files to remove `.txt` before uploading.

After the files are in the repository, open CURSOR_PROMPT.md and paste its full contents into Cursor for that repository.

The reference folder does not automatically change the live application. Cursor must integrate it with the existing signed-in CHIEF screen. The `index.html` here is a design reference and should stay in this folder, rather than replacing the repository's root entry file.

## What you are transferring

- A fixed, single-screen CHIEF workspace with responsive layouts.
- The Frontier homepage's original seeded sphere geometry and central lightning bolt.
- Opposing orbit traces, filament lights, breathing, subtle stars, and an architectural horizon.
- Left navigation, right system and context panels, and bottom conversation controls.
- Local demonstrations of listening, reasoning, responding, stopping, and new conversations.
- Motion pause, reduced-motion support, and adaptive canvas rendering.

No external fonts, images, libraries, or API keys are needed to open the reference. For a standalone preview, open index.html with chief.css and chief.js beside it.

## Integration scope

This package updates the signed-in CHIEF interface. Keep the approved homepage and login flow intact, along with existing authentication, real conversation history, model selection, voice behavior, memory, tools, finance features, permissions, and backend services.

The prototype's conversations, state sequence, model picker, and response-mode controls are demonstrations. The microphone button does not record audio. Navigation and context tiles are visual placeholders. Cursor should connect existing supported behavior and remove demonstration messages from the integrated application.

## Verification

The three source downloads were compared byte for byte with the published prototype's source commit, 2014a6440aa8e1748bfe2573c10cd67c1b984f46. Packaging does not modify the design or animation. JavaScript syntax and source reference checks passed during prototype creation. Browser visual verification and live-app integration remain to be completed in the existing application.
