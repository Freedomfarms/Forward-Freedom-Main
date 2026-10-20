# Shared wiki (Karpathy LLM Wiki)

Cross-project knowledge for Freedom OS and Forward Freedom Financial lives in the private
repository `Freedomfarms/ai-development-wiki`. Agent sessions expect it as a sibling checkout of
this repo at `../ai-development-wiki` and read it before doing work (see `AGENTS.md`).

## Helper script

`scripts/cloud-agent-wiki.sh` wires the wiki into a session:

| Command | Behaviour                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`  | Clone the wiki at `../ai-development-wiki` or fast-forward an existing checkout. Always exits 0; prints a `WARNING` when the wiki is unreachable. |
| `check` | Confirm the wiki is readable and list its index, architecture and standards pages. Exits 1 with a `WARNING` when it is missing.                   |
| `path`  | Print the resolved wiki directory.                                                                                                                |

Environment variables: `AI_DEV_WIKI_DIR` (location override), `AI_DEV_WIKI_URL` (clone URL
override), `AI_DEV_WIKI_TOKEN` (optional read-only token, see below). The token is passed as a
per-invocation HTTP header; it is never printed and never written to any git config.

Layouts the script understands:

- Multi-repo Cloud environment: Cursor checks every repo out side by side under `/workspace`, so
  `/workspace/Forward-Freedom-Main/../ai-development-wiki` already exists; `sync` only refreshes it.
- Single-repo Cloud environment: this repo is `/workspace`, so the sibling path is
  `/ai-development-wiki`. `sync` creates it (owned by the agent user) with passwordless `sudo` and
  clones into it.
- Local checkout: clone the wiki next to this repo, or point `AI_DEV_WIKI_DIR` at it.

## Giving Cursor Cloud access to the wiki

The Cloud Agent GitHub token only covers the repositories in the agent's environment. The
existing `Forward-Freedom-Main` environment is single-repo, so the wiki is not reachable until one
of the following is done in the Cursor dashboard (Cloud Agents):

1. Preferred: create a multi-repo environment that selects both `Freedomfarms/Forward-Freedom-Main`
   and `Freedomfarms/ai-development-wiki` (Cursor GitHub App access to the wiki repo is required).
   Cursor clones both repos, and the sibling layout works without any token. Note that Cursor's
   long-running agents feature is not yet available for multi-repo environments.
2. Fallback: keep the single-repo environment and add a Cloud Agent secret `AI_DEV_WIKI_TOKEN`
   containing a fine-grained GitHub token with read-only Contents access to
   `Freedomfarms/ai-development-wiki`. Scope the secret to this repo or environment.

In either case, add the sync step to the environment so the wiki is present before a session starts:

- Install script (baked into Builds): append `bash scripts/cloud-agent-wiki.sh sync`
- Start command (refresh on every boot): append `bash scripts/cloud-agent-wiki.sh sync`

Both are additive; keep the existing install/start commands as they are. Credentials never belong
in `environment.json`, scripts, or this repository.

## Validation

```sh
scripts/cloud-agent-wiki.sh sync
scripts/cloud-agent-wiki.sh check
cat "$(scripts/cloud-agent-wiki.sh path)/wiki/index.md"
```

A session without access sees `[shared-wiki] WARNING: shared wiki NOT available ...` and must say
so rather than pretend the shared memory was loaded.

## Updating the wiki

Knowledge flows back through pull requests only: branch in `ai-development-wiki`, open a PR, never
push to `main`. If a session cannot open that PR itself, it lists the proposed entries under a
"Wiki updates" heading in the application PR description.
