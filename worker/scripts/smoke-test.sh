#!/usr/bin/env bash
# AdvocateMCP client portal smoke test.
# Run after every deploy to confirm the auth flow is working.
#
# Usage:
#   bash scripts/smoke-test.sh \
#     --email    "you@example.com" \
#     --password "YourPassword!" \
#     [--url     "https://advocatecameron.workers.dev"]
#
# Requirements: curl, grep. Optional: jq (for API response pretty-print).
#
# The script does NOT stop on first failure — it runs all tests and prints
# a summary at the end. Exit code is 0 only if all tests pass.

set -uo pipefail

BASE="https://advocatecameron.workers.dev"
EMAIL=""
PASSWORD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)    EMAIL="$2";    shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --url)      BASE="$2";     shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Usage: $0 --email EMAIL --password PASSWORD [--url BASE_URL]"
  exit 1
fi

COOKIE_JAR="$(mktemp /tmp/amcp_smoke_XXXXXX.txt)"
trap 'rm -f "$COOKIE_JAR"' EXIT

PASS=0
FAIL=0

# ── Helpers ────────────────────────────────────────────────────────────────

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ✓  $label"
    ((PASS++)) || true
  else
    echo "  ✗  $label"
    echo "       expected to contain: $expected"
    echo "       got:                 $actual"
    ((FAIL++)) || true
  fi
}

hdr() { echo; echo "── $1"; }

# ── Tests ──────────────────────────────────────────────────────────────────

hdr "1. Login page"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/login")
check "GET /login → 200" "200" "$STATUS"

hdr "2. Dashboard requires auth"

HEADERS=$(curl -s -D - -o /dev/null "$BASE/dashboard")
check "GET /dashboard (no cookie) → 302" "302" "$HEADERS"
check "GET /dashboard (no cookie) → Location contains /login" "/login" "$HEADERS"
check "GET /dashboard (no cookie) → error=expired" "error=expired" "$HEADERS"

hdr "3. Invalid login"

HEADERS=$(curl -s -D - -o /dev/null \
  -X POST "$BASE/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "email=nosuchuser@example.com" \
  --data-urlencode "password=definitelywrong")
check "POST /auth/login (wrong creds) → 302" "302" "$HEADERS"
check "POST /auth/login (wrong creds) → Location contains /login" "/login" "$HEADERS"
check "POST /auth/login (wrong creds) → error=invalid" "error=invalid" "$HEADERS"

hdr "4. Valid login"

HEADERS=$(curl -s -D - -c "$COOKIE_JAR" -o /dev/null \
  -X POST "$BASE/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "email=${EMAIL}" \
  --data-urlencode "password=${PASSWORD}")
check "POST /auth/login (valid) → 302"               "302"        "$HEADERS"
check "POST /auth/login (valid) → Location /dashboard" "/dashboard" "$HEADERS"
check "POST /auth/login (valid) → Set-Cookie present" "amcp_session=" "$HEADERS"
check "POST /auth/login (valid) → HttpOnly flag"      "HttpOnly"   "$HEADERS"
check "POST /auth/login (valid) → Secure flag"        "Secure"     "$HEADERS"
check "POST /auth/login (valid) → SameSite=Lax"       "SameSite=Lax" "$HEADERS"

hdr "5. Dashboard with valid session"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" "$BASE/dashboard")
check "GET /dashboard (with cookie) → 200" "200" "$STATUS"

hdr "6. Protected API endpoints"

RESP=$(curl -s -w "\n%{http_code}" "$BASE/api/client/me")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -1)
check "GET /api/client/me (no cookie) → 401" "401" "$CODE"
check "GET /api/client/me (no cookie) → error body" "Unauthorized" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" -b "$COOKIE_JAR" "$BASE/api/client/me")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/client/me (with cookie) → 200" "200" "$CODE"
check "GET /api/client/me (with cookie) → email in body" "$EMAIL" "$BODY"

hdr "7. Admin endpoint auth"

RESP=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE/admin/create-client" \
  -d '{}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -1)
check "POST /admin/create-client (no Content-Type) → 415" "415" "$CODE"

RESP=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE/admin/create-client" \
  -H "Content-Type: application/json" \
  -d '{}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -1)
check "POST /admin/create-client (no auth header) → 401" "401" "$CODE"
check "POST /admin/create-client (no auth header) → Unauthorized" "Unauthorized" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE/admin/create-client" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer thisisthewrongsecret" \
  -d '{}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -1)
check "POST /admin/create-client (wrong secret) → 401" "401" "$CODE"
check "POST /admin/create-client (wrong secret) → Unauthorized" "Unauthorized" "$BODY"

hdr "8. Logout"

HEADERS=$(curl -s -D - -b "$COOKIE_JAR" -o /dev/null \
  -X POST "$BASE/auth/logout")
check "POST /auth/logout → 302"                    "302"       "$HEADERS"
check "POST /auth/logout → Location /login"        "/login"    "$HEADERS"
check "POST /auth/logout → Set-Cookie clears session" "Max-Age=0" "$HEADERS"

# Confirm session is gone after logout
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" "$BASE/dashboard")
check "GET /dashboard (after logout) → 302 (session invalidated)" "302" "$STATUS"

# ── Summary ────────────────────────────────────────────────────────────────

echo
echo "────────────────────────────────"
if [[ $FAIL -eq 0 ]]; then
  echo "  All $PASS tests passed."
  echo
  exit 0
else
  echo "  $FAIL test(s) FAILED, $PASS passed."
  echo
  exit 1
fi
