#!/usr/bin/env bash
# Shared LLM wiki helper for Cursor Cloud sessions.
#
# The shared, cross-project memory for Freedom OS / Forward Freedom Financial lives in the
# private repo Freedomfarms/ai-development-wiki and is expected as a sibling checkout of this
# repository at ../ai-development-wiki.
#
# Usage:
#   scripts/cloud-agent-wiki.sh sync    clone or fast-forward the wiki; never exits non-zero so it
#                                       is safe in the environment's install/start commands
#   scripts/cloud-agent-wiki.sh check   verify the wiki is readable; exit 1 with a WARNING if not
#   scripts/cloud-agent-wiki.sh path    print the resolved wiki directory
#
# Environment:
#   AI_DEV_WIKI_DIR    override the checkout location (default: <repo root>/../ai-development-wiki)
#   AI_DEV_WIKI_URL    override the clone URL (default: https://github.com/Freedomfarms/ai-development-wiki.git)
#   AI_DEV_WIKI_TOKEN  optional read-only GitHub token supplied via Cursor Cloud Agent secrets.
#                      Only needed when the environment's own GitHub token does not cover the
#                      wiki repo. It is sent as a per-invocation HTTP header and is never printed
#                      or written to any git config.
set -uo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIKI_URL="${AI_DEV_WIKI_URL:-https://github.com/Freedomfarms/ai-development-wiki.git}"
WIKI_NAME="ai-development-wiki"

log() { printf '[shared-wiki] %s\n' "$*"; }
warn() { printf '[shared-wiki] WARNING: %s\n' "$*" >&2; }

resolve_wiki_dir() {
  if [ -n "${AI_DEV_WIKI_DIR:-}" ]; then
    printf '%s\n' "$AI_DEV_WIKI_DIR"
    return
  fi
  local parent sibling
  parent="$(cd "$APP_ROOT/.." && pwd)"
  [ "$parent" = "/" ] && parent=""
  sibling="$parent/$WIKI_NAME"
  # Multi-repo Cloud environments check every repo out side by side under /workspace. Prefer an
  # existing checkout there if the sibling location is empty.
  if [ ! -d "$sibling/.git" ] && [ -d "/workspace/$WIKI_NAME/.git" ]; then
    printf '%s\n' "/workspace/$WIKI_NAME"
    return
  fi
  printf '%s\n' "$sibling"
}

WIKI_DIR="$(resolve_wiki_dir)"

# Run git with the optional token as a one-off Authorization header. GIT_CONFIG_GLOBAL is blanked
# so Cursor's global insteadOf rewrite (which carries the environment token) does not compete with
# the explicit wiki token.
git_with_token() {
  local auth
  auth="$(printf 'x-access-token:%s' "$AI_DEV_WIKI_TOKEN" | base64 | tr -d '\n')"
  GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    git -c "http.extraheader=AUTHORIZATION: basic $auth" "$@"
}

git_ambient() {
  GIT_TERMINAL_PROMPT=0 git "$@"
}

run_git() {
  if [ -n "${AI_DEV_WIKI_TOKEN:-}" ]; then
    git_with_token "$@"
  else
    git_ambient "$@"
  fi
}

ensure_parent_writable() {
  local parent
  parent="$(dirname "$WIKI_DIR")"
  if [ -w "$parent" ]; then
    return 0
  fi
  # Single-repo Cloud layouts put this repo at /workspace, so ../ai-development-wiki resolves to a
  # root-owned path. Create it owned by the current user when passwordless sudo is available.
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n install -d -o "$(id -u)" -g "$(id -g)" "$WIKI_DIR" && return 0
  fi
  return 1
}

cmd_sync() {
  if [ -d "$WIKI_DIR/.git" ]; then
    if run_git -C "$WIKI_DIR" pull --ff-only --quiet 2>/tmp/shared-wiki-pull.err; then
      log "wiki up to date at $WIKI_DIR ($(git -C "$WIKI_DIR" rev-parse --short HEAD))"
    else
      warn "could not refresh $WIKI_DIR; using the existing (possibly stale) checkout."
      sed 's/^/[shared-wiki]   /' /tmp/shared-wiki-pull.err >&2
    fi
    rm -f /tmp/shared-wiki-pull.err
    return 0
  fi

  if [ -d "$WIKI_DIR/wiki" ]; then
    log "wiki present at $WIKI_DIR (not a git checkout; skipping refresh)"
    return 0
  fi

  if ! ensure_parent_writable; then
    warn "cannot create $WIKI_DIR (parent not writable). Set AI_DEV_WIKI_DIR to a writable path."
    warn "shared wiki NOT available; do not assume shared memory was loaded."
    return 0
  fi

  log "cloning $WIKI_URL -> $WIKI_DIR"
  local ok=0
  if git_ambient clone --quiet "$WIKI_URL" "$WIKI_DIR" 2>/tmp/shared-wiki-clone.err; then
    ok=1
  elif [ -n "${AI_DEV_WIKI_TOKEN:-}" ] &&
    git_with_token clone --quiet "$WIKI_URL" "$WIKI_DIR" 2>/tmp/shared-wiki-clone.err; then
    ok=1
  fi

  if [ "$ok" = 1 ]; then
    log "wiki cloned at $WIKI_DIR ($(git -C "$WIKI_DIR" rev-parse --short HEAD))"
  else
    warn "could not clone the shared wiki."
    sed 's/^/[shared-wiki]   /' /tmp/shared-wiki-clone.err >&2
    warn "shared wiki NOT available; do not assume shared memory was loaded."
    warn "fix: add $WIKI_NAME to this Cloud environment's repositories (preferred) or add an"
    warn "     AI_DEV_WIKI_TOKEN secret with read access. See docs/SHARED_WIKI.md."
    rmdir "$WIKI_DIR" 2>/dev/null || sudo -n rmdir "$WIKI_DIR" 2>/dev/null || true
  fi
  rm -f /tmp/shared-wiki-clone.err
  return 0
}

cmd_check() {
  if [ ! -d "$WIKI_DIR/wiki" ]; then
    warn "shared wiki NOT available at $WIKI_DIR."
    warn "Do not claim shared memory was loaded. Run 'scripts/cloud-agent-wiki.sh sync' and see docs/SHARED_WIKI.md."
    return 1
  fi

  local rev="unknown"
  if [ -d "$WIKI_DIR/.git" ]; then
    rev="$(git -C "$WIKI_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  fi
  log "shared wiki available at $WIKI_DIR (rev $rev)"

  local f
  for f in wiki/index.md wiki/log.md wiki/shared/tooling/connecting-a-project-repo.md; do
    if [ -r "$WIKI_DIR/$f" ]; then
      log "  found $f"
    else
      log "  (missing) $f"
    fi
  done

  log "architecture pages:"
  find "$WIKI_DIR/wiki" -type f -iname '*architecture*' 2>/dev/null | sed "s|^$WIKI_DIR/|[shared-wiki]   |"
  log "standards pages:"
  find "$WIKI_DIR/wiki" -type f -iname '*standard*' 2>/dev/null | sed "s|^$WIKI_DIR/|[shared-wiki]   |"
  log "read wiki/index.md first, then the pages above for this project, before changing code."
  return 0
}

case "${1:-}" in
  sync) cmd_sync ;;
  check) cmd_check ;;
  path) printf '%s\n' "$WIKI_DIR" ;;
  *)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
