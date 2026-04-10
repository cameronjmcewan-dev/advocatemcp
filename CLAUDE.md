# AdvocateMCP — Claude Code Context

Read this entire file before doing anything. When in doubt, ask before acting.

## Product in three sentences

AdvocateMCP intercepts AI search crawler traffic at the edge (Cloudflare Worker), detects bots by user-agent, and routes them to a Claude-powered conversational agent that returns a citation-ready response tailored to the bot's query. Every citation link we return is tracked end-to-end so we can attribute downstream user clicks and conversions back to the originating AI bot and query. We also expose all registered businesses through a single central MCP server at `/mcp` so MCP-compatible clients (Claude Desktop, Cursor) can query any business directly.

## What makes us different

Static GEO tools (Scrunch, Profound, Peec, Otterly, Athena HQ) monitor citations and optimize content statically. We are the only system that intercepts bot traffic at the edge, generates per-bot per-query optimized responses in real time, AND tracks the resulting referral end to end. The dual-surface architecture (crawler interception + central MCP server) and the closed attribution loop are the moat. Protect both.

## Stack — do not deviate without explicit approval

- **Edge**: Cloudflare Worker (TypeScript, strict mode), deployed via wrangler from `worker/` directory only
- **Backend**: Node.js + Express on Railway (`server/`), TypeScript
- **Databases**: SQLite for analytics and full business data (`server/dev.db`), Cloudflare D1 for portal auth and edge-side data (`advocatemcp-auth`), KV namespace `BUSINESS_MAP` for domain→slug routing, KV namespace `TENANT_DATA` for tenant onboarding records
- **AI**: Anthropic Claude API, model `claude-sonnet-4-6`, prompt caching enabled on system prompts
- **Auth (portal)**: PBKDF2-SHA256 100k iterations, session tokens hashed with SHA-256, HttpOnly+Secure+SameSite=Lax cookies
- **Email**: Resend (use this, not Postmark)
- **Payments**: Stripe (secrets stored as Wrangler secrets — all four must be same mode: all test OR all live)
- **Testing**: bash smoke test at `worker/scripts/smoke-test.sh`, vitest for new code
- **Crypto**: HMAC-SHA256 for signed tokens — helpers go in `server/src/lib/` and `worker/src/lib/` with identical signing logic

## Repository layout

```
advocatemcp/
├── server/                    # Node/Express backend on Railway
│   ├── src/
│   │   ├── routes/            # Express routes (agent, analytics, mcp, register, wellknown)
│   │   ├── agent/             # Claude prompt builder and query runner
│   │   ├── middleware/        # Auth, rate limiting
│   │   ├── lib/               # Shared helpers (crypto, tracked-url)
│   │   └── prompts/           # Per-bot system prompts (to be added in Session 2)
│   ├── dev.db                 # SQLite — DO NOT commit
│   └── package.json
├── worker/                    # Cloudflare Worker (edge)
│   ├── src/
│   │   ├── index.ts           # Main entrypoint, bot detection, dispatch
│   │   ├── routes/            # portal, demo, onboard, stripe, domains, sharedLayout
│   │   ├── auth.ts            # PBKDF2 auth helpers
│   │   ├── portalDb.ts        # D1 query helpers
│   │   └── lib/               # Worker helpers (tracked-url)
│   ├── migrations/            # D1 migrations (0001_init, 0002_cf_hostname, 0003_stripe)
│   ├── scripts/               # smoke-test.sh, create-client.sh, check-design.mjs
│   └── wrangler.toml          # ONLY wrangler config — root wrangler.toml.orphan-do-not-use is deleted
├── site/                      # Static HTML (index, terms, privacy, DPA, onboarding)
├── docs/                      # Subsystem documentation — read before touching
│   ├── attribution.md
│   ├── bot-detection.md
│   ├── response-generation.md
│   └── mcp-server.md
└── CLAUDE.md                  # This file
```

## Data model — current

### ⚠️ Two separate `businesses` tables — NEVER merge them

There are two `businesses` tables by design:

1. **SQLite on Railway** — full business profile, source of truth for all business data and agent responses
2. **D1 on the Worker** — thin auth lookup only (`id, slug, business_name, api_key, cf_hostname_id, stripe_customer_id, stripe_subscription_id, plan, domain`)

They must never be merged. The Worker D1 table exists solely so the portal can authenticate clients and proxy analytics requests without a round-trip to Railway for auth. The Railway SQLite table is the only place business profile data lives.

### SQLite (server/dev.db) — Railway

```sql
CREATE TABLE businesses (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                 TEXT UNIQUE NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL,
  services             TEXT NOT NULL,          -- JSON array of service strings
  pricing              TEXT,
  location             TEXT,
  phone                TEXT,
  website              TEXT,
  referral_url         TEXT,                   -- the CTA link to send AI searchers to
  tone                 TEXT DEFAULT 'friendly',-- friendly | professional | luxury
  api_key              TEXT UNIQUE NOT NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- Rich SMB profile (added via ALTER TABLE migrations):
  category             TEXT,
  star_rating          REAL,
  review_count         INTEGER,
  years_in_business    INTEGER,
  top_services         TEXT,
  availability         TEXT,
  differentiator       TEXT,
  service_radius_miles INTEGER,
  certifications       TEXT,
  pricing_tier         TEXT,
  service_area_keywords TEXT
);

CREATE TABLE queries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug    TEXT NOT NULL,
  crawler_agent    TEXT,               -- e.g. "PerplexityBot"
  query_text       TEXT NOT NULL,
  response_text    TEXT NOT NULL,
  referral_clicked INTEGER DEFAULT 0,  -- updated to 1 when /track click arrives
  intent           TEXT,               -- brand_direct|emergency|affordable|best_top|specific_service|general
  timestamp        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE click_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug TEXT NOT NULL,
  ref           TEXT,        -- bot name that sourced the response (e.g. "PerplexityBot")
  user_agent    TEXT,        -- UA of the human who clicked
  ip_hash       TEXT,        -- SHA-256(IP) for deduplication
  timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP
  -- destination TEXT column added in Session 1 migration
  -- query_id INTEGER column added in Session 1 migration
  -- legacy INTEGER DEFAULT 0 column added in Session 1 migration
);
```

### D1 (advocatemcp-auth) — Cloudflare Worker

```sql
-- users: portal accounts
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'client',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- businesses: thin auth lookup only (NOT the source of truth for profile data)
CREATE TABLE businesses (
  id                    TEXT PRIMARY KEY,
  slug                  TEXT UNIQUE NOT NULL,
  business_name         TEXT NOT NULL,
  api_key               TEXT NOT NULL,
  cf_hostname_id        TEXT,                -- added in 0002_cf_hostname.sql
  stripe_customer_id    TEXT,               -- added in 0003_stripe.sql
  stripe_subscription_id TEXT,              -- added in 0003_stripe.sql
  plan                  TEXT DEFAULT 'free',-- added in 0003_stripe.sql
  domain                TEXT,               -- added in 0003_stripe.sql
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- user_business_access: JOIN table for portal auth
CREATE TABLE user_business_access (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, business_id)
);

-- sessions: hashed tokens only (raw token lives in HttpOnly cookie only)
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT UNIQUE NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- login_attempts: rate limiting (5 attempts per 15 min per email)
CREATE TABLE login_attempts (
  id           TEXT PRIMARY KEY,
  identifier   TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### KV namespaces
- `BUSINESS_MAP`: domain hostname → slug string
- `TENANT_DATA`: domain hostname → full JSON tenant record (status, onboarding state)

## Conventions

- TypeScript strict mode everywhere, no `any` without a comment explaining why
- Errors: throw typed errors, never return error objects, never swallow exceptions silently
- All routes validate input with zod schemas
- All SQL is parameterized — no string interpolation
- All Claude API calls go through the `queryAgent` helper in `server/src/agent/query.ts`
- Tests live next to code in `*.test.ts` files
- Conventional commits (`feat:`, `fix:`, `chore:`, etc.)
- Branch naming: `feature/short-name`, `fix/short-name`
- All `wrangler` commands run from `worker/` directory only — never from repo root

## UI conventions (Worker pages)

All Worker HTML pages must use `sharedLayout.ts` for tokens, header, footer, and theme toggle. No hardcoded hex colors in page-specific styles — use CSS variables. See `worker/CLAUDE.md` for the full UI rules.

## Wrangler CLI gotchas

Wrangler's local-vs-remote defaults are **inconsistent across subcommands**. This has bitten us in production cleanup work — assume nothing, pass the flag.

- `wrangler kv:key put|get|delete|list` defaults to **remote** (production KV namespaces). No flag needed to touch prod.
- `wrangler d1 execute` defaults to **local** (`.wrangler/state/v3/d1`). You must pass `--remote` to hit the production D1 database. Running a SELECT without `--remote` will silently query an empty local DB and look like the row is missing.
- `wrangler secret list|put|delete` is remote-only — there is no local mode.

Rule of thumb: for any D1 command that needs to see or modify production data, always add `--remote` explicitly. For KV, the default is already remote, but passing no flag is still a footgun if you're mentally expecting symmetry with D1.

This bit us during the `workman-copy-co` dry-run cleanup on 2026-04-10: a `d1 execute SELECT` without `--remote` returned `no such table: businesses` because it hit empty local state, masking whether the dry-run actually wrote `cf_hostname_id` to prod. It had.

## Do not

- Do not modify bot detection logic in `worker/src/index.ts` (the `AI_CRAWLERS` array and the user-agent matching) without explicit instruction
- Do not refactor the Worker portal code in `worker/src/routes/portal.ts` without explicit instruction — auth code is load-bearing
- Do not change the shape of existing Express route responses without approval — clients depend on them
- Do not move logic between Worker and Railway without approval
- Do not add new dependencies without proposing them and getting approval first
- Do not introduce a frontend framework or build step on customer-facing widgets — vanilla TypeScript only, bundled to a single file under 15kb gzipped
- Do not autogenerate large volumes of templated content for customer domains — Google penalizes scaled content
- Do not refactor code outside the current task. Mention it and wait.
- Do not write narrating comments. Comments explain why, not what.
- Do not use ORMs. Raw SQL through helpers.
- Do not use React, Next, Vite, or any SPA framework.
- Do not log PII to long-term analytics. Raw events with PII go to R2 only.
- Do not commit `.env`, `dev.db`, or any secret.
- Do not duplicate the intent classifier — it already exists in `server/src/agent/query.ts` (`detectIntent`)
- Do not rebuild the `/track` + `click_events` attribution skeleton — it already exists

## What is shipped today

- **Bot detection**: Cloudflare Worker edge detection for PerplexityBot, GPTBot, OAI-SearchBot, ClaudeBot, Google-Extended, Googlebot, anthropic-ai, cohere-ai, meta-externalagent
- **KV routing**: domain→slug lookup via `BUSINESS_MAP`; Cloudflare for SaaS `cf-custom-hostname` fallback; first-path-segment fallback for testing
- **Agent endpoint**: `POST /agents/:slug/query` on Railway powered by `claude-sonnet-4-6`, max 512 tokens, profile-aware system prompt
- **Intent classification**: six categories — `brand_direct`, `emergency`, `affordable`, `best_top`, `specific_service`, `general` — running on every query, stored in `queries.intent` column. **Do not duplicate.**
- **Response generation**: intent-tuned system prompt via `server/src/agent/builder.ts` with emphasis blocks per intent
- **Attribution — signed tokens** *(Session 1 — server: `80358b9`, worker: `ce36cdf`, docs: `edbaad6`)*: Railway generates a HMAC-SHA256 signed token per response (`server/src/lib/tracked-url.ts`, `buildToken`); Worker verifies it before logging (`worker/src/lib/tracked-url.ts`, `verifyToken`); `/track` handler dual-paths on `?t=` (signed) vs `?to=` (legacy); `click_events` stores `destination`, `query_id`, `legacy`; `queries.referral_clicked` updated on click; cross-tenant guard rejects mismatched slug/query_id; three structured log metrics (`track_signed_click`, `track_legacy_click`, `track_verification_failure`). Legacy cleartext path remains live until `legacy=1` traffic decays to zero.
- **Analytics**: `GET /analytics/:slug` with bearer auth — surfaces query counts, clicks, intent breakdown, crawler breakdown, daily trend, recent queries
- **Click detail**: `GET /analytics/:slug/clicks` — 50 most recent click events
- **MCP server**: `POST /mcp` and `GET /mcp` exposing `search_businesses` and `query_business_agent` tools via `@modelcontextprotocol/sdk`
- **AI discovery**: `/.well-known/ai-agent.json` served by Worker with optional rich profile from Railway
- **Business registration**: `POST /register` returning slug + api_key
- **Profile management**: `GET/PATCH /agents/:slug/profile` and `POST /agents/:slug/rotate-key`
- **Client portal**: multi-tenant login/dashboard in the Worker with PBKDF2 auth, D1-backed sessions, rate limiting (5 attempts/15 min), smoke tests (18 assertions)
- **Onboarding flow**: `/onboard` page with Stripe payment integration
- **Rollback playbook**: three options documented in README

## What is in progress

Phase 1.5 customers.advocatemcp.com proxy cleanup shipped. Session 2 (per-bot prompt tuning) and Phase 3 (self-serve onboarding UI) are next.

## What is next on the roadmap (priority order)

See IMPLEMENTATION_PLAN.md for the full seven-session plan.

## Performance and cost guardrails

- Bot response p95 latency target: under 1500ms end-to-end
- Claude API cost per bot response: target under $0.02
- Daily Claude spend per customer: alert if over $5/day
- If a change pushes any of these over budget, stop and flag it

## Security

- All signed tokens use HMAC-SHA256 with the secret in `TOKEN_SIGNING_KEY` env var (Wrangler secret + Railway env var, must be identical) — added in Session 1
- Customer data is isolated by slug at every query — never write a query that touches business data without a slug filter
- Bot detection results are never trusted as auth — they're routing signals only
- Never log auth tokens, signing keys, or full Claude API requests with system prompts to permanent storage
- Portal session tokens are SHA-256 hashed in D1, raw tokens only in HttpOnly cookies
- Stripe secrets: all four must be the same mode (all test OR all live) — never mix

## How to work on a task

Every non-trivial task follows the same loop:

1. Read this file and the relevant `docs/` file for the subsystem you're touching.
2. Read the existing files you'll be modifying.
3. Propose a plan: data model changes, new files, modified files, function/route contracts, test strategy. Wait for explicit approval before writing code.
4. Implement exactly as approved. If the plan was wrong mid-implementation, stop and ask — do not improvise.
5. Write tests as part of implementation, not after.
6. Run tests and the type checker. Fix everything before declaring done.
7. Update the relevant `docs/` file with what changed.
8. Summarize what you did, what you assumed, anything I should review carefully.

If a task takes more than ~20 tool calls, stop and checkpoint. Summarize, commit what works, wait for me to continue or start fresh.

## When you are unsure

Ask. Specifically ask before:
- Adding any new dependency
- Changing any database schema
- Modifying bot detection
- Touching the attribution token format once it exists (after Session 1)
- Refactoring code outside the immediate task
- Introducing any new pattern not already in the codebase
- Moving logic between Worker and Railway
