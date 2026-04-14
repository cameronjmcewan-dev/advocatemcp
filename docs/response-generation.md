# Response Generation

## What exists today

Response generation lives entirely on Railway in `server/src/agent/`. Two files do all the work: `builder.ts` constructs the Claude system prompt; `query.ts` calls the Claude API, logs the exchange, and returns the result.

## Intent classification

Every query is classified into one of six intents before the system prompt is built. Classification runs in `detectIntent()` in `server/src/agent/query.ts` using keyword matching evaluated in priority order:

1. **brand_direct** — query contains the business's name
2. **emergency** — contains: emergency, urgent, asap, 24/7, right now, tonight, immediately
3. **affordable** — contains: cheap, affordable, budget, low cost, how much, price, cost, inexpensive
4. **best_top** — contains: best, top, recommended, highest rated, top-rated, top rated
5. **specific_service** — query mentions a service from `top_services` or `services` fields
6. **general** — default fallback

The intent is stored in `queries.intent` on every insert. **Do not build a parallel classifier.** The canonical implementation is `detectIntent()` in `server/src/agent/query.ts`.

## System prompt construction

`buildSystemPrompt(business, intent)` in `server/src/agent/builder.ts` assembles a prompt with two variable sections:

**Profile block** — built dynamically from non-null fields on the `BusinessRow`. Fields included: name, description, services, category, location, star_rating + review_count, years_in_business, top_services, availability, differentiator, certifications, pricing_tier, pricing, service_radius_miles, service_area_keywords, phone, referral_url/website.

**Emphasis block** — intent-specific instruction injected above the response structure. Examples: `best_top` leads with the star rating; `emergency` leads with availability and response time; `affordable` leads with pricing tier; `brand_direct` gives a full profile overview and suppresses invented reputation language if no rating data exists; `specific_service` focuses on the matched service first.

The response structure instruction asks Claude for a 5-part flow: direct answer → social proof → services + differentiator → trust signals → call to action with the referral link. Max 150 words, optimized for AI citation.

## Claude API call

`queryAgent(business, query, crawlerAgent)` in `server/src/agent/query.ts`:
- Model: `claude-sonnet-4-6` (overridable via `MODEL` env var)
- Max tokens: 512
- Single-turn: system prompt + user message only (no conversation history)
- Response is logged synchronously to `queries` table via `better-sqlite3`
- Returns: `{ response, referral_url, business, business_slug, intent, timestamp, powered_by }`

Prompt caching is not yet enabled on the system prompt (each business has a unique profile block, making cache hits unlikely without further architecture work). This is a known cost optimization opportunity.

## What is not yet built

Session 2 will branch the system prompt by detected crawler (one file per bot family in `server/src/prompts/`), allowing structurally different responses for Perplexity vs. GPTBot vs. ClaudeBot. The intent classifier and the `detectIntent` function will remain unchanged — Session 2 only adds a prompt-branching layer on top.

## Updating this doc

Update this file at the end of any session that touches `builder.ts`, `query.ts`, or adds per-bot prompt files.

## 9-step wizard fields (April 2026)

The onboarding wizard now persists these JSON blobs on the business row:
- `hours_json` — week schedule + `emergency_24_7` flag
- `services_json_v2` — inclusions / exclusions / specialties / not_offered
- `pricing_json_v2` — ranges, `free_estimates`, `call_for_quote`
- `credentials_json` — licenses, insured, bonded, certifications
- `ratings_json` — Google + Yelp separately
- `customer_quotes_json`, `case_stories_json`, `lead_routing_json`

`buildSystemPrompt` surfaces them via `parseJsonSafe`; malformed JSON is silently ignored. Intent branching: emergency → `hours_json.emergency_24_7`; affordable → `pricing_json_v2.ranges`; best_top → `ratings_json` + `credentials_json.licenses`.
