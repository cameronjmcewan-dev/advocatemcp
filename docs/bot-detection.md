# Bot Detection

## What exists today

Bot detection runs in the Cloudflare Worker at `worker/src/index.ts`. The `AI_CRAWLERS` constant lists nine user-agent substrings matched case-insensitively against every incoming `User-Agent` header: `PerplexityBot`, `GPTBot`, `OAI-SearchBot`, `ClaudeBot`, `Google-Extended`, `Googlebot`, `anthropic-ai`, `cohere-ai`, `meta-externalagent`. The `isAiCrawler(ua)` function returns a boolean; `crawlerName(ua)` returns the matched string or `null`. Both are used in the main fetch handler to branch routing.

Detection is purely user-agent based — no IP allowlist, no TLS fingerprinting. This is intentional: the goal is routing signal, not access control. Bot detection results are never trusted as authentication; they only determine whether a request is forwarded to the agent API or returned an info response. The Worker also uses `crawlerName` to populate the `botType` field in the structured analytics log (JSON to Cloudflare Logpush) and the `utm_content` UTM parameter on tagged referral URLs.

## Request routing (checked in order)

1. Portal routes (`/login`, `/auth/*`, `/dashboard`, `/api/client/*`, `/admin/create-client`) — always human/API, checked first
2. Demo routes (`/demo`, `/demo/search`, `/demo/:slug`) — public, no crawler logic
3. `/track` redirect — click logging + 302 to destination; bot-filtered (only logs non-crawler UAs)
4. `/mcp` and `/mcp/*` — proxied straight to Railway, bypasses crawler detection
5. `/.well-known/ai-agent.json` — served to all UAs including crawlers
6. Non-crawler traffic — returns a 200 JSON info response (not a passthrough)
7. AI crawler traffic — KV slug lookup → optional tenant status check → backend proxy

## What to do when updating

Do not modify `AI_CRAWLERS` or the detection functions without explicit instruction from the repo owner. Changes here affect every downstream routing decision. If a new crawler needs to be added, propose it with the exact user-agent string from that crawler's published documentation and wait for approval before touching the array.
