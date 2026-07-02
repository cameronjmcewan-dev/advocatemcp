# AdvocateMCP — Copilot Context

This file is loaded automatically at the start of every GitHub Copilot conversation. It gives Copilot persistent context about the AdvocateMCP project so you never have to re-explain it.

---

## Product Overview

**AdvocateMCP** is an "AI visibility" service for local businesses (plumbers, dentists, property managers, copy shops, etc.).

When consumers ask AI assistants (Claude, ChatGPT, Perplexity, Gemini) questions like "who's a good plumber in Austin?", AdvocateMCP ensures the business appears in those AI answers with a direct link back to the business.

- Category: **answer engine optimization / generative engine optimization (AEO/GEO)**
- Subscription pricing: **Base $100/mo**, **Pro $250/mo** via Stripe (test mode)
- ⚠️ The marketing site `index.html` incorrectly shows $49/$149 — known mismatch artifact, do not "fix" it to match the HTML

---

## Architecture — 3 Systems

### System 1: Marketing Site (Cloudflare Pages)

| Item | Value |
|------|-------|
| URL | `advocatemcp.com` / `www.advocatemcp.com` |
| CF project | `advocatemcp-site` |
| Source | `site/` directory |
| Deploy | `wrangler pages deploy site/` — direct upload, NOT git-connected |

⚠️ **Pages deploys are NOT git-connected.** Running `wrangler pages deploy site/` from a directory missing files **will wipe those files from production.**

Key HTML files: `index.html`, `onboarding.html`, `dashboard.html`, `login.html`, `activate.html`

JS modules in `site/js/`: `dashboard-auth`, `dashboard-overview`, `dashboard-bots`, `dashboard-clicks`, `dashboard-requests`, `dashboard-recs`, `dashboard-settings`, `dashboard-activate`

---

### System 2: Cloudflare Worker

| Item | Value |
|------|-------|
| URL | `customers.advocatemcp.com` + `*.hosted.advocatemcp.com` (wildcard for hosted tenants) |
| Worker name | `advocatemcp-worker` |
| Source | `worker/` directory |
| D1 database | `advocatemcp-auth` (ID: `1247938a-cf98-4c66-8588-5c9d71699094`) |

**D1 is source of truth for:** user accounts, billing state, Stripe linkage, sessions, auth tokens.

Key routes: `/api/onboard/public`, `/api/onboard/basic`, `/api/stripe/webhook`, `/api/auth/*`, `/api/client/*`, `/onboard` (admin Wizard 2)

Worker source files:
- `worker/src/index.ts` — main router
- `worker/src/routes/` — activate, authApi, dashboard, demo, domains, onboard, onboardPage, portal, stripe, sharedLayout
- `worker/src/lib/` — access-token, activation-token, cors, origin-discovery, proxy, resend, tracked-url
- `worker/src/portalDb.ts`, `worker/src/types.ts`

---

### System 3: Railway Backend (Express/Node)

| Item | Value |
|------|-------|
| URL | `https://advocate-production-2887.up.railway.app` |
| Source | `server/` directory |
| Database | SQLite on Railway persistent volume |

**Railway is source of truth for:** AI agent profiles, crawler analytics, query logs, MCP server runtime.

Key endpoints: `POST /register`, `POST /agents/:slug/query`, `GET /agents/:slug/profile`, `GET /analytics/:slug`, `POST /mcp`, `GET /mcp`, `GET /.well-known/ai-agent.json`, `GET /registry`, `GET /health`

Server source files:
- `server/src/index.ts`
- `server/src/db.ts`
- `server/src/agent/builder.ts` — Claude prompt construction
- `server/src/agent/query.ts` — Claude API + intent detection
- `server/src/routes/` — agent, analytics, mcp, register, wellknown
- `server/src/middleware/` — auth, rateLimit
- `server/src/lib/tracked-url.ts`

---

## Design System

- **Theme:** Dark default; light opt-in via `data-theme="light"`
- **Fonts:** General Sans (body), Instrument Serif (headings/display)
- **Accent:** `#4f98a3` (dark) / `#01696f` (light)
- **Background:** `#171614` (dark) / `#f5f4f2` (light)
- **Border radius scale:** 4px, 8px, 12px, 16px
- **CSS custom properties** throughout — see `site/index.html` `:root` block for full palette
- **All UI is vanilla HTML/CSS/JS** — no React, no build step on the site

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Marketing site | Static HTML/CSS/JS on Cloudflare Pages |
| Worker | Cloudflare Workers (TypeScript), D1 database, KV store |
| Backend | Express.js, TypeScript, better-sqlite3, Claude API (`@anthropic-ai/sdk`) |
| Payments | Stripe (test mode) |
| Email | Resend |
| Hosting | Cloudflare (Pages + Workers + D1 + KV), Railway |
| MCP | `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport` |
| Charts | Chart.js (dashboard) |
| Icons | Lucide (dashboard) |

---

## Current State (April 2026)

### ✅ Working
- Customer dashboard at `advocatemcp.com/dashboard` (vanilla HTML, authenticated via worker)
- Cross-origin Bearer auth + refresh cookies (Phase C)
- Admin Wizard 2 at `customers.advocatemcp.com/onboard` — full end-to-end Stripe flow
- Phase F dual-write: new tenants provisioned in both D1 and Railway
- Hosted tenant flow at `*.hosted.advocatemcp.com`
- Attribution system: signed tokens, click tracking, query-to-click linkage
- Railway agent runtime, MCP server, registry
- First real customer, fully onboarded

### ❌ Broken / Not Yet Wired
- `site/onboarding.html` — posts to `https://advocate-production-2887.up.railway.app/api/businesses` which does NOT exist on Railway. Should be wired to the worker's `/api/onboard/public`
- `customers.advocatemcp.com/dashboard` — returns empty body instead of redirecting
- Pricing display on marketing site shows $49/$149 instead of real $100/$250
- Post-Stripe completion page (`site/onboarding/complete.html`) — lost in a Pages deploy, needs rebuild
- Stripe webhook only handles `checkout.session.completed` — missing subscription lifecycle events
- Admin secret was exposed in client-side JS at `worker/src/routes/onboardPage.ts` — value removed from the served HTML and endpoint switched to admin-session auth (`fix/onboard-admin-secret-exposure`); rotate `ADMIN_SECRET` out of band
- DNS custom hostname routing for custom domains (returns 522 for crawler traffic)

---

## Critical Rules

1. **NEVER delete `biz_[first-customer-slug]`** — this is the real paying customer tenant in D1.
2. `8961b467481648518431f2072bdc1ded` (old test row slug) = DELETE is OK. The real customer tenant row = NEVER DELETE.
3. Pages deploys are NOT git-connected — a `wrangler pages deploy site/` from a working directory missing files WILL wipe those files from production.
4. Any shared secret rotation must update BOTH sides (worker wrangler secret AND Railway env var) in the same operation.

---

## First Customer

First paying customer is a copywriting agency, fully onboarded in both D1 and Railway.
- Custom domain currently returns 522 for crawler traffic (DNS routing blocker — see `docs/followups.md`)

---

## Key Documentation

Read these docs for deeper context:

| File | Contents |
|------|----------|
| `docs/followups.md` | Prioritized bug/task list (blockers → bugs → polish → research) |
| `docs/attribution.md` | Full attribution/tracking flow documentation |
| `docs/bot-detection.md` | Crawler detection and request routing |
| `docs/mcp-server.md` | MCP server architecture |
| `docs/response-generation.md` | Claude prompt construction and intent classification |
| `docs/rearchitecture-plan-2026-04-10.md` | Comprehensive rearchitecture plan |
| `CLAUDE.md` | Session context for Claude Code |
| `IMPLEMENTATION_PLAN.md` | Phased implementation roadmap |
| `README.md` | Setup, API reference, deployment docs |

---

## Language Composition

| Language | Share |
|----------|-------|
| TypeScript | 70.2% (worker + server) |
| HTML | 23% (marketing site) |
| JavaScript | 5.3% (dashboard JS modules) |
| Shell | 1.5% (scripts) |
