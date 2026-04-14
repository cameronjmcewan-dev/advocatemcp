# AdvocateMCP — Design Brief

> Self-contained brief for Max and his AI assistant. Ingest this document to produce a page-by-page design plan, a Figma component library, and a `tokens.json` export without needing to ask clarifying questions about business logic or data shape for 80%+ of what you touch.

**Status:** Draft v1 — 2026-04-14
**Owner:** Cameron (product + engineering). Max = external designer.
**Scope:** Unified visual identity across the marketing site (Webflow) and the customer dashboard (vanilla TS).
**Out of scope:** backend implementation, brand-asset redraw, copywriting revisions beyond placeholders in examples.

---

## Table of contents

1. [Product orientation](#1-product-orientation)
2. [Brand](#2-brand)
3. [Page inventory](#3-page-inventory)
4. [Data contracts](#4-data-contracts)
5. [User flows](#5-user-flows)
6. [Component inventory](#6-component-inventory)
7. [Design tokens](#7-design-tokens)
8. [Technical constraints](#8-technical-constraints)
9. [Reference inspirations](#9-reference-inspirations)
10. [Deliverables checklist](#10-deliverables-checklist)

---

## 1. Product orientation

**What AdvocateMCP does.** AdvocateMCP intercepts AI search crawler traffic at the edge (Cloudflare Worker), detects bots by user-agent, and routes them to a Claude-powered conversational agent that returns a citation-ready answer tailored to the bot's query. Every citation link we serve is signed and tracked end-to-end, so the customer can attribute downstream human clicks and conversions back to the originating AI bot and query. We also expose every registered business through a single central MCP server at `/mcp` so MCP-compatible clients (Claude Desktop, Cursor, Perplexity) can query any business directly.

**Who buys it.** Local service businesses: plumbers, roofers, electricians, HVAC, lawyers, dentists, general contractors, home-services — the long tail of SMB/mid-market operators whose customers now start their search in ChatGPT or Perplexity instead of Google. They typically run small marketing teams (1–3 people) or outsource to agencies. They pay $100–$250/month for visibility and attribution, not for content creation. They understand the concept of "rankings" and "reviews" but not the machinery of LLM citation — the product has to feel like Google Analytics, not a developer tool.

**Two surfaces.** The **marketing site** (`advocatemcp.com`) sells the product and runs the 9-step onboarding wizard that ends in Stripe checkout. The **customer dashboard** (`customers.advocatemcp.com`) is where logged-in customers manage their agent, view analytics, configure their competitor radar, rotate API keys, and manage billing. These two surfaces today use two incompatible design systems; this brief unifies them.

**Positioning.** Scrunch, Profound, Peec, Otterly, Athena HQ all *monitor* AI citations statically. AdvocateMCP is the only product that *intercepts* bot traffic in real time, serves a per-bot optimized response, AND tracks the resulting referral end-to-end. Design should feel grown-up, technical, and confident — not flashy, not marketing-first, not templated.

---

## 2. Brand

### 2.1 Color (target)

| Role | Hex | Notes |
|---|---|---|
| `brand-maroon` | `#7d2550` | Primary. Dark maroon / burgundy. **Replaces the current teal `#4f98a3` everywhere.** |
| `brand-maroon-hover` | `#8f2d5d` | +1 luminance step for hover/active |
| `brand-maroon-dim` | `rgba(125, 37, 80, 0.10)` | Subtle tints (hero-accent backgrounds, focus rings) |
| `brand-maroon-ring` | `rgba(125, 37, 80, 0.24)` | Focus rings, chip borders |

Everywhere you see teal `#4f98a3`, green `#01696f`, or Poppins-era green in the current codebase, treat it as legacy. The target system is maroon-only for accent, with a neutral dark bg (see Section 7).

### 2.2 Logo (canonical)

**Source file:** `site/legal-source/logo-v1.svg` — 200×200 viewBox, stroke-based, currentColor-driven.

**Geometry.** Two interlocking chevrons forming a 4-pointed star. One horizontal chevron pair (left + right diamonds), one vertical chevron pair (top + bottom diamonds). Stroke width 14 at 200×200, `stroke-linejoin="round"`, `stroke-linecap="round"`.

Reproduced here for unambiguous reference:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none"
     stroke="currentColor" stroke-width="14" stroke-linejoin="round" stroke-linecap="round">
  <path d="M 20 100 L 70 70 L 100 100 L 70 130 Z
           M 180 100 L 130 70 L 100 100 L 130 130 Z" />
  <path d="M 100 20 L 70 70 L 100 100 L 130 70 Z
           M 100 180 L 70 130 L 100 100 L 130 130 Z" />
</svg>
```

**Lockup.** Primary lockup is **white star on maroon** (`#fff` star on `#7d2550` background). Secondary lockup is **maroon star on white/neutral**.

**Rules.**
- Minimum size: 16px logo height for favicons, 24px for inline use.
- Clear space: 1× the height of the logo on all sides, no other elements within that box.
- Never stretch, rotate, re-color into gradients, add drop shadows, or place on busy photographic backgrounds.
- Monochrome variants: white on any dark color ≥ #7d2550 luminance; black only for print.
- Variants to produce (Section 10): full color, mono white, mono black, favicon SVG + 32×32 PNG fallback, social/OG card 1200×630.

### 2.3 Typography

| Use | Family | Weights | Notes |
|---|---|---|---|
| Display / headings | **Instrument Serif** | 400, 400 italic | Editorial, confident. `em` tags carry italic emphasis + accent color. |
| Body / UI | **General Sans** | 400, 500, 600 | Geometric sans. Matches the body text on `site/index.html`. |
| Mono (code, API keys, tokens) | **JetBrains Mono** or system mono stack | 400, 500 | Only for code blocks, API keys, snippet copy-paste. |

**Self-host.** No Google Fonts CDN links. Include WOFF2 subset files in the repo under `site/fonts/` and reference via `@font-face`.

### 2.4 Voice

Confident. Technical. Plain-English. No marketing-jargon fluff ("revolutionize", "leverage", "unlock"). Examples:

| ✅ Do say | ❌ Don't say |
|---|---|
| "See which AI bots cited you this week" | "Unlock unprecedented visibility into the AI economy" |
| "Rotate your API key" | "Empower your security posture" |
| "Perplexity cited you in 12 of 18 queries" | "AI-powered insights at your fingertips" |

Numbers and verbs do the work.

---

## 3. Page inventory

Priority: **P0** = must ship in v1; **P1** = ship within 4 weeks of v1; **P2** = backlog.

### 3.1 Marketing (Webflow)

| Page | Audience | Priority | Source today |
|---|---|---|---|
| Landing (`/`) | First-time visitors | P0 | `site/index.html` |
| Pricing (`/pricing`) | Evaluating buyers | P0 | (new — currently inline on `/`) |
| How-it-works (`/how-it-works`) | Evaluating buyers, skeptics | P0 | (new — currently a section on `/`) |
| Onboarding wizard (`/onboarding`) — **9 steps** | Buyers post-click | P0 | `site/onboarding.html` (legacy 4-step) |
| Login (`/login`) | Existing customers | P0 | `site/login.html` |
| Activate (`/activate`) | Post-Stripe email landing | P0 | `site/activate.html` |
| Legal — Terms (`/terms`) | Regulatory | P0 | `site/terms.html` |
| Legal — Privacy (`/privacy`) | Regulatory | P0 | `site/privacy.html` |
| Legal — DPA (`/dpa`) | Enterprise prospects | P0 | `site/dpa.html` |
| Blog index (`/blog`) | SEO, content marketing | P1 | (new) |
| Blog post (`/blog/:slug`) | SEO, content marketing | P1 | (new) |
| 404 / error | All | P1 | (new) |
| Customer stories / case studies | Evaluating buyers | P2 | (new) |

### 3.2 Dashboard (vanilla TS, hosted on `customers.advocatemcp.com`)

All dashboard pages live behind login and are scoped to a selected business (a customer may have multiple). A persistent left nav has: Overview, Agent, Analytics, Competitors, Referrals, Settings, Billing.

| Page | Priority | Current source |
|---|---|---|
| Login | P0 | `worker/src/routes/portal.ts:authLogin` — HTML rendered by worker |
| Overview (home) | P0 | `worker/src/routes/dashboard.ts:buildDashboard` |
| Agent config (profile + prompt tuning) | P0 | (new — today just a rotate-key button) |
| Analytics — Queries | P0 | folded into dashboard.ts |
| Analytics — Referrals (clicks) | P0 | folded into dashboard.ts |
| Competitor radar | P0 | (new — endpoints ship, no UI yet) |
| Settings — Profile | P0 | (new) |
| Settings — API keys | P0 | (part of dashboard.ts today) |
| Settings — Embed snippet | P1 | (new — show the `/.well-known/ai-agent.json` instructions + JS tag) |
| Billing | P0 | (new — Stripe customer portal link for now) |
| Team (invite teammates) | P2 | (new — D1 `users ↔ user_business_access` already exists) |
| Empty states for every page | P0 | (cross-cutting) |
| 404 / error | P0 | (new) |

### 3.3 Shared (both surfaces)

| Surface | Priority | Notes |
|---|---|---|
| Top nav (marketing) | P0 | Product / Pricing / How-it-works / Blog / Login / Get started |
| Top nav (dashboard) | P0 | Business switcher / notifications / account menu |
| Footer | P0 | Links to legal + company + social + status |
| Cookie / privacy banner | P1 | GDPR-lite |
| Toast / notification system | P0 | Used on both surfaces |

---

## 4. Data contracts

Every dashboard page renders real JSON from one of the endpoints below. Shapes are pulled **verbatim** from the backend code. Design populated + empty states + error states for each.

All dashboard endpoints live on `customers.advocatemcp.com` (the Worker). The Worker proxies to Railway (`advocate-production-2887.up.railway.app`) for business data. Errors always use the shape `{ "ok": false, "error_code": "<snake_case>" }` or, on Railway direct, `{ "error": "<code>", ... }`.

### 4.1 Auth — hybrid Bearer + refresh cookie

Phase C shipped this. Flow: login → receive short-lived access token (15 min) in JSON + opaque refresh token in HttpOnly cookie → call API with `Authorization: Bearer <access_token>` → on 401, call `/api/auth/refresh` → retry.

#### `POST /api/auth/login`

**Request**
```json
{ "email": "jane@acme.com", "password": "..." }
```

**200 OK**
```json
{
  "access_token": "eyJhbGciOi...<base64url signed>",
  "expires_in": 900,
  "user": {
    "id": "u_01HX...",
    "email": "jane@acme.com",
    "full_name": "Jane Smith",
    "role": "client",
    "tenant_id": "b_01HY..."
  }
}
```
Plus `Set-Cookie: amcp_refresh=...; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh; Max-Age=2592000`.

**Error codes**
| Status | `error_code` | When |
|---|---|---|
| 400 | `invalid_body` | missing email or password |
| 401 | `invalid_credentials` | wrong email or wrong password — never leaks which |
| 429 | `rate_limited` | 5 failed attempts in 15 min for this email |
| 500 | `platform_error` | signing key misconfigured (shouldn't happen in prod) |

#### `POST /api/auth/refresh`

No body. Reads `amcp_refresh` cookie.

**200 OK**
```json
{ "access_token": "eyJ...", "expires_in": 900 }
```
(new `Set-Cookie` rotates the refresh token)

**Error codes:** `no_refresh_cookie` (401), `invalid_refresh` (401), `platform_error` (500).

#### `POST /api/auth/logout`

**Always** returns 200 `{ "ok": true }` + `Set-Cookie: amcp_refresh=; Max-Age=0`. Idempotent — never leaks whether a session existed.

### 4.2 Dashboard — Bearer-authed client endpoints

All four accept `Authorization: Bearer <access_token>`. Return `401 Unauthorized` with `{ ok: false, error_code: "Unauthorized" }` if token missing/invalid/expired. On 404 return `{ ok: false, error_code: "No business found for this account" }`.

#### `GET /api/client/me`

**200**
```json
{
  "id": "u_01HX...",
  "email": "jane@acme.com",
  "full_name": "Jane Smith",
  "role": "client"
}
```

#### `GET /api/client/metrics?slug=<slug>`

Proxies Railway `/analytics/:slug`. Shape:

**200 — populated**
```json
{
  "slug": "acme-plumbing-boise",
  "total_queries": 247,
  "referral_clicks": 34,
  "referral_clicks_last_30_days": 22,
  "queries_by_crawler": {
    "PerplexityBot": 118, "GPTBot": 64, "ClaudeBot": 41,
    "OAI-SearchBot": 18, "Googlebot": 6
  },
  "queries_by_intent": {
    "emergency": 72, "best_top": 58, "specific_service": 49,
    "affordable": 34, "general": 22, "brand_direct": 12
  },
  "top_queries": [
    "emergency plumber boise",
    "best 24 hour plumber in boise",
    "affordable drain cleaning boise id",
    "..."
  ],
  "queries_last_30_days": [
    { "date": "2026-03-16", "count": 4 },
    { "date": "2026-03-17", "count": 7 },
    "..."
  ],
  "activity_by_dow_hour": [
    { "dow": 1, "hour": 8, "count": 12 },
    { "dow": 1, "hour": 9, "count": 18 },
    "..."
  ],
  "recent_queries": [
    {
      "id": 5821,
      "crawler_agent": "PerplexityBot",
      "query_text": "burst pipe emergency plumber boise at 2am",
      "response_text": "Acme Plumbing offers 24/7 emergency service...",
      "referral_clicked": 1,
      "timestamp": "2026-04-14T07:14:22.000Z",
      "intent": "emergency"
    }
  ]
}
```

**200 — empty (new tenant, no data yet)**
```json
{ "message": "No data available yet", "slug": "acme-plumbing-boise" }
```

**Design note.** `dow` is 0–6 (Sun–Sat, UTC). `hour` is 0–23 UTC. The heatmap in Section 6 renders these as a 7×24 grid.

#### `GET /api/client/activity?slug=<slug>`

Returns just the `recent_queries` array from above (same shape). Empty state: `[]`.

#### `POST /api/client/rotate-key?slug=<slug>`

No body. Returns:

**200**
```json
{ "ok": true, "new_api_key": "9a7c1d2e-..." }
```

**Design note.** Show the new API key **once** in a modal with a copy button and a warning: "Save this now — we can't show it again. The old key stops working immediately."

### 4.3 Onboarding wizard (Worker-hosted)

#### `POST /api/onboard/public`

The 9-step wizard's final submit. Request body is the `OnboardingPayloadSchema` from `server/src/schemas/business.ts`. Full shape below, step by step.

```ts
{
  // Step 1 — Identity
  name: string (1..200),
  description: string (1..2000),
  category: string (1..80),            // "plumber", "roofer", "family law attorney"
  location: string (1..200),           // "Boise, ID"
  phone?: string,
  website?: string (url),
  referral_url?: string (url),         // defaults to website
  tone: "friendly" | "professional" | "luxury",

  // Step 2 — Services
  services: string[] (>=1),
  services_json_v2?: {
    inclusions: string[],              // what they do
    exclusions: string[],              // what they won't do
    specialties: string[],             // niches
    not_offered: string[]              // services they deliberately don't offer
  },

  // Step 3 — Hours & availability
  hours_json?: {
    mon: { open: "HH:MM", close: "HH:MM" } | null,
    tue: ..., wed: ..., thu: ..., fri: ..., sat: ..., sun: ...,
    emergency_24_7: boolean
  },
  availability?: string,
  service_radius_miles?: number,
  service_area_keywords?: string,

  // Step 4 — Pricing
  pricing?: string,                    // free-text fallback
  pricing_tier?: "budget" | "mid-range" | "premium",
  pricing_json_v2?: {
    ranges: { service, min, max, unit: "job"|"hour"|"visit"|"sqft" }[],
    call_for_quote: boolean,
    free_estimates: boolean
  },

  // Step 5 — Credentials & trust
  credentials_json?: {
    licenses: { name: string, number: string }[],
    insured: boolean,
    bonded: boolean,
    certifications: string[]
  },
  certifications?: string,
  years_in_business?: number,

  // Step 6 — Ratings (dual source)
  star_rating: number (0..5),          // rolled-up
  review_count: number (>=0),
  ratings_json?: {
    google?: { rating, count },
    yelp?:   { rating, count },
    facebook?: { rating, count },
    bbb?:    { rating, count }
  },

  // Step 7 — Differentiators & proof
  differentiator?: string,
  differentiators_text?: string (<=1500),
  customer_quotes_json?: {
    quote: string (1..500),
    author: string (1..120),
    source: "google" | "yelp" | "facebook" | "bbb" | "direct"
  }[],
  guarantee_text?: string (<=500),
  case_stories_json?: {
    title: string (1..120),
    summary: string (1..600)
  }[],
  top_services?: string,

  // Step 8 — Lead routing
  lead_routing_json?: {
    preferred_channel: "phone" | "email" | "form" | "text",
    phone?: string,
    email?: string (email),
    form_url?: string (url)
  },

  // Step 9 — Plan & review
  plan?: "base" | "pro"                // base = $100/mo, pro = $250/mo
}
```

**201 Created**
```json
{
  "slug": "acme-plumbing-boise",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_..."
}
```

**400 validation_error**
```json
{
  "error": "validation_error",
  "issues": [
    { "path": "star_rating", "message": "Number must be less than or equal to 5" },
    { "path": "services", "message": "Array must contain at least 1 element(s)" }
  ]
}
```

**Design note.** The wizard is the highest-stakes UI in the product. Map each step above to a wizard screen. Every step should have: progress bar, step title, step subtitle, one primary action (Continue), one secondary action (Back), and a "Save & exit" link that calls `/api/onboard/draft` (Section 4.4). Step 2 (services) and step 7 (quotes + stories) have inline array editors — dedicate a dialog to those rather than cramming into a single screen.

#### `POST /api/onboard/draft`

Upserts in-progress wizard state so a customer can leave and resume.

**Request**
```json
{
  "email": "jane@acme.com",
  "step": 4,
  "payload": { "...partial OnboardingPayloadSchema fields..." }
}
```

**200** `{ "ok": true, "email": "jane@acme.com", "step": 4, "updated_at": "2026-04-14T..." }`

**Error codes:** `invalid_json` (400), `validation_error` (400), `payload_too_large` (413, >256 KB).

#### `GET /api/onboard/draft/:email`

**200**
```json
{
  "email": "jane@acme.com",
  "step": 4,
  "updated_at": "2026-04-14T...",
  "payload": { "...last saved partial..." }
}
```

**404** `{ "ok": false, "error_code": "not_found" }`

### 4.4 Business profile + analytics (Railway direct — referenced from dashboard)

#### `GET /agents/:slug/profile`  (`Authorization: Bearer <server API_KEY>`)

Used to render the "Agent" tab (read-only view of the business profile).

**200**
```json
{
  "slug": "acme-plumbing-boise",
  "name": "Acme Plumbing",
  "description": "Family-owned plumbers serving the Treasure Valley since 1998.",
  "category": "plumber",
  "services": ["drain cleaning", "water heater", "burst pipe", "sewer line"],
  "top_services": ["emergency repair", "drain cleaning"],
  "pricing": "$89 service call, $125/hr labor",
  "pricing_tier": "mid-range",
  "location": "Boise, ID",
  "phone": "+1-208-555-0142",
  "website": "https://acmeplumbingboise.com",
  "referral_url": "https://acmeplumbingboise.com/book",
  "tone": "friendly",
  "star_rating": 4.8,
  "review_count": 312,
  "years_in_business": 28,
  "availability": "24/7 for emergencies, 7am–7pm for scheduled work",
  "differentiator": "Same-day emergency response anywhere in Ada County",
  "service_radius_miles": 30,
  "certifications": ["master plumber", "backflow certified"],
  "service_area_keywords": ["boise", "meridian", "eagle", "nampa", "kuna"],
  "created_at": "2025-11-02T14:22:18.000Z"
}
```

#### `GET /analytics/:slug/clicks`

**200**
```json
{
  "slug": "acme-plumbing-boise",
  "clicks": [
    {
      "id": 4218,
      "ref": "PerplexityBot",
      "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)...",
      "timestamp": "2026-04-14T11:42:09.000Z"
    }
  ]
}
```

Empty: `{ "slug": "...", "clicks": [] }`.

### 4.5 Competitor radar

New in the last session. Two Pro-plan-gated (today: admin/api-key-gated) read endpoints + basket CRUD.

#### `GET /api/competitor-radar/:slug/summary?days=30`

**200**
```json
{
  "range_days": 30,
  "total_polls": 84,
  "cited_count": 52,
  "citation_rate": 0.619,
  "avg_cited_rank": 2.3,
  "top_competitor_domains": [
    { "domain": "rotorooter.com", "cited_count": 31 },
    { "domain": "servicemaster.com", "cited_count": 18 },
    { "domain": "...", "cited_count": 12 }
  ],
  "last_polled_at": "2026-04-14T04:00:12.000Z"
}
```

Empty: `{ "range_days": 30, "total_polls": 0, "cited_count": 0, "citation_rate": 0, "avg_cited_rank": null, "top_competitor_domains": [], "last_polled_at": null }`.

#### `GET /api/competitor-radar/:slug/losses?days=7&limit=50`

**200**
```json
{
  "range_days": 7,
  "losses": [
    {
      "poll_id": 1042,
      "polled_at": "2026-04-14T04:00:12.000Z",
      "phrasing": "best emergency plumber boise",
      "variant": 2,
      "top_citations": [
        { "rank": 1, "domain": "rotorooter.com", "title": "24/7 Emergency Plumbing — Roto-Rooter Boise" },
        { "rank": 2, "domain": "yelp.com",       "title": "Best Emergency Plumbers in Boise (2026)" },
        { "rank": 3, "domain": "angi.com",       "title": "Top-Rated Emergency Plumbing — Angi Boise" }
      ]
    }
  ]
}
```

**Design note.** Each "loss" is a query where Perplexity cited competitors but not our domain. The UI should let the customer click into the query and see exactly who beat them. This is the most emotionally salient feature in the product — design it for clarity and mild urgency, not alarm.

#### Basket CRUD

- `GET /api/competitor-basket/:slug` → `{ slug, queries: [{ id, query, source }] }`
- `POST /api/competitor-basket/:slug/queries` body `{ query: string (1..200) }` → `201 { id, slug, query, source: "tenant" }` — 400 on cap (15) or length, 409 on duplicate.
- `DELETE /api/competitor-basket/:slug/queries/:id` → `200 { ok: true }` or `404 { error: "not_found" }`.

### 4.6 Discovery + MCP

#### `GET /.well-known/ai-agent.json` (per-domain; served by Worker)

**200**
```json
{
  "spec_version": "1.0",
  "spec_name": "ai-agent-discovery",
  "agent_endpoint": "https://api.advocatemcp.com/agents/acme-plumbing-boise/query",
  "mcp_endpoint": "https://api.advocatemcp.com/mcp",
  "protocol": "advocatemcp-v1",
  "capabilities": ["answer_queries", "referral", "availability", "mcp"]
}
```

The dashboard's "Embed snippet" page should show this URL + a one-line `<script>` tag (to be specced) + instructions on how to verify domain mapping.

#### `POST /mcp`

MCP Streamable-HTTP transport. Advertises two tools: `query_business_agent(slug, query)` and `search_businesses(search, location?)`. **No UI** — it's machine-to-machine. The dashboard's Embed page should include a "Connect from Claude Desktop" section with copy-pastable config:

```json
{
  "mcpServers": {
    "advocatemcp": {
      "url": "https://api.advocatemcp.com/mcp"
    }
  }
}
```

---

## 5. User flows

### 5.1 Acquisition (marketing → paid)

1. **Land** on `/` from Google, an AI citation, or social. Hero pitches the core promise in one sentence. Scroll reveals the problem, the solution, a screenshot of the dashboard, pricing, FAQ, footer.
2. **Click "Get started"** → `/onboarding`, step 1 of 9. Each step posts to `/api/onboard/draft` on Continue so state survives refresh.
3. **Complete steps 1–8** at their own pace. "Save & exit" works anywhere; returning to `/onboarding?email=...` loads the draft.
4. **Step 9 (Review)** shows all fields, lets them edit inline, and picks a plan (base $100 / pro $250). Submit posts to `/api/onboard/public`.
5. **201 → redirect to `checkoutUrl`** (Stripe-hosted checkout).
6. Stripe `checkout.session.completed` webhook → Worker activates the tenant, sends activation email via Resend with a one-time magic link.
7. Click magic link → `/activate?token=...` → creates password → lands on dashboard **first-run overview** with an empty state that says "Your agent is live — AI bots can now find you. Data will appear here as soon as the first bot visits."

### 5.2 Daily use (the "did it work?" loop)

1. Log in at `customers.advocatemcp.com/login`. Bearer access token in memory, refresh cookie stored.
2. **Overview** shows: this week's queries, top crawler, CTR, top 3 competitor losses, recommended action. One CTA: "Review competitor losses".
3. **Competitor radar** lists queries where we weren't cited. Click into a loss → see top 5 domains that WERE cited → see the agent's current profile for context.
4. Click "Improve agent" → navigates to **Agent config**. Suggests differentiator edits based on the loss. Save calls `PATCH /agents/:slug/profile`.
5. Back to **Analytics** after 24–48 hours to verify citation rate improved.

### 5.3 Admin / housekeeping

1. Log in. **Settings → API keys.**
2. Click "Rotate key". Confirm modal ("This breaks any existing integration — continue?").
3. New key shown once in a modal with copy button.
4. **Settings → Embed snippet** shows how to update the key in the Worker environment if the customer self-hosts any integration.
5. **Billing** links to Stripe's customer portal (use Stripe's hosted page — don't rebuild it).

---

## 6. Component inventory

Max builds each component once in Figma and again in Webflow (for marketing) / vanilla TS (for dashboard). Names listed here are the canonical names used in both systems.

### 6.1 Primitives

| Component | Variants | Notes |
|---|---|---|
| `Button` | `primary`, `secondary`, `ghost`, `destructive` × `sm`/`md`/`lg` | Primary = solid maroon on dark bg. Ghost = outline. Destructive = red for rotate-key / delete. |
| `Input` | `default`, `error`, `disabled` × `sm`/`md` | With label-above, optional helper text, optional suffix/prefix slot. |
| `Textarea` | `default`, `error`, `disabled` | Auto-resize up to 8 lines. |
| `Select` | `default`, `error`, `disabled` | Native-looking but styled. |
| `Checkbox` | `default`, `checked`, `indeterminate`, `disabled` | Used in wizard services/exclusions, credentials (licensed/insured/bonded). |
| `Radio` | `default`, `checked`, `disabled` | Used in wizard plan picker, tone selector. |
| `Toggle` | `off`, `on`, `disabled` | Used in wizard hours for emergency_24_7, credentials boolean fields. |
| `Tag` / `Pill` | `neutral`, `success`, `warning`, `danger`, `info` | Intent pills on queries table, crawler pills, plan badges. |
| `Tooltip` | `default` | Keyboard-accessible. |
| `Avatar` | `sm`/`md`/`lg`, `initials`/`image` | Account menu. |
| `Link` | `default`, `inverted` | Underline on hover. |

### 6.2 Patterns

| Component | Notes |
|---|---|
| `NavMarketing` | Logo + product/pricing/how-it-works/blog + Login + Get started CTA. |
| `NavDashboard` | Logo + business switcher + notifications + account menu. Left-side sidebar with nav items. |
| `BusinessSwitcher` | Dropdown — used when a customer has >1 business. Default business shown first. |
| `WizardShell` | Progress bar (1 of 9), step title, step subtitle, slot for step body, footer with Back / Continue / Save & exit. |
| `FormField` | Label + input + helper text + error message. Wraps any primitive. |
| `EmptyState` | Centered illustration + headline + 1-sentence body + optional CTA. One variant per page: analytics-empty, competitors-empty, activity-empty, queries-empty. |
| `ErrorState` | For 500s. Message + "Try again" + contact support link. |
| `MetricCard` | Label + big number + delta (↑12% this week) + sparkline. Used on overview. |
| `StatGrid` | 3–4 `MetricCard`s in a responsive row. |
| `DataTable` | Header row (sortable), body rows, pagination footer. Used for queries, losses, clicks. Includes search input + filter pills at top. |
| `Heatmap` | 7×24 grid (day × hour). Cell opacity scales with count. Data from `activity_by_dow_hour`. |
| `BarChart` | Horizontal bars for `queries_by_crawler`, `queries_by_intent`. |
| `Sparkline` | Inline mini-line chart for 30-day trend. |
| `CodeBlock` | Monospace, copy button top-right, syntax-highlighted for JSON. Used for embed snippet + MCP config. |
| `Modal` | Header + body + footer (primary + secondary buttons). Used for rotate-key confirmation + one-time-key display. |
| `Toast` | Success / error / info. Top-right, auto-dismiss 4s. |
| `Drawer` | Right-side panel for "query detail" (click a row in queries table). |
| `InlineEditor` | Click-to-edit on profile fields (debounced save via PATCH). |
| `ArrayEditor` | Used in wizard for services, customer_quotes, case_stories, licenses. Add/remove rows + per-row validation. |

### 6.3 Page sections

| Component | Notes |
|---|---|
| `Hero` | Eyebrow + h1 (with italic-accent `em`) + subheadline + primary CTA + secondary CTA + screenshot/video. |
| `FeatureGrid` | 3 or 6 icon-headline-body cards. |
| `ProductDemo` | Large screenshot or embedded video — "what you'll see" social proof. |
| `PricingTable` | 3 tiers (Free / Base $100 / Pro $250). Each card: name, price, feature list, CTA. Pro gets a "Most popular" tag. |
| `Testimonial` | Quote + author + logo. 3-column grid. |
| `CTA` | Full-bleed band — headline + CTA. One per landing page, one before footer. |
| `Footer` | 4 columns (Product / Company / Resources / Legal) + social icons + copyright. |
| `FAQ` | Accordion. |
| `BlogCard` | Image + category + title + excerpt + date + author. |

---

## 7. Design tokens

Produce `tokens.json` (source of truth, Style Dictionary-compatible), then generate `tokens.css` (CSS custom properties) and a Webflow style guide from it.

### 7.1 Target shape for `tokens.json`

```json
{
  "color": {
    "bg":              { "value": "#13100f" },
    "surface":         { "value": "#1a1715" },
    "surface-raised":  { "value": "#221e1c" },
    "border":          { "value": "#2a2622" },
    "border-strong":   { "value": "#3a3430" },
    "text-primary":    { "value": "#ece7e2" },
    "text-secondary":  { "value": "#a49c94" },
    "text-muted":      { "value": "#6c655f" },
    "accent":          { "value": "#7d2550" },
    "accent-hover":    { "value": "#8f2d5d" },
    "accent-dim":      { "value": "rgba(125,37,80,0.10)" },
    "accent-ring":     { "value": "rgba(125,37,80,0.24)" },
    "success":         { "value": "#3ea572" },
    "warning":         { "value": "#d9a23e" },
    "danger":          { "value": "#c9465a" },
    "info":            { "value": "#5a93c0" }
  },
  "radius": {
    "xs": { "value": "4px"  },
    "sm": { "value": "8px"  },
    "md": { "value": "12px" },
    "lg": { "value": "16px" },
    "pill": { "value": "999px" }
  },
  "space": {
    "1": { "value": "4px"  },
    "2": { "value": "8px"  },
    "3": { "value": "12px" },
    "4": { "value": "16px" },
    "5": { "value": "24px" },
    "6": { "value": "32px" },
    "7": { "value": "48px" },
    "8": { "value": "64px" },
    "9": { "value": "96px" }
  },
  "type": {
    "family-display": { "value": "'Instrument Serif', Georgia, serif" },
    "family-body":    { "value": "'General Sans', system-ui, sans-serif" },
    "family-mono":    { "value": "'JetBrains Mono', ui-monospace, monospace" },
    "size-xs":   { "value": "clamp(12px, 0.75rem + 0.1vw, 13px)" },
    "size-sm":   { "value": "clamp(13px, 0.8rem + 0.15vw, 14px)" },
    "size-base": { "value": "clamp(15px, 0.9rem + 0.2vw, 16px)" },
    "size-lg":   { "value": "clamp(17px, 1rem + 0.3vw, 18px)" },
    "size-xl":   { "value": "clamp(20px, 1.15rem + 0.5vw, 22px)" },
    "size-2xl":  { "value": "clamp(28px, 1.6rem + 1.2vw, 36px)" },
    "size-3xl":  { "value": "clamp(40px, 2.2rem + 2.5vw, 64px)" }
  },
  "shadow": {
    "1": { "value": "0 1px 2px rgba(0,0,0,0.4)" },
    "2": { "value": "0 4px 12px rgba(0,0,0,0.45)" },
    "3": { "value": "0 12px 40px rgba(0,0,0,0.55)" }
  },
  "motion": {
    "fast":     { "value": "150ms" },
    "standard": { "value": "250ms" },
    "slow":     { "value": "400ms" },
    "ease":     { "value": "cubic-bezier(0.2, 0.8, 0.2, 1)" }
  }
}
```

### 7.2 Generated `tokens.css` (expected output)

```css
:root {
  --bg: #13100f;
  --surface: #1a1715;
  --surface-raised: #221e1c;
  --border: #2a2622;
  --border-strong: #3a3430;
  --text-primary: #ece7e2;
  --text-secondary: #a49c94;
  --text-muted: #6c655f;
  --accent: #7d2550;
  --accent-hover: #8f2d5d;
  --accent-dim: rgba(125,37,80,0.10);
  --accent-ring: rgba(125,37,80,0.24);
  /* ...etc */
  --r-xs: 4px; --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-pill: 999px;
  --s-1: 4px; --s-2: 8px; /* ...etc */
  --font-display: 'Instrument Serif', Georgia, serif;
  --font-body:    'General Sans', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', ui-monospace, monospace;
  /* ...type scale, shadows, motion */
}
```

### 7.3 Dark-first, light mode optional

Ship dark mode as the default (the current marketing site is already dark). If Max produces a light-mode variant, it should live under `html[data-theme="light"]` or `@media (prefers-color-scheme: light)`. Not required for v1.

### 7.4 Accent is **maroon, not teal**

Any teal in existing designs is legacy. The `accent` token drives every brand-colored pixel in the UI: button bg, hero em italic color, focus rings, chart accent lines, hover tints. One color. No gradients.

---

## 8. Technical constraints

| Area | Constraint |
|---|---|
| Dashboard framework | Vanilla TypeScript. **No React, Vue, Next, Vite, Svelte, or any SPA framework.** Bundle target: <50 KB gzipped for the whole dashboard (we currently ship 0 KB of JS for most pages — stay lean). |
| Marketing framework | Webflow-native. Do not inject external JS frameworks. Custom code blocks are fine for interactive bits (copy buttons, tabs). |
| CSS | Custom properties + plain CSS. No Tailwind, no CSS-in-JS, no Sass. Webflow's style panel for marketing; plain `.css` files for dashboard. |
| Accessibility | WCAG 2.1 AA minimum. Text contrast 4.5:1, UI contrast 3:1. All interactive elements keyboard-reachable. Focus states visible on every clickable thing. ARIA labels on icon-only buttons. |
| Responsive | Mobile-first from 375px. Breakpoints: 480, 768, 1024, 1280. No horizontal scroll at any width ≥ 375px. |
| Fonts | Instrument Serif + General Sans + one mono (JetBrains Mono preferred). **Self-host** — no Google Fonts CDN. WOFF2 subsets only. |
| Logos / icons | SVG only, no raster. Icon set: Lucide (open source) — only pull icons we actually use. |
| Images / photos | Use photography sparingly. Prefer abstract geometric illustrations that echo the star logo. No stock photos of people in hard hats. |
| Browser support | Evergreen Chrome, Firefox, Safari, Edge. No IE. iOS Safari + Chrome Android. |
| Animation | Purposeful only. 150ms for micro-interactions, 250ms for transitions, 400ms for major layout. `prefers-reduced-motion` respected. |
| Copy length | Longest headline: 72 chars. Longest subhead: 180 chars. Button labels: ≤ 22 chars. Design for these limits. |
| Do not bolt on | A chat widget. A cookie banner (P1 later). Any third-party analytics beyond Plausible. |

---

## 9. Reference inspirations

Each reference solves a specific problem well. Don't copy wholesale — borrow the move.

### 9.1 Dashboards

| Reference | Use for |
|---|---|
| **Linear** (linear.app) | Empty states, keyboard shortcuts, information density, subtle motion. |
| **Vercel** (vercel.com/dashboard, marketing) | Type scale, generous whitespace, dark mode done right. |
| **Stripe dashboard** (dashboard.stripe.com) | Tabular data clarity, filter pills, detail drawers, timeline events. |
| **Plausible Analytics** (plausible.io) | Simple analytics UX for non-technical users — this is our customer's mental model. |
| **Retool** (retool.com/dashboard) | Data-dense without feeling cluttered. |

### 9.2 Marketing

| Reference | Use for |
|---|---|
| **Stripe.com** | Hero + type scale + technical-but-warm tone. |
| **Ramp** (ramp.com) | Dark-first elegance + confident b2b voice. |
| **Retool homepage** | Feature grid + product screenshot composition. |
| **Figma.com** | Micro-interactions on homepage. |

### 9.3 Onboarding wizards

| Reference | Use for |
|---|---|
| **Stripe Atlas / Stripe onboarding** | Multi-step progression, save & resume, trust cues on the payment step. |
| **Vercel import flow** | Clean progress indicator + pre-fill patterns. |
| **Linear onboarding** | Tone — conversational but precise. |

### 9.4 Things to NOT look at

- Generic SaaS marketing templates on Framer / Webflow showcases (too glossy, too templated).
- AI-themed sites with gradient blobs and synthwave aesthetics (wrong audience).
- Enterprise-analytics tools (Amplitude, Mixpanel) — too dense for our SMB user.

---

## 10. Deliverables checklist

### 10.1 Figma

- [ ] Single Figma file, organized by pages per Section 3.
- [ ] Component library matching Section 6 names exactly (`Button`, `WizardShell`, `MetricCard`, etc.).
- [ ] Variants for every component state (default/hover/active/disabled/error).
- [ ] Auto-layout on everything that will translate to CSS flex/grid.
- [ ] Text styles + color styles derived from tokens (named to match `tokens.json` keys: `color/accent`, `space/4`, etc.).
- [ ] Dark mode is the primary. Light mode optional.
- [ ] Screens: desktop 1440, tablet 768, mobile 375 for every P0 page.

### 10.2 Webflow

- [ ] Webflow project covering all P0 marketing pages.
- [ ] Style guide page exposing every token and component.
- [ ] All pages responsive at 375 / 768 / 1024 / 1440.
- [ ] Forms for wizard wired to the real endpoints in Section 4 (happy path only; engineering handles error handling).
- [ ] CMS collection scaffolded for Blog (even if empty at launch).
- [ ] Hosting configured on `advocatemcp.com`.

### 10.3 Tokens

- [ ] `tokens.json` in the exact shape from Section 7.1.
- [ ] Generated `tokens.css` committed to `site/tokens.css`.
- [ ] Webflow style guide uses the same variable names.

### 10.4 Brand assets

- [ ] Logo — full color (white star on maroon), SVG.
- [ ] Logo — mono white, SVG.
- [ ] Logo — mono black, SVG.
- [ ] Favicon — SVG + 32×32 PNG fallback.
- [ ] Apple touch icon — 180×180 PNG.
- [ ] Social / OG card — 1200×630 PNG (logo + tagline on maroon).

### 10.5 Documentation / handoff

- [ ] One-page README describing the Figma file organization.
- [ ] Component-to-code mapping doc for engineering (which Figma component maps to which planned TS component).
- [ ] One Loom walkthrough (≤10 min) of the dashboard flow end-to-end.
- [ ] Screenshot pack: every page × desktop + mobile, in `docs/design/screenshots/`.

### 10.6 Out of scope for Max

- Copywriting beyond what's in this brief (engineering will hand over final copy before Webflow launch).
- Illustration set beyond the logo (P1 — can use geometric SVG primitives in Webflow for v1).
- Email templates for activation / password reset (P1).
- Video production for hero (P2).

---

## Appendix A — Files of record

| File | Purpose |
|---|---|
| `site/legal-source/logo-v1.svg` | Canonical logo geometry |
| `server/src/schemas/business.ts` | Wizard schema (Section 4.3) |
| `server/src/routes/register.ts` | POST /register Railway handler |
| `server/src/routes/analytics.ts` | Analytics response shape (Section 4.2, 4.4) |
| `server/src/routes/agent.ts` | Profile + rotate-key handlers |
| `server/src/routes/competitorRadar.ts` | Competitor radar endpoints (Section 4.5) |
| `worker/src/routes/authApi.ts` | Phase C auth endpoints (Section 4.1) |
| `worker/src/routes/portal.ts` | `/api/client/*` handlers (Section 4.2) |
| `worker/src/routes/onboardDraft.ts` | Draft save/load (Section 4.3) |
| `worker/src/routes/stripe.ts` | `/api/onboard/public` handler |
| `worker/src/routes/dashboard.ts` | Current dashboard HTML (reference only — to be replaced) |
| `worker/src/routes/sharedLayout.ts` | Current green/Poppins system (to deprecate) |
| `site/index.html`, `site/onboarding.html`, `site/privacy.html`, `site/terms.html`, `site/dpa.html` | Current System B tokens (teal — to replace) |

## Appendix B — Glossary

| Term | Meaning |
|---|---|
| **Slug** | URL-safe identifier for a business (e.g. `acme-plumbing-boise`). Primary key on every API call. |
| **Crawler / bot** | An AI search user-agent (PerplexityBot, GPTBot, ClaudeBot, OAI-SearchBot, Google-Extended, etc.). |
| **Intent** | Classified query intent: `brand_direct`, `emergency`, `affordable`, `best_top`, `specific_service`, `general`. |
| **Citation** | The act of an AI response linking to a domain. The product measures citation rate. |
| **Referral click** | A human clicking the tracked link in an AI response back to the customer's site. The closed-loop metric. |
| **Basket** | A tenant's set of queries to poll against for competitor radar (cap 15, min 1). |
| **Loss** | A polled query where competitors were cited and we were not. |
| **Plan tiers** | `base` ($100/mo) = core product; `pro` ($250/mo) = includes competitor radar + higher limits. |
| **Tenant** | A customer — 1:1 with a `business` row. A user can belong to multiple tenants via `user_business_access`. |

---

*Questions during design? Tag them inline with `TODO(max):` comments in the Figma file — we'll address them in the weekly review. Anything that can't wait a week, ping Cameron directly.*
