#!/usr/bin/env bash
# Install repo-managed git hooks. Idempotent — safe to re-run.
#
# Why not Husky: husky requires a top-level package.json + a dependency,
# and this repo intentionally has no root package.json (server/ and
# worker/ are separate workspaces). A plain hook script committed to
# scripts/git-hooks/ + a one-time install symlink achieves the same gate
# with zero new dependencies.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="${REPO_ROOT}/.git/hooks"
SRC_DIR="${REPO_ROOT}/scripts/git-hooks"

if [[ ! -d "$HOOKS_DIR" ]]; then
  echo "fatal: ${HOOKS_DIR} not found — are you inside a git repo?" >&2
  exit 1
fi

for hook in pre-commit; do
  src="${SRC_DIR}/${hook}"
  dst="${HOOKS_DIR}/${hook}"
  if [[ ! -f "$src" ]]; then
    echo "skipping ${hook} — ${src} does not exist"
    continue
  fi
  chmod +x "$src"
  # Use a relative symlink so it works on any clone path. .git/hooks/X ->
  # ../../scripts/git-hooks/X. If a non-symlink hook already exists,
  # back it up rather than clobber.
  if [[ -e "$dst" && ! -L "$dst" ]]; then
    mv "$dst" "${dst}.bak.$(date +%s)"
    echo "backed up existing ${hook} to $(basename "${dst}").bak.*"
  fi
  ln -sf "../../scripts/git-hooks/${hook}" "$dst"
  echo "installed: ${dst} -> ../../scripts/git-hooks/${hook}"
done

echo
echo "All hooks installed. Test by staging a change and running:"
echo "  git commit --dry-run -m test"
