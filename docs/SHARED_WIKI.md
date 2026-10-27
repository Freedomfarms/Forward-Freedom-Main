# Shared wiki (Karpathy LLM Wiki)

Cross-project knowledge for Freedom OS and Forward Freedom Financial lives in the private
repository `Freedomfarms/ai-development-wiki`. Agent sessions expect it as a sibling checkout of
this repo at `../ai-development-wiki` and read it before doing work (see `AGENTS.md`).

## Wiki layout

```text
ai-development-wiki/
  index.md                                   # entry point: read first
  log.md                                     # chronological log of changes and decisions
  wiki/
    projects/freedom-os/                     # Freedom OS architecture and project pages
    projects/forward-freedom-financial/      # Forward Freedom Financial architecture and project pages
    shared/                                  # shared standards and tooling
    shared/tooling/connecting-a-project-repo.md
```

Both project directories apply to this repository (the Freedom OS app hosts Forward Freedom
Financial).

## Helper script

`scripts/cloud-agent-wiki.sh` wires the wiki into a session:

| Command | Behaviour                                                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`  | Clone the wiki at `../ai-development-wiki` or fast-forward an existing checkout. Always exits 0; prints a `WARNING` when the wiki is unreachable.                                        |
| `check` | Confirm `index.md` is readable and list `log.md`, the tooling doc, the two project directories, `wiki/shared/`, and architecture/standards pages. Exits 1 with a `WARNING` when missing. |
| `path`  | Print the resolved wiki directory.                                                                                                                                                       |

Environment variables:

- `AI_DEV_WIKI_TOKEN`: optional read-only GitHub token supplied as a Cursor Cloud Agent secret.
  Used only when the environment's own GitHub token cannot read the wiki. It is sent as a
  per-invocation HTTP `Authorization` header; it is never printed, never embedded in the clone URL,
  and never written to any git config.
- `AI_DEV_WIKI_DIR`: location override (default `<repo root>/../ai-development-wiki`).
- `AI_DEV_WIKI_URL`: clone URL override.

In the single-repo Cursor Cloud environment this repo is `/workspace`, so the sibling path is
`/ai-development-wiki`; `sync` creates it owned by the agent user with passwordless `sudo` and
clones into it. In a local checkout, clone the wiki next to this repo or set `AI_DEV_WIKI_DIR`.

## Cursor Cloud setup (single-repo environment)

The Cloud Agent GitHub token only covers `Forward-Freedom-Main`, so the wiki needs a separate
read-only token. Nothing here goes into source control.

1. Create a fine-grained GitHub personal access token: Resource owner `Freedomfarms`, repository
   access limited to `ai-development-wiki`, permission Contents: Read-only, nothing else.
2. Cursor Dashboard > Cloud Agents > Secrets: add `AI_DEV_WIKI_TOKEN` with that value, scoped to
   the `Forward-Freedom-Main` repository (or the `Forward-Freedom-Main` environment).
3. Cursor Dashboard > Cloud Agents > Environments > `Freedomfarms/Forward-Freedom-Main`: append
   `bash scripts/cloud-agent-wiki.sh sync` on its own line to the existing install script (Builds
   bake the checkout in) and to the start command (every boot fast-forwards it). Keep the existing
   commands unchanged.
4. Trigger a Build so new agents start with the wiki present, then start an agent and run the
   validation below.

## Validation

```sh
scripts/cloud-agent-wiki.sh sync
scripts/cloud-agent-wiki.sh check
cat "$(scripts/cloud-agent-wiki.sh path)/index.md"
ls "$(scripts/cloud-agent-wiki.sh path)/wiki/projects/freedom-os"
```

A session without access sees `[shared-wiki] WARNING: shared wiki NOT available ...` and must say
so rather than pretend the shared memory was loaded.

## Updating the wiki

Knowledge flows back through pull requests only: branch in `ai-development-wiki`, open a PR, never
push to `main`.

## Automatic documentation sync

Every project pull request is assessed by `scripts/wiki-sync.mjs`. Cursor and Codex run the same
command. The script does not call a model and does not start another coding agent. The session
that changed the code writes the wiki pull request when one is required. GitHub Actions job
`wiki-sync` records the result in the step summary and in the `wiki-sync-result` artifact.

| Classifier result | What CI records                                                                                                           | Wiki pull request                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `neutral`         | `no-update-required`                                                                                                      | Not required. Routine bug fixes stay lightweight.          |
| `wiki-required`   | `blocked` until the wiki PR is reviewed and merged or its head is already on the wiki default branch, then `synchronized` | Required. A `no-update-required` marker cannot waive this. |

Categories and the kind of diff that trips them (the patterns themselves live in
`scripts/wiki-sync.mjs`):

| Category                 | Requires a wiki update                                                                                                               | Stays neutral                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Architecture             | `docs/adr/**`, routing, `vercel.json`, the architecture docs named in the script                                                     | UI components and copy                 |
| Integrations             | Plaid client, connector registry, agent connection modules, added or deleted files under `server/plaid/`                             | Edits inside an existing Plaid handler |
| Agent capabilities       | Capability registries, tool spec, inventory, and builtin catalog; added or deleted tool or skill files                               | Edits inside an existing tool module   |
| Database or memory       | Anything under `prisma/`, schema capability module, added or deleted memory modules                                                  | Edits inside an existing memory module |
| Security and permissions | `docs/SECURITY.md`, `docs/RLS_ROLLOUT.md`, grants and access-boundary modules, added or deleted files under `server/chief/security/` | Edits to rate limiting                 |
| Workflows and decisions  | `AGENTS.md`, `.cursor/rules/**`, `.github/workflows/**`, this document, the wiki scripts                                             | Tests                                  |

Paths under `test/`, `third_party/`, and `design-references/` are neutral. Adding or removing a
dependency name in `package.json` counts as an integration change. A version bump does not.

If a design change sits inside a file the classifier treats as neutral, the session sets
`result: update-required` in the project pull request body. That raises the gate. Nothing in the
pull request body can lower a `wiki-required` classification.

The project pull request body carries:

```markdown
<!-- wiki-sync -->

result: update-required
wiki_pr: https://github.com/Freedomfarms/ai-development-wiki/pull/<number>
reason: <which wiki pages changed and why>

<!-- /wiki-sync -->
```

The linked wiki pull request must mention `Freedomfarms/Forward-Freedom-Main#<number>` or the
head branch name. Completion also requires an approving review from a GitHub user other than the
wiki pull request author. Direct pushes to the wiki default branch are not a substitute.

`GITHUB_TOKEN` for this repository cannot read the private wiki. The job reads the Actions secret
`AI_DEV_WIKI_TOKEN`. When a wiki update is required and that secret is missing, or the token
cannot read the linked pull request, the job fails closed. Neutral pull requests still pass.
Agents that must open the wiki pull request need a token that can push to
`Freedomfarms/ai-development-wiki`. A read-only token is enough for the Actions job to verify a
pull request that already exists.

The session helper `scripts/cloud-agent-wiki.sh check` still warns instead of failing when the
checkout is missing. That is separate from this pull request gate.
