# AGENTS.md

## Cursor Cloud specific instructions

### Validation preference: no validation on edits by default

Do NOT validate edits unless the user explicitly asks for testing.

For normal edits (including UI/styling changes):
- Make the edit.
- Stop.

Do not (unless explicitly requested):
- Run lint or build.
- Run automated tests.
- Do manual/browser testing.
- Record videos, take screenshots, or produce walkthroughs.
- Re-test unrelated areas or narrate validation.

Only validate when:
1. The user explicitly asks for testing/QA, or
2. The user reports a runtime error/bug and asks for a fix (verify the fix only).

Keep responses concise:
- What changed (one or two lines).
- No validation/testing sections unless testing was explicitly requested.
