# Vendored: Everything Claude Code

- Upstream: https://github.com/affaan-m/ECC (`affaan-m/everything-claude-code` is this repository)
- Pin: `f3904009440af24f00617343910ee89714df8be3`
- Version: `2.2.3`
- License: MIT, Copyright (c) 2026 Affaan Mustafa. Text: `LICENSE` in this directory.
- Integrity: `checksums.json` records the upstream path and sha256 of every copied file.

Copied unchanged:

- `hooks/block-no-verify.js` and `hooks/lib/shell-scan.js` (its only local dependency)
- `hooks/config-protection.js`
- `rules/common/` and `rules/typescript/`
- The skill files named in `catalog.json`

Not copied: `src/llm`, Hermes, the state store, agent definitions, slash commands, `workflows/orch-review.workflow.js`, session writers, and the upstream `.cursor/hooks.json`.

`package.json` in this directory is Freedom OS metadata. It is not upstream. It marks this folder as CommonJS so Node can run the unchanged hook scripts inside a repository whose root package is ESM.

`catalog.json` is the Freedom OS catalog. It is not upstream `scripts/catalog.js`.

The live Cursor hook configuration is `.cursor/hooks.json` at the repository root. It calls `server/chief/ecc/cursorHook.js`. It does not run `claude`, session writers, or the upstream stop hook.
