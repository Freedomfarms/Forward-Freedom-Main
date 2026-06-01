# AGENTS.md

## Cursor Cloud specific instructions

### Validation preference: minimal validation by default

Use a minimal validation workflow unless the user explicitly requests deeper testing.

For small UI/styling changes:
- Make the edit.
- Run lint/build once only.
- Perform one quick manual verification of the exact requested behavior.
- Stop.

Do not:
- Record videos.
- Repeat validations.
- Prove hover vs click behavior unless explicitly requested.
- Do extended walkthroughs.
- Re-test unrelated areas.
- Narrate validation in detail.

Escalate testing only if:
1. Build/lint fails.
2. There is an actual runtime error.
3. The change touches shared/core logic.
4. The user explicitly asks for full QA.

Keep responses concise:
- What changed.
- Whether lint/build passed.
- One-line verification result.
