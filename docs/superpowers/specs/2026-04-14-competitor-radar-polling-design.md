# Competitor Radar Polling (P3) — Design Spec

**Date:** 2026-04-14
**Feature:** Sub-project P3 of the Pro-tier Competitor Radar + Firecrawl Suggestions initiative
**Status:** Draft — design approved, awaiting user review before plan-writing

---

## Context

AdvocateMCP's moat is real-time per-bot response generation plus end-to-end attribution of AI-bot-originated clicks. Static GEO tools (Scrunch, Profound, Peec, Otterly, Athena HQ) ship audit-style reports; they do not have the bot-traffic interception point or the attribution loop.

The Pro-tier Competitor Radar + Firecrawl Suggestions feature leverages both. The full feature decomposes into six sub-projects:

- **P1** — Competitor set derivation (hybrid: auto-discover + tenant-curate)
- **P2** — Firecrawl scrape pipeline for approved competitors
- **P3** — **This spec.** Competitor Radar polling against Perplexity (v1) and OpenAI (v1.1) to detect citation wins and losses
- **P4** — Suggestion engine + Pro dashboard surface
- **P5** — Weekly email digest (Monday AM)
- **P6** — Pricing intelligence
- **P7** — Off-site authority report

P3 is the foundation. It produces the loss log that every other sub-project depends on. It also ships an independent deliverable on its own (the data layer underlying roadmap Session 4 "Competitor Radar" in `CLAUDE.md`).

**Why this is the right starting point:**
- The loss log unblocks P4's scrape trigger and P5's email numbers.
- Getting the citation-measurement layer right first isolates the hardest problem (sampling variance, cost control, API reliability) from downstream product work.
- The data model crystallizes P3 — later sub-projects read from these tables rather than mutating the schema.

---

## Scope

**In scope:**
- `node-cron` scheduler inside the existing Railway Express process
- Perplexity API integration via `server/src/lib/perplexity.ts`
- Canonical domain matching via `server/src/lib/domainMatch.ts`
- Three new SQLite tables in `server/dev.db`
- Auto-seeding the query basket on Stripe `checkout.session.completed` for Pro plan
- Basket CRUD endpoints so tenants can edit their polling queries
- Read endpoints (`summary` and `losses`) for P4 and P5 to consume
- Daily budget cap with Resend alert on breach

**Out of scope (explicit):**
- OpenAI Responses API polling — deferred to P3 v1.1
- Google AI Overview / Claude polling — no reliable citation API
- Firecrawl competitor scraping (P2)
- Dashboard UI (P4)
- Email digest (P5)
- Pricing intelligence (P6)
- Off-site authority report (P7)
- Owned-presence matching (Yelp, Google Biz, Facebook) — strict domain match only in v1; revisit in v1.1 based on tenant feedback
- Subdomain-root matching — strict exact-domain only in v1
- LLM-generated phrasing variants — fixed templates in v1

---

## Architecture

| Concern | Decision | Reason |
|---|---|---|
| Execution location | Railway (`server/` package) | Business data + prompt builder already there; no new infra |
| Scheduler | `node-cron` inline in Express process | Simpler than Railway scheduled-job service for the v1 scale (~100 tenants) |
| External API | Perplexity `chat/completions` (native `citations[]`) | Only reliable citation-returning API today |
| Storage | 3 new tables in `server/dev.db` | Co-located with tenant profile; avoids cross-DB joins |
| Config | Env vars: `PERPLEXITY_API_KEY`, `POLL_SCHEDULE_CRON`, `COMPETITOR_POLL_DAILY_BUDGET_USD` | No config file needed |
| Concurrency | 4 parallel tenant workers with shared 1 req/s token bucket to Perplexity | Keeps memory low, rate-limits gracefully |
| Alerting | Existing Resend helper (`server/src/lib/resend.ts`) | Reuse; no new dependency |

Default cron: `0 4 * * 1,3,5` (Mon/Wed/Fri 04:00 UTC). Override via `POLL_SCHEDULE_CRON` env var.

Default daily budget: `$10` USD. Override via `COMPETITOR_POLL_DAILY_BUDGET_USD` env var.

**Estimated cost:**
- Baseline (100 tenants, default 6 auto-queries, 3 variants, 3 runs/week): 5,400 polls/week ≈ $27/week at $0.005/Perplexity call → $1.17/tenant/month.
- Worst case (100 tenants at the 15-query basket cap): 13,500 polls/week ≈ $68/week → $2.93/tenant/month.

Both fit well inside the Pro $250/mo margin. The $10/day default budget cap brackets the worst case (≈$70/week ceiling).

---

## Prerequisites

Railway's `businesses` table does not currently carry the `plan` value — the Worker owns it in D1 + KV and does not forward it in `registerBusinessOnRailway`. P3 needs to know which tenants are on Pro.

P3's migration adds:

```sql
ALTER TABLE businesses ADD COLUMN plan TEXT NOT NULL DEFAULT 'base';
```

Matching Worker-side changes (small, additive, no breaking risk):

1. `worker/src/routes/stripe.ts` — `registerBusinessOnRailway`: include `plan: tenant.plan ?? "base"` in the forwarded body.
2. `server/src/schemas/business.ts` — `OnboardingPayloadSchema`: add `plan: z.enum(["base","pro"]).optional().default("base")`.
3. `server/src/routes/register.ts` — INSERT: add `plan` column binding.

Backfill: the migration default `'base'` means existing rows are non-Pro by default. Any existing customer already on Pro (historically routed through Stripe) can be flipped by hand via `UPDATE businesses SET plan='pro' WHERE slug=?`.

These three changes are part of P3's deliverable. They're small enough to fit in P3 rather than spawning a separate sub-project.

---

## Data Model

### Table 1: `competitor_query_baskets`

Each tenant's polling query list. Hybrid auto-seeded + tenant-curated.

```sql
CREATE TABLE competitor_query_baskets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  query      TEXT NOT NULL,
  source     TEXT NOT NULL CHECK(source IN ('auto','tenant')),
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(slug, query)
);
CREATE INDEX idx_cqb_slug ON competitor_query_baskets(slug, enabled);
```

Soft-delete via `enabled=0` so historical polls still join.

### Table 2: `competitor_polls`

One row per `(query × phrasing-variant × bot × run)`.

```sql
CREATE TABLE competitor_polls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT NOT NULL,
  query_basket_id  INTEGER NOT NULL,
  bot              TEXT NOT NULL,                 -- 'perplexity' in v1
  phrasing         TEXT NOT NULL,                 -- actual string sent to the API
  phrasing_variant INTEGER NOT NULL,              -- 0, 1, or 2
  polled_at        TEXT NOT NULL,
  our_domain_cited INTEGER NOT NULL,              -- 0 or 1
  our_cited_rank   INTEGER,                       -- 1-indexed if cited, NULL otherwise
  citation_count   INTEGER NOT NULL,
  cost_usd         REAL,
  error            TEXT,                          -- NULL on success
  FOREIGN KEY(query_basket_id) REFERENCES competitor_query_baskets(id)
);
CREATE INDEX idx_cp_slug_polled ON competitor_polls(slug, polled_at DESC);
CREATE INDEX idx_cp_slug_lost   ON competitor_polls(slug, our_domain_cited);
```

Both binary (`our_domain_cited`) and positional (`our_cited_rank`) signals stored. Downstream consumers can compute either without schema change.

`error` is stored inline on the poll row rather than in a separate errors table. Trade-off accepted: easier per-tenant success/failure queries; mixes API-failure semantics with zero-citation semantics. Acceptable for v1.

### Table 3: `competitor_citations`

Citations returned by each poll.

```sql
CREATE TABLE competitor_citations (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  rank    INTEGER NOT NULL,                       -- 1-indexed position in response
  url     TEXT NOT NULL,
  domain  TEXT NOT NULL,                          -- canonicalized (strip scheme, www, path)
  title   TEXT,
  FOREIGN KEY(poll_id) REFERENCES competitor_polls(id)
);
CREATE INDEX idx_cc_poll   ON competitor_citations(poll_id);
CREATE INDEX idx_cc_domain ON competitor_citations(domain);
```

Separate from polls so "top domains cited when tenant X wasn't, last 30 days" is a direct `GROUP BY` without JSON reparsing.

### Migration

File: `server/migrations/0007_competitor_radar.sql` — contains all three `CREATE TABLE` statements + indexes, applied idempotently (`IF NOT EXISTS`).

---

## Query Basket Seeding

**Lazy, cron-driven** — no Stripe webhook coupling. Seeding runs inline at the top of each cron iteration.

```
For each Pro tenant:
  If SELECT COUNT(*) FROM competitor_query_baskets WHERE slug=? AND enabled=1 = 0:
    Seed auto-queries from profile.
```

Auto-queries generated (up to 6, field-missing-safe):

```
  "best {category} in {location}"
  "top {category} in {city}"                    -- city = split(location, ",")[0].trim()
  "{category} near me in {location}"
  "{services[0]} {category} {location}"         -- if services[0] exists
  "{services[1]} {category} {location}"         -- if services[1] exists
  "{services[2]} {category} {location}"         -- if services[2] exists
```

All rows tagged `source='auto'`. Tenants add/disable via the basket CRUD endpoints.

**Why lazy, not webhook-driven:** Stripe webhooks fire to the Worker, not Railway. Propagating webhook events to Railway would require a new RPC, adding a failure mode for marginal benefit (polling fires at most 48h after Pro activation). Lazy seeding also gives us a clean re-seed path if `plan` flips Base→Pro→Base→Pro: the `UNIQUE(slug, query)` constraint prevents duplicate auto rows, previously-disabled auto rows stay disabled.

**Prerequisite:** `businesses` on Railway needs a `plan` column. See "Prerequisites" section below.

---

## Phrasing Variants

Each stored basket query fans out to 3 Perplexity calls per run (deterministic, not LLM-generated):

```
variant 0: q                                   -- as-stored
variant 1: q + " reviews"                      -- review intent
variant 2: "top rated " + q                    -- rank intent
```

**Dedupe guard:** if the stored query already contains a variant's affix (case-insensitive substring), skip that variant. E.g., if tenant saves `"top rated plumber Boise"`, variant 2 is skipped. One `competitor_polls` row per variant that actually fires.

Rationale for deterministic templates: reproducible, zero LLM cost, easy to reason about. Swap-in path to LLM-generated variants in v1.1 is trivial (producer function returns `string[]`; everything downstream is variant-count-agnostic).

---

## Polling Loop

`server/src/jobs/competitorRadar.ts` — the cron handler.

```
On cron fire:
  1. Budget gate:
     SELECT SUM(cost_usd) FROM competitor_polls
     WHERE polled_at >= today 00:00 UTC
     If sum >= COMPETITOR_POLL_DAILY_BUDGET_USD:
       log "budget_cap_hit" + send Resend alert → exit.

  2. Load Pro tenants:
     SELECT slug, website FROM businesses
     WHERE plan='pro' AND api_key != 'pending'

  3. For each tenant (p-limit concurrency=4):
     a. Load basket rows (source IN ('auto','tenant') AND enabled=1).
     b. For each basket row:
        For each phrasing variant 0..2 (after dedupe):
          - Acquire token-bucket slot (1 req/s global).
          - Call perplexity.search(phrasing).
          - Canonicalize each citation URL → domain.
          - Compare against tenant's canonicalized website.
          - Compute our_cited_rank = lowest rank where domain matches, else NULL.
          - Insert competitor_polls row.
          - Bulk INSERT competitor_citations rows.
          - On thrown error: write error string on poll row, continue.

  4. Log aggregate: { tenants_polled, queries_run, citations_stored, errors, total_cost_usd }.
```

**Rate limiting:** shared token bucket, 1 req/s global across the 4 workers. Well under Perplexity's published limits.

**Concurrency rationale:** 4 workers × ~1s per poll + global 1 req/s throttle means workers spend most time waiting for tokens. Keeps memory low; no thundering-herd risk.

**Error isolation:** per-poll try/catch. One failed call never aborts the batch.

---

## Domain Matching (v1: strict)

`server/src/lib/domainMatch.ts`:

```ts
function canonicalDomain(urlOrDomain: string): string {
  // Accept full URL or bare domain.
  // Lowercase; strip scheme, leading "www.", path/query/fragment, port.
  // Return "" on unparseable input.
}

function isCitationOfTenant(
  citationUrl: string,
  tenantWebsite: string | null,
): boolean {
  const c = canonicalDomain(citationUrl);
  const t = canonicalDomain(tenantWebsite ?? "");
  return c !== "" && t !== "" && c === t;
}
```

Handled v1 edge cases:
- Tenant `website=null` → always `false` (no crash).
- URL with scheme (`https://`), `www.`, trailing slash, path, query, fragment, port → all stripped.
- Empty / malformed input → `""`, safe to compare.

Explicitly NOT handled in v1:
- Subdomain match: `shop.tenant.com` does NOT match `tenant.com` (strict). If SMB feedback shows this hurts, add subdomain-root match in v1.1.
- Owned-presence: Yelp / Google Biz / Facebook / BBB profiles of the tenant do NOT match. Defer alias table to P4.

Rationale: strict match gives clean, defensible numbers for v1. Complaints about Yelp-citation misses are useful product feedback for v1.1 alias schema.

---

## Read API (consumed by P4 / P5)

Both endpoints on Railway, behind the existing `requireApiKey` middleware.

### `GET /api/competitor-radar/:slug/summary?days=30`

```json
{
  "range_days": 30,
  "total_polls": 234,
  "cited_count": 178,
  "citation_rate": 0.76,
  "avg_cited_rank": 2.4,
  "top_competitor_domains": [
    { "domain": "boiseplumbco.com", "cited_count": 42 },
    { "domain": "aceplumbing.com",  "cited_count": 31 }
  ],
  "last_polled_at": "2026-04-14T04:03:12Z"
}
```

`top_competitor_domains` is the top 5 domains (by count) cited when `our_domain_cited=0`, excluding the tenant's own domain.

### `GET /api/competitor-radar/:slug/losses?days=7&limit=50`

```json
{
  "range_days": 7,
  "losses": [
    {
      "poll_id": 441,
      "polled_at": "2026-04-14T04:03:12Z",
      "phrasing": "top rated best plumber in Boise",
      "variant": 2,
      "top_citations": [
        { "rank": 1, "domain": "boiseplumbco.com", "title": "Best Plumbers in Boise" },
        { "rank": 2, "domain": "yelp.com",         "title": "..." },
        { "rank": 3, "domain": "aceplumbing.com",  "title": "..." }
      ]
    }
  ]
}
```

Limit cap: `min(limit, 200)`. Ordered by `polled_at DESC`. Each loss row includes up to top 5 citations (by rank) for that poll.

---

## Basket CRUD API (tenant edits polling queries)

All behind `requireApiKey`. All three routes live in `server/src/routes/competitorRadar.ts` alongside the read endpoints.

### `GET /api/competitor-basket/:slug`

Returns enabled queries only (both `source='auto'` and `source='tenant'`), ordered by `created_at ASC`:

```json
{
  "slug": "smoke-plumbing",
  "queries": [
    { "id": 12, "query": "best plumber in Boise, ID", "source": "auto" },
    { "id": 18, "query": "24/7 emergency plumber",    "source": "tenant" }
  ]
}
```

### `POST /api/competitor-basket/:slug/queries`

Body: `{ "query": "string, max 200 chars" }`. Creates a row with `source='tenant'`, `enabled=1`.

Validation:
- `query` trimmed, non-empty, ≤ 200 chars.
- Reject if tenant already has ≥ 15 enabled rows (cost cap at edit time).
- Reject on `UNIQUE(slug, query)` conflict with a clear error.

Returns the created row.

### `DELETE /api/competitor-basket/:slug/queries/:id`

Soft-delete: `UPDATE competitor_query_baskets SET enabled=0 WHERE id=? AND slug=?`.

Ownership check — the `WHERE slug=?` clause prevents cross-tenant deletes even if an attacker forges a basket id.

Returns `{ "ok": true }`.

---

## Testing

All tests in `server/src/jobs/competitorRadar.test.ts` and `server/src/routes/competitorRadar.test.ts`, using `better-sqlite3` in-memory pattern + `vitest` stubs.

### Unit — `domainMatch.test.ts`

12 canonicalization cases:
- `http://tenant.com/path` → `tenant.com`
- `https://www.tenant.com` → `tenant.com`
- `https://tenant.com/` → `tenant.com`
- `https://tenant.com?q=1` → `tenant.com`
- `https://tenant.com#frag` → `tenant.com`
- `https://tenant.com:8080` → `tenant.com`
- `tenant.com` → `tenant.com`
- `WWW.TENANT.COM` → `tenant.com`
- `""` → `""`
- `null` → `""` (from `isCitationOfTenant`)
- Garbage (`"not a url"`) → `""`
- Subdomain (`shop.tenant.com`) → `shop.tenant.com` (note: not-equal to `tenant.com`, v1 strict match)

### Unit — basket seeding

Given profile: `{category:"plumber", location:"Boise, ID", services:["drain","pipe","heater","sewer"]}`, assert exactly 6 auto-queries (first 3 services included, 4th ignored), all `source='auto'`, all `enabled=1`.

Given profile missing `services`: assert 3 auto-queries (no service-based ones).

### Unit — phrasing variants

- Plain query → 3 variants fire.
- Query containing `"reviews"` → variant 1 skipped, 2 fire.
- Query containing `"top rated"` (case-insensitive) → variant 2 skipped, 2 fire.
- Query containing both → 1 variant fires (just the as-stored).

### Integration — cron run (happy path)

Stub `perplexity.search` → returns 5 citations with tenant's domain at rank 3.
Seed 1 tenant + 1 basket query → run one cron iteration.
Assert:
- 3 rows in `competitor_polls` (one per variant).
- Each row: `our_domain_cited=1`, `our_cited_rank=3`, `citation_count=5`.
- 15 rows in `competitor_citations` (5 per poll).

### Integration — budget cap

Insert polls totaling `$10.01` cost for today UTC.
Run cron.
Assert:
- Zero new `competitor_polls` rows inserted.
- `sendAlert` (Resend mock) invoked exactly once with cap-hit subject.

### Integration — error handling

Stub `perplexity.search` to throw `Error("500 api")` on call #2 of 6.
Run cron with 1 tenant, 2 basket queries.
Assert:
- 6 rows in `competitor_polls` (all variants still attempted).
- Row #2 has `error="500 api"`, `citation_count=0`, `our_domain_cited=0`.
- Rows #1, 3, 4, 5, 6 succeed with valid citation rows.

### Integration — rate limiting

Stub time + token bucket with 1 req/s.
Queue 10 simultaneous poll requests across 4 workers.
Assert: total elapsed time ≥ 9s (10 tokens × 1s interval, minus the first).

### Endpoint — summary

Fixture DB: 30 polls for `slug=t1`, 20 cited (ranks 1–5), 10 not cited, losses citing 3 distinct competitor domains.
`GET /api/competitor-radar/t1/summary?days=30` →
- `total_polls=30`, `cited_count=20`, `citation_rate≈0.667`
- `avg_cited_rank` = mean of 20 ranks
- `top_competitor_domains` has exactly the 3 competitors, ordered by count desc.

### Endpoint — losses

Fixture: 5 losses in last 7 days, 10 outside window.
`GET /api/competitor-radar/t1/losses?days=7` → returns 5 loss rows, each with up to 5 top citations, ordered by `polled_at DESC`.

### Endpoint — basket CRUD

- `GET` returns only enabled rows.
- `POST` with valid query creates `source='tenant'` row.
- `POST` past 15-row cap → 400.
- `POST` duplicate → 409.
- `DELETE` sets `enabled=0` but row persists.
- `DELETE` for another tenant's id → 404 (not 403 — don't leak existence).

Target: ~20 test cases. All hermetic; no live Perplexity calls.

---

## File Inventory

### Create
- `server/migrations/0007_competitor_radar.sql` — 3 tables + indexes
- `server/src/lib/perplexity.ts` — API client (single `search(query) → {citations[]}` function)
- `server/src/lib/perplexity.test.ts` — response-shape parsing tests
- `server/src/lib/domainMatch.ts` — `canonicalDomain` + `isCitationOfTenant`
- `server/src/lib/domainMatch.test.ts` — 12 canonicalization cases
- `server/src/jobs/competitorRadar.ts` — cron handler + basket seeder
- `server/src/jobs/competitorRadar.test.ts` — seeding, variants, cron run, budget, errors, rate limit
- `server/src/routes/competitorRadar.ts` — summary/losses/basket-CRUD endpoints
- `server/src/routes/competitorRadar.test.ts` — endpoint shape + auth tests
- `.env.example` additions: `PERPLEXITY_API_KEY`, `POLL_SCHEDULE_CRON`, `COMPETITOR_POLL_DAILY_BUDGET_USD`

### Modify
- `server/src/index.ts` — mount new router + start cron job
- `server/src/schemas/business.ts` — add `plan: z.enum(["base","pro"]).optional().default("base")`
- `server/src/routes/register.ts` — bind `plan` column in the INSERT
- `worker/src/routes/stripe.ts` — `registerBusinessOnRailway`: include `plan` in forwarded body
- `server/package.json` — add `node-cron`, `p-limit` (token bucket can be inline)
- `docs/followups.md` — log the "subdomain match" and "owned-presence aliases" follow-ups for v1.1

### Reference / no change
- `server/src/middleware/auth.ts` — `requireApiKey` reused as-is
- `server/src/lib/resend.ts` — alert helper reused as-is
- `server/dev.db` — migration applied via existing migration runner

---

## Dependencies & Sequencing

**Blocks:** nothing. P3 ships standalone.

**Unblocks:**
- P2 (Firecrawl scrape pipeline) — reads from `competitor_citations` to pick which domains to scrape.
- P4 (suggestion engine) — reads `summary` + `losses` endpoints.
- P5 (weekly email digest) — reads `summary` + `losses` endpoints.

**Parallel-safe with:** P1 (competitor set derivation) — P1 is about Firecrawl targets, P3 is about bot polling. They share no code, no tables.

---

## Verification

After implementation, verify end-to-end:

1. Apply the migration locally: `npm run migrate` (or whatever pattern `server/` uses).
2. Run the test suite: `cd server && npm test` — expect ~20 new passing tests, no regressions.
3. Manually seed a Pro tenant:
   ```bash
   sqlite3 server/dev.db "UPDATE businesses SET plan='pro' WHERE slug='smoke-plumb-apr14c'"
   ```
4. Trigger basket seeding manually via a one-off script or by replaying the Stripe webhook fixture.
5. Run the cron handler once manually: `npm run job:competitor-radar` (or node invocation).
6. Inspect:
   ```bash
   sqlite3 server/dev.db "SELECT COUNT(*) FROM competitor_polls WHERE slug='smoke-plumb-apr14c'"
   sqlite3 server/dev.db "SELECT COUNT(*) FROM competitor_citations WHERE poll_id IN (SELECT id FROM competitor_polls WHERE slug='smoke-plumb-apr14c')"
   ```
7. Hit the endpoints:
   ```bash
   curl -H "Authorization: Bearer <api_key>" \
     https://advocate-production-2887.up.railway.app/api/competitor-radar/smoke-plumb-apr14c/summary?days=30
   curl -H "Authorization: Bearer <api_key>" \
     https://advocate-production-2887.up.railway.app/api/competitor-radar/smoke-plumb-apr14c/losses?days=7
   ```
   Expect valid JSON matching the shapes above.
8. Budget-cap smoke: temporarily set `COMPETITOR_POLL_DAILY_BUDGET_USD=0.01`, trigger the job, assert zero new polls and one Resend alert fired.

---

## Open Questions (deferred, not blocking)

These are captured for P3 v1.1 or the relevant downstream sub-project. None block v1.

1. **Subdomain-root matching** — do enough tenants get cited on subdomains (`shop.tenant.com`, `blog.tenant.com`) that strict match misses are material? Re-evaluate after 30 days of production data.
2. **Owned-presence aliases (Yelp, Google Biz, Facebook, BBB)** — if tenant feedback says "Perplexity cited my Yelp listing, why didn't you count that?", design `tenant_domain_aliases` table in P4.
3. **LLM-generated phrasing variants** — if fixed 3-variant templates produce bimodal citation rates (consistently cited or consistently not), swap in LLM-generated variants. Producer-function swap, no schema change.
4. **OpenAI Responses API integration (P3 v1.1)** — land when OpenAI's web-search tool-call output schema stabilizes. Adds a second `bot='openai'` value; same tables.
5. **Per-tenant budget caps** — v1 uses a global daily cap. If one tenant dominates spend, add per-tenant caps keyed by plan tier.
