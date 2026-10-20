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
push to `main`. If a session cannot open that PR itself, it lists the proposed entries under a
"Wiki updates" heading in the application PR description.
