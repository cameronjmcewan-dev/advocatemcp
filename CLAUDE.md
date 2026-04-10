# AdvocateMCP — Claude Code Context

Read this entire file before doing anything. When in doubt, ask before acting.

## Product in three sentences

AdvocateMCP intercepts AI search crawler traffic at the edge (Cloudflare Worker), detects bots by user-agent, and routes them to a Claude-powered conversational agent that returns a citation-ready response tailored to the bot's query. Every citation link we return is tracked end-to-end so we can attribute downstream user clicks and conversions back to the originating AI bot and query. We also expose all registered businesses through a single central MCP server at `/mcp` so MCP-compatible clients (Claude Desktop, Cursor) can query any business directly.

## What makes us different

Static GEO tools (Scrunch, Profound, Peec, Otterly, Athena HQ) monitor citations and optimize content statically. We are the only system that intercepts bot traffic at the edge, generates per-bot per-query optimized responses in real time, AND tracks the resulting referral end to end. The dual-surface architecture (crawler interception + central MCP server) and the closed attribution loop are the moat. Protect both.

## Stack — do not deviate without explicit approval

- **Edge**: Cloudflare Worker (TypeScript, strict mode), deployed via wrangler
- **Backend**: Node.js + Express on Railway (`server/`), TypeScript
- **Databases**: SQLite for analytics and business data (`server/dev.db`), Cloudflare D1 for portal auth and edge-side data, KV namespace `BUSINESS_MAP` for domain→slug routing
- **AI**: Anthropic Claude API, model `claude-sonnet-4-6`, prompt caching enabled on system prompts
- **Auth (portal)**: PBKDF2-SHA256 100k iterations, session tokens hashed with SHA-256, HttpOnly+Secure+SameSite=Lax cookies
- **Email**: Resend (use this, not Postmark)
- **Testing**: bash smoke test at `worker/scripts/smoke-test.sh`, vitest for new code
- **Crypto**: HMAC-SHA256 for signed tokens — helpers go in `server/src/lib/crypto.ts` and `worker/src/lib/crypto.ts` with identical signing logic
- **Routing**: Worker uses native fetch handler dispatch, Express uses standard Express routers

## Repository layout

```
advocatemcp/
├── server/                    # Node/Express backend on Railway
│   ├── src/
│   │   ├── routes/            # Express routes (agents, analytics, mcp, register)
│   │   ├── lib/               # Shared helpers
│   │   └── prompts/           # (to be created in session 2) per-bot system prompts
│   ├── dev.db                 # SQLite — DO NOT commit
│   └── package.json
├── worker/                    # Cloudflare Worker (edge)
│   ├── src/
│   │   ├── index.ts           # Main entrypoint, bot detection, dispatch
│   │   ├── portal/            # Multi-tenant client portal (login, dashboard)
│   │   └── lib/               # Worker helpers
│   ├── migrations/            # D1 migrations
│   ├── scripts/               # smoke-test.sh, create-client.sh
│   ├── public/                # (to be created) static assets served by worker
│   └── wrangler.toml
├── docs/                      # Subsystem documentation — read before touching
│   ├── attribution.md
│   ├── bot-detection.md
│   ├── response-generation.md
│   └── mcp-server.md
└── CLAUDE.md                  # This file
```

## Data model — current

### SQLite (server/dev.db)
[FILL IN: run `sqlite3 server/dev.db ".schema"` and paste output here. This single section saves hours.]

Tables in use today: `businesses`, `queries`, `referral_clicks` (likely — confirm by running the schema dump).

### D1 (advocatemcp-auth)
[FILL IN: paste contents of `worker/migrations/0001_init.sql` here]

Tables today: `users`, `sessions`, `user_business_access`, login attempt rate limiting.

### KV
- `BUSINESS_MAP`: domain string → slug string

## Conventions

- TypeScript strict mode everywhere, no `any` without a comment explaining why
- Errors: throw typed errors, never return error objects, never swallow exceptions silently
- All routes validate input with zod schemas
- All SQL is parameterized — no string interpolation
- All Claude API calls go through a single helper that handles retries, prompt caching, and cost logging
- Tests live next to code in `*.test.ts` files
- Conventional commits (`feat:`, `fix:`, `chore:`, etc.)
- Branch naming: `feature/short-name`, `fix/short-name`

## Do not

- Do not modify bot detection logic in `worker/src/index.ts` (the `AI_CRAWLERS` array and the user-agent matching) without explicit instruction
- Do not refactor the Worker portal code in `worker/src/portal/` without explicit instruction — auth code is load-bearing
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

## How to work on a task

Every non-trivial task follows the same loop:

1. Read this file and the relevant `docs/` file for the subsystem you're touching.
2. Read the existing files you'll be modifying.
3. Propose a plan: data model changes, new files, modified files, function/route contracts, test strategy. Wait for explicit approval before writing code.
4. Implement exactly as approved. If the plan was wrong mid-implementation, stop and ask, do not improvise.
5. Write tests as part of implementation, not after.
6. Run tests and the type checker. Fix everything before declaring done.
7. Update the relevant `docs/` file with what changed.
8. Summarize what you did, what you assumed, anything I should review carefully.

If a task takes more than ~20 tool calls, stop and checkpoint. Summarize, commit what works, wait for me to continue or start fresh.

## What is shipped today

- Cloudflare Worker with edge bot detection for: PerplexityBot, GPTBot, OAI-SearchBot, ClaudeBot, Google-Extended, Googlebot, anthropic-ai, cohere-ai, meta-externalagent
- KV-based domain→slug routing in the Worker
- Express agent API at `POST /agents/:slug/query` powered by `claude-sonnet-4-6`
- Business registration at `POST /register` returning slug + api_key
- Analytics at `GET /analytics/:slug` with bearer auth
- Referral click tracking at `POST /analytics/:slug/referral-click`
- Central MCP server at `POST /mcp` and `GET /mcp` exposing `search_businesses` and `query_business_agent` tools
- `/.well-known/ai-agent.json` discovery file served by the Worker
- Multi-tenant client portal in the Worker with PBKDF2 auth, D1-backed sessions, rate limiting, smoke tests (18 assertions)
- Rollback playbook with three options
- API key rotation at `POST /agents/:slug/rotate-key`

## What is in progress

[FILL IN if anything]

## What is next on the roadmap (priority order)

1. **Session 1 — Signed-token attribution redirect.** Replace bare `referral_url` with tracked `/r/:token` redirects logged in D1. Foundation for everything.
2. **Session 2 — Per-bot response tuning.** Branch the system prompt by detected crawler so each bot gets a structurally optimized response.
3. **Session 3 — MCP server distribution.** Make `/mcp` submission-ready, add manifest endpoint, rate limiting, structured logging. Submit to public directories.
4. **Session 4 — Competitor radar.** Weekly cron prompts the major AIs with category questions, emails Monday morning summary.
5. **Session 5 — AI handoff.** Tracked landing page context script so customer sites can read decoded intent client-side.
6. **Session 6 — ai-agent.json standard.** Formalize as a published standard with public spec page and separate spec repo.
7. **Session 7 — Off-site authority kit.** Per-customer authority report identifying citation opportunities on Reddit, Wikidata, review platforms, YouTube.

## Performance and cost guardrails

- Bot response p95 latency target: under 1500ms end-to-end (currently higher due to Worker→Railway→Claude hop, will be addressed in a future latency session)
- Claude API cost per bot response: target under $0.02
- Daily Claude spend per customer: alert if over $5/day
- If a change pushes any of these over budget, stop and flag it.

## Security

- All signed tokens use HMAC-SHA256 with the secret in `TOKEN_SIGNING_KEY` env var (Worker secret + Railway env var, must be identical)
- Customer data is isolated by slug at every query — never write a query that touches business data without a slug filter
- Bot detection results are never trusted as auth — they're routing signals only
- Never log auth tokens, signing keys, or full Claude API requests with system prompts to permanent storage
- Portal session tokens are SHA-256 hashed in D1, raw tokens only in HttpOnly cookies

## When you are unsure

Ask. Specifically ask before:
- Adding any new dependency
- Changing any database schema
- Modifying bot detection
- Touching the attribution token format once it exists
- Refactoring code outside the immediate task
- Introducing any new pattern not already in the codebase
- Moving logic between Worker and Railway

## Cutting edge — what it means here

The cutting edge that matters in this codebase lives in three places: bot detection accuracy, per-bot response generation quality, and attribution loop completeness. Innovate aggressively in those layers. Everywhere else — routing, dashboards, email, auth, testing — use the most boring stable option that works. Boring infrastructure plus innovative core is how this company wins.
