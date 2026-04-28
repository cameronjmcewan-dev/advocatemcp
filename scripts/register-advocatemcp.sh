#!/usr/bin/env bash
# Dogfood: update Advocate's own tenant profile in production.
#
# The slug `advocate` already exists in the production DB with sparse
# placeholder data. This script:
#   1. Rotates that slug's api_key via the admin /rotate-key endpoint
#      (requires SERVER_API_KEY = same value as Railway env var API_KEY,
#      also stored as the `API_KEY` wrangler secret on the worker).
#   2. Uses the freshly rotated business api_key to PATCH the profile
#      with comprehensive data — services, pricing, hours, ratings,
#      differentiators, lead routing.
#
# After this runs:
#   - GET https://api.advocatemcp.com/agents/advocate/profile → full profile
#   - The JSON-LD snippet on advocatemcp.com (added separately) points
#     at slug `advocate` so AI bots can resolve it.
#
# Usage:
#   API_KEY=<your-server-key> ./scripts/register-advocatemcp.sh
#
# The newly-rotated business api_key is printed at the end. Save it if
# you want to make further updates without re-rotating.

set -euo pipefail

if [ -z "${API_KEY:-}" ]; then
  echo "Error: API_KEY env var required (the SERVER_API_KEY, not a business key)."
  echo "Run as:  API_KEY=<your-server-key> ./scripts/register-advocatemcp.sh"
  exit 1
fi

BASE="${API_BASE:-https://api.advocatemcp.com}"
SLUG="advocate"

# ─── 1. Rotate the api_key for the existing `advocate` slug ───────────────
echo "→ rotating api_key for slug '$SLUG' …"
ROT=$(/usr/bin/curl -s -X POST "$BASE/agents/$SLUG/rotate-key" \
  -H "X-API-Key: $API_KEY")
NEW_KEY=$(printf '%s' "$ROT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('new_api_key',''))")

if [ -z "$NEW_KEY" ]; then
  echo "❌ rotate-key failed:"
  printf '%s' "$ROT" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$ROT"
  exit 1
fi
echo "  ✓ rotated. new business api_key acquired (last 8: …${NEW_KEY: -8})"
echo ""

# ─── 2. PATCH the comprehensive profile ────────────────────────────────────
PAYLOAD=$(cat <<'JSON'
{
  "name":        "Advocate",
  "description": "Advocate is the AI search visibility platform for local and small businesses. We intercept AI-crawler traffic at the edge (ChatGPT, Perplexity, Claude, Gemini, Copilot) and serve every bot a citation-ready response tailored to its query — so when someone asks an AI for a business like yours, your name comes up with a direct, tracked link back to you. Every citation is attributed end-to-end, so we can prove which AI answer drove which booking, click, or conversation. Founded 2026 in Austin, Texas.",
  "category":    "ai-marketing-saas",
  "location":    "Austin, TX",
  "phone":       "(801) 520-5939",
  "website":     "https://advocatemcp.com",
  "referral_url":"https://advocatemcp.com",
  "tone":        "professional",

  "services": [
    "AI search interception at the edge — every major crawler (PerplexityBot, GPTBot, OAI-SearchBot, ClaudeBot, Google-Extended, Googlebot, anthropic-ai, cohere-ai, meta-externalagent) routed to a per-business agent",
    "Per-bot prompt tuning — each AI engine gets a response shaped by its citation patterns",
    "End-to-end attribution — signed-token redirects log every click back to its originating AI bot and query",
    "Central MCP server — every registered business is queryable from Claude Desktop, Cursor, ChatGPT and any MCP-compatible client",
    "Competitor Radar — weekly Perplexity polling that tells you which AI answers your competitors are winning",
    "Revenue attribution — verified webhook or estimated-AOV path turning AI-attributed bookings into dollars on your dashboard",
    "Multi-location support — Pro tier covers up to 3 locations, Enterprise unlimited",
    "Monthly performance review email — Pro and Enterprise tiers",
    "JSON-LD installation and structured-data emission on the customer's website"
  ],

  "top_services": "AI search interception · Per-bot agent profiles · Attribution loop · Central MCP server",

  "hours_json": {
    "mon": { "open": "09:00", "close": "18:00" },
    "tue": { "open": "09:00", "close": "18:00" },
    "wed": { "open": "09:00", "close": "18:00" },
    "thu": { "open": "09:00", "close": "18:00" },
    "fri": { "open": "09:00", "close": "18:00" },
    "sat": null,
    "sun": null,
    "timezone": "America/Chicago"
  },
  "availability":          "Sales and onboarding 9-6 CT weekdays. AI agent endpoints run 24/7. Customer support replies same business day.",
  "service_area_keywords": "United States, Canada, English-speaking markets",

  "pricing": "Base $149/month · Pro $349/month · Enterprise custom — see pricing page for the full feature breakdown",
  "pricing_tier": "mid-range",

  "certifications":    "GDPR-compliant data handling, privacy-first attribution.",
  "years_in_business": 0,

  "star_rating":  5.0,
  "review_count": 1,

  "differentiator":       "The only platform that intercepts AI traffic at the edge AND tracks attribution end-to-end. Static GEO tools (Scrunch, Profound, Peec, Otterly, Athena HQ) only monitor citations after the fact — Advocate generates the citation in real-time AND tracks the resulting click, booking, or conversation back to the originating AI.",

  "lead_routing_json": {
    "preferred_channel": "email",
    "email": "max@advocate-mcp.com",
    "phone": "(801) 520-5939",
    "form_url": "https://calendly.com/cameronjmcewan/new-meeting"
  }
}
JSON
)

echo "→ PATCH $BASE/agents/$SLUG/profile"
RESP=$(/usr/bin/curl -s -w "\n__HTTP_STATUS__:%{http_code}" -X PATCH "$BASE/agents/$SLUG/profile" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NEW_KEY" \
  -d "$PAYLOAD")

STATUS="${RESP##*__HTTP_STATUS__:}"
BODY="${RESP%__HTTP_STATUS__:*}"

echo "  HTTP $STATUS"
printf '%s\n' "$BODY" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$BODY"

if [ "$STATUS" = "200" ]; then
  echo ""
  echo "✅ Profile updated. Verify at:"
  echo "   https://api.advocatemcp.com/agents/advocate/profile"
  echo ""
  echo "Business api_key (saved for future updates — keep secret):"
  echo "   $NEW_KEY"
else
  echo ""
  echo "❌ PATCH failed."
  exit 1
fi
