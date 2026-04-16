#!/usr/bin/env bash
#
# deploy-pages.sh — deploy site/ to advocatemcp.com (Cloudflare Pages)
#                   from a GUARANTEED-FRESH checkout of origin/main.
#
# Why this exists:
#   Apr 16 2026 incident — a cofounder ran `wrangler pages deploy site/`
#   from a local working tree that was 19 files behind origin/main. The
#   deploy regressed privacy.html, terms.html, icon assets, and the entire
#   dashboard JS module suite. Fixing took ~15 minutes of live production
#   debugging during the ChatGPT Apps SDK submission window.
#
#   Since the site/ tree is pure static assets (no build step, no local
#   state), the only safe deploy is one that pulls origin/main and deploys
#   verbatim. Local working-tree state is irrelevant at best and actively
#   harmful at worst.
#
# Usage:
#   ./scripts/deploy-pages.sh            # deploy origin/main
#   ./scripts/deploy-pages.sh <branch>   # deploy a specific branch (rare;
#                                          for testing a PR preview)
#
# Exit codes:
#   0 on successful deploy
#   1 on any prerequisite failure (missing wrangler, no git, etc.)
#   2 if the user's working tree has a dirty site/ (prevents accidental
#     "I edited locally and want that deployed" — if that's the intent,
#     commit + push to main first, then re-run this script).
#
# No dependencies beyond: git, wrangler (from worker/), curl (for health
# check), mktemp. Runs on macOS + Linux.

set -euo pipefail

BRANCH="${1:-main}"
REPO_URL="https://github.com/cameronjmcewan-dev/advocatemcp.git"
PROJECT_NAME="advocatemcp-site"

# ─── Locate repo root regardless of where the script is invoked from ──────
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

echo "→ repo: $REPO_ROOT"
echo "→ branch: $BRANCH"
echo "→ project: $PROJECT_NAME"
echo ""

# ─── Prerequisite checks ──────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  echo "✘ git not found on PATH" >&2
  exit 1
fi

if [ ! -d "$REPO_ROOT/worker" ]; then
  echo "✘ expected $REPO_ROOT/worker to exist (for wrangler context)" >&2
  exit 1
fi

# ─── Safety gate: reject deploy if local site/ has uncommitted changes ─────
# If the user is editing site/ locally and wants that deployed, they must
# commit + push + merge to the target branch first. This script will not
# serve as an escape hatch around the review process.
if [ -d "$REPO_ROOT/site" ]; then
  DIRTY=$(git -C "$REPO_ROOT" status --porcelain site/ 2>/dev/null || true)
  if [ -n "$DIRTY" ]; then
    echo "✘ local site/ has uncommitted changes:" >&2
    echo "$DIRTY" | sed 's/^/    /' >&2
    echo "" >&2
    echo "  This script always deploys origin/$BRANCH verbatim. Local changes" >&2
    echo "  will NOT be included. Commit + push + merge to $BRANCH first," >&2
    echo "  then re-run this script." >&2
    echo "" >&2
    echo "  (If you intentionally want to discard local site/ changes first," >&2
    echo "   run: git -C $REPO_ROOT checkout -- site/)" >&2
    exit 2
  fi
fi

# ─── Fresh shallow checkout of origin/<branch> into a temp directory ──────
TMPDIR=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

echo "→ cloning origin/$BRANCH (shallow) to $TMPDIR"
git -C "$TMPDIR" init -q
git -C "$TMPDIR" remote add origin "$REPO_URL"
git -C "$TMPDIR" fetch origin "$BRANCH" --quiet --depth=1

if ! git -C "$TMPDIR" checkout FETCH_HEAD -- site/ 2>/dev/null; then
  echo "✘ origin/$BRANCH has no site/ directory" >&2
  exit 1
fi

FILE_COUNT=$(find "$TMPDIR/site" -type f | wc -l | tr -d ' ')
echo "→ pulled $FILE_COUNT files from origin/$BRANCH"

# ─── Deploy via wrangler from the worker/ subproject ──────────────────────
# wrangler reads its auth from the worker/ wrangler.toml + env, so we must
# invoke from there. --commit-dirty=true silences the default warning about
# the repo being dirty (which is expected — our TMPDIR is clean, but wrangler
# doesn't know that).
echo ""
echo "→ deploying to Cloudflare Pages..."
cd "$REPO_ROOT/worker"
npx wrangler pages deploy "$TMPDIR/site" \
  --project-name="$PROJECT_NAME" \
  --commit-dirty=true

# ─── Post-deploy smoke: ensure /privacy still serves the real policy ──────
# Catches the specific regression that motivated this script's existence.
echo ""
echo "→ post-deploy smoke test..."
sleep 3  # give CF edge a moment to propagate the new deploy to the alias
TITLE=$(curl -sL "https://advocatemcp.com/privacy?cb=$(date +%s)" | grep -o '<title>[^<]*</title>' | head -1 || true)
if echo "$TITLE" | grep -q "Privacy Policy"; then
  echo "  ✓ /privacy title: $TITLE"
else
  echo "  ⚠ /privacy title: $TITLE"
  echo "    (expected something containing 'Privacy Policy' — may be edge cache lag, re-check in 60s)"
fi

ICON_CT=$(curl -sI "https://advocatemcp.com/icon-512.png?cb=$(date +%s)" | grep -i '^content-type:' | head -1 | tr -d '\r' || true)
if echo "$ICON_CT" | grep -qi 'image/png'; then
  echo "  ✓ /icon-512.png: $ICON_CT"
else
  echo "  ⚠ /icon-512.png: $ICON_CT"
  echo "    (expected image/png — likely still propagating, re-check in 60s)"
fi

echo ""
echo "✓ deploy complete"
