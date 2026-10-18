# Freedom OS — Awakening: GitHub handoff

This is the six-second opening version of the Frontier homepage, matching the published prototype at https://freedom-os-awakening.navyowl11.chatgpt.site.

Source commit: `2bd051fe8156622838426011650b7da39d01ec0f`.

## Upload manually to GitHub

Create `design-references/freedom-os-awakening/` in your existing Freedom OS repository. Open each downloaded text file, copy all its contents, and use GitHub's Add file → Create new file. Save with these names:

| Download | GitHub filename inside the new folder |
| --- | --- |
| `awakening-index.html.txt` | `index.html` |
| `awakening-frontier.css.txt` | `frontier.css` |
| `awakening-frontier.js.txt` | `frontier.js` |
| `awakening-README.md.txt` | `README.md` |
| `awakening-CURSOR_PROMPT.md.txt` | `CURSOR_PROMPT.md` |

Do not include the `awakening-` prefix or the final `.txt` in the GitHub filenames. Keep the three runtime files together. Do not replace your application's root index.html with this reference file.

Alternatively, unzip `freedom-os-awakening-github.zip` and upload the contents of its `freedom-os-awakening` folder into the reference folder above. The ZIP uses the correct filenames already.

Once the files are in GitHub, paste the full contents of CURSOR_PROMPT.md into Cursor with your current Freedom OS repository selected.

## Preview

Open index.html in a modern browser with frontier.css and frontier.js beside it. No installation, build step, API key, external font, or image download is required.

The three runtime files are exact copies of the published prototype's source. This export does not redesign the page.

## Opening behavior

- A fresh load at the top builds chapter 01 over six seconds: filaments, lightning, headline, CHIEF label, then the completed landing scene.
- Chapters 02–04 retain the original scrolling capability panels, American flag scene, and account-entry preview.
- Returning to chapter 01 does not replay the opening. Refresh at the top to replay it.
- Skip intro, Escape, or a destination link can finish the opening early.
- The motion button pauses the opening and ambient motion. Hidden tabs suspend the opening clock.
- Reduced-motion users, restored pages, and direct links to later chapters bypass the opening.

## Integration scope

This package is a public homepage and login/signup visual reference. Its form and Google button are demonstrations; they do not authenticate, create accounts, send credentials, or connect to providers. Terms and Privacy dialogs are placeholders.

Cursor must reuse the existing application's authentication, legal pages, session handling, and navigation. Preserve signed-in CHIEF, financial pages, tools, memory, providers, and backend behavior. Uploading these reference files alone does not integrate or deploy the new homepage.

## Validation

The prototype passed JavaScript syntax and deterministic runtime checks for the six-second finish, scroll return, early skip, pause/resume, hidden tabs, reduced motion, deep links, browser restoration, and a single animation loop. Runtime checks used a simulated DOM/canvas. Visual browser playback was not verified in the build environment and should be reviewed during integration.
