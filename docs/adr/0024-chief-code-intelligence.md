# ADR-0024: Read-only CHIEF code intelligence

- Status: accepted
- Date: 2026-10-02
- Scope: CHIEF (Module 03)

## Context

CHIEF can operate registered Freedom OS capabilities and could not inspect the
source those capabilities come from. The repository has no code index and no
GitHub client. `file:read` is a generic filesystem grant and stays off the
baseline. `code:execute` stays forbidden.

## Reuse check (mandatory)

- The capability registry, `TurnMachine`, and `ToolExecutor` stay the only
  execution path.
- GitHub's contents, git tree, and code-search reads are the existing remote
  API. No local checkout is mounted into the tool.
- No CEO Agents registry, shell, or filesystem module is reused.

## Decision

`server/chief/codeintel/` exposes `tree`, `read`, and `search`. The registered
capabilities are `code_tree`, `code_read`, and `code_search`. Each is effect
`read`, confirmation `none`, and requires `code:read`.

`code:read` is on the empty-grant baseline. An explicit deny still wins.
The model cannot grant it.

The repository is server configuration, defaulting to
`Freedomfarms/Forward-Freedom-Main`. `CHIEF_CODE_READ_TOKEN` is a server-side
contents-read credential. The client sends it only as a GitHub `Authorization`
header on `GET https://api.github.com`. The model cannot pass a URL, owner, or
repository. Refs are a branch, tag, or commit. Paths are repository-relative.

Protected paths (environment files, keys, credential JSON) are refused before
a fetch. Obvious credential text in a file or search fragment is refused and
is not returned. Oversized files are not truncated; the tool asks for a line
range of at most 200 lines.

File-body search uses GitHub code search on the default branch. Other refs use
path-name search against that ref's tree. There is no symbol index in this
phase.

Successful calls record tool, operation, repository, ref, path, size, and
duration on the existing trace. Trace detail does not store source text or the
token.

## Consequences

- CHIEF can inspect Freedom OS source and cannot modify, commit, push, or
  deploy it. The code module has no write route and no shell.
- Users without `code:read` get the existing capability denial.
- A stored grant row is merged onto the baseline, so `code:read` stays
  available unless an explicit deny removes it.
- Route, symbol, and import indexes remain future work.
- Grok workforce ingestion, the operational graph, and finance writes are not
  part of this decision.
