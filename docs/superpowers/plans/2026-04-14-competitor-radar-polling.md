# Competitor Radar Polling (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the polling layer that runs Perplexity queries on a cron, detects whether the tenant's domain was cited, and exposes `summary`/`losses`/`basket` endpoints — producing the "loss log" that P4 (suggestions) and P5 (email digest) will consume.

**Architecture:** A `node-cron` job inside the existing Railway Express process polls Perplexity's `chat/completions` endpoint for each Pro tenant's basket of queries (fanned out to 3 phrasing variants), canonicalizes the returned `citations[]` URLs, stores binary + positional citation signals in three new SQLite tables, and gates the whole batch behind a daily USD budget cap with Resend alerting. Seven Express endpoints (two read, three basket-CRUD, plus the cron itself) round out the surface.

**Tech Stack:** TypeScript (strict), Node/Express on Railway, `better-sqlite3` SQLite, `node-cron`, `p-limit`, `zod`, `vitest` + `supertest`, Perplexity REST API, Resend REST API.

---

## Spec Reference

Full design: `docs/superpowers/specs/2026-04-14-competitor-radar-polling-design.md`.

## Deviations From Spec

Read before Task 1. These are minor but material.

1. **No `server/migrations/` folder exists.** The spec calls for `server/migrations/0007_competitor_radar.sql`. The actual server pattern is inline schema management inside `server/src/db.ts::_initSchema` using `CREATE TABLE IF NOT EXISTS` + the existing `_addColumnIfNotExists` helper. This plan extends `_initSchema` rather than creating a migrations directory.

2. **No `server/src/lib/resend.ts` exists.** The spec says "reuse the existing Resend helper." It doesn't exist yet. This plan creates `server/src/lib/alert.ts` with a single `sendBudgetAlert(subject, body)` function that POSTs to the Resend API if `RESEND_API_KEY` is set and otherwise logs at error level. No new dependency — uses global `fetch`.

3. **Worker-side change (Prerequisites task) is in a different deploy pipeline.** Task 1 includes one edit in `worker/src/routes/stripe.ts`. That edit ships via `cd advocatemcp/worker && npx wrangler deploy`, not via Railway auto-deploy. The task's commit step handles this explicitly.

4. **`better-sqlite3` is synchronous.** Tests use the `_resetDbForTests()` + `DATABASE_PATH` tmpfile pattern from existing tests (see `server/src/routes/register.test.ts` lines 12–31). No in-memory mode — tmp file per test suite.

---

## File Structure

### Create
- `server/src/lib/perplexity.ts` — Perplexity `chat/completions` client
- `server/src/lib/perplexity.test.ts` — response-shape tests
- `server/src/lib/domainMatch.ts` — `canonicalDomain` + `isCitationOfTenant`
- `server/src/lib/domainMatch.test.ts` — 12 canonicalization cases
- `server/src/lib/alert.ts` — `sendBudgetAlert` (Resend wrapper)
- `server/src/lib/tokenBucket.ts` — shared 1 req/s bucket
- `server/src/jobs/competitorRadar.ts` — cron handler, seeder, variant producer
- `server/src/jobs/competitorRadar.test.ts` — seeding, variants, cron integration
- `server/src/routes/competitorRadar.ts` — summary, losses, basket CRUD
- `server/src/routes/competitorRadar.test.ts` — endpoint + auth tests

### Modify
- `server/src/db.ts` — add `plan` column + 3 new tables in `_initSchema`
- `server/src/schemas/business.ts` — add `plan` field to `OnboardingPayloadSchema`
- `server/src/routes/register.ts` — bind `plan` column in INSERT
- `server/src/index.ts` — mount `competitorRadarRouter`, start cron
- `server/package.json` — add `node-cron`, `p-limit`, `@types/node-cron`
- `worker/src/routes/stripe.ts` — forward `plan` in `registerBusinessOnRailway`
- `docs/followups.md` — log v1.1 deferred items

---

## Task 1: Plan-column propagation (Prerequisites)

Adds the `plan` column to Railway's `businesses` table and wires it through the Worker→Railway registration path so P3 can filter `plan='pro'`.

**Files:**
- Modify: `server/src/db.ts` — schema + `BusinessRow` type
- Modify: `server/src/schemas/business.ts` — zod schema
- Modify: `server/src/routes/register.ts` — INSERT binding
- Modify: `worker/src/routes/stripe.ts` — `registerBusinessOnRailway` body
- Test: `server/src/routes/register.test.ts` — extend existing test

- [ ] **Step 1: Write the failing test for plan persistence**

Append to `server/src/routes/register.test.ts`, inside the existing `describe("POST /register", …)` block, after the last `it(...)`:

```typescript
  it("persists plan='pro' when supplied in payload", async () => {
    const payload = {
      name: "Pro Plumb",
      description: "d",
      category: "plumber",
      location: "Boise, ID",
      services: ["drain"],
      star_rating: 4.5,
      review_count: 10,
      plan: "pro",
    };
    const res = await request(app)
      .post("/register")
      .set("Authorization", "Bearer test-admin-key")
      .send(payload);
    expect(res.status).toBe(201);

    const { getDb } = await import("../db.js");
    const row = getDb()
      .prepare("SELECT plan FROM businesses WHERE slug = ?")
      .get(res.body.slug) as { plan: string };
    expect(row.plan).toBe("pro");
  });

  it("defaults plan to 'base' when omitted", async () => {
    const payload = {
      name: "Base Plumb",
      description: "d",
      category: "plumber",
      location: "Boise, ID",
      services: ["drain"],
      star_rating: 4.5,
      review_count: 10,
    };
    const res = await request(app)
      .post("/register")
      .set("Authorization", "Bearer test-admin-key")
      .send(payload);
    expect(res.status).toBe(201);

    const { getDb } = await import("../db.js");
    const row = getDb()
      .prepare("SELECT plan FROM businesses WHERE slug = ?")
      .get(res.body.slug) as { plan: string };
    expect(row.plan).toBe("base");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/routes/register.test.ts`
Expected: both new tests FAIL. First fails with either "no such column: plan" or `row.plan` being `undefined`.

- [ ] **Step 3: Add `plan` column to `_initSchema`**

In `server/src/db.ts`, inside `_initSchema`, add one line immediately after the `lead_routing_json` entry in the `bizCols` array (around line 100):

```typescript
    ["lead_routing_json", "TEXT"],
    // P3: competitor radar — tenant plan tier
    ["plan", "TEXT NOT NULL DEFAULT 'base'"],
  ];
```

And add `plan: string;` to the `BusinessRow` interface — append after `lead_routing_json: string | null;` at the bottom of the interface:

```typescript
  lead_routing_json: string | null;
  plan: string;   // 'base' | 'pro'
}
```

- [ ] **Step 4: Add `plan` to the zod schema**

In `server/src/schemas/business.ts`, inside `OnboardingPayloadSchema`, append a new field just before the closing `});` of the schema (after `lead_routing_json`):

```typescript
  lead_routing_json: LeadRoutingSchema.optional(),

  // P3: tenant plan tier — forwarded by Worker on Stripe checkout
  plan: z.enum(["base", "pro"]).optional().default("base"),
});
```

- [ ] **Step 5: Bind `plan` in the INSERT**

In `server/src/routes/register.ts`, update the INSERT statement to include the `plan` column and value.

Current SQL ends `…case_stories_json, lead_routing_json)`. Change to:

```typescript
          case_stories_json, lead_routing_json, plan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
```

(33 placeholders — one more than before.) And add `p.plan,` as the final bound value, immediately after `j(p.lead_routing_json),`:

```typescript
      j(p.lead_routing_json),
      p.plan,
    );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/routes/register.test.ts`
Expected: all tests PASS (including existing ones — regression check).

- [ ] **Step 7: Run the typechecker**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Update the Worker to forward `plan`**

In `worker/src/routes/stripe.ts`, find the `registerBusinessOnRailway` function body where it constructs the POST body to Railway. Add `plan: tenant.plan ?? "base",` as a top-level field alongside the existing `slug`, `name`, etc. fields being forwarded. Example:

```typescript
// inside registerBusinessOnRailway
const body = {
  ...existingFields,
  plan: tenant.plan ?? "base",
};
```

(Exact location: search for the `JSON.stringify({…})` inside the Railway fetch. Whichever object is being stringified gets the `plan` key added.)

- [ ] **Step 9: Typecheck the Worker**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/db.ts server/src/schemas/business.ts server/src/routes/register.ts server/src/routes/register.test.ts worker/src/routes/stripe.ts
git commit -m "feat(p3): propagate plan tier from Worker to Railway businesses table"
```

---

## Task 2: Create the three competitor radar tables

Adds `competitor_query_baskets`, `competitor_polls`, and `competitor_citations` to the inline schema.

**Files:**
- Modify: `server/src/db.ts`
- Test: `server/src/db.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/src/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("P3 schema — competitor radar tables", () => {
  const tmp = path.join(os.tmpdir(), `p3-schema-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    const { _resetDbForTests } = await import("./db.js");
    _resetDbForTests();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(tmp + suffix, { force: true });
    }
    delete process.env.DATABASE_PATH;
  });

  it("creates competitor_query_baskets table", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get("competitor_query_baskets");
    expect(row).toBeTruthy();
  });

  it("creates competitor_polls table", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get("competitor_polls");
    expect(row).toBeTruthy();
  });

  it("creates competitor_citations table", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get("competitor_citations");
    expect(row).toBeTruthy();
  });

  it("enforces UNIQUE(slug, query) on baskets", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at) VALUES (?, ?, 'auto', 1, datetime('now'))"
    );
    insert.run("t1", "best plumber");
    expect(() => insert.run("t1", "best plumber")).toThrow(/UNIQUE/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/db.test.ts`
Expected: 4 new tests FAIL with "no such table".

- [ ] **Step 3: Add the three tables + indexes to `_initSchema`**

In `server/src/db.ts`, at the end of `_initSchema` (after the `click_events` block and the `_addColumnIfNotExists` calls for its columns), append:

```typescript
  // ── P3: competitor radar tables ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS competitor_query_baskets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL,
      query      TEXT NOT NULL,
      source     TEXT NOT NULL CHECK(source IN ('auto','tenant')),
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(slug, query)
    );
    CREATE INDEX IF NOT EXISTS idx_cqb_slug ON competitor_query_baskets(slug, enabled);

    CREATE TABLE IF NOT EXISTS competitor_polls (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      slug             TEXT NOT NULL,
      query_basket_id  INTEGER NOT NULL,
      bot              TEXT NOT NULL,
      phrasing         TEXT NOT NULL,
      phrasing_variant INTEGER NOT NULL,
      polled_at        TEXT NOT NULL,
      our_domain_cited INTEGER NOT NULL,
      our_cited_rank   INTEGER,
      citation_count   INTEGER NOT NULL,
      cost_usd         REAL,
      error            TEXT,
      FOREIGN KEY(query_basket_id) REFERENCES competitor_query_baskets(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_slug_polled ON competitor_polls(slug, polled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cp_slug_lost   ON competitor_polls(slug, our_domain_cited);

    CREATE TABLE IF NOT EXISTS competitor_citations (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      rank    INTEGER NOT NULL,
      url     TEXT NOT NULL,
      domain  TEXT NOT NULL,
      title   TEXT,
      FOREIGN KEY(poll_id) REFERENCES competitor_polls(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cc_poll   ON competitor_citations(poll_id);
    CREATE INDEX IF NOT EXISTS idx_cc_domain ON competitor_citations(domain);
  `);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/db.test.ts`
Expected: all 4 new tests PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/db.ts server/src/db.test.ts
git commit -m "feat(p3): add competitor_query_baskets, competitor_polls, competitor_citations tables"
```

---

## Task 3: Domain-match library

Canonicalizes URLs to comparable domains and answers "is this citation the tenant's own site?"

**Files:**
- Create: `server/src/lib/domainMatch.ts`
- Create: `server/src/lib/domainMatch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/lib/domainMatch.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { canonicalDomain, isCitationOfTenant } from "./domainMatch.js";

describe("canonicalDomain", () => {
  it.each([
    ["http://tenant.com/path",       "tenant.com"],
    ["https://www.tenant.com",       "tenant.com"],
    ["https://tenant.com/",          "tenant.com"],
    ["https://tenant.com?q=1",       "tenant.com"],
    ["https://tenant.com#frag",      "tenant.com"],
    ["https://tenant.com:8080",      "tenant.com"],
    ["tenant.com",                   "tenant.com"],
    ["WWW.TENANT.COM",               "tenant.com"],
    ["",                             ""],
    ["not a url",                    ""],
    ["shop.tenant.com",              "shop.tenant.com"],
    ["https://sub.tenant.co.uk/x",   "sub.tenant.co.uk"],
  ])("canonicalizes %s → %s", (input, expected) => {
    expect(canonicalDomain(input)).toBe(expected);
  });
});

describe("isCitationOfTenant", () => {
  it("matches on equal canonical domains", () => {
    expect(isCitationOfTenant("https://www.tenant.com/about", "tenant.com")).toBe(true);
  });
  it("returns false for different domains", () => {
    expect(isCitationOfTenant("https://yelp.com/biz/tenant", "tenant.com")).toBe(false);
  });
  it("returns false when subdomain differs (strict match v1)", () => {
    expect(isCitationOfTenant("https://shop.tenant.com", "tenant.com")).toBe(false);
  });
  it("returns false when tenant website is null", () => {
    expect(isCitationOfTenant("https://tenant.com", null)).toBe(false);
  });
  it("returns false on unparseable citation url", () => {
    expect(isCitationOfTenant("not a url", "tenant.com")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/lib/domainMatch.test.ts`
Expected: FAIL with "Cannot find module './domainMatch.js'".

- [ ] **Step 3: Implement `domainMatch.ts`**

Create `server/src/lib/domainMatch.ts`:

```typescript
/**
 * Canonicalize a URL-or-domain string to a lowercase bare domain.
 * Returns "" on unparseable input so callers can safely compare.
 */
export function canonicalDomain(urlOrDomain: string): string {
  if (!urlOrDomain || typeof urlOrDomain !== "string") return "";
  const trimmed = urlOrDomain.trim();
  if (!trimmed) return "";

  // Try as URL first. If no scheme, retry with https:// prefix.
  let host = "";
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    host = u.hostname;
  } catch {
    return "";
  }

  // Reject obvious garbage (URL constructor accepts "not" as a scheme-less host otherwise).
  if (!host.includes(".")) return "";

  host = host.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

/**
 * Strict-match: citation url canonical domain === tenant website canonical domain.
 * v1 does NOT match subdomains to roots or owned-presence profiles (Yelp, BBB, etc.).
 */
export function isCitationOfTenant(
  citationUrl: string,
  tenantWebsite: string | null | undefined,
): boolean {
  const c = canonicalDomain(citationUrl);
  const t = canonicalDomain(tenantWebsite ?? "");
  return c !== "" && t !== "" && c === t;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/lib/domainMatch.test.ts`
Expected: all 17 cases PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/lib/domainMatch.ts server/src/lib/domainMatch.test.ts
git commit -m "feat(p3): add canonicalDomain + isCitationOfTenant helpers"
```

---

## Task 4: Perplexity API client

Thin wrapper around Perplexity `chat/completions` that returns `{citations: string[], costUsd: number}`.

**Files:**
- Create: `server/src/lib/perplexity.ts`
- Create: `server/src/lib/perplexity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/lib/perplexity.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { perplexitySearch } from "./perplexity.js";

describe("perplexitySearch", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { process.env.PERPLEXITY_API_KEY = "pplx-test-key"; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.PERPLEXITY_API_KEY;
    vi.restoreAllMocks();
  });

  it("returns citations array from Perplexity response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          citations: ["https://a.com", "https://b.com"],
          choices: [{ message: { content: "answer" } }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await perplexitySearch("best plumber Boise");
    expect(result.citations).toEqual(["https://a.com", "https://b.com"]);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("returns empty citations when response omits them", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await perplexitySearch("q");
    expect(result.citations).toEqual([]);
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("server error", { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(perplexitySearch("q")).rejects.toThrow(/500/);
  });

  it("throws if PERPLEXITY_API_KEY is missing", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    await expect(perplexitySearch("q")).rejects.toThrow(/PERPLEXITY_API_KEY/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/lib/perplexity.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `perplexity.ts`**

Create `server/src/lib/perplexity.ts`:

```typescript
/**
 * Minimal Perplexity chat/completions client.
 * Returns the native `citations[]` array plus an estimated USD cost.
 *
 * Cost model (v1): flat $0.005/call. Revisit if Perplexity publishes per-token pricing.
 */
const PERPLEXITY_URL   = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_MODEL = "sonar";
const FLAT_COST_USD    = 0.005;

export interface PerplexityResult {
  citations: string[];
  costUsd: number;
}

export async function perplexitySearch(query: string): Promise<PerplexityResult> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY is not set");

  const res = await fetch(PERPLEXITY_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages: [{ role: "user", content: query }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`perplexity ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { citations?: string[] };
  const citations = Array.isArray(json.citations) ? json.citations.filter((c): c is string => typeof c === "string") : [];
  return { citations, costUsd: FLAT_COST_USD };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/lib/perplexity.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/lib/perplexity.ts server/src/lib/perplexity.test.ts
git commit -m "feat(p3): add perplexitySearch client"
```

---

## Task 5: Alert helper

Sends a budget-cap email via Resend, or logs at error level if `RESEND_API_KEY` is unset. No new dependency — uses global `fetch`.

**Files:**
- Create: `server/src/lib/alert.ts`
- Create: `server/src/lib/alert.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/lib/alert.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendBudgetAlert } from "./alert.js";

describe("sendBudgetAlert", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_EMAIL_TO;
    delete process.env.ALERT_EMAIL_FROM;
    vi.restoreAllMocks();
  });

  it("POSTs to Resend when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY  = "re_test";
    process.env.ALERT_EMAIL_TO  = "ops@example.com";
    process.env.ALERT_EMAIL_FROM = "noreply@example.com";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await sendBudgetAlert("[radar] budget cap hit", "spent $10.01");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["ops@example.com"]);
    expect(body.subject).toBe("[radar] budget cap hit");
  });

  it("logs to stderr and does not throw when RESEND_API_KEY is missing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await sendBudgetAlert("subject", "body");
    expect(errSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/lib/alert.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `alert.ts`**

Create `server/src/lib/alert.ts`:

```typescript
/**
 * Send a budget/ops alert via Resend if configured, else log to stderr.
 * Never throws — alerting failures must not crash the cron.
 */
export async function sendBudgetAlert(subject: string, body: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.ALERT_EMAIL_TO;
  const from   = process.env.ALERT_EMAIL_FROM ?? "alerts@advocatemcp.com";

  if (!apiKey || !to) {
    console.error(`[alert] ${subject} — ${body} (Resend not configured: RESEND_API_KEY/ALERT_EMAIL_TO)`);
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
    });
    if (!res.ok) {
      const resBody = await res.text().catch(() => "");
      console.error(`[alert] resend ${res.status}: ${resBody.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`[alert] resend threw:`, err);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/lib/alert.test.ts`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/lib/alert.ts server/src/lib/alert.test.ts
git commit -m "feat(p3): add sendBudgetAlert helper"
```

---

## Task 6: Shared 1 req/s token bucket

In-process token bucket that serializes Perplexity calls to 1/sec across all workers.

**Files:**
- Create: `server/src/lib/tokenBucket.ts`
- Create: `server/src/lib/tokenBucket.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/lib/tokenBucket.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TokenBucket } from "./tokenBucket.js";

describe("TokenBucket", () => {
  it("allows the first call immediately", async () => {
    const bucket = new TokenBucket({ intervalMs: 1000 });
    const t0 = Date.now();
    await bucket.acquire();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("delays the Nth call by (N-1) * intervalMs", async () => {
    const bucket = new TokenBucket({ intervalMs: 100 });
    const t0 = Date.now();
    await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire()]);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/lib/tokenBucket.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `tokenBucket.ts`**

Create `server/src/lib/tokenBucket.ts`:

```typescript
/**
 * Simple serial token bucket: each acquire() returns at least `intervalMs`
 * after the previous acquire(). Used to rate-limit outbound Perplexity calls
 * across parallel workers.
 */
export class TokenBucket {
  private readonly intervalMs: number;
  private nextAvailable = 0;

  constructor(opts: { intervalMs: number }) {
    this.intervalMs = opts.intervalMs;
  }

  async acquire(): Promise<void> {
    const now  = Date.now();
    const slot = Math.max(now, this.nextAvailable);
    this.nextAvailable = slot + this.intervalMs;
    const waitMs = slot - now;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/lib/tokenBucket.test.ts`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/lib/tokenBucket.ts server/src/lib/tokenBucket.test.ts
git commit -m "feat(p3): add TokenBucket rate-limit helper"
```

---

## Task 7: Install `node-cron` + `p-limit`

Add runtime deps needed by the cron handler.

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Install the deps**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/server
npm install node-cron p-limit
npm install --save-dev @types/node-cron
```

- [ ] **Step 2: Verify package.json reflects the new deps**

Run: `cd server && cat package.json | grep -E '"(node-cron|p-limit|@types/node-cron)"'`
Expected: three matching lines.

- [ ] **Step 3: Typecheck to confirm nothing broke**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/package.json server/package-lock.json
git commit -m "chore(p3): add node-cron and p-limit"
```

---

## Task 8: Basket seeding + phrasing variants

Pure functions used by the cron. Seeding generates up to 6 auto-queries from profile; variants fan each query into up to 3 phrasings with substring-dedupe.

**Files:**
- Create: `server/src/jobs/competitorRadar.ts` (initial scaffold — seeding + variants only)
- Create: `server/src/jobs/competitorRadar.test.ts` (seeding + variants)

- [ ] **Step 1: Write the failing test**

Create `server/src/jobs/competitorRadar.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateAutoQueries, phrasingVariants } from "./competitorRadar.js";

describe("generateAutoQueries", () => {
  it("produces 6 queries when category, location, and 3+ services present", () => {
    const qs = generateAutoQueries({
      category: "plumber",
      location: "Boise, ID",
      services: ["drain", "pipe", "heater", "sewer"],
    });
    expect(qs).toEqual([
      "best plumber in Boise, ID",
      "top plumber in Boise",
      "plumber near me in Boise, ID",
      "drain plumber Boise, ID",
      "pipe plumber Boise, ID",
      "heater plumber Boise, ID",
    ]);
  });

  it("omits service-based queries when services is empty", () => {
    const qs = generateAutoQueries({
      category: "plumber",
      location: "Boise, ID",
      services: [],
    });
    expect(qs).toEqual([
      "best plumber in Boise, ID",
      "top plumber in Boise",
      "plumber near me in Boise, ID",
    ]);
  });

  it("returns [] when category or location missing", () => {
    expect(generateAutoQueries({ category: "", location: "Boise", services: [] })).toEqual([]);
    expect(generateAutoQueries({ category: "plumber", location: "", services: [] })).toEqual([]);
  });
});

describe("phrasingVariants", () => {
  it("fans a plain query into 3 variants", () => {
    expect(phrasingVariants("best plumber Boise")).toEqual([
      "best plumber Boise",
      "best plumber Boise reviews",
      "top rated best plumber Boise",
    ]);
  });

  it("skips variant 1 when query already contains 'reviews'", () => {
    expect(phrasingVariants("plumber reviews Boise")).toEqual([
      "plumber reviews Boise",
      "top rated plumber reviews Boise",
    ]);
  });

  it("skips variant 2 when query already contains 'top rated' (case-insensitive)", () => {
    expect(phrasingVariants("Top Rated plumber")).toEqual([
      "Top Rated plumber",
      "Top Rated plumber reviews",
    ]);
  });

  it("returns only the base variant when both affixes already present", () => {
    expect(phrasingVariants("top rated plumber reviews")).toEqual(["top rated plumber reviews"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/jobs/competitorRadar.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `generateAutoQueries` and `phrasingVariants`**

Create `server/src/jobs/competitorRadar.ts`:

```typescript
/**
 * Competitor Radar cron handler + pure helpers.
 *
 * This file is the single entry point for P3 polling. The cron-scheduled
 * `pollAll()` will be added in a later task. For now it exports two pure
 * helpers used by seeding and the fan-out loop.
 */

export interface ProfileForSeeding {
  category: string;
  location: string;
  services: string[];
}

/**
 * Produce up to 6 deterministic auto-seed queries from a tenant profile.
 * Field-missing-safe: returns [] if category or location is blank.
 */
export function generateAutoQueries(p: ProfileForSeeding): string[] {
  const cat = p.category.trim();
  const loc = p.location.trim();
  if (!cat || !loc) return [];

  const city = loc.split(",")[0]!.trim();
  const base = [
    `best ${cat} in ${loc}`,
    `top ${cat} in ${city}`,
    `${cat} near me in ${loc}`,
  ];
  const services = (p.services ?? []).slice(0, 3).map((s) => s.trim()).filter(Boolean);
  for (const svc of services) base.push(`${svc} ${cat} ${loc}`);
  return base;
}

/**
 * Fan a stored query into up to 3 phrasing variants. Skips a variant if the
 * query already contains the variant's distinguishing affix (case-insensitive).
 */
export function phrasingVariants(query: string): string[] {
  const lower = query.toLowerCase();
  const out: string[] = [query];
  if (!lower.includes("reviews")) out.push(`${query} reviews`);
  if (!lower.includes("top rated")) out.push(`top rated ${query}`);
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/jobs/competitorRadar.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/jobs/competitorRadar.ts server/src/jobs/competitorRadar.test.ts
git commit -m "feat(p3): add generateAutoQueries and phrasingVariants"
```

---

## Task 9: Lazy basket seeder

Writes auto-query rows for any Pro tenant whose basket is empty. Runs at the top of each cron iteration.

**Files:**
- Modify: `server/src/jobs/competitorRadar.ts`
- Modify: `server/src/jobs/competitorRadar.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/jobs/competitorRadar.test.ts`:

```typescript
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, afterAll } from "vitest";

describe("seedBasketIfEmpty", () => {
  const tmp = path.join(os.tmpdir(), `p3-seed-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    const { getDb } = await import("../db.js");
    getDb(); // init schema
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
  });

  it("seeds 6 auto rows for a fresh Pro tenant", async () => {
    const { getDb } = await import("../db.js");
    const { seedBasketIfEmpty } = await import("./competitorRadar.js");
    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t1", "T1", "d", JSON.stringify(["drain","pipe","heater"]),
        "k1", "plumber", "Boise, ID", 4.5, 10
      );

    seedBasketIfEmpty("t1");

    const rows = db.prepare(
      "SELECT query, source FROM competitor_query_baskets WHERE slug=? AND enabled=1 ORDER BY id"
    ).all("t1") as { query: string; source: string }[];
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.source === "auto")).toBe(true);
    expect(rows[0]!.query).toBe("best plumber in Boise, ID");
  });

  it("is a no-op when basket already has rows", async () => {
    const { getDb } = await import("../db.js");
    const { seedBasketIfEmpty } = await import("./competitorRadar.js");
    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t2", "T2", "d", JSON.stringify([]), "k2", "plumber", "Boise, ID", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t2', 'custom q', 'tenant', 1, datetime('now'))`).run();

    seedBasketIfEmpty("t2");

    const { count } = db.prepare(
      "SELECT COUNT(*) AS count FROM competitor_query_baskets WHERE slug='t2'"
    ).get() as { count: number };
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/jobs/competitorRadar.test.ts`
Expected: the two new cases FAIL with "seedBasketIfEmpty is not a function".

- [ ] **Step 3: Implement `seedBasketIfEmpty`**

Append to `server/src/jobs/competitorRadar.ts`:

```typescript
import { getDb } from "../db.js";

/**
 * Idempotently seed the auto-query basket for one tenant. No-op if any
 * enabled row already exists (handles Base→Pro→Base→Pro re-activation).
 */
export function seedBasketIfEmpty(slug: string): void {
  const db = getDb();
  const { count } = db
    .prepare("SELECT COUNT(*) AS count FROM competitor_query_baskets WHERE slug=? AND enabled=1")
    .get(slug) as { count: number };
  if (count > 0) return;

  const biz = db
    .prepare("SELECT category, location, services FROM businesses WHERE slug=?")
    .get(slug) as { category: string | null; location: string | null; services: string } | undefined;
  if (!biz) return;

  let services: string[] = [];
  try { services = JSON.parse(biz.services ?? "[]"); } catch { services = []; }

  const queries = generateAutoQueries({
    category: biz.category ?? "",
    location: biz.location ?? "",
    services,
  });

  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO competitor_query_baskets
       (slug, query, source, enabled, created_at)
     VALUES (?, ?, 'auto', 1, ?)`
  );
  for (const q of queries) insert.run(slug, q, now);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/jobs/competitorRadar.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/jobs/competitorRadar.ts server/src/jobs/competitorRadar.test.ts
git commit -m "feat(p3): lazy basket seeder"
```

---

## Task 10: Cron poll loop with budget gate + error isolation

The main `pollAll()` function. Reads Pro tenants, seeds baskets, fans each basket query into variants, calls Perplexity behind the token bucket, writes poll + citation rows, and gates the entire run behind a daily USD budget cap.

**Files:**
- Modify: `server/src/jobs/competitorRadar.ts`
- Modify: `server/src/jobs/competitorRadar.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/jobs/competitorRadar.test.ts`:

```typescript
import { vi } from "vitest";

describe("pollAll", () => {
  const tmp = path.join(os.tmpdir(), `p3-poll-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.COMPETITOR_POLL_DAILY_BUDGET_USD = "10";
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    const { getDb } = await import("../db.js");
    getDb();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.COMPETITOR_POLL_DAILY_BUDGET_USD;
    vi.restoreAllMocks();
  });

  it("writes 3 poll rows + 15 citations for a tenant whose domain is cited at rank 3", async () => {
    const { getDb } = await import("../db.js");
    const { pollAll } = await import("./competitorRadar.js");
    const perplexity = await import("../lib/perplexity.js");

    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t1", "T1", "d", "[]", "k1", "plumber", "Boise, ID",
        "https://tenant.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t1', 'best plumber boise', 'tenant', 1, datetime('now'))`).run();

    vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: [
        "https://other1.com",
        "https://other2.com",
        "https://tenant.com/about",
        "https://other3.com",
        "https://other4.com",
      ],
      costUsd: 0.005,
    });

    await pollAll();

    const polls = db.prepare("SELECT * FROM competitor_polls WHERE slug='t1'").all() as Array<{
      our_domain_cited: number; our_cited_rank: number | null; citation_count: number;
    }>;
    expect(polls).toHaveLength(3);
    expect(polls.every((p) => p.our_domain_cited === 1)).toBe(true);
    expect(polls.every((p) => p.our_cited_rank === 3)).toBe(true);
    expect(polls.every((p) => p.citation_count === 5)).toBe(true);

    const citations = db.prepare("SELECT COUNT(*) AS c FROM competitor_citations").get() as { c: number };
    expect(citations.c).toBe(15);
  });

  it("skips polling and sends alert when daily budget cap is breached", async () => {
    const { getDb } = await import("../db.js");
    const { pollAll } = await import("./competitorRadar.js");
    const perplexity = await import("../lib/perplexity.js");
    const alert      = await import("../lib/alert.js");

    process.env.COMPETITOR_POLL_DAILY_BUDGET_USD = "10";
    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t2", "T2", "d", "[]", "k2", "plumber", "Boise, ID", "https://t2.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t2', 'q', 'tenant', 1, datetime('now'))`).run();

    // Pre-seed today's spend above the cap.
    db.prepare(`INSERT INTO competitor_polls
      (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at, our_domain_cited, citation_count, cost_usd)
      VALUES ('t2', 1, 'perplexity', 'x', 0, ?, 0, 0, 10.01)`).run(new Date().toISOString());

    const searchSpy = vi.spyOn(perplexity, "perplexitySearch");
    const alertSpy  = vi.spyOn(alert, "sendBudgetAlert").mockResolvedValue();

    await pollAll();

    expect(searchSpy).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledOnce();
  });

  it("isolates errors: one failing call does not abort the batch", async () => {
    const { getDb } = await import("../db.js");
    const { pollAll } = await import("./competitorRadar.js");
    const perplexity = await import("../lib/perplexity.js");

    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t3", "T3", "d", "[]", "k3", "plumber", "Boise, ID", "https://t3.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t3', 'q', 'tenant', 1, datetime('now'))`).run();

    let call = 0;
    vi.spyOn(perplexity, "perplexitySearch").mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error("500 api");
      return { citations: ["https://t3.com"], costUsd: 0.005 };
    });

    await pollAll();

    const polls = db.prepare(
      "SELECT our_domain_cited, citation_count, error FROM competitor_polls WHERE slug='t3' ORDER BY id"
    ).all() as Array<{ our_domain_cited: number; citation_count: number; error: string | null }>;
    expect(polls).toHaveLength(3);
    expect(polls[1]!.error).toBe("500 api");
    expect(polls[1]!.citation_count).toBe(0);
    expect(polls[0]!.error).toBeNull();
    expect(polls[2]!.error).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/jobs/competitorRadar.test.ts`
Expected: the three new cases FAIL with "pollAll is not a function".

- [ ] **Step 3: Implement `pollAll`**

Append to `server/src/jobs/competitorRadar.ts`:

```typescript
import pLimit from "p-limit";
import { perplexitySearch } from "../lib/perplexity.js";
import { canonicalDomain, isCitationOfTenant } from "../lib/domainMatch.js";
import { sendBudgetAlert } from "../lib/alert.js";
import { TokenBucket } from "../lib/tokenBucket.js";

const BOT          = "perplexity";
const CONCURRENCY  = 4;
const RATE_INTERVAL_MS = 1000;

interface TenantRow { slug: string; website: string | null }
interface BasketRow { id: number; query: string }

function todayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function budgetCapUsd(): number {
  const raw = process.env.COMPETITOR_POLL_DAILY_BUDGET_USD;
  const n = raw ? Number(raw) : 10;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/**
 * Main cron entry point. Called by node-cron; also callable manually for smoke tests.
 */
export async function pollAll(): Promise<void> {
  const db = getDb();

  // 1. Budget gate.
  const cap = budgetCapUsd();
  const { spent } = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM competitor_polls WHERE polled_at >= ?`)
    .get(todayStartIso()) as { spent: number };
  if (spent >= cap) {
    console.warn(`[radar] budget_cap_hit spent=$${spent.toFixed(2)} cap=$${cap}`);
    await sendBudgetAlert(
      `[radar] daily budget cap hit ($${cap})`,
      `Today's Perplexity spend: $${spent.toFixed(2)}. Polling skipped.`,
    );
    return;
  }

  // 2. Load Pro tenants.
  const tenants = db
    .prepare(`SELECT slug, website FROM businesses WHERE plan='pro' AND api_key <> 'pending'`)
    .all() as TenantRow[];

  // 3. Seed + poll each tenant with bounded concurrency.
  const limit  = pLimit(CONCURRENCY);
  const bucket = new TokenBucket({ intervalMs: RATE_INTERVAL_MS });

  let totalPolls = 0, totalCitations = 0, totalErrors = 0, totalCost = 0;

  await Promise.all(tenants.map((t) => limit(async () => {
    seedBasketIfEmpty(t.slug);

    const basket = db
      .prepare(`SELECT id, query FROM competitor_query_baskets WHERE slug=? AND enabled=1`)
      .all(t.slug) as BasketRow[];

    for (const row of basket) {
      for (const [variantIdx, phrasing] of phrasingVariants(row.query).entries()) {
        await bucket.acquire();

        let citations: string[] = [];
        let errorMsg: string | null = null;
        let costUsd = 0;
        try {
          const r = await perplexitySearch(phrasing);
          citations = r.citations;
          costUsd   = r.costUsd;
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
          totalErrors++;
        }

        const cited      = citations.findIndex((c) => isCitationOfTenant(c, t.website));
        const citedRank  = cited >= 0 ? cited + 1 : null;
        const pollInsert = db.prepare(
          `INSERT INTO competitor_polls
             (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at,
              our_domain_cited, our_cited_rank, citation_count, cost_usd, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const info = pollInsert.run(
          t.slug, row.id, BOT, phrasing, variantIdx, new Date().toISOString(),
          citedRank !== null ? 1 : 0, citedRank, citations.length, costUsd, errorMsg,
        );
        const pollId = Number(info.lastInsertRowid);

        if (citations.length > 0) {
          const citInsert = db.prepare(
            `INSERT INTO competitor_citations (poll_id, rank, url, domain, title) VALUES (?, ?, ?, ?, ?)`
          );
          const tx = db.transaction((rows: { rank: number; url: string }[]) => {
            for (const c of rows) citInsert.run(pollId, c.rank, c.url, canonicalDomain(c.url), null);
          });
          tx(citations.map((url, i) => ({ rank: i + 1, url })));
          totalCitations += citations.length;
        }

        totalPolls++;
        totalCost += costUsd;
      }
    }
  })));

  console.log(`[radar] run_complete tenants=${tenants.length} polls=${totalPolls} citations=${totalCitations} errors=${totalErrors} cost=$${totalCost.toFixed(4)}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/jobs/competitorRadar.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Run the full suite to catch regressions**

Run: `cd server && npx vitest run`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/jobs/competitorRadar.ts server/src/jobs/competitorRadar.test.ts
git commit -m "feat(p3): pollAll cron loop with budget gate, error isolation, token-bucket rate limit"
```

---

## Task 11: Read endpoints — summary + losses

Two GET endpoints behind `requireApiKey`, powering P4 and P5.

**Files:**
- Create: `server/src/routes/competitorRadar.ts`
- Create: `server/src/routes/competitorRadar.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/competitorRadar.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";

describe("GET /api/competitor-radar/:slug/summary + /losses", () => {
  const tmp = path.join(os.tmpdir(), `p3-routes-${Date.now()}.db`);
  let app: express.Express;

  beforeAll(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.API_KEY = "admin-key";
    const { _resetDbForTests, getDb } = await import("../db.js");
    _resetDbForTests();
    const db = getDb();

    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t1", "T1", "d", "[]", "tenant-key", "plumber", "Boise, ID",
        "https://tenant.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t1', 'q', 'auto', 1, datetime('now'))`).run();

    const mkPoll = db.prepare(`INSERT INTO competitor_polls
      (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at, our_domain_cited, our_cited_rank, citation_count, cost_usd)
      VALUES ('t1', 1, 'perplexity', 'q', 0, ?, ?, ?, ?, 0.005)`);
    const mkCit = db.prepare(`INSERT INTO competitor_citations (poll_id, rank, url, domain, title) VALUES (?, ?, ?, ?, ?)`);

    // 20 cited polls (ranks 1-5), 10 lost, losses cite 3 distinct competitors.
    const now = new Date();
    for (let i = 0; i < 20; i++) {
      const rank = (i % 5) + 1;
      const info = mkPoll.run(new Date(now.getTime() - i * 1000).toISOString(), 1, rank, 5);
      mkCit.run(Number(info.lastInsertRowid), rank, "https://tenant.com", "tenant.com", "t");
    }
    const competitors = ["boiseplumbco.com", "aceplumbing.com", "plumbpro.com"];
    for (let i = 0; i < 10; i++) {
      const info = mkPoll.run(new Date(now.getTime() - (20 + i) * 1000).toISOString(), 0, null, 3);
      const pollId = Number(info.lastInsertRowid);
      mkCit.run(pollId, 1, `https://${competitors[i % 3]}/x`, competitors[i % 3]!, "c");
      mkCit.run(pollId, 2, `https://yelp.com/${i}`, "yelp.com", "y");
      mkCit.run(pollId, 3, `https://${competitors[(i + 1) % 3]}/y`, competitors[(i + 1) % 3]!, "c");
    }

    const { competitorRadarRouter } = await import("./competitorRadar.js");
    app = express();
    app.use(express.json());
    app.use(competitorRadarRouter);
  });

  afterAll(async () => {
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.API_KEY;
    delete process.env.DATABASE_PATH;
  });

  it("401 on summary without api key", async () => {
    const res = await request(app).get("/api/competitor-radar/t1/summary");
    expect(res.status).toBe(401);
  });

  it("returns summary shape for tenant with mixed polls", async () => {
    const res = await request(app)
      .get("/api/competitor-radar/t1/summary?days=30")
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(200);
    expect(res.body.total_polls).toBe(30);
    expect(res.body.cited_count).toBe(20);
    expect(res.body.citation_rate).toBeCloseTo(20 / 30, 3);
    expect(res.body.avg_cited_rank).toBeCloseTo(3, 3);
    expect(res.body.top_competitor_domains).toHaveLength(4); // 3 competitors + yelp
    expect(res.body.top_competitor_domains.find((d: { domain: string }) => d.domain === "tenant.com")).toBeUndefined();
    expect(res.body.last_polled_at).toBeDefined();
  });

  it("returns losses with top citations, limit-capped", async () => {
    const res = await request(app)
      .get("/api/competitor-radar/t1/losses?days=7&limit=5")
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(200);
    expect(res.body.losses.length).toBeLessThanOrEqual(5);
    expect(res.body.losses[0].top_citations.length).toBeGreaterThan(0);
    expect(res.body.losses[0].top_citations.length).toBeLessThanOrEqual(5);
  });

  it("caps losses limit at 200 even if caller asks for more", async () => {
    const res = await request(app)
      .get("/api/competitor-radar/t1/losses?days=7&limit=9999")
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(200);
    expect(res.body.losses.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/competitorRadar.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the two read endpoints**

Create `server/src/routes/competitorRadar.ts`:

```typescript
import { Router } from "express";
import type { Request, Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { canonicalDomain } from "../lib/domainMatch.js";

export const competitorRadarRouter = Router();

function parseDays(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 365 ? Math.floor(n) : fallback;
}
function parseLimit(raw: unknown, fallback: number, cap: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), cap);
}
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/**
 * GET /api/competitor-radar/:slug/summary?days=30
 */
competitorRadarRouter.get(
  "/api/competitor-radar/:slug/summary",
  requireApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const days = parseDays(req.query.days, 30);
    const since = daysAgoIso(days);
    const db = getDb();

    const biz = db.prepare("SELECT website FROM businesses WHERE slug=?")
      .get(slug) as { website: string | null } | undefined;
    if (!biz) { res.status(404).json({ error: "not_found" }); return; }
    const ownDomain = canonicalDomain(biz.website ?? "");

    const polls = db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN our_domain_cited=1 THEN 1 ELSE 0 END) AS cited,
         AVG(CASE WHEN our_domain_cited=1 THEN our_cited_rank END) AS avg_rank,
         MAX(polled_at) AS last_polled_at
       FROM competitor_polls
       WHERE slug=? AND polled_at>=?`
    ).get(slug, since) as {
      total: number; cited: number | null; avg_rank: number | null; last_polled_at: string | null;
    };

    const top = db.prepare(
      `SELECT cc.domain, COUNT(*) AS cited_count
         FROM competitor_citations cc
         JOIN competitor_polls cp ON cp.id = cc.poll_id
        WHERE cp.slug=? AND cp.polled_at>=? AND cp.our_domain_cited=0 AND cc.domain <> ?
        GROUP BY cc.domain
        ORDER BY cited_count DESC
        LIMIT 5`
    ).all(slug, since, ownDomain) as { domain: string; cited_count: number }[];

    res.json({
      range_days: days,
      total_polls: polls.total,
      cited_count: polls.cited ?? 0,
      citation_rate: polls.total > 0 ? (polls.cited ?? 0) / polls.total : 0,
      avg_cited_rank: polls.avg_rank,
      top_competitor_domains: top,
      last_polled_at: polls.last_polled_at,
    });
  },
);

/**
 * GET /api/competitor-radar/:slug/losses?days=7&limit=50
 */
competitorRadarRouter.get(
  "/api/competitor-radar/:slug/losses",
  requireApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const days  = parseDays(req.query.days, 7);
    const limit = parseLimit(req.query.limit, 50, 200);
    const since = daysAgoIso(days);
    const db = getDb();

    const polls = db.prepare(
      `SELECT id, polled_at, phrasing, phrasing_variant
         FROM competitor_polls
        WHERE slug=? AND polled_at>=? AND our_domain_cited=0
        ORDER BY polled_at DESC
        LIMIT ?`
    ).all(slug, since, limit) as {
      id: number; polled_at: string; phrasing: string; phrasing_variant: number;
    }[];

    const citationStmt = db.prepare(
      `SELECT rank, domain, title FROM competitor_citations
        WHERE poll_id=? ORDER BY rank ASC LIMIT 5`
    );

    const losses = polls.map((p) => ({
      poll_id:   p.id,
      polled_at: p.polled_at,
      phrasing:  p.phrasing,
      variant:   p.phrasing_variant,
      top_citations: citationStmt.all(p.id),
    }));

    res.json({ range_days: days, losses });
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/competitorRadar.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/routes/competitorRadar.ts server/src/routes/competitorRadar.test.ts
git commit -m "feat(p3): GET summary and losses endpoints"
```

---

## Task 12: Basket CRUD — GET + POST + DELETE

Three endpoints so tenants can edit their polling queries.

**Files:**
- Modify: `server/src/routes/competitorRadar.ts`
- Modify: `server/src/routes/competitorRadar.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/routes/competitorRadar.test.ts`, in a new `describe` block:

```typescript
describe("basket CRUD", () => {
  const tmp = path.join(os.tmpdir(), `p3-basket-${Date.now()}.db`);
  let app: express.Express;

  beforeAll(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.API_KEY = "admin-key";
    const { _resetDbForTests, getDb } = await import("../db.js");
    _resetDbForTests();
    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "tb", "TB", "d", "[]", "tenant-key", "plumber", "Boise, ID", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('tb', 'seeded auto', 'auto', 1, datetime('now'))`).run();
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('tb', 'disabled old', 'tenant', 0, datetime('now'))`).run();

    const { competitorRadarRouter } = await import("./competitorRadar.js");
    app = express();
    app.use(express.json());
    app.use(competitorRadarRouter);
  });

  afterAll(async () => {
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.API_KEY;
    delete process.env.DATABASE_PATH;
  });

  it("GET returns only enabled queries", async () => {
    const res = await request(app)
      .get("/api/competitor-basket/tb")
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(200);
    expect(res.body.queries).toHaveLength(1);
    expect(res.body.queries[0].query).toBe("seeded auto");
  });

  it("POST creates a tenant-source query", async () => {
    const res = await request(app)
      .post("/api/competitor-basket/tb/queries")
      .set("X-API-Key", "admin-key")
      .send({ query: "24/7 emergency plumber" });
    expect(res.status).toBe(201);
    expect(res.body.query).toBe("24/7 emergency plumber");
    expect(res.body.source).toBe("tenant");
  });

  it("POST rejects empty/long queries", async () => {
    const r1 = await request(app)
      .post("/api/competitor-basket/tb/queries")
      .set("X-API-Key", "admin-key")
      .send({ query: "" });
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .post("/api/competitor-basket/tb/queries")
      .set("X-API-Key", "admin-key")
      .send({ query: "x".repeat(201) });
    expect(r2.status).toBe(400);
  });

  it("POST 409s on duplicate", async () => {
    const res = await request(app)
      .post("/api/competitor-basket/tb/queries")
      .set("X-API-Key", "admin-key")
      .send({ query: "seeded auto" });
    expect(res.status).toBe(409);
  });

  it("POST 400s past 15-row cap", async () => {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const stmt = db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('tb', ?, 'tenant', 1, datetime('now'))`);
    for (let i = 0; i < 14; i++) stmt.run(`filler ${i}`);
    const res = await request(app)
      .post("/api/competitor-basket/tb/queries")
      .set("X-API-Key", "admin-key")
      .send({ query: "one too many" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cap/);
  });

  it("DELETE soft-deletes (enabled=0) a tenant row", async () => {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const info = db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('tb', 'to-delete', 'tenant', 1, datetime('now'))`).run();
    const id = Number(info.lastInsertRowid);

    const res = await request(app)
      .delete(`/api/competitor-basket/tb/queries/${id}`)
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(200);

    const row = db.prepare("SELECT enabled FROM competitor_query_baskets WHERE id=?")
      .get(id) as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it("DELETE returns 404 for another tenant's id", async () => {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const info = db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('other-tenant', 'cross', 'tenant', 1, datetime('now'))`).run();
    const id = Number(info.lastInsertRowid);

    const res = await request(app)
      .delete(`/api/competitor-basket/tb/queries/${id}`)
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/competitorRadar.test.ts`
Expected: the 7 new basket tests FAIL with 404s (routes not registered).

- [ ] **Step 3: Implement the three basket endpoints**

Append to `server/src/routes/competitorRadar.ts`:

```typescript
const BASKET_CAP = 15;
const QUERY_MAX  = 200;

/**
 * GET /api/competitor-basket/:slug
 */
competitorRadarRouter.get(
  "/api/competitor-basket/:slug",
  requireApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const db = getDb();
    const queries = db.prepare(
      `SELECT id, query, source FROM competitor_query_baskets
        WHERE slug=? AND enabled=1
        ORDER BY created_at ASC`
    ).all(slug) as { id: number; query: string; source: string }[];
    res.json({ slug, queries });
  },
);

/**
 * POST /api/competitor-basket/:slug/queries
 */
competitorRadarRouter.post(
  "/api/competitor-basket/:slug/queries",
  requireApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const raw = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!raw || raw.length > QUERY_MAX) {
      res.status(400).json({ error: "query must be 1..200 chars" });
      return;
    }

    const db = getDb();
    const { count } = db.prepare(
      "SELECT COUNT(*) AS count FROM competitor_query_baskets WHERE slug=? AND enabled=1"
    ).get(slug) as { count: number };
    if (count >= BASKET_CAP) {
      res.status(400).json({ error: `basket cap reached (${BASKET_CAP} enabled queries)` });
      return;
    }

    try {
      const info = db.prepare(
        `INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
         VALUES (?, ?, 'tenant', 1, ?)`
      ).run(slug, raw, new Date().toISOString());
      res.status(201).json({ id: Number(info.lastInsertRowid), slug, query: raw, source: "tenant" });
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        res.status(409).json({ error: "duplicate query for this tenant" });
        return;
      }
      throw err;
    }
  },
);

/**
 * DELETE /api/competitor-basket/:slug/queries/:id  — soft delete
 */
competitorRadarRouter.delete(
  "/api/competitor-basket/:slug/queries/:id",
  requireApiKey,
  (req: Request, res: Response) => {
    const { slug, id } = req.params;
    const numId = Number(id);
    if (!Number.isFinite(numId)) { res.status(404).json({ error: "not_found" }); return; }

    const db = getDb();
    const info = db.prepare(
      "UPDATE competitor_query_baskets SET enabled=0 WHERE id=? AND slug=? AND enabled=1"
    ).run(numId, slug);
    if (info.changes === 0) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ ok: true });
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/competitorRadar.test.ts`
Expected: all basket CRUD tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/routes/competitorRadar.ts server/src/routes/competitorRadar.test.ts
git commit -m "feat(p3): basket CRUD endpoints (GET, POST, DELETE)"
```

---

## Task 13: Mount router + register cron in `index.ts`

Wire the new router and schedule the cron. Default schedule: `0 4 * * 1,3,5` (Mon/Wed/Fri 04:00 UTC), overridable via `POLL_SCHEDULE_CRON`.

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Add the imports and router mount**

In `server/src/index.ts`, add imports near the existing ones:

```typescript
import cron from "node-cron";
import { competitorRadarRouter } from "./routes/competitorRadar.js";
import { pollAll } from "./jobs/competitorRadar.js";
```

- [ ] **Step 2: Mount the router**

Add after the existing `app.use(mcpRouter)` line:

```typescript
app.use(competitorRadarRouter); // GET summary/losses, basket CRUD (requireApiKey)
```

- [ ] **Step 3: Schedule the cron**

Append just before the closing `app.listen(PORT, …)` call:

```typescript
// ── P3: competitor radar cron ──
const CRON_SCHEDULE = process.env.POLL_SCHEDULE_CRON ?? "0 4 * * 1,3,5";
if (process.env.PERPLEXITY_API_KEY && cron.validate(CRON_SCHEDULE)) {
  cron.schedule(CRON_SCHEDULE, () => {
    pollAll().catch((err) => console.error("[radar] pollAll threw:", err));
  });
  console.log(`[radar] scheduled: ${CRON_SCHEDULE}`);
} else {
  console.warn("[radar] cron NOT scheduled — missing PERPLEXITY_API_KEY or invalid POLL_SCHEDULE_CRON");
}
```

- [ ] **Step 4: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full suite**

Run: `cd server && npx vitest run`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/src/index.ts
git commit -m "feat(p3): mount competitor-radar router and schedule cron"
```

---

## Task 14: Env template + followups doc

Document the three new env vars and log the deferred v1.1 items.

**Files:**
- Create or modify: `server/.env.example`
- Modify: `docs/followups.md`

- [ ] **Step 1: Append to `server/.env.example`**

If the file does not exist, create it. Append these lines:

```
# ── P3: competitor radar ──
# Required. Perplexity API key for the polling cron. Without it the cron does not schedule.
PERPLEXITY_API_KEY=

# Optional. node-cron expression. Default "0 4 * * 1,3,5" (Mon/Wed/Fri 04:00 UTC).
POLL_SCHEDULE_CRON=0 4 * * 1,3,5

# Optional. Daily USD budget cap. Default 10. Polling skipped + alert sent on breach.
COMPETITOR_POLL_DAILY_BUDGET_USD=10

# Optional. Alerting via Resend.
RESEND_API_KEY=
ALERT_EMAIL_TO=
ALERT_EMAIL_FROM=alerts@advocatemcp.com
```

- [ ] **Step 2: Append P3 v1.1 followups**

Append to `docs/followups.md` a new section:

```markdown
## P3 Competitor Radar — v1.1 candidates

- **Subdomain-root matching.** Strict v1 match treats `shop.tenant.com` as NOT `tenant.com`. Revisit after 30 days of production data if false-negative rate is material.
- **Owned-presence aliases.** If tenants report "Perplexity cited my Yelp/Google Biz/Facebook/BBB listing and you didn't count it," add `tenant_domain_aliases` table and widen `isCitationOfTenant`. Belongs in P4.
- **LLM-generated phrasing variants.** v1 uses 3 fixed templates. If citation rates are bimodal (consistently cited vs. never), swap in LLM-generated variants. Producer-function swap — no schema change.
- **OpenAI Responses API (P3 v1.1).** Add `bot='openai'` polling once the web-search tool-call output schema stabilizes.
- **Per-tenant budget caps.** v1 uses a single global daily cap. Add per-tenant caps keyed by plan tier if one tenant dominates spend.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add server/.env.example docs/followups.md
git commit -m "docs(p3): env template + v1.1 followups"
```

---

## Task 15: End-to-end verification

Apply the schema locally, run the suite, trigger one manual poll, and hit both read endpoints. This is the final sanity gate before merging to `main`.

**Files:** none — runtime verification only.

- [ ] **Step 1: Run the full test suite**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/server
npx vitest run
```
Expected: all tests PASS, including the ~25 new ones added by this plan.

- [ ] **Step 2: Typecheck server and worker**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/server && npx tsc --noEmit
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker && npx tsc --noEmit
```
Expected: zero errors in both.

- [ ] **Step 3: Apply the schema locally by booting the server**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/server
DATABASE_PATH=./dev.db PERPLEXITY_API_KEY=pplx-fake npm run dev
```
In another terminal, verify the tables exist:
```bash
sqlite3 /Users/cameronmcewan/Desktop/advocate/advocatemcp/server/dev.db ".tables"
```
Expected: output includes `competitor_query_baskets`, `competitor_polls`, `competitor_citations`. Stop the dev server (Ctrl-C) afterwards.

- [ ] **Step 4: Promote an existing test tenant to Pro**

```bash
sqlite3 /Users/cameronmcewan/Desktop/advocate/advocatemcp/server/dev.db \
  "UPDATE businesses SET plan='pro', website='https://smokeplumb.example' WHERE slug='smoke-plumb-apr14c'"
```
Expected: `Changes: 1`. If slug doesn't exist, substitute any slug present in the DB.

- [ ] **Step 5: Run `pollAll` manually with a mock Perplexity**

Create a throwaway `server/scripts/run-radar-once.ts`:

```typescript
import "dotenv/config";
import { pollAll } from "../src/jobs/competitorRadar.js";
await pollAll();
process.exit(0);
```

Run (with a real `PERPLEXITY_API_KEY` for a true end-to-end, or stub by temporarily mocking if you want to save cost — your call):

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/server
npx tsx scripts/run-radar-once.ts
```
Expected: console logs `[radar] run_complete tenants=1 polls=N citations=M errors=0 cost=$…`.

- [ ] **Step 6: Inspect the tables**

```bash
sqlite3 /Users/cameronmcewan/Desktop/advocate/advocatemcp/server/dev.db \
  "SELECT COUNT(*) FROM competitor_polls WHERE slug='smoke-plumb-apr14c'"
sqlite3 /Users/cameronmcewan/Desktop/advocate/advocatemcp/server/dev.db \
  "SELECT COUNT(*) FROM competitor_citations WHERE poll_id IN (SELECT id FROM competitor_polls WHERE slug='smoke-plumb-apr14c')"
```
Expected: both counts > 0.

- [ ] **Step 7: Hit the summary + losses endpoints locally**

With the dev server running:

```bash
curl -s -H "X-API-Key: $API_KEY" \
  http://localhost:3000/api/competitor-radar/smoke-plumb-apr14c/summary?days=30 | jq
curl -s -H "X-API-Key: $API_KEY" \
  http://localhost:3000/api/competitor-radar/smoke-plumb-apr14c/losses?days=7 | jq
```
Expected: valid JSON matching the shapes in the spec (fields: `total_polls`, `cited_count`, `citation_rate`, `top_competitor_domains`, `last_polled_at`; and `losses[]` with `top_citations[]`).

- [ ] **Step 8: Smoke the basket CRUD**

```bash
curl -s -H "X-API-Key: $API_KEY" \
  http://localhost:3000/api/competitor-basket/smoke-plumb-apr14c | jq
curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"24/7 emergency plumber"}' \
  http://localhost:3000/api/competitor-basket/smoke-plumb-apr14c/queries | jq
```
Expected: first call returns `{slug, queries:[…auto rows…]}`; second returns `{id, slug, query:"24/7 emergency plumber", source:"tenant"}` with status 201.

- [ ] **Step 9: Budget-cap smoke**

Temporarily override the cap to provoke the gate:

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/server
COMPETITOR_POLL_DAILY_BUDGET_USD=0.001 npx tsx scripts/run-radar-once.ts
```
Expected: log line `[radar] budget_cap_hit` and — if `RESEND_API_KEY` is configured — one alert email. No new `competitor_polls` rows (verify via sqlite3 count).

- [ ] **Step 10: Delete the throwaway script + commit the sweep**

```bash
rm /Users/cameronmcewan/Desktop/advocate/advocatemcp/server/scripts/run-radar-once.ts
```

If the `scripts/` directory was created new and is now empty, `rmdir` it too.

No commit needed — throwaway only.

---

## Self-Review Results

**Spec coverage check** — every spec section has a task:

| Spec section | Task(s) |
|---|---|
| Prerequisites (plan column, Worker forward, zod, register.ts) | 1 |
| Data Model (3 tables + indexes) | 2 |
| Domain Matching (v1 strict) | 3 |
| Perplexity client | 4 |
| Resend alerting (spec "existing helper", plan creates new) | 5 |
| Rate limiting (token bucket) | 6 |
| Dependencies (`node-cron`, `p-limit`) | 7 |
| Query Basket Seeding (lazy) | 8, 9 |
| Phrasing Variants | 8 |
| Polling Loop (budget gate, concurrency, error isolation) | 10 |
| Read API (summary + losses) | 11 |
| Basket CRUD API (GET, POST, DELETE) | 12 |
| Cron scheduling + router wiring | 13 |
| Env + followups docs | 14 |
| Verification (the spec's manual checklist) | 15 |

No spec requirement is orphaned.

**Type consistency check:**
- `generateAutoQueries(profile: ProfileForSeeding)` defined in Task 8, reused in Task 9.
- `phrasingVariants(q: string): string[]` defined in Task 8, reused in Task 10.
- `seedBasketIfEmpty(slug: string): void` defined in Task 9, called in Task 10's `pollAll`.
- `canonicalDomain` / `isCitationOfTenant` signatures defined in Task 3, used consistently in Tasks 10 and 11.
- `perplexitySearch(q: string): Promise<{citations: string[], costUsd: number}>` defined in Task 4, called in Task 10.
- `TokenBucket({intervalMs}).acquire()` defined in Task 6, used in Task 10.
- `sendBudgetAlert(subject, body)` defined in Task 5, called in Task 10.
- `pollAll(): Promise<void>` defined in Task 10, scheduled in Task 13.
- `competitorRadarRouter` created in Task 11, extended in Task 12, mounted in Task 13.

All names consistent across tasks.

**Placeholder check:** no TBD / TODO / "similar to Task N" patterns.
