#!/usr/bin/env bash
# Pre-deploy environment check for the AdvocateMCP client portal.
# Run from the worker/ directory: bash scripts/check-portal-env.sh
#
# Exits 0 only if every check passes.

set -euo pipefail
cd "$(dirname "$0")/.."  # always run from worker/

PASS=0
FAIL=0

ok()   { echo "  ✓  $1"; ((PASS++)) || true; }
fail() { echo "  ✗  $1"; ((FAIL++)) || true; }
hdr()  { echo; echo "── $1"; }

hdr "wrangler.toml"

if [[ -f wrangler.toml ]]; then
  ok "wrangler.toml exists"
else
  fail "wrangler.toml not found — are you in worker/?"
fi

if grep -q 'binding\s*=\s*"DB"' wrangler.toml 2>/dev/null; then
  ok "D1 binding 'DB' declared"
else
  fail "D1 binding 'DB' missing from wrangler.toml"
fi

if grep -q 'REPLACE_WITH_D1_DATABASE_ID' wrangler.toml 2>/dev/null; then
  fail "database_id is still a placeholder — run: wrangler d1 create advocatemcp-auth"
else
  ok "D1 database_id is set (not a placeholder)"
fi

if grep -q 'binding\s*=\s*"BUSINESS_MAP"' wrangler.toml 2>/dev/null; then
  ok "KV binding 'BUSINESS_MAP' declared"
else
  fail "KV binding 'BUSINESS_MAP' missing from wrangler.toml"
fi

if grep -q 'API_BASE_URL' wrangler.toml 2>/dev/null; then
  ok "API_BASE_URL is set in [vars]"
else
  fail "API_BASE_URL missing from [vars] in wrangler.toml"
fi

hdr "Migrations"

if [[ -f migrations/0001_init.sql ]]; then
  ok "migrations/0001_init.sql exists"
else
  fail "migrations/0001_init.sql missing"
fi

hdr "Source files"

for f in src/types.ts src/auth.ts src/portalDb.ts src/routes/portal.ts src/index.ts; do
  if [[ -f "$f" ]]; then
    ok "$f exists"
  else
    fail "$f MISSING"
  fi
done

hdr "Wrangler secrets (remote check)"

if command -v wrangler &>/dev/null || command -v npx &>/dev/null; then
  echo "     Listing remote secrets (requires wrangler login)..."
  SECRETS=$(npx wrangler secret list 2>/dev/null || echo "")

  if echo "$SECRETS" | grep -q '"ADMIN_SECRET"'; then
    ok "ADMIN_SECRET is set as a Wrangler secret"
  else
    fail "ADMIN_SECRET is NOT set — run: wrangler secret put ADMIN_SECRET"
  fi
else
  fail "wrangler not found — install with: npm install -g wrangler"
fi

hdr "Summary"

echo
if [[ $FAIL -eq 0 ]]; then
  echo "  All $PASS checks passed. Safe to deploy."
  echo
  exit 0
else
  echo "  $FAIL check(s) failed, $PASS passed. Fix the above before deploying."
  echo
  exit 1
fi
