# Session 11 — Per-Agent Reputation + Metering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop. Track which agents drive which outcomes (clicks, reservations, confirmations, handoffs) and feed that signal back into rate limits via per-agent trust tiers.

**Architecture:** Wrap every MCP tool handler in a logger that writes one `agent_requests` row per call. Backfill `outcome_signal` async when `/a2a/confirm`, handoff completion, or `click_events` fire. A 15-min rollup job aggregates `agent_requests` into a per-(agent_id, window) `agent_reputation` table. Rate-limit middleware reads `agent_reputation` to assign `unverified` / `known` / `trusted` tier per request.

**Tech Stack:** Same — Node + Express, better-sqlite3, vitest. No new dependencies.

**v1 explicit non-goals (per master plan):**
- No prompt mutation based on reputation (abuse vector: agent climbs reputation by spam-confirming reservations)
- No `search_businesses` re-ranking by reputation (same)
- No OAuth — header > tool arg ranking from Session 10 stays
- Feedback loop is **rate-limit tiers only**

---

## File Structure

**New files:**
- `server/src/db/migrations/010_agent_requests.sql`
- `server/src/db/migrations/011_agent_reputation.sql`
- `server/src/db/migrations/012_click_events_agent.sql`
- `server/src/repos/agentRequests.ts` — insert + query helpers
- `server/src/repos/agentReputation.ts` — read + upsert helpers
- `server/src/lib/agentTier.ts` — trust-tier resolver (`unverified` | `known` | `trusted`)
- `server/src/lib/agentRequestLogger.ts` — `withAgentRequestLog(toolName, req, handler)` higher-order wrapper
- `server/src/jobs/reputationRollup.ts` — sync recompute function + boot-time `setInterval` schedule
- `server/src/routes/admin/agents.ts` — `GET /admin/agents` reputation read endpoint
- `server/src/routes/admin/index.ts` — admin sub-router
- All paired `*.test.ts` files

**Modified files:**
- `server/src/middleware/rateLimit.ts` — add tier resolver + per-tier ceilings
- `server/src/manifest/schema.ts` — extend `rate_limits` to allow tiered shape
- `server/src/manifest/descriptor.ts` — emit tiered rate_limits
- `server/src/routes/mcp.ts` — wrap `query_business_agent` + `search_businesses` handlers in logger
- `server/src/mcp/tools/{getAvailability,getQuote,reserveSlot,initiateHandoff}.ts` — same
- `server/src/routes/a2a.ts` — backfill `outcome_signal = 'reservation_confirmed'` on confirm
- `server/src/routes/analytics.ts` — accept + persist `agent_id` + `request_id` on `/analytics/:slug/referral-click`
- `server/src/index.ts` — mount admin sub-router; start rollup interval

**Renames / deletions:** None.

---

## Task 1: Migration 010 — `agent_requests` table

**Files:**
- Create: `server/src/db/migrations/010_agent_requests.sql`
- Test: `server/src/db/migrations/010_agent_requests.test.ts`

**Schema rationale:** One row per MCP tool invocation. `outcome_signal` starts at `'none'` and is mutated async by callbacks (reserve, confirm, handoff, click). `agent_id_source` records *how* we know the identity (`oauth` reserved for future, `header` from `x-agent-identity`, `tool_arg` from arg, `inferred` if we synthesized — Session 11 doesn't infer but column is reserved). `related_id` is the join key for outcome backfill (reservation_id, handoff_id).

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/db/migrations/010_agent_requests.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./../migrations.js";

describe("migration 010_agent_requests", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
  afterEach(() => db.close());

  it("creates agent_requests table with required columns", () => {
    const cols = db.prepare("PRAGMA table_info(agent_requests)").all() as { name: string }[];
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "agent_id", "agent_id_source", "business_slug", "cost_cents",
      "id", "latency_ms", "outcome_signal", "outcome_ts",
      "related_id", "request_id", "timestamp", "tool_called",
    ]);
  });

  it("agent_id is NOT NULL; outcome_signal defaults to 'none'", () => {
    db.prepare(
      `INSERT INTO agent_requests
       (id, agent_id, agent_id_source, business_slug, tool_called, request_id, latency_ms, cost_cents)
       VALUES ('r1', 'cursor', 'header', 'acme', 'query_business_agent', 'req-1', 42, 0)`
    ).run();
    const row = db.prepare("SELECT outcome_signal FROM agent_requests WHERE id='r1'").get() as { outcome_signal: string };
    expect(row.outcome_signal).toBe("none");
  });

  it("rejects insert when agent_id is NULL", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO agent_requests
         (id, agent_id_source, business_slug, tool_called, request_id, latency_ms, cost_cents)
         VALUES ('r2', 'header', 'acme', 'query_business_agent', 'req-2', 42, 0)`
      ).run()
    ).toThrow(/NOT NULL constraint failed: agent_requests.agent_id/);
  });

  it("registers in schema_migrations", () => {
    const row = db.prepare("SELECT filename FROM schema_migrations WHERE filename = '010_agent_requests.sql'").get();
    expect(row).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd server && npx vitest run src/db/migrations/010_agent_requests.test.ts`
Expected: FAIL — `no such table: agent_requests`.

- [ ] **Step 3: Write the migration**

```sql
-- server/src/db/migrations/010_agent_requests.sql
CREATE TABLE IF NOT EXISTS agent_requests (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  agent_id_source TEXT NOT NULL CHECK (agent_id_source IN ('oauth', 'header', 'tool_arg', 'inferred')),
  business_slug   TEXT,
  tool_called     TEXT NOT NULL,
  request_id      TEXT,
  timestamp       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  latency_ms      INTEGER NOT NULL,
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  outcome_signal  TEXT NOT NULL DEFAULT 'none' CHECK (outcome_signal IN ('none', 'click', 'reservation_held', 'reservation_confirmed', 'handoff_completed', 'error')),
  outcome_ts      TEXT,
  related_id      TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_requests_agent_ts ON agent_requests(agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_agent_requests_request_id ON agent_requests(request_id);
CREATE INDEX IF NOT EXISTS idx_agent_requests_related_id ON agent_requests(related_id);
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run src/db/migrations/010_agent_requests.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add server/src/db/migrations/010_agent_requests.sql server/src/db/migrations/010_agent_requests.test.ts
git commit -m "feat(db): migration 010 — agent_requests audit table

One row per MCP tool invocation. outcome_signal defaults to 'none' and is
mutated async by /a2a/confirm, handoff completion, and click_events.
related_id is the join key for outcome backfill (reservation_id|handoff_id).

Indexes on (agent_id, timestamp) for the rollup query, request_id for
correlation lookups, and related_id for outcome backfill."
```

---

## Task 2: Migration 011 — `agent_reputation` rollup table

**Files:**
- Create: `server/src/db/migrations/011_agent_reputation.sql`
- Test: `server/src/db/migrations/011_agent_reputation.test.ts`

**Schema rationale:** Pre-computed window aggregates. PK is `(agent_id, window)` so rollup runs upsert-in-place. Stored windows: `'7d'` and `'30d'` only; finer granularity adds query cost without insight at our v1 traffic volume.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/db/migrations/011_agent_reputation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./../migrations.js";

describe("migration 011_agent_reputation", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
  afterEach(() => db.close());

  it("creates agent_reputation with composite PK on (agent_id, window)", () => {
    const cols = db.prepare("PRAGMA table_info(agent_reputation)").all() as { name: string; pk: number }[];
    const pkNames = cols.filter(c => c.pk > 0).map(c => c.name).sort();
    expect(pkNames).toEqual(["agent_id", "window"]);
  });

  it("requires window in ('7d','30d')", () => {
    expect(() =>
      db.prepare(
        "INSERT INTO agent_reputation (agent_id, window, requests, reservations_confirmed, conversion_rate, avg_cost_cents, quality_score) VALUES ('a','1h',1,0,0,0,0)"
      ).run()
    ).toThrow(/CHECK constraint/);
  });

  it("upsert on conflict replaces the row", () => {
    const ins = (n: number) => db.prepare(
      "INSERT INTO agent_reputation (agent_id, window, requests, reservations_confirmed, conversion_rate, avg_cost_cents, quality_score, updated_at) VALUES ('a','7d', ?, 0, 0, 0, 0, CURRENT_TIMESTAMP) ON CONFLICT(agent_id, window) DO UPDATE SET requests = excluded.requests"
    ).run(n);
    ins(5); ins(10);
    const r = db.prepare("SELECT requests FROM agent_reputation WHERE agent_id='a' AND window='7d'").get() as { requests: number };
    expect(r.requests).toBe(10);
  });
});
```

- [ ] **Step 2: Run failing test**

Expected: FAIL — `no such table`.

- [ ] **Step 3: Write the migration**

```sql
-- server/src/db/migrations/011_agent_reputation.sql
CREATE TABLE IF NOT EXISTS agent_reputation (
  agent_id               TEXT NOT NULL,
  window                 TEXT NOT NULL CHECK (window IN ('7d', '30d')),
  requests               INTEGER NOT NULL DEFAULT 0,
  reservations_confirmed INTEGER NOT NULL DEFAULT 0,
  conversion_rate        REAL    NOT NULL DEFAULT 0,
  avg_cost_cents         REAL    NOT NULL DEFAULT 0,
  quality_score          REAL    NOT NULL DEFAULT 0,
  updated_at             TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_id, window)
);

CREATE INDEX IF NOT EXISTS idx_agent_reputation_quality ON agent_reputation(quality_score DESC);
```

- [ ] **Step 4: Run test, confirm pass; commit**

```bash
git add server/src/db/migrations/011_agent_reputation.sql server/src/db/migrations/011_agent_reputation.test.ts
git commit -m "feat(db): migration 011 — agent_reputation rollup table

Composite PK (agent_id, window) supports upsert-in-place from the rollup
job. quality_score index lets the rate-limit middleware resolve a tier
in one indexed lookup."
```

---

## Task 3: Migration 012 — `click_events.agent_id` + `request_id`

**Files:**
- Create: `server/src/db/migrations/012_click_events_agent.sql`
- Test: `server/src/db/migrations/012_click_events_agent.test.ts`

**Why:** click_events is the crawl-path outcome signal. To attribute clicks to agents, we need agent_id on the click row. request_id lets us join click → originating MCP request when the agent calls a tool that returned a tracked URL.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/db/migrations/012_click_events_agent.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./../migrations.js";

describe("migration 012_click_events_agent", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
  afterEach(() => db.close());

  it("adds agent_id and request_id columns to click_events (TEXT NULL)", () => {
    const cols = db.prepare("PRAGMA table_info(click_events)").all() as { name: string; notnull: number }[];
    const agent = cols.find(c => c.name === "agent_id");
    const req = cols.find(c => c.name === "request_id");
    expect(agent).toBeDefined();
    expect(req).toBeDefined();
    expect(agent!.notnull).toBe(0); // back-compat: pre-Session-11 rows have NULL
    expect(req!.notnull).toBe(0);
  });

  it("creates index on (agent_id, timestamp)", () => {
    const idx = db.prepare("PRAGMA index_list(click_events)").all() as { name: string }[];
    expect(idx.map(i => i.name)).toContain("idx_click_events_agent_ts");
  });
});
```

- [ ] **Step 2: Run failing test**

Expected: FAIL — column doesn't exist.

- [ ] **Step 3: Write the migration**

```sql
-- server/src/db/migrations/012_click_events_agent.sql
ALTER TABLE click_events ADD COLUMN agent_id   TEXT;
ALTER TABLE click_events ADD COLUMN request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_click_events_agent_ts ON click_events(agent_id, timestamp);
```

- [ ] **Step 4: Run test, confirm pass; commit**

```bash
git add server/src/db/migrations/012_click_events_agent.sql server/src/db/migrations/012_click_events_agent.test.ts
git commit -m "feat(db): migration 012 — click_events.agent_id + request_id

Both nullable for back-compat. Pre-Session-11 click rows stay NULL.
Index on (agent_id, timestamp) supports the reputation rollup join."
```

---

## Task 4: `agentRequests` repo

**Files:**
- Create: `server/src/repos/agentRequests.ts`
- Test: `server/src/repos/agentRequests.test.ts`

**Why a repo and not inline SQL:** The logger writes from MCP handlers, the backfill writes from `/a2a/confirm` and `/analytics/.../referral-click`, and the rollup reads. Three call sites = single source of truth helper.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/repos/agentRequests.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import {
  insertAgentRequest,
  setOutcome,
  findByRelatedId,
  type AgentIdSource,
  type OutcomeSignal,
} from "./agentRequests.js";

describe("agentRequests repo", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
  afterEach(() => db.close());

  it("insertAgentRequest writes a row with defaults", () => {
    const id = insertAgentRequest(db, {
      agentId: "cursor",
      agentIdSource: "header",
      businessSlug: "acme",
      toolCalled: "query_business_agent",
      requestId: "req-1",
      latencyMs: 42,
      costCents: 1,
    });
    expect(id).toMatch(/^ar_/); // ULID-ish prefixed
    const row = db.prepare("SELECT * FROM agent_requests WHERE id = ?").get(id) as { outcome_signal: string };
    expect(row.outcome_signal).toBe("none");
  });

  it("setOutcome updates outcome_signal and outcome_ts", () => {
    const id = insertAgentRequest(db, {
      agentId: "x", agentIdSource: "tool_arg", toolCalled: "reserve_slot",
      requestId: "r2", latencyMs: 1, costCents: 0, relatedId: "res_abc",
    });
    const ok = setOutcome(db, { id, outcomeSignal: "reservation_held" });
    expect(ok).toBe(true);
    const row = db.prepare("SELECT outcome_signal, outcome_ts FROM agent_requests WHERE id=?").get(id) as { outcome_signal: string; outcome_ts: string };
    expect(row.outcome_signal).toBe("reservation_held");
    expect(row.outcome_ts).not.toBeNull();
  });

  it("findByRelatedId returns the most recent matching row", () => {
    insertAgentRequest(db, {
      agentId: "x", agentIdSource: "header", toolCalled: "reserve_slot",
      requestId: "r3", latencyMs: 1, costCents: 0, relatedId: "res_xyz",
    });
    const found = findByRelatedId(db, "res_xyz");
    expect(found?.related_id).toBe("res_xyz");
  });
});
```

- [ ] **Step 2: Run failing test**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the repo**

```typescript
// server/src/repos/agentRequests.ts
import type Database from "better-sqlite3";
import { generateUlid } from "../lib/requestId.js";

export type AgentIdSource = "oauth" | "header" | "tool_arg" | "inferred";
export type OutcomeSignal =
  | "none"
  | "click"
  | "reservation_held"
  | "reservation_confirmed"
  | "handoff_completed"
  | "error";

export interface AgentRequestInsert {
  agentId: string;
  agentIdSource: AgentIdSource;
  businessSlug?: string | null;
  toolCalled: string;
  requestId?: string | null;
  latencyMs: number;
  costCents: number;
  relatedId?: string | null;
  outcomeSignal?: OutcomeSignal;
}

export interface AgentRequestRow {
  id: string;
  agent_id: string;
  agent_id_source: AgentIdSource;
  business_slug: string | null;
  tool_called: string;
  request_id: string | null;
  timestamp: string;
  latency_ms: number;
  cost_cents: number;
  outcome_signal: OutcomeSignal;
  outcome_ts: string | null;
  related_id: string | null;
}

export function insertAgentRequest(
  db: Database.Database,
  r: AgentRequestInsert,
): string {
  const id = `ar_${generateUlid()}`;
  db.prepare(
    `INSERT INTO agent_requests
     (id, agent_id, agent_id_source, business_slug, tool_called, request_id,
      latency_ms, cost_cents, outcome_signal, related_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    r.agentId,
    r.agentIdSource,
    r.businessSlug ?? null,
    r.toolCalled,
    r.requestId ?? null,
    r.latencyMs,
    r.costCents,
    r.outcomeSignal ?? "none",
    r.relatedId ?? null,
  );
  return id;
}

export function setOutcome(
  db: Database.Database,
  args: { id: string; outcomeSignal: OutcomeSignal },
): boolean {
  const result = db.prepare(
    `UPDATE agent_requests
        SET outcome_signal = ?, outcome_ts = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).run(args.outcomeSignal, args.id);
  return result.changes > 0;
}

export function findByRelatedId(
  db: Database.Database,
  relatedId: string,
): AgentRequestRow | undefined {
  return db.prepare(
    `SELECT * FROM agent_requests WHERE related_id = ? ORDER BY timestamp DESC LIMIT 1`,
  ).get(relatedId) as AgentRequestRow | undefined;
}

export function findByRequestId(
  db: Database.Database,
  requestId: string,
): AgentRequestRow | undefined {
  return db.prepare(
    `SELECT * FROM agent_requests WHERE request_id = ? ORDER BY timestamp DESC LIMIT 1`,
  ).get(requestId) as AgentRequestRow | undefined;
}
```

**Note on ULID generation:** This project does NOT use the `ulidx` npm package. Session 0 ships an in-house `generateUlid()` in `server/src/lib/requestId.ts` (Crockford base32, 26 chars, 48-bit time + 80-bit random). Reuse it — adding `ulidx` would be an unnecessary dep.

- [ ] **Step 4: Run test, confirm 3/3 pass; commit**

```bash
git add server/src/repos/agentRequests.ts server/src/repos/agentRequests.test.ts
git commit -m "feat(repos): agentRequests insert/setOutcome/findBy* helpers

Single source of truth for the audit log. Used by the MCP logger wrapper
(insert), /a2a/confirm + handoff completion + click_events writes
(setOutcome), and the rollup job (read)."
```

---

## Task 5: `agentRequestLogger` wrapper

**Files:**
- Create: `server/src/lib/agentRequestLogger.ts`
- Test: `server/src/lib/agentRequestLogger.test.ts`

**Design:** Higher-order function that takes a tool name + request context + the original handler, runs the handler, measures latency, classifies outcome (`error` if it threw, `none` otherwise — backfilled to richer signals async), and writes one row.

`request_id` and `agent_id` resolution rules (mirror Session 10):
- `request_id` from `res.locals.requestId` (set by `requestIdMiddleware`)
- `agent_id` resolved by Session 10's `resolveAgentId(req, toolArg)` — header > tool arg
- `agent_id_source`: `'header'` if `x-agent-identity` set, `'tool_arg'` if only the arg, else **skip the row entirely** (no agent identity = no audit row, since the whole point is per-agent reputation; logging anonymous calls would pollute the rollup)

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/lib/agentRequestLogger.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { withAgentRequestLog } from "./agentRequestLogger.js";

function fakeReq(headers: Record<string, string> = {}) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as import("express").Request;
}

describe("withAgentRequestLog", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
  });
  afterEach(() => { _setDbForTesting(null); db.close(); });

  it("writes one row when agent_id resolves from header", async () => {
    const req = fakeReq({ "x-agent-identity": "cursor" });
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await withAgentRequestLog(
      { toolName: "query_business_agent", req, requestId: "rid-1", toolArgAgentId: undefined, businessSlug: "acme" },
      handler,
    );
    const rows = db.prepare("SELECT agent_id, agent_id_source, tool_called, business_slug, request_id, outcome_signal FROM agent_requests").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: "cursor",
      agent_id_source: "header",
      tool_called: "query_business_agent",
      business_slug: "acme",
      request_id: "rid-1",
      outcome_signal: "none",
    });
  });

  it("writes a row with agent_id_source='tool_arg' when only arg is set", async () => {
    const req = fakeReq();
    await withAgentRequestLog(
      { toolName: "search_businesses", req, requestId: "rid-2", toolArgAgentId: "claude-desktop" },
      async () => ({ x: 1 }),
    );
    const row = db.prepare("SELECT agent_id_source FROM agent_requests").get() as { agent_id_source: string };
    expect(row.agent_id_source).toBe("tool_arg");
  });

  it("skips logging when no agent_id is available (anonymous)", async () => {
    const req = fakeReq();
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const result = await withAgentRequestLog(
      { toolName: "search_businesses", req, requestId: "rid-3", toolArgAgentId: undefined },
      handler,
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true });
    const rows = db.prepare("SELECT id FROM agent_requests").all();
    expect(rows).toHaveLength(0);
  });

  it("records outcome_signal='error' and re-throws when handler throws", async () => {
    const req = fakeReq({ "x-agent-identity": "cursor" });
    await expect(
      withAgentRequestLog(
        { toolName: "get_quote", req, requestId: "rid-4", toolArgAgentId: undefined },
        async () => { throw new Error("boom"); },
      ),
    ).rejects.toThrow("boom");
    const row = db.prepare("SELECT outcome_signal FROM agent_requests").get() as { outcome_signal: string };
    expect(row.outcome_signal).toBe("error");
  });

  it("returns the inserted id so caller can later setOutcome", async () => {
    const req = fakeReq({ "x-agent-identity": "x" });
    let captured: string | null = null;
    await withAgentRequestLog(
      {
        toolName: "reserve_slot",
        req,
        requestId: "rid-5",
        toolArgAgentId: undefined,
        onLogged: (id) => { captured = id; },
      },
      async () => ({ reservation_id: "res_z" }),
    );
    expect(captured).toMatch(/^ar_/);
  });
});
```

- [ ] **Step 2: Run failing test**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the wrapper**

```typescript
// server/src/lib/agentRequestLogger.ts
import type { Request } from "express";
import { resolveAgentId, AGENT_IDENTITY_HEADER } from "./agentIdentity.js";
import { getDb } from "../db.js";
import {
  insertAgentRequest,
  setOutcome,
  type AgentIdSource,
  type OutcomeSignal,
} from "../repos/agentRequests.js";

export interface LogContext {
  toolName: string;
  req: Request;
  requestId?: string | null;
  toolArgAgentId?: string | null;
  businessSlug?: string | null;
  /** Optional callback invoked with the inserted row id, so callers can
   *  later setOutcome(id, ...) once async outcome data lands (e.g. the
   *  reservation_id returned by reserve_slot). Not invoked when skipped. */
  onLogged?: (id: string) => void;
}

/**
 * Wrap an MCP tool handler. On success: writes one agent_requests row with
 * outcome_signal='none' and latency_ms measured. On throw: writes outcome
 * 'error' and re-throws. Skips writing entirely when no agent identity is
 * available — anonymous calls would pollute the per-agent rollup.
 */
export async function withAgentRequestLog<T>(
  ctx: LogContext,
  handler: () => Promise<T>,
): Promise<T> {
  const headerAgent = ctx.req.header(AGENT_IDENTITY_HEADER)?.trim();
  const argAgent = ctx.toolArgAgentId?.trim();
  const agentId = resolveAgentId(ctx.req, ctx.toolArgAgentId ?? undefined);

  // No identity = no audit row (master plan: agent_id_source='inferred'
  // reserved for future, never set today).
  if (!agentId) return handler();

  const source: AgentIdSource = headerAgent ? "header" : argAgent ? "tool_arg" : "header";
  const db = getDb();
  const start = Date.now();

  let id: string | null = null;
  let outcome: OutcomeSignal = "none";
  try {
    const result = await handler();
    id = insertAgentRequest(db, {
      agentId,
      agentIdSource: source,
      businessSlug: ctx.businessSlug ?? null,
      toolCalled: ctx.toolName,
      requestId: ctx.requestId ?? null,
      latencyMs: Date.now() - start,
      costCents: 0, // v1: cost stamping deferred — manifest static estimate is the proxy
      outcomeSignal: "none",
    });
    if (id && ctx.onLogged) ctx.onLogged(id);
    return result;
  } catch (err) {
    outcome = "error";
    id = insertAgentRequest(db, {
      agentId,
      agentIdSource: source,
      businessSlug: ctx.businessSlug ?? null,
      toolCalled: ctx.toolName,
      requestId: ctx.requestId ?? null,
      latencyMs: Date.now() - start,
      costCents: 0,
      outcomeSignal: outcome,
    });
    if (id && ctx.onLogged) ctx.onLogged(id);
    throw err;
  }
}
```

- [ ] **Step 4: Run test, confirm 5/5 pass; commit**

```bash
git add server/src/lib/agentRequestLogger.ts server/src/lib/agentRequestLogger.test.ts
git commit -m "feat(lib): agentRequestLogger HOF + tests

Wraps an MCP tool handler. On success: latency_ms measured + 'none'
written. On throw: 'error' written + rethrows. Skips when no agent
identity (header > tool arg) — anonymous calls don't pollute the rollup.
onLogged callback gives caller the row id so they can setOutcome later
(e.g. reserve_slot stamping reservation_held + related_id)."
```

---

## Task 6: Wire logger into MCP tool handlers

**Files:**
- Modify: `server/src/routes/mcp.ts` (wraps `query_business_agent` and `search_businesses`)
- Modify: `server/src/mcp/tools/getAvailability.ts`
- Modify: `server/src/mcp/tools/getQuote.ts`
- Modify: `server/src/mcp/tools/reserveSlot.ts` (also stamps `relatedId` + `reservation_held` outcome)
- Modify: `server/src/mcp/tools/initiateHandoff.ts`
- Test: `server/src/routes/mcp.agentRequests.test.ts`

**Why one task for all six tools:** The wiring pattern is identical at each call site. Splitting per-tool would make 6 trivial diffs that all do the same thing.

**Wiring pattern (apply to each tool registration):**

```typescript
// Before:
server.tool("foo", "...", schema.shape, async (args) => {
  /* handler body */
  return { content: [...] };
});

// After:
server.tool("foo", "...", schema.shape, async (args, _extra) => {
  return withAgentRequestLog(
    {
      toolName: "foo",
      req: req!,                      // captured from createMcpServer(req?)
      requestId,                       // captured from createMcpServer(requestId?)
      toolArgAgentId: args.agent_id,   // when the tool's schema includes it
      businessSlug: args.slug,         // when the tool's schema includes it
    },
    async () => {
      /* original handler body */
      return { content: [...] };
    },
  );
});
```

For `reserveSlot` specifically: capture the inserted log row id via `onLogged`, then after the reservation is created, call `setOutcome(db, { id, outcomeSignal: "reservation_held" })` and update the row's `related_id` to `reservation_id`.

- [ ] **Step 1: Write the failing integration test**

```typescript
// server/src/routes/mcp.agentRequests.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { mcpRouter } from "./mcp.js";
import { requestIdMiddleware } from "../lib/requestId.js";

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "stub" }] }) };
  },
}));

function makeApp(db: Database.Database) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(mcpRouter);
  _setDbForTesting(db);
  return app;
}

function callTool(app: express.Express, name: string, args: object, headers: Record<string, string> = {}) {
  let req = request(app).post("/mcp")
    .set("Content-Type", "application/json")
    .set("Accept", "application/json, text/event-stream");
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

describe("MCP tool calls write agent_requests rows", () => {
  let db: Database.Database;
  let app: express.Express;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      `INSERT INTO businesses (slug, name, description, services, tone, api_key, website)
       VALUES ('acme', 'Acme', 'd', '["x"]', 'friendly', 'k', 'https://acme.example')`
    ).run();
    app = makeApp(db);
  });
  afterEach(() => { _setDbForTesting(null); db.close(); });

  it("query_business_agent with x-agent-identity writes one row", async () => {
    await callTool(app, "query_business_agent", { slug: "acme", query: "hi" }, { "x-agent-identity": "cursor" });
    const rows = db.prepare("SELECT tool_called, agent_id, agent_id_source, business_slug FROM agent_requests").all();
    expect(rows).toEqual([
      { tool_called: "query_business_agent", agent_id: "cursor", agent_id_source: "header", business_slug: "acme" },
    ]);
  });

  it("search_businesses without identity writes nothing (anonymous)", async () => {
    await callTool(app, "search_businesses", { search: "acme" });
    expect(db.prepare("SELECT COUNT(*) c FROM agent_requests").get()).toEqual({ c: 0 });
  });
});
```

- [ ] **Step 2: Run failing test**

Expected: FAIL — `agent_requests` empty (handlers not wrapped yet).

- [ ] **Step 3: Wire each handler**

Walk through each file and wrap. For `routes/mcp.ts`:
- Import `withAgentRequestLog` from `../lib/agentRequestLogger.js`
- Both `query_business_agent` and `search_businesses` handlers wrap their body in `withAgentRequestLog({...}, async () => {...})`

For `mcp/tools/{getAvailability,getQuote,initiateHandoff}.ts`: their `register*(server, req?, requestId?)` signature needs extending so the closure has access to req + requestId. Currently they're registered as bare `register*(server)` — they need access to per-request context. Solution: thread `req` + `requestId` from `createMcpServer(requestId?, req?)` (already added in Session 10) down through each `register*` call.

```typescript
// Updated register signatures
export function registerGetAvailability(server: McpServer, req?: Request, requestId?: string) { ... }
// And in mcp.ts:
registerGetAvailability(server, req, requestId);
```

For `reserveSlot.ts` specifically — after the reservation is created, capture the log id via `onLogged`, then run `setOutcome(db, { id, outcomeSignal: "reservation_held" })` and one extra UPDATE to set `related_id = reservation_id`.

- [ ] **Step 4: Run integration test, confirm pass; commit**

```bash
git add server/src/routes/mcp.ts server/src/mcp/tools/getAvailability.ts server/src/mcp/tools/getQuote.ts server/src/mcp/tools/reserveSlot.ts server/src/mcp/tools/initiateHandoff.ts server/src/routes/mcp.agentRequests.test.ts
git commit -m "feat(mcp): wrap all 6 tools in agentRequestLogger

Every MCP tool call with a resolved agent_id writes one agent_requests
row with latency_ms and outcome_signal='none' (or 'error'). reserve_slot
additionally stamps reservation_held + related_id=reservation_id so
/a2a/confirm can backfill 'reservation_confirmed' on the right row.

register*() signatures extended to take (req?, requestId?) so the closure
has per-request context — threaded from createMcpServer(requestId?, req?)
which was added in Session 10."
```

---

## Task 7: Outcome backfill — `/a2a/confirm` + handoff completion

**Files:**
- Modify: `server/src/routes/a2a.ts`
- Test: `server/src/routes/a2a.outcomeBackfill.test.ts`

**Why:** When a reservation flips `held → confirmed`, find the originating `agent_requests` row by `related_id = reservation_id` and set `outcome_signal = 'reservation_confirmed'`. Same for handoff: when `/a2a/continue/:token` is consumed, set `'handoff_completed'`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/routes/a2a.outcomeBackfill.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { a2aRouter } from "./a2a.js";
import { insertAgentRequest } from "../repos/agentRequests.js";
// (token signing helper to mint a confirmation token for an existing reservation)

describe("/a2a/confirm backfills agent_requests.outcome_signal", () => {
  let db: Database.Database;
  let app: express.Express;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
    app = express();
    app.use(express.json());
    app.use(a2aRouter);
  });
  afterEach(() => { _setDbForTesting(null); db.close(); });

  it("flips matching agent_requests row to reservation_confirmed", async () => {
    // 1. Insert a held reservation
    db.prepare(
      `INSERT INTO reservations (id, business_slug, agent_id, requested_at, window_start, window_end, status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
       VALUES ('res_zzz', 'acme', 'cursor', CURRENT_TIMESTAMP, 0, 0, 'held', 'tok_test', '{}', 'idem_1', '2099-01-01')`
    ).run();
    // 2. Insert the matching agent_requests row that reserve_slot would have written
    const arId = insertAgentRequest(db, {
      agentId: "cursor", agentIdSource: "header", toolCalled: "reserve_slot",
      requestId: "rid-9", latencyMs: 1, costCents: 0,
      relatedId: "res_zzz", outcomeSignal: "reservation_held",
    });
    // 3. POST /a2a/confirm with the token
    // [TEST IMPLEMENTATION: actual signing helper call goes here, mirroring
    //  whatever pattern existing a2a tests use. If a2a.test.ts exists, copy
    //  its setup. The test's purpose is to assert the row flips.]
    // ...
    const row = db.prepare("SELECT outcome_signal FROM agent_requests WHERE id = ?").get(arId) as { outcome_signal: string };
    expect(row.outcome_signal).toBe("reservation_confirmed");
  });
});
```

(Implementer: open the existing `a2a.test.ts` (if any) for the exact `/a2a/confirm` request shape and token signing helper. If no test file exists, mirror the pattern in `mcp.queryBusinessAgent.test.ts` for app wiring.)

- [ ] **Step 2: Run failing test**

Expected: FAIL — outcome_signal still "reservation_held".

- [ ] **Step 3: Wire the backfill**

In `routes/a2a.ts`, immediately after the reservation status flip succeeds:

```typescript
import { findByRelatedId, setOutcome } from "../repos/agentRequests.js";
// ...
// After successful UPDATE reservations SET status='confirmed':
const ar = findByRelatedId(db, reservationId);
if (ar) setOutcome(db, { id: ar.id, outcomeSignal: "reservation_confirmed" });
```

Same pattern in `/a2a/continue/:token` handler:

```typescript
const ar = findByRelatedId(db, handoffId);
if (ar) setOutcome(db, { id: ar.id, outcomeSignal: "handoff_completed" });
```

- [ ] **Step 4: Run test, confirm pass; commit**

```bash
git add server/src/routes/a2a.ts server/src/routes/a2a.outcomeBackfill.test.ts
git commit -m "feat(a2a): backfill agent_requests outcome_signal on confirm + handoff

When a reservation flips held → confirmed, find the originating
agent_requests row by related_id = reservation_id and stamp
'reservation_confirmed'. Same for handoff completion via
/a2a/continue/:token → 'handoff_completed'. Closes the loop the rollup
job aggregates over."
```

---

## Task 8: `click_events.agent_id` + `request_id` write path

**Files:**
- Modify: `server/src/routes/analytics.ts` (the `/analytics/:slug/referral-click` POST handler around line 236)
- Test: `server/src/routes/analytics.referralClick.test.ts`

**Why:** The redirect endpoint already verifies the signed token (in the worker). When the worker POSTs the beacon to central, it should pass `agent_id` (from the verified token's `aid` claim) and `request_id`. v1 accepts both as optional fields in the request body — back-compat for old worker versions.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/routes/analytics.referralClick.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { analyticsRouter } from "./analytics.js";

describe("POST /analytics/:slug/referral-click", () => {
  let db: Database.Database;
  let app: express.Express;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(`INSERT INTO businesses (slug, name, description, services, tone, api_key) VALUES ('acme','Acme','d','[]','friendly','k')`).run();
    _setDbForTesting(db);
    app = express();
    app.use(express.json());
    app.use(analyticsRouter);
  });
  afterEach(() => { _setDbForTesting(null); db.close(); });

  it("persists agent_id and request_id when supplied", async () => {
    await request(app).post("/analytics/acme/referral-click")
      .send({ destination: "https://x", ref: "ai", agent_id: "cursor", request_id: "rid-1" })
      .expect(200);
    const row = db.prepare("SELECT agent_id, request_id FROM click_events").get() as { agent_id: string | null; request_id: string | null };
    expect(row.agent_id).toBe("cursor");
    expect(row.request_id).toBe("rid-1");
  });

  it("persists null agent_id and request_id for back-compat callers", async () => {
    await request(app).post("/analytics/acme/referral-click")
      .send({ destination: "https://x", ref: "ai" })
      .expect(200);
    const row = db.prepare("SELECT agent_id, request_id FROM click_events").get() as { agent_id: string | null; request_id: string | null };
    expect(row.agent_id).toBeNull();
    expect(row.request_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing test**

Expected: FAIL — INSERT statement doesn't list the new columns.

- [ ] **Step 3: Extend the route**

In `routes/analytics.ts`:
1. Extend the request body zod schema to accept optional `agent_id?: string` and `request_id?: string`
2. Extend the INSERT statement: add `agent_id, request_id` to the column list and `?, ?` to VALUES, pass `body.agent_id ?? null, body.request_id ?? null`

Also: optionally backfill `agent_requests.outcome_signal = 'click'` when `request_id` resolves to a known agent_requests row:

```typescript
import { findByRequestId, setOutcome } from "../repos/agentRequests.js";
// After click_events INSERT:
if (body.request_id) {
  const ar = findByRequestId(db, body.request_id);
  if (ar) setOutcome(db, { id: ar.id, outcomeSignal: "click" });
}
```

- [ ] **Step 4: Run test, confirm pass; commit**

```bash
git add server/src/routes/analytics.ts server/src/routes/analytics.referralClick.test.ts
git commit -m "feat(analytics): persist agent_id + request_id on referral-click

Back-compat: both fields optional in the request body. Old worker
versions continue to write NULL. When request_id resolves to a known
agent_requests row, also stamps that row's outcome_signal='click' so
the rollup picks up clicks-without-reservations."
```

---

## Task 9: `agentReputation` repo + `reputationRollup` job

**Files:**
- Create: `server/src/repos/agentReputation.ts`
- Create: `server/src/jobs/reputationRollup.ts`
- Test: `server/src/jobs/reputationRollup.test.ts`

**Algorithm (per agent, per window):**
- `requests` = COUNT(*) FROM agent_requests WHERE agent_id=? AND timestamp > now - window
- `reservations_confirmed` = COUNT(*) WHERE outcome_signal='reservation_confirmed' AND ...
- `conversion_rate` = `reservations_confirmed / requests` (clamped 0..1)
- `avg_cost_cents` = AVG(cost_cents)
- `quality_score` (v1 simple): `min(1.0, conversion_rate * 5)` — 20% conversion = score 1.0; 0% = 0. Future versions add latency, error rate, recency decay.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/jobs/reputationRollup.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { insertAgentRequest, setOutcome } from "../repos/agentRequests.js";
import { runReputationRollup } from "./reputationRollup.js";

function seed(db: Database.Database, agent: string, total: number, confirmed: number) {
  for (let i = 0; i < total; i++) {
    const id = insertAgentRequest(db, {
      agentId: agent, agentIdSource: "header", toolCalled: "reserve_slot",
      requestId: `r-${agent}-${i}`, latencyMs: 50, costCents: 0,
    });
    if (i < confirmed) setOutcome(db, { id, outcomeSignal: "reservation_confirmed" });
  }
}

describe("runReputationRollup", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
  afterEach(() => db.close());

  it("computes per-agent 7d row with conversion_rate and quality_score", () => {
    seed(db, "cursor", 10, 2); // 20% conversion → quality 1.0
    seed(db, "claude-desktop", 10, 0); // 0% conversion → quality 0
    runReputationRollup(db);
    const cursor = db.prepare("SELECT * FROM agent_reputation WHERE agent_id='cursor' AND window='7d'").get() as any;
    const claude = db.prepare("SELECT * FROM agent_reputation WHERE agent_id='claude-desktop' AND window='7d'").get() as any;
    expect(cursor.requests).toBe(10);
    expect(cursor.reservations_confirmed).toBe(2);
    expect(cursor.conversion_rate).toBeCloseTo(0.2, 5);
    expect(cursor.quality_score).toBeCloseTo(1.0, 5);
    expect(claude.quality_score).toBe(0);
  });

  it("upserts in place — running twice doesn't duplicate", () => {
    seed(db, "x", 5, 1);
    runReputationRollup(db);
    runReputationRollup(db);
    const rows = db.prepare("SELECT COUNT(*) c FROM agent_reputation WHERE agent_id='x'").get() as { c: number };
    expect(rows.c).toBe(2); // 7d + 30d, never duplicated
  });

  it("ignores agent_requests older than the window", () => {
    insertAgentRequest(db, {
      agentId: "old", agentIdSource: "header", toolCalled: "x",
      requestId: "r-old", latencyMs: 1, costCents: 0,
    });
    db.prepare("UPDATE agent_requests SET timestamp = '2020-01-01' WHERE agent_id='old'").run();
    runReputationRollup(db);
    const row = db.prepare("SELECT requests FROM agent_reputation WHERE agent_id='old' AND window='7d'").get() as { requests: number } | undefined;
    expect(row?.requests ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Run failing test**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement repo + job**

```typescript
// server/src/repos/agentReputation.ts
import type Database from "better-sqlite3";

export type ReputationWindow = "7d" | "30d";

export interface AgentReputationRow {
  agent_id: string;
  window: ReputationWindow;
  requests: number;
  reservations_confirmed: number;
  conversion_rate: number;
  avg_cost_cents: number;
  quality_score: number;
  updated_at: string;
}

export function getReputation(
  db: Database.Database,
  agentId: string,
  window: ReputationWindow = "7d",
): AgentReputationRow | undefined {
  return db.prepare(
    `SELECT * FROM agent_reputation WHERE agent_id = ? AND window = ?`,
  ).get(agentId, window) as AgentReputationRow | undefined;
}

export function listReputation(db: Database.Database): AgentReputationRow[] {
  return db.prepare(
    `SELECT * FROM agent_reputation ORDER BY quality_score DESC, agent_id ASC`,
  ).all() as AgentReputationRow[];
}

export function upsertReputation(
  db: Database.Database,
  r: Omit<AgentReputationRow, "updated_at">,
): void {
  db.prepare(
    `INSERT INTO agent_reputation
       (agent_id, window, requests, reservations_confirmed, conversion_rate, avg_cost_cents, quality_score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_id, window) DO UPDATE SET
       requests = excluded.requests,
       reservations_confirmed = excluded.reservations_confirmed,
       conversion_rate = excluded.conversion_rate,
       avg_cost_cents = excluded.avg_cost_cents,
       quality_score = excluded.quality_score,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    r.agent_id, r.window, r.requests, r.reservations_confirmed,
    r.conversion_rate, r.avg_cost_cents, r.quality_score,
  );
}
```

```typescript
// server/src/jobs/reputationRollup.ts
import type Database from "better-sqlite3";
import { upsertReputation, type ReputationWindow } from "../repos/agentReputation.js";

const WINDOW_DAYS: Record<ReputationWindow, number> = { "7d": 7, "30d": 30 };

interface AggregateRow {
  agent_id: string;
  requests: number;
  reservations_confirmed: number;
  avg_cost_cents: number;
}

/**
 * Recompute agent_reputation from agent_requests for both windows.
 * Idempotent — safe to run multiple times. Reads agent_requests, writes
 * agent_reputation. v1 quality_score: min(1.0, conversion_rate * 5).
 */
export function runReputationRollup(db: Database.Database): void {
  for (const window of ["7d", "30d"] as ReputationWindow[]) {
    const days = WINDOW_DAYS[window];
    const rows = db.prepare(
      `SELECT
         agent_id,
         COUNT(*) AS requests,
         SUM(CASE WHEN outcome_signal = 'reservation_confirmed' THEN 1 ELSE 0 END) AS reservations_confirmed,
         COALESCE(AVG(cost_cents), 0) AS avg_cost_cents
       FROM agent_requests
       WHERE timestamp > datetime('now', ?)
       GROUP BY agent_id`,
    ).all(`-${days} days`) as AggregateRow[];

    for (const row of rows) {
      const conversionRate = row.requests > 0 ? row.reservations_confirmed / row.requests : 0;
      const qualityScore = Math.min(1.0, conversionRate * 5);
      upsertReputation(db, {
        agent_id: row.agent_id,
        window,
        requests: row.requests,
        reservations_confirmed: row.reservations_confirmed,
        conversion_rate: conversionRate,
        avg_cost_cents: row.avg_cost_cents,
        quality_score: qualityScore,
      });
    }
  }
}

let _interval: NodeJS.Timeout | null = null;
export function startReputationRollupSchedule(db: Database.Database, intervalMs = 15 * 60 * 1000) {
  if (_interval) return;
  // Run once on boot so /admin/agents has data immediately.
  try { runReputationRollup(db); } catch (e) { console.error("[rollup] boot run failed", e); }
  _interval = setInterval(() => {
    try { runReputationRollup(db); } catch (e) { console.error("[rollup] tick failed", e); }
  }, intervalMs);
  _interval.unref(); // don't keep event loop alive in tests
}
export function stopReputationRollupSchedule() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}
```

- [ ] **Step 4: Run test, confirm 3/3 pass; commit**

```bash
git add server/src/repos/agentReputation.ts server/src/jobs/reputationRollup.ts server/src/jobs/reputationRollup.test.ts
git commit -m "feat(jobs): reputationRollup — agent_requests → agent_reputation

Pure aggregate query per (agent_id, window). v1 quality_score = min(1,
conversion_rate * 5) so 20% confirmed = 1.0. Idempotent upsert. Boot
runs the rollup once so /admin/agents has data without waiting for the
first 15-min tick."
```

---

## Task 10: `agentTier` resolver + rate-limit middleware integration

**Files:**
- Create: `server/src/lib/agentTier.ts`
- Test: `server/src/lib/agentTier.test.ts`
- Modify: `server/src/middleware/rateLimit.ts`
- Test: `server/src/middleware/rateLimit.tier.test.ts`

**Tier rules:**
- `unverified` — no `x-agent-identity` header, OR header set but no `agent_reputation` row exists
- `known` — has reputation row with `requests >= 10` AND `quality_score >= 0.1`
- `trusted` — has reputation row with `requests >= 100` AND `quality_score >= 0.5`

**Per-tier ceilings (per minute):**
- `unverified`: 100 (= existing `PER_IP_LIMIT_PER_MINUTE`)
- `known`: 250
- `trusted`: 1000

- [ ] **Step 1: Write failing test for the resolver**

```typescript
// server/src/lib/agentTier.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { upsertReputation } from "../repos/agentReputation.js";
import { resolveAgentTier, TIER_LIMITS } from "./agentTier.js";

describe("resolveAgentTier", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
  afterEach(() => db.close());

  it("returns 'unverified' when agentId is undefined", () => {
    expect(resolveAgentTier(db, undefined)).toBe("unverified");
  });
  it("returns 'unverified' when no reputation row exists", () => {
    expect(resolveAgentTier(db, "newcomer")).toBe("unverified");
  });
  it("returns 'known' for >=10 requests at quality >=0.1", () => {
    upsertReputation(db, { agent_id: "k", window: "7d", requests: 10, reservations_confirmed: 1, conversion_rate: 0.1, avg_cost_cents: 0, quality_score: 0.5 });
    expect(resolveAgentTier(db, "k")).toBe("known");
  });
  it("returns 'trusted' for >=100 requests at quality >=0.5", () => {
    upsertReputation(db, { agent_id: "t", window: "7d", requests: 100, reservations_confirmed: 50, conversion_rate: 0.5, avg_cost_cents: 0, quality_score: 1.0 });
    expect(resolveAgentTier(db, "t")).toBe("trusted");
  });
  it("TIER_LIMITS exposes per-minute ceilings", () => {
    expect(TIER_LIMITS.unverified).toBe(100);
    expect(TIER_LIMITS.known).toBe(250);
    expect(TIER_LIMITS.trusted).toBe(1000);
  });
});
```

- [ ] **Step 2: Run failing test, then implement**

```typescript
// server/src/lib/agentTier.ts
import type Database from "better-sqlite3";
import { getReputation } from "../repos/agentReputation.js";

export type AgentTier = "unverified" | "known" | "trusted";

export const TIER_LIMITS: Record<AgentTier, number> = {
  unverified: 100,
  known: 250,
  trusted: 1000,
};

export function resolveAgentTier(
  db: Database.Database,
  agentId: string | undefined | null,
): AgentTier {
  if (!agentId) return "unverified";
  const rep = getReputation(db, agentId, "7d");
  if (!rep) return "unverified";
  if (rep.requests >= 100 && rep.quality_score >= 0.5) return "trusted";
  if (rep.requests >= 10  && rep.quality_score >= 0.1) return "known";
  return "unverified";
}
```

- [ ] **Step 3: Confirm tier resolver passes, then write rate-limit integration test**

```typescript
// server/src/middleware/rateLimit.tier.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { upsertReputation } from "../repos/agentReputation.js";
import { rateLimitMiddleware, _resetRateLimitBuckets } from "./rateLimit.js";

function makeApp() {
  const app = express();
  app.use(rateLimitMiddleware);
  app.get("/x", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("rateLimitMiddleware tier-aware ceilings", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
    _resetRateLimitBuckets();
  });
  afterEach(() => { _setDbForTesting(null); db.close(); });

  it("allows 250 req/min for known tier (more than the default 100)", async () => {
    upsertReputation(db, { agent_id: "k", window: "7d", requests: 50, reservations_confirmed: 5, conversion_rate: 0.1, avg_cost_cents: 0, quality_score: 0.5 });
    const app = makeApp();
    // Send 150 requests as 'k' — past the 100 unverified ceiling but under known's 250
    for (let i = 0; i < 150; i++) {
      const r = await request(app).get("/x").set("x-agent-identity", "k");
      expect(r.status).toBe(200);
    }
  });

  it("returns 429 to unverified at the 101st request in a minute", async () => {
    const app = makeApp();
    let lastStatus = 0;
    for (let i = 0; i < 101; i++) {
      const r = await request(app).get("/x"); // no x-agent-identity
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(429);
  });
});
```

- [ ] **Step 4: Wire tier resolution into `rateLimit.ts`**

In `server/src/middleware/rateLimit.ts`:
1. Import `resolveAgentTier`, `TIER_LIMITS`, `getDb`, `AGENT_IDENTITY_HEADER`
2. Add helper `_resetRateLimitBuckets()` exported for tests
3. In `rateLimitMiddleware`: read `x-agent-identity` from req headers; resolve tier; pick the per-minute ceiling from `TIER_LIMITS[tier]`; key the bucket by `agentId ?? clientIp(req)` so per-agent buckets exist
4. Keep the existing IP bucket as a backstop for traffic without identity

(Implementer: read the existing 82-line file end-to-end; the change is contained — replace the per-IP-only sliding window with a per-(agentId|ip) one keyed on tier.)

- [ ] **Step 5: Run test, confirm pass; commit**

```bash
git add server/src/lib/agentTier.ts server/src/lib/agentTier.test.ts server/src/middleware/rateLimit.ts server/src/middleware/rateLimit.tier.test.ts
git commit -m "feat(middleware): tier-aware rate limit (unverified|known|trusted)

Resolves tier from agent_reputation.7d. Ceilings: 100/250/1000 per
minute. Unverified (no header OR no reputation row) keeps today's
behavior — back-compat. _resetRateLimitBuckets exposed for tests.

Reputation thresholds: known >=10 req @ quality>=0.1; trusted >=100 req
@ quality>=0.5. Both keyed off the 7d rollup so a single bad week pulls
the agent back to known/unverified."
```

---

## Task 11: Manifest schema + descriptor — tiered rate_limits

**Files:**
- Modify: `server/src/manifest/schema.ts`
- Modify: `server/src/manifest/descriptor.ts`
- Test: `server/src/manifest/descriptor.test.ts` (extend existing)

**Why:** External agent frameworks reading `/.well-known/mcp.json` should see the tiered ceilings so they can plan their request rate. Schema must be back-compat — a bare `{ per_agent_per_minute, per_ip_per_minute }` should still parse.

- [ ] **Step 1: Write the failing test additions**

```typescript
// In server/src/manifest/descriptor.test.ts add a new describe block:
describe("rate_limits — Session 11 tiered shape", () => {
  it("MANIFEST.rate_limits exposes tiered per-agent-per-minute ceilings", () => {
    expect(MANIFEST.rate_limits.tiers).toEqual({
      unverified: 100,
      known: 250,
      trusted: 1000,
    });
  });
  it("retains the flat per_agent_per_minute key for back-compat clients", () => {
    expect(typeof MANIFEST.rate_limits.per_agent_per_minute).toBe("number");
  });
});
```

- [ ] **Step 2: Run failing test**

Expected: FAIL — `tiers` undefined.

- [ ] **Step 3: Extend schema + descriptor**

```typescript
// server/src/manifest/schema.ts — extend RateLimits zod schema
const RateLimitsSchema = z.object({
  per_agent_per_minute: z.number(),
  per_ip_per_minute: z.number(),
  tiers: z.object({
    unverified: z.number(),
    known: z.number(),
    trusted: z.number(),
  }).optional(), // optional so older manifest snapshots still parse
});
```

```typescript
// server/src/manifest/descriptor.ts — in buildManifest():
import { TIER_LIMITS } from "../lib/agentTier.js";
// ...
rate_limits: {
  per_agent_per_minute: Math.floor(PER_API_KEY_LIMIT_PER_HOUR / 60),
  per_ip_per_minute: PER_IP_LIMIT_PER_MINUTE,
  tiers: TIER_LIMITS,
},
```

- [ ] **Step 4: Run full descriptor test, confirm pass; commit**

```bash
git add server/src/manifest/schema.ts server/src/manifest/descriptor.ts server/src/manifest/descriptor.test.ts
git commit -m "feat(manifest): expose tiered rate_limits.tiers in /.well-known/mcp.json

External agent frameworks reading the manifest now see per-tier ceilings
so they can plan their request rate. Flat per_agent_per_minute kept as
a mid-point estimate for back-compat clients that don't read the tier
shape."
```

---

## Task 12: `GET /admin/agents` + index wiring + boot rollup schedule

**Files:**
- Create: `server/src/routes/admin/agents.ts`
- Create: `server/src/routes/admin/index.ts`
- Test: `server/src/routes/admin/agents.test.ts`
- Modify: `server/src/index.ts`

**Auth pattern:** Bearer token from `ADMIN_API_KEY` env var. Reject 401 if missing/wrong. Internal-only — never advertised in the manifest.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/routes/admin/agents.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../db/migrations.js";
import { _setDbForTesting } from "../../db.js";
import { upsertReputation } from "../../repos/agentReputation.js";
import { adminRouter } from "./index.js";

describe("GET /admin/agents", () => {
  let db: Database.Database;
  let app: express.Express;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
    process.env.ADMIN_API_KEY = "test-admin";
    app = express();
    app.use(express.json());
    app.use(adminRouter);
  });
  afterEach(() => { _setDbForTesting(null); db.close(); delete process.env.ADMIN_API_KEY; });

  it("401s without bearer token", async () => {
    const r = await request(app).get("/admin/agents");
    expect(r.status).toBe(401);
  });
  it("401s with wrong bearer token", async () => {
    const r = await request(app).get("/admin/agents").set("Authorization", "Bearer wrong");
    expect(r.status).toBe(401);
  });
  it("returns the reputation rollup as JSON when authed", async () => {
    upsertReputation(db, { agent_id: "x", window: "7d", requests: 10, reservations_confirmed: 1, conversion_rate: 0.1, avg_cost_cents: 0, quality_score: 0.5 });
    const r = await request(app).get("/admin/agents").set("Authorization", "Bearer test-admin");
    expect(r.status).toBe(200);
    expect(r.body.agents).toEqual([
      expect.objectContaining({ agent_id: "x", window: "7d", requests: 10, quality_score: 0.5 }),
    ]);
  });
});
```

- [ ] **Step 2: Run failing test**

Expected: FAIL — `adminRouter` not found.

- [ ] **Step 3: Implement**

```typescript
// server/src/routes/admin/agents.ts
import { Router } from "express";
import { getDb } from "../../db.js";
import { listReputation } from "../../repos/agentReputation.js";

export const agentsRouter = Router();

agentsRouter.get("/agents", (_req, res) => {
  const db = getDb();
  res.json({ agents: listReputation(db) });
});
```

```typescript
// server/src/routes/admin/index.ts
import { Router, type Request, type Response, type NextFunction } from "express";
import { agentsRouter } from "./agents.js";

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return res.status(401).json({ error: "Admin API key not configured" });
  const auth = req.header("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (token !== expected) return res.status(401).json({ error: "Unauthorized" });
  next();
}

export const adminRouter = Router();
adminRouter.use("/admin", requireAdmin, agentsRouter);
```

- [ ] **Step 4: Wire into `server/src/index.ts`**

```typescript
import { adminRouter } from "./routes/admin/index.js";
import { startReputationRollupSchedule } from "./jobs/reputationRollup.js";
// ... after other routers:
app.use(adminRouter);
// At server start (after getDb() is callable):
startReputationRollupSchedule(getDb());
```

- [ ] **Step 5: Run test, confirm 3/3 pass; commit**

```bash
git add server/src/routes/admin server/src/index.ts server/src/routes/admin/agents.test.ts
git commit -m "feat(admin): GET /admin/agents reputation read endpoint + boot schedule

Bearer-auth via ADMIN_API_KEY env var. Returns the agent_reputation
rollup ordered by quality_score DESC. Internal-only — not advertised
in the manifest. server/src/index.ts boots the 15-min rollup interval
so /admin/agents has fresh data without waiting for an external cron."
```

---

## Final verification

- [ ] **Step 1: Run full server suite + tsc**

```bash
cd server && npx vitest run && npx tsc --noEmit
```

Expected: ~280+ tests pass (251 baseline + ~30 from Session 11), tsc clean.

- [ ] **Step 2: Run worker tsc**

```bash
cd worker && npx tsc --noEmit
```

Expected: clean (no worker code changed).

- [ ] **Step 3: Manifest sanity check**

```bash
cd server && node -e "
import('./dist/manifest/descriptor.js').then(m => {
  console.log(JSON.stringify(m.MANIFEST.rate_limits, null, 2));
});
"
```

Expected: `{ per_agent_per_minute, per_ip_per_minute, tiers: { unverified, known, trusted } }`.

- [ ] **Step 4: Update CLAUDE.md "What is shipped today"**

Add under the existing Session 10 paragraph:

```markdown
- **Session 11 (Apr 2026) — Per-agent reputation + metering.** Closes the loop.
  Every MCP tool call with a resolved agent_id writes one `agent_requests` row
  (latency, cost, outcome). `/a2a/confirm` and handoff completion backfill
  `outcome_signal` to `reservation_confirmed` / `handoff_completed`.
  `click_events` gained `agent_id` + `request_id` columns; the central beacon
  endpoint accepts both as optional body fields. A 15-min rollup
  (`server/src/jobs/reputationRollup.ts`, started at boot) aggregates into
  `agent_reputation` keyed by (agent_id, window). Rate-limit middleware reads
  the rollup to assign `unverified` (100/min) / `known` (250/min) / `trusted`
  (1000/min) tier per request. `GET /admin/agents` (bearer auth via
  `ADMIN_API_KEY`) exposes the rollup. Manifest's `rate_limits.tiers` field
  advertises the per-tier ceilings. v1 deliberately ships **no** prompt
  mutation or `search_businesses` re-ranking — abuse vectors deferred until
  customer-confirmed outcome signal exists. Migrations 010/011/012.
```

- [ ] **Step 5: Push branch + open PR**

```bash
git push -u origin feature/session-11-reputation
gh pr create --base main --head feature/session-11-reputation \
  --title "feat: Session 11 — per-agent reputation + metering" \
  --body "$(cat <<'EOF'
## Summary

Closes the reputation loop. Every MCP tool call with an agent identity writes
one `agent_requests` row; outcome signals (`reservation_confirmed`, `click`,
`handoff_completed`) are backfilled async. A 15-min rollup powers a tiered
rate limit (unverified 100/min → known 250/min → trusted 1000/min).

## v1 explicit non-goals (per master plan)

- **No prompt mutation** based on reputation
- **No search_businesses re-ranking** by reputation
- Both deferred until customer-confirmed outcome signal exists (abuse vectors)
- v1's only feedback loop is rate-limit tier — the least-abusable application

## Changes

- 3 migrations: `agent_requests`, `agent_reputation`, `click_events.agent_id + request_id`
- New repos: `agentRequests`, `agentReputation`
- New libs: `agentRequestLogger` (HOF wrapper), `agentTier` (resolver + ceilings)
- New job: `reputationRollup` (sync recompute + boot setInterval, 15 min)
- New route: `GET /admin/agents` (bearer auth via `ADMIN_API_KEY`)
- Modified: `rateLimit.ts` (per-tier ceilings), `manifest/{schema,descriptor}.ts` (tiered shape), all 6 MCP tools (logger wrap), `a2a.ts` (outcome backfill), `analytics.ts` (click `agent_id`/`request_id` capture)

## Test plan

- [x] All ~280 server tests pass (251 baseline + Session 11)
- [x] Server + worker tsc clean
- [x] Manifest exposes tiered rate_limits at `/.well-known/mcp.json`
- [x] Integration: tool calls with `x-agent-identity` write rows; anonymous calls skip
- [x] Integration: `/a2a/confirm` flips matching `agent_requests` row to `reservation_confirmed`
- [x] Rollup is idempotent and ignores rows older than the window
- [x] `known` tier gets 250 req/min; `unverified` 429s at 101st
- [ ] Post-merge: ≥10 distinct `agent_id` values with `agent_id_source != 'inferred'` after 7 days (master plan acceptance)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Risks acknowledged

1. **Self-asserted agent_id is spoofable.** v1 keys reputation off the same self-asserted signal as Session 10 tuning. A bad actor can claim `x-agent-identity: cursor` and burn cursor's reputation. Mitigation: monitor `/admin/agents` for anomalous spikes; add OAuth client-id ranking later. The rate-limit tier is the **only** consequence today, and the worst case is over-allowing a 1000/min ceiling — not destructive.
2. **Spam-confirm reputation farming.** An agent could `reserve_slot` then immediately `/a2a/confirm` against its own reservations to inflate `quality_score`. v1 doesn't gate this — the consequence is rate-limit headroom, which costs us infra not money. Future: weight `reservations_confirmed` by whether the customer-side webhook acknowledges the reservation as real (Session 12+).
3. **Cold start for new agents.** Every new agent starts at `unverified` (100/min). Onboarding doc should explain how to graduate (need 10 requests at quality 0.1+ in 7d). Mitigated: customer-side allowlist could short-circuit to `known` for known partners, deferred to admin tooling.
4. **SQLite contention from logger writes on every tool call.** At our v1 traffic (<10 req/sec), better-sqlite3's WAL mode handles this trivially. At 1000 req/sec it would matter — revisit when traffic justifies it.
5. **Rollup runs on the same DB as the live request path.** A 15-min interval on agent_reputation aggregation is sub-second on 100k rows (master plan acceptance). At 10M rows we'd want to move to async / periodic snapshot tables. Not a v1 concern.
