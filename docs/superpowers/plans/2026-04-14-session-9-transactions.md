# Session 9 — Transaction Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every registered business into an addressable transactional endpoint by exposing four new MCP tools — `get_availability`, `get_quote`, `reserve_slot`, `initiate_handoff` — plus the supporting `/a2a/confirm` and `/a2a/continue/:token` endpoints, so an agent acting on behalf of a user can check availability, quote, hold, and commit without leaving the MCP surface.

**Architecture:** Four MCP tools register via the Session 8 descriptor pattern (shared zod shapes in `manifest/tools.ts` → `ToolDescriptor` entries in `manifest/descriptor.ts` → `server.tool(...)` in `routes/mcp.ts`, with the drift test enforcing parity). Two new tables (`reservations`, `handoffs`) land via migrations 006 + 007; a nullable column `businesses.availability_webhook_url` lands via 008 for v2 real-inventory integration that v1 does not use. Transactional v1 is synthetic-availability from `hours_json`, deterministic-quote from `pricing_json_v2.ranges[]` with an opt-in Claude fallback labeled `"estimate"`, and 15-minute HELD reservations confirmed via signed token posted back to `/a2a/confirm`. Handoffs are a discriminated union: `mode: "human"` dispatches SMS/email via fetch against Twilio/SES REST (no SDK deps, env-gated), `mode: "agent"` mints a continuation URL consumed by `/a2a/continue/:token`. All new code is TypeScript strict; no `any` without a justifying comment; no new npm dependencies.

**Tech Stack:** TypeScript strict • Express 5 • better-sqlite3 (sync) • zod • `@modelcontextprotocol/sdk` • HMAC-SHA256 via Node `crypto` • Anthropic SDK (for quote fallback only) • fetch against Twilio SMS + SES REST (env-gated stubs in dev) • Vitest 4 • Supertest 7

---

## Critical cross-cutting rules (read once)

**1. HMAC domain separation.** Attribution tokens (Session 0) and continuation tokens (this session) MUST NOT be interchangeable. The continuation signer prefixes its HMAC input with the literal ASCII string `"a2a-continuation:v1:"` before the base64url payload — any verifier that doesn't prepend the same prefix cannot produce matching bytes, so an attribution token cannot be replayed as a continuation token and vice versa. This is the rule the Session 9 master plan calls "domain-separated HMAC salts" — implemented as a prefix, not a second env var, so operators don't have two keys to rotate.

**2. No new npm dependencies.** Per `/Users/cameronmcewan/Desktop/CLAUDE.md`: "Do not add new dependencies without proposing them and getting approval first." The notify adapter uses the built-in `fetch` globally (Node 18+). No `twilio`, no `@aws-sdk/client-ses`. The plan intentionally ignores any task that would install a package.

**3. No scope creep into Sessions 10/11.** This session ships transactional primitives only. Do NOT touch `agent_id` prompt tuning (Session 10) or `agent_requests` reputation (Session 11). If you see a seam where those would plug in, leave a `// Session 10:` comment and move on.

**4. Test isolation.** Any new test that calls `createTestApp()` must set `process.env.DATABASE_PATH ??= ":memory:"` in `beforeAll` — the `??=` (not `=`) is load-bearing; using `=` clobbers sibling tests in the same vitest worker. See `server/src/routes/wellknownMcp.test.ts` for precedent.

**5. ESM.** `server/package.json` declares `"type": "module"`. Always use `await import("./foo.js")` (with `.js` extension even for `.ts` source), never `require()`.

**6. Repository pattern.** Today the codebase calls `getDb().prepare(...).run()` inline at use sites. Follow that. Do NOT introduce a `server/src/db/repos/` directory — keep the inline pattern to minimize churn.

**7. Drift test is load-bearing.** The Session 8 drift test (`server/src/manifest/descriptor.test.ts` lines ~92–142) asserts `DESCRIPTORS.map(d=>d.name).sort()` equals the sorted keys of `createMcpServer()._registeredTools`. Every new tool MUST appear in both places in the same commit, or CI fails loudly. This is the forcing function for manifest honesty.

---

## File structure (lock in before tasks)

**New files:**
- `server/src/db/migrations/006_reservations.sql` — `reservations` table
- `server/src/db/migrations/007_handoffs.sql` — `handoffs` table
- `server/src/db/migrations/008_businesses_availability_webhook.sql` — nullable column
- `server/src/mcp/tools/getAvailability.ts` — tool handler (registration + `synthSlots` pure function + types)
- `server/src/mcp/tools/getAvailability.test.ts`
- `server/src/mcp/tools/getQuote.ts` — tool handler (registration + `deterministicQuote` + LLM fallback)
- `server/src/mcp/tools/getQuote.test.ts`
- `server/src/mcp/tools/reserveSlot.ts` — tool handler (idempotency, 15-min hold, emits `confirmation_token`)
- `server/src/mcp/tools/reserveSlot.test.ts`
- `server/src/mcp/tools/initiateHandoff.ts` — tool handler (union of `human`/`agent` modes)
- `server/src/mcp/tools/initiateHandoff.test.ts`
- `server/src/mcp/tools/index.ts` — thin re-export barrel: each tool file exports `{ name, register(server) }`; `index.ts` exposes `registerAllTransactionalTools(server)`
- `server/src/lib/continuationToken.ts` — mint + verify (domain-separated HMAC prefix)
- `server/src/lib/continuationToken.test.ts`
- `server/src/lib/notify.ts` — `sendSms()` + `sendEmail()` via fetch (env-gated)
- `server/src/lib/notify.test.ts`
- `server/src/lib/anthropic.ts` — thin `callClaude({system, user, maxTokens})` helper used by quote fallback
- `server/src/routes/a2a.ts` — `POST /a2a/confirm`, `POST /a2a/continue/:token`
- `server/src/routes/a2a.test.ts`
- `server/src/jobs/expirySweeper.ts` — `sweepExpiredReservations()` pure function (synchronously called at `reserve_slot` entry; no cron in v1)
- `server/src/jobs/expirySweeper.test.ts`

**Modified files:**
- `server/src/manifest/tools.ts` — add 4 new zod shapes
- `server/src/manifest/descriptor.ts` — add 4 new `ToolDescriptor` entries
- `server/src/manifest/descriptor.test.ts` — update drift expectations (now 6 tools, was 2)
- `server/src/routes/mcp.ts` — call `registerAllTransactionalTools(server)` after existing two tool registrations
- `server/src/db.ts` — add `ReservationRow` and `HandoffRow` TypeScript interfaces next to existing `BusinessRow`
- `server/src/testApp.ts` — mount `a2aRouter` after `mcpRouter`
- `AGENTS.md` — document the 4 new tools + the continuation flow

**No changes to:**
- `worker/` (Session 9 is server-only; worker's bot detection, portal, and attribution stay untouched — CLAUDE.md prohibits)
- Session 0 migrations 001–005
- Session 8 manifest schema / descriptor registry mechanism

---

## Task 1: Migration 006 — `reservations` table

**Files:**
- Create: `server/src/db/migrations/006_reservations.sql`
- Modify: `server/src/db.ts` (add `ReservationRow` interface)

**Data model rationale:** 15-min HELD → CONFIRMED state machine. `idempotency_key UNIQUE` makes the same agent retrying the same reservation a no-op; `confirmation_token` is the signed blob the agent posts back to `/a2a/confirm`. ULID id so IDs sort by time for cheap debugging. `expires_at` indexed so the sweeper can `WHERE expires_at < now() AND status='held'` efficiently.

- [ ] **Step 1: Write the migration SQL**

Create `server/src/db/migrations/006_reservations.sql`:

```sql
-- Session 9: reservations — 15-min HELD → CONFIRMED transactional holds.
-- HELD created by reserve_slot; CONFIRMED by /a2a/confirm posting the
-- signed confirmation_token. Expired holds swept synchronously on the
-- next reserve_slot call (no cron in v1).
CREATE TABLE IF NOT EXISTS reservations (
  id                    TEXT PRIMARY KEY,
  business_slug         TEXT NOT NULL,
  agent_id              TEXT,
  requested_at          INTEGER NOT NULL,
  window_start          INTEGER NOT NULL,
  window_end            INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('held','confirmed','rejected','expired')),
  confirmation_token    TEXT NOT NULL,
  customer_contact_json TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL UNIQUE,
  expires_at            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_reservations_slug_window
  ON reservations(business_slug, window_start);

CREATE INDEX IF NOT EXISTS idx_reservations_expiry
  ON reservations(status, expires_at);
```

- [ ] **Step 2: Add the TypeScript row type**

Modify `server/src/db.ts`. Add next to the existing `BusinessRow` interface:

```typescript
export interface ReservationRow {
  id: string;
  business_slug: string;
  agent_id: string | null;
  requested_at: number;
  window_start: number;
  window_end: number;
  status: 'held' | 'confirmed' | 'rejected' | 'expired';
  confirmation_token: string;
  customer_contact_json: string;
  idempotency_key: string;
  expires_at: number;
  created_at: number;
}
```

- [ ] **Step 3: Write the failing migration test**

Create `server/src/db/migrations/006_reservations.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 006 — reservations", () => {
  it("creates reservations table with the required columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(reservations)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "agent_id",
      "business_slug",
      "confirmation_token",
      "created_at",
      "customer_contact_json",
      "expires_at",
      "id",
      "idempotency_key",
      "requested_at",
      "status",
      "window_end",
      "window_start",
    ]);
  });

  it("enforces the status CHECK constraint", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insertBad = () => db.prepare(`
      INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
      VALUES ('r1', 'x', 1, 1, 2, 'bogus', 't', '{}', 'k1', 100)
    `).run();
    expect(insertBad).toThrow(/CHECK/);
  });

  it("enforces UNIQUE on idempotency_key", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(`
      INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
      VALUES ('r1', 'x', 1, 1, 2, 'held', 't', '{}', 'same-key', 100)
    `).run();
    const dup = () => db.prepare(`
      INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
      VALUES ('r2', 'x', 1, 1, 2, 'held', 't', '{}', 'same-key', 100)
    `).run();
    expect(dup).toThrow(/UNIQUE/);
  });

  it("is idempotent when reapplied (schema_migrations blocks replay)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
  });
});
```

- [ ] **Step 4: Run the test, expect failure on missing table**

```
cd server && npx vitest run src/db/migrations/006_reservations.test.ts
```

Expected: 4 failures — `no such table: reservations`.

- [ ] **Step 5: Run the full test, expect pass**

```
cd server && npx vitest run src/db/migrations/006_reservations.test.ts
```

Expected: 4/4 pass (the migration runner auto-picks up new `.sql` files in the directory).

- [ ] **Step 6: Run the full server suite — nothing regresses**

```
cd server && npx vitest run
```

Expected: 138 passing (134 baseline + 4 new). If a sibling test touches `reservations` tables expecting them to NOT exist, fix it; otherwise baseline is preserved.

- [ ] **Step 7: Typecheck**

```
cd server && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 8: Commit**

```
git add server/src/db/migrations/006_reservations.sql server/src/db/migrations/006_reservations.test.ts server/src/db.ts
git commit -m "feat(db): migration 006 — reservations table with HELD→CONFIRMED state machine"
```

---

## Task 2: Migration 007 — `handoffs` table

**Files:**
- Create: `server/src/db/migrations/007_handoffs.sql`
- Modify: `server/src/db.ts` (add `HandoffRow` interface)

**Data model rationale:** Handoffs are a discriminated union on the wire but a single flat table on disk. `mode` column carries the discriminant; `delivered_via` is populated only for `mode='human'`; `continuation_url`/`handshake_token` only for `mode='agent'`. Nullable columns instead of two tables keeps reporting queries simple (one join, not two).

- [ ] **Step 1: Write the migration SQL**

Create `server/src/db/migrations/007_handoffs.sql`:

```sql
-- Session 9: handoffs — discriminated union on `mode`.
-- mode='human' → delivered_via + ticket_id populated, continuation_url NULL.
-- mode='agent' → continuation_url + handshake_token populated, delivered_via NULL.
-- reservation_id nullable: some handoffs happen without a prior reserve_slot.
CREATE TABLE IF NOT EXISTS handoffs (
  id                TEXT PRIMARY KEY,
  business_slug     TEXT NOT NULL,
  reservation_id    TEXT,
  mode              TEXT NOT NULL CHECK (mode IN ('human','agent')),
  delivered_via     TEXT CHECK (delivered_via IN ('sms','email') OR delivered_via IS NULL),
  continuation_url  TEXT,
  handshake_token   TEXT,
  ticket_id         TEXT,
  agent_id          TEXT,
  created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_handoffs_slug ON handoffs(business_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_reservation ON handoffs(reservation_id);
```

- [ ] **Step 2: Add the TypeScript row type**

Modify `server/src/db.ts`:

```typescript
export interface HandoffRow {
  id: string;
  business_slug: string;
  reservation_id: string | null;
  mode: 'human' | 'agent';
  delivered_via: 'sms' | 'email' | null;
  continuation_url: string | null;
  handshake_token: string | null;
  ticket_id: string | null;
  agent_id: string | null;
  created_at: number;
}
```

- [ ] **Step 3: Write the failing migration test**

Create `server/src/db/migrations/007_handoffs.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 007 — handoffs", () => {
  it("creates handoffs table with required columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(handoffs)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "agent_id",
      "business_slug",
      "continuation_url",
      "created_at",
      "delivered_via",
      "handshake_token",
      "id",
      "mode",
      "reservation_id",
      "ticket_id",
    ]);
  });

  it("rejects mode outside ('human','agent')", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const bad = () => db.prepare(`
      INSERT INTO handoffs (id, business_slug, mode) VALUES ('h1','x','other')
    `).run();
    expect(bad).toThrow(/CHECK/);
  });

  it("allows delivered_via NULL (for mode='agent')", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const good = () => db.prepare(`
      INSERT INTO handoffs (id, business_slug, mode) VALUES ('h1','x','agent')
    `).run();
    expect(good).not.toThrow();
  });

  it("rejects delivered_via outside ('sms','email')", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const bad = () => db.prepare(`
      INSERT INTO handoffs (id, business_slug, mode, delivered_via) VALUES ('h1','x','human','carrier-pigeon')
    `).run();
    expect(bad).toThrow(/CHECK/);
  });
});
```

- [ ] **Step 4: Run the failing test**

```
cd server && npx vitest run src/db/migrations/007_handoffs.test.ts
```

Expected: failures on missing table.

- [ ] **Step 5: Run test after migration lands, expect pass**

```
cd server && npx vitest run src/db/migrations/007_handoffs.test.ts
```

Expected: 4/4 pass.

- [ ] **Step 6: Full suite + typecheck**

```
cd server && npx vitest run && npx tsc --noEmit
```

Expected: 142 passing (138 + 4), typecheck clean.

- [ ] **Step 7: Commit**

```
git add server/src/db/migrations/007_handoffs.sql server/src/db/migrations/007_handoffs.test.ts server/src/db.ts
git commit -m "feat(db): migration 007 — handoffs table (human/agent discriminated union)"
```

---

## Task 3: Migration 008 — `businesses.availability_webhook_url`

**Files:**
- Create: `server/src/db/migrations/008_businesses_availability_webhook.sql`

**Rationale:** v1 uses synthetic slots from `hours_json`. v2 will accept a tenant-configured webhook that returns real inventory. Adding the nullable column now means v2 is a data migration, not a schema migration — ship-blocker avoided.

- [ ] **Step 1: Write the migration**

```sql
-- Session 9: availability_webhook_url — reserved for v2 real-calendar inventory.
-- v1 ignores this column; its presence only means v2 migration won't be schema-breaking.
ALTER TABLE businesses ADD COLUMN availability_webhook_url TEXT;
```

- [ ] **Step 2: Write the test**

Create `server/src/db/migrations/008_businesses_availability_webhook.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 008 — businesses.availability_webhook_url", () => {
  it("adds the nullable column to businesses", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(businesses)").all() as Array<{ name: string; notnull: number }>;
    const col = cols.find(c => c.name === "availability_webhook_url");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it("accepts NULL on insert (backward compat)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const ins = () => db.prepare(`
      INSERT INTO businesses (id, slug, name, api_key) VALUES ('b1','x','X','k')
    `).run();
    expect(ins).not.toThrow();
  });
});
```

- [ ] **Step 3: Run tests + typecheck**

```
cd server && npx vitest run src/db/migrations/008_businesses_availability_webhook.test.ts && npx tsc --noEmit
```

Expected: 2/2 pass; typecheck clean.

- [ ] **Step 4: Full suite**

```
cd server && npx vitest run
```

Expected: 144 passing (142 + 2).

- [ ] **Step 5: Commit**

```
git add server/src/db/migrations/008_businesses_availability_webhook.sql server/src/db/migrations/008_businesses_availability_webhook.test.ts
git commit -m "feat(db): migration 008 — businesses.availability_webhook_url (nullable, v2 reservation)"
```

---

## Task 4: `get_availability` — synthetic slotter + tool registration

**Files:**
- Create: `server/src/mcp/tools/getAvailability.ts`
- Create: `server/src/mcp/tools/getAvailability.test.ts`
- Modify: `server/src/manifest/tools.ts` (add `getAvailabilityInput` shape)
- Modify: `server/src/manifest/descriptor.ts` (add `DESCRIPTORS` entry)

**Synthetic slotter rules:**
- Input `hours_json` is `{monday:{open,close}?, tuesday:..., ...}` with ISO 24h strings (`"09:00"`–`"17:00"`) or absent key meaning closed.
- 30-minute granularity. A slot `{start, end}` is a Unix-seconds-range where `end - start = 1800`.
- Window defaults: `window_start = now`, `window_end = now + 7 days`. Cap output at 48 slots.
- `capacity: 1` always in v1 (no per-slot concurrency model).
- `source: "hours_json"` always in v1.

- [ ] **Step 1: Write the failing slotter test**

Create `server/src/mcp/tools/getAvailability.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { synthSlots, type HoursJson } from "./getAvailability.js";

const MONDAY_9_TO_10 = 1712572200; // 2024-04-08 09:30 UTC Monday — no actually pick a Mon
// Use a fixed Monday at midnight UTC. 2026-04-13 00:00 UTC is a Monday.
const MON_0000 = 1776211200;
const TUE_0000 = MON_0000 + 86400;

describe("synthSlots — pure function", () => {
  it("returns zero slots when the window intersects only closed days", () => {
    const hours: HoursJson = {}; // all days closed
    const out = synthSlots({ hours, window_start: MON_0000, window_end: MON_0000 + 86400 });
    expect(out).toEqual([]);
  });

  it("returns 2 half-hour slots for a 09:00–10:00 Monday", () => {
    const hours: HoursJson = { monday: { open: "09:00", close: "10:00" } };
    const out = synthSlots({ hours, window_start: MON_0000, window_end: TUE_0000 });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ start: MON_0000 + 9 * 3600, end: MON_0000 + 9 * 3600 + 1800, capacity: 1 });
    expect(out[1]).toEqual({ start: MON_0000 + 9 * 3600 + 1800, end: MON_0000 + 10 * 3600, capacity: 1 });
  });

  it("caps output at 48 slots even if the window is wider", () => {
    const hours: HoursJson = {
      monday: { open: "00:00", close: "23:59" },
      tuesday: { open: "00:00", close: "23:59" },
    };
    const out = synthSlots({ hours, window_start: MON_0000, window_end: MON_0000 + 3 * 86400 });
    expect(out.length).toBe(48);
  });

  it("clamps window_start upward to max(now, window_start) is the caller's job — slotter just uses the given window", () => {
    const hours: HoursJson = { monday: { open: "09:00", close: "10:00" } };
    const out = synthSlots({ hours, window_start: MON_0000 + 9 * 3600 + 600, window_end: TUE_0000 });
    // 09:10 UTC is inside the 09:00 slot, so the slotter must drop that slot and start at 09:30
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(MON_0000 + 9 * 3600 + 1800);
  });
});
```

- [ ] **Step 2: Run the test, confirm fail**

```
cd server && npx vitest run src/mcp/tools/getAvailability.test.ts
```

Expected: module-not-found error.

- [ ] **Step 3: Implement the slotter + shape + descriptor scaffold**

Create `server/src/mcp/tools/getAvailability.ts`:

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { getAvailabilityInput } from "../../manifest/tools.js";

export interface DaySpec { open: string; close: string }
export type HoursJson = Partial<Record<
  "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday",
  DaySpec
>>;

const DAY_NAMES = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
] as const;
const SLOT_SECONDS = 1800;
const MAX_SLOTS = 48;

/**
 * Pure function: given hours_json and a [window_start, window_end) in Unix seconds,
 * return up to MAX_SLOTS 30-minute slots on days with matching hours.
 * Slots whose [start, end) isn't fully inside an open interval are dropped.
 */
export function synthSlots(args: {
  hours: HoursJson;
  window_start: number;
  window_end: number;
}): Array<{ start: number; end: number; capacity: 1 }> {
  const out: Array<{ start: number; end: number; capacity: 1 }> = [];
  // Walk each UTC day in the window.
  const dayStart = Math.floor(args.window_start / 86400) * 86400;
  for (let d = dayStart; d < args.window_end && out.length < MAX_SLOTS; d += 86400) {
    const dow = DAY_NAMES[new Date(d * 1000).getUTCDay()]!;
    const spec = args.hours[dow];
    if (!spec) continue;
    const open = parseHHMM(spec.open);
    const close = parseHHMM(spec.close);
    if (open == null || close == null || close <= open) continue;
    for (let t = d + open; t + SLOT_SECONDS <= d + close && out.length < MAX_SLOTS; t += SLOT_SECONDS) {
      if (t + SLOT_SECONDS <= args.window_start) continue;
      if (t >= args.window_end) break;
      if (t < args.window_start) continue; // partial first slot — drop
      out.push({ start: t, end: t + SLOT_SECONDS, capacity: 1 });
    }
  }
  return out;
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 3600 + mm * 60;
}

export async function handleGetAvailability(
  input: z.infer<typeof getAvailabilityInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const row = getDb().prepare(`
    SELECT slug, hours_json, availability_webhook_url
    FROM businesses WHERE slug = ?
  `).get(input.slug) as { slug: string; hours_json: string | null; availability_webhook_url: string | null } | undefined;

  if (!row) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }] };
  }
  const now = Math.floor(Date.now() / 1000);
  const window_start = input.window_start ?? now;
  const window_end = input.window_end ?? now + 7 * 86400;
  let hours: HoursJson = {};
  if (row.hours_json) {
    try { hours = JSON.parse(row.hours_json) as HoursJson; } catch { hours = {}; }
  }
  const slots = synthSlots({ hours, window_start, window_end });
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        slots,
        source: "hours_json",
        generated_at: now,
      }),
    }],
  };
}

export function registerGetAvailability(server: McpServer): void {
  server.tool(
    "get_availability",
    "Return 30-minute availability windows for a business from its hours_json. v1 is synthetic; v2 will consult availability_webhook_url when set.",
    getAvailabilityInput.shape,
    async (args) => handleGetAvailability(args)
  );
}
```

- [ ] **Step 4: Add the shared zod shape**

Modify `server/src/manifest/tools.ts`. Append:

```typescript
export const getAvailabilityInput = z.object({
  slug: z.string().min(1).describe("business slug"),
  window_start: z.number().int().positive().optional().describe("Unix seconds; default now"),
  window_end: z.number().int().positive().optional().describe("Unix seconds; default now + 7 days"),
});
export type GetAvailabilityInput = z.infer<typeof getAvailabilityInput>;
```

- [ ] **Step 5: Add the descriptor entry**

Modify `server/src/manifest/descriptor.ts`. Add import:

```typescript
import { getAvailabilityInput } from "./tools.js";
```

Append to `DESCRIPTORS`:

```typescript
{
  name: "get_availability",
  description: "30-minute slot windows derived from business hours_json (v1 synthetic).",
  inputZod: getAvailabilityInput,
  outputSchema: {
    type: "object",
    properties: {
      slots: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start: { type: "number" },
            end: { type: "number" },
            capacity: { type: "number" },
          },
        },
      },
      source: { type: "string" },
      generated_at: { type: "number" },
    },
  },
  idempotent: true,
  estimated_latency_ms: 150,
  estimated_cost_cents: 0,
},
```

- [ ] **Step 6: Wire the tool into `createMcpServer`**

Modify `server/src/routes/mcp.ts`. Add import near the top:

```typescript
import { registerGetAvailability } from "../mcp/tools/getAvailability.js";
```

Inside `createMcpServer()`, after the existing two `server.tool(...)` registrations, before the `_requestHandlers` wrapper block:

```typescript
  registerGetAvailability(server);
```

- [ ] **Step 7: Extend the test with a tool-registration assertion**

Append to `server/src/mcp/tools/getAvailability.test.ts`:

```typescript
import { describe as d2, it as i2, expect as e2, beforeAll } from "vitest";
describe("get_availability — tool registration", () => {
  it("is registered on createMcpServer and callable via handler", async () => {
    process.env.DATABASE_PATH ??= ":memory:";
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { createMcpServer } = await import("../../routes/mcp.js");
    const s = createMcpServer();
    const names = Object.keys((s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(names).toContain("get_availability");
  });
});
```

- [ ] **Step 8: Run the test**

```
cd server && npx vitest run src/mcp/tools/getAvailability.test.ts
```

Expected: all pass (unit tests + registration assertion).

- [ ] **Step 9: Run drift test + full suite**

```
cd server && npx vitest run src/manifest/descriptor.test.ts && npx vitest run
```

Expected: drift test green (tools array now has 3 entries: existing 2 + `get_availability`); full suite green.

**Drift note:** If the drift test fails with `expected ["get_availability", "query_business_agent", "search_businesses"] received ["query_business_agent", "search_businesses"]`, you forgot to add the descriptor entry in Step 5.

- [ ] **Step 10: Typecheck**

```
cd server && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 11: Commit**

```
git add server/src/mcp/tools/getAvailability.ts server/src/mcp/tools/getAvailability.test.ts server/src/manifest/tools.ts server/src/manifest/descriptor.ts server/src/routes/mcp.ts
git commit -m "feat(mcp): get_availability tool — synthetic 30-min slots from hours_json"
```

---

## Task 5: `get_quote` deterministic path — lookup against `pricing_json_v2.ranges[]`

**Files:**
- Create: `server/src/mcp/tools/getQuote.ts` (deterministic path + stub for LLM fallback; LLM lands in Task 6)
- Create: `server/src/mcp/tools/getQuote.test.ts`
- Modify: `server/src/manifest/tools.ts` (add `getQuoteInput` shape)

**Deterministic rules:**
- `pricing_json_v2` shape (existing column): `{ ranges: Array<{ service: string, low: number, high: number, currency: string, params?: Record<string,string> }> }`.
- Match: `service` exact (case-insensitive trim). If `params` on the range, every key/value must match input `params`. Returns `confidence: "exact"` if `low === high`, `"range"` otherwise.
- Miss: return `null` for v1 deterministic; Task 6 adds LLM fallback.

- [ ] **Step 1: Write the failing test**

Create `server/src/mcp/tools/getQuote.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { deterministicQuote } from "./getQuote.js";

const pricing = {
  ranges: [
    { service: "lawn mowing", low: 40, high: 40, currency: "USD" },
    { service: "lawn mowing", low: 60, high: 90, currency: "USD", params: { size: "large" } },
    { service: "hedge trimming", low: 30, high: 75, currency: "USD" },
  ],
};

describe("deterministicQuote", () => {
  it("returns exact when low === high on matched service", () => {
    const q = deterministicQuote({ service: "lawn mowing", params: {} }, pricing);
    expect(q).toEqual({ low: 40, high: 40, currency: "USD", confidence: "exact", basis: "pricing_json_v2" });
  });
  it("returns range when low < high", () => {
    const q = deterministicQuote({ service: "hedge trimming", params: {} }, pricing);
    expect(q).toEqual({ low: 30, high: 75, currency: "USD", confidence: "range", basis: "pricing_json_v2" });
  });
  it("respects param narrowing when the range declares params", () => {
    const q = deterministicQuote({ service: "lawn mowing", params: { size: "large" } }, pricing);
    expect(q).toEqual({ low: 60, high: 90, currency: "USD", confidence: "range", basis: "pricing_json_v2" });
  });
  it("is case/whitespace insensitive on service name", () => {
    const q = deterministicQuote({ service: "  LAWN MOWING  ", params: {} }, pricing);
    expect(q?.low).toBe(40);
  });
  it("returns null on service miss (no param-less match)", () => {
    const q = deterministicQuote({ service: "window washing", params: {} }, pricing);
    expect(q).toBeNull();
  });
  it("returns null on param mismatch", () => {
    const q = deterministicQuote({ service: "lawn mowing", params: { size: "small" } }, pricing);
    // "small" doesn't match any row; the size-free row applies to any size — but because
    // the caller supplied a param, we require the range to declare the same param.
    expect(q).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, confirm fail**

```
cd server && npx vitest run src/mcp/tools/getQuote.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the deterministic path**

Create `server/src/mcp/tools/getQuote.ts`:

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { getQuoteInput } from "../../manifest/tools.js";

export interface PricingRange {
  service: string;
  low: number;
  high: number;
  currency: string;
  params?: Record<string, string>;
}
export interface PricingJson { ranges: PricingRange[] }

export interface Quote {
  low: number;
  high: number;
  currency: string;
  confidence: "exact" | "range" | "estimate";
  basis: "pricing_json_v2" | "llm_estimate";
  disclaimer?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

function paramsMatch(required: Record<string, string> | undefined, given: Record<string, string>): boolean {
  if (!required) return Object.keys(given).length === 0;
  for (const [k, v] of Object.entries(required)) {
    if (given[k] !== v) return false;
  }
  return true;
}

/**
 * Deterministic quote. Returns null on miss; Task 6 wraps this with the LLM fallback.
 * Confidence: "exact" when low === high, "range" otherwise. Never returns "estimate".
 */
export function deterministicQuote(
  args: { service: string; params: Record<string, string> },
  pricing: PricingJson
): Quote | null {
  const target = norm(args.service);
  for (const r of pricing.ranges) {
    if (norm(r.service) !== target) continue;
    if (!paramsMatch(r.params, args.params)) continue;
    return {
      low: r.low,
      high: r.high,
      currency: r.currency,
      confidence: r.low === r.high ? "exact" : "range",
      basis: "pricing_json_v2",
    };
  }
  return null;
}

export async function handleGetQuote(
  input: z.infer<typeof getQuoteInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const row = getDb().prepare(`
    SELECT pricing_json_v2 FROM businesses WHERE slug = ?
  `).get(input.slug) as { pricing_json_v2: string | null } | undefined;

  if (!row) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }] };
  }
  let pricing: PricingJson = { ranges: [] };
  if (row.pricing_json_v2) {
    try { pricing = JSON.parse(row.pricing_json_v2) as PricingJson; } catch { pricing = { ranges: [] }; }
  }
  const det = deterministicQuote({ service: input.service, params: input.params ?? {} }, pricing);
  if (det) {
    return { content: [{ type: "text", text: JSON.stringify({ quote: det }) }] };
  }
  // Task 6 replaces this with the LLM fallback.
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ quote: null, reason: "no_deterministic_match" }),
    }],
  };
}

export function registerGetQuote(server: McpServer): void {
  server.tool(
    "get_quote",
    "Quote price for a service at a business. Deterministic lookup of pricing_json_v2.ranges[]; returns null on miss (LLM fallback in next commit).",
    getQuoteInput.shape,
    async (args) => handleGetQuote(args)
  );
}
```

- [ ] **Step 4: Add the zod shape**

Modify `server/src/manifest/tools.ts`:

```typescript
export const getQuoteInput = z.object({
  slug: z.string().min(1).describe("business slug"),
  service: z.string().min(1).describe("requested service name"),
  params: z.record(z.string()).optional().describe("optional service parameters (e.g., {size:'large'})"),
});
export type GetQuoteInput = z.infer<typeof getQuoteInput>;
```

Note: `z.record(z.string())` produces a `Record<string, string>`. The hand-rolled `zodToJsonSchema` from Session 8 does NOT support `ZodRecord` — so BEFORE this shape lands, see Task 5b below.

- [ ] **Step 5: Extend the hand-rolled zod→JSON Schema converter to support `ZodRecord`**

Modify `server/src/manifest/schema.ts`. Inside `zodToJsonSchema`:

```typescript
  if (def.typeName === "ZodRecord") {
    // ZodRecord(valueType). We emit as an `object` with `additionalProperties` describing the value type.
    const valueType = (def as { valueType?: unknown }).valueType as ZodTypeAny | undefined;
    if (!valueType) throw new Error(`zodToJsonSchema: ZodRecord missing valueType`);
    return {
      type: "object",
      additionalProperties: zodToJsonSchema(valueType),
    };
  }
```

Append a test to `server/src/manifest/schema.test.ts`:

```typescript
  it("converts z.record(z.string()) to object with additionalProperties", () => {
    const out = zodToJsonSchema(z.record(z.string()));
    expect(out).toEqual({ type: "object", additionalProperties: { type: "string" } });
  });
```

- [ ] **Step 6: Register the descriptor entry**

Modify `server/src/manifest/descriptor.ts`. Add import:

```typescript
import { getQuoteInput } from "./tools.js";
```

Append to `DESCRIPTORS`:

```typescript
{
  name: "get_quote",
  description: "Quote a service price from pricing_json_v2; exact|range|estimate labelled.",
  inputZod: getQuoteInput,
  outputSchema: {
    type: "object",
    properties: {
      quote: {
        type: "object",
        properties: {
          low: { type: "number" },
          high: { type: "number" },
          currency: { type: "string" },
          confidence: { type: "string" },
          basis: { type: "string" },
          disclaimer: { type: "string" },
        },
      },
    },
  },
  idempotent: true,
  estimated_latency_ms: 200,
  estimated_cost_cents: 0, // LLM fallback in Task 6 raises this for the non-deterministic branch
},
```

- [ ] **Step 7: Wire into `createMcpServer`**

Modify `server/src/routes/mcp.ts`:

```typescript
import { registerGetQuote } from "../mcp/tools/getQuote.js";
```

Inside `createMcpServer()`, after `registerGetAvailability(server);`:

```typescript
  registerGetQuote(server);
```

- [ ] **Step 8: Run full test suite + drift + typecheck**

```
cd server && npx vitest run && npx tsc --noEmit
```

Expected: all green; drift test now asserts 4 tools.

- [ ] **Step 9: Commit**

```
git add server/src/mcp/tools/getQuote.ts server/src/mcp/tools/getQuote.test.ts server/src/manifest/tools.ts server/src/manifest/descriptor.ts server/src/manifest/schema.ts server/src/manifest/schema.test.ts server/src/routes/mcp.ts
git commit -m "feat(mcp): get_quote deterministic path + zodToJsonSchema ZodRecord support"
```

---

## Task 6: `get_quote` LLM fallback

**Files:**
- Create: `server/src/lib/anthropic.ts` (thin `callClaude` helper)
- Create: `server/src/lib/anthropic.test.ts`
- Modify: `server/src/mcp/tools/getQuote.ts` (add fallback path)
- Modify: `server/src/mcp/tools/getQuote.test.ts` (cover the fallback)
- Modify: `server/src/manifest/descriptor.ts` (update `estimated_cost_cents` comment)

**Fallback contract:**
- Triggered when `deterministicQuote` returns `null`.
- Calls Claude with business profile (name, description, services_text, pricing_json_v2 raw) + the user's service query.
- Returns `{low, high, currency, confidence: "estimate", basis: "llm_estimate", disclaimer}`.
- If Claude errors or returns unparseable JSON, return `{quote: null, reason: "llm_unavailable"}` — never throw.

- [ ] **Step 1: Write the failing test for the Anthropic helper**

Create `server/src/lib/anthropic.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("callClaude — thin Anthropic wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("returns the concatenated text of the assistant response", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "hello" }] }) };
      },
    }));
    const { callClaude } = await import("./anthropic.js");
    const out = await callClaude({ system: "s", user: "u", maxTokens: 50 });
    expect(out).toBe("hello");
  });

  it("returns null on SDK error (never throws)", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockRejectedValue(new Error("429")) };
      },
    }));
    const { callClaude } = await import("./anthropic.js");
    const out = await callClaude({ system: "s", user: "u", maxTokens: 50 });
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, fail on missing module**

```
cd server && npx vitest run src/lib/anthropic.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the helper**

Create `server/src/lib/anthropic.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  return client;
}

/**
 * Thin wrapper. Returns assistant text, or null on any failure.
 * Callers treat `null` as "LLM unavailable" and fall back.
 */
export async function callClaude(opts: {
  system: string;
  user: string;
  maxTokens: number;
  model?: string;
}): Promise<string | null> {
  try {
    const resp = await getClient().messages.create({
      model: opts.model ?? "claude-sonnet-4-6",
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    });
    const texts = resp.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map(b => b.text);
    return texts.join("");
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test, expect pass**

```
cd server && npx vitest run src/lib/anthropic.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 5: Write the failing fallback test**

Append to `server/src/mcp/tools/getQuote.test.ts`:

```typescript
import { llmQuoteFallback } from "./getQuote.js";
import { vi } from "vitest";

describe("llmQuoteFallback", () => {
  it("parses a well-formed Claude JSON response into a Quote", async () => {
    vi.doMock("../../lib/anthropic.js", () => ({
      callClaude: vi.fn().mockResolvedValue(JSON.stringify({ low: 50, high: 100, currency: "USD" })),
    }));
    vi.resetModules();
    const { llmQuoteFallback } = await import("./getQuote.js");
    const q = await llmQuoteFallback({
      service: "window cleaning",
      params: {},
      businessName: "Acme",
      businessDescription: "services business",
      pricingRawJson: null,
    });
    expect(q).toEqual({
      low: 50, high: 100, currency: "USD",
      confidence: "estimate",
      basis: "llm_estimate",
      disclaimer: "Estimate generated by AI from public business profile. Confirm with provider before relying.",
    });
  });
  it("returns null when callClaude returns null", async () => {
    vi.doMock("../../lib/anthropic.js", () => ({ callClaude: vi.fn().mockResolvedValue(null) }));
    vi.resetModules();
    const { llmQuoteFallback } = await import("./getQuote.js");
    const q = await llmQuoteFallback({
      service: "x", params: {}, businessName: "A", businessDescription: null, pricingRawJson: null,
    });
    expect(q).toBeNull();
  });
  it("returns null on unparseable response", async () => {
    vi.doMock("../../lib/anthropic.js", () => ({ callClaude: vi.fn().mockResolvedValue("not json") }));
    vi.resetModules();
    const { llmQuoteFallback } = await import("./getQuote.js");
    const q = await llmQuoteFallback({
      service: "x", params: {}, businessName: "A", businessDescription: null, pricingRawJson: null,
    });
    expect(q).toBeNull();
  });
});
```

- [ ] **Step 6: Run the test, expect fail on missing export**

```
cd server && npx vitest run src/mcp/tools/getQuote.test.ts
```

Expected: `llmQuoteFallback` not exported.

- [ ] **Step 7: Implement the fallback**

Modify `server/src/mcp/tools/getQuote.ts`. Add:

```typescript
import { callClaude } from "../../lib/anthropic.js";

const LLM_DISCLAIMER =
  "Estimate generated by AI from public business profile. Confirm with provider before relying.";

export async function llmQuoteFallback(opts: {
  service: string;
  params: Record<string, string>;
  businessName: string;
  businessDescription: string | null;
  pricingRawJson: string | null;
}): Promise<Quote | null> {
  const system =
    "You estimate prices for small businesses based on the business profile the user provides. " +
    "You respond ONLY with a JSON object of shape {\"low\": number, \"high\": number, \"currency\": string}. " +
    "No other fields. No prose. If you truly cannot estimate, respond {\"low\": 0, \"high\": 0, \"currency\": \"USD\"} and the caller will treat it as unavailable.";
  const user = JSON.stringify({
    service: opts.service,
    params: opts.params,
    business: {
      name: opts.businessName,
      description: opts.businessDescription,
      pricing_profile: opts.pricingRawJson,
    },
  });
  const raw = await callClaude({ system, user, maxTokens: 200 });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { low?: unknown; high?: unknown; currency?: unknown };
    if (
      typeof parsed.low !== "number" ||
      typeof parsed.high !== "number" ||
      typeof parsed.currency !== "string" ||
      parsed.low < 0 || parsed.high < parsed.low
    ) return null;
    if (parsed.low === 0 && parsed.high === 0) return null; // Claude's "I don't know" sentinel
    return {
      low: parsed.low,
      high: parsed.high,
      currency: parsed.currency,
      confidence: "estimate",
      basis: "llm_estimate",
      disclaimer: LLM_DISCLAIMER,
    };
  } catch {
    return null;
  }
}
```

Update `handleGetQuote` to use the fallback:

```typescript
export async function handleGetQuote(
  input: z.infer<typeof getQuoteInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const row = getDb().prepare(`
    SELECT name, description, pricing_json_v2 FROM businesses WHERE slug = ?
  `).get(input.slug) as { name: string; description: string | null; pricing_json_v2: string | null } | undefined;

  if (!row) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }] };
  }
  let pricing: PricingJson = { ranges: [] };
  if (row.pricing_json_v2) {
    try { pricing = JSON.parse(row.pricing_json_v2) as PricingJson; } catch { /* fall through */ }
  }
  const det = deterministicQuote({ service: input.service, params: input.params ?? {} }, pricing);
  if (det) {
    return { content: [{ type: "text", text: JSON.stringify({ quote: det }) }] };
  }
  const llm = await llmQuoteFallback({
    service: input.service,
    params: input.params ?? {},
    businessName: row.name,
    businessDescription: row.description,
    pricingRawJson: row.pricing_json_v2,
  });
  if (llm) {
    return { content: [{ type: "text", text: JSON.stringify({ quote: llm }) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify({ quote: null, reason: "llm_unavailable" }) }] };
}
```

- [ ] **Step 8: Update descriptor comment on cost**

Modify `server/src/manifest/descriptor.ts`. Change the `get_quote` entry's `estimated_cost_cents: 0` line to:

```typescript
  estimated_cost_cents: 0, // deterministic=0; LLM fallback ~1–2¢ per call; averaged assumes ≥70% deterministic hit
```

- [ ] **Step 9: Run full suite + typecheck**

```
cd server && npx vitest run && npx tsc --noEmit
```

Expected: all green; baseline rolls up to 151-ish (exact count depends on earlier-task fine-grained tests).

- [ ] **Step 10: Commit**

```
git add server/src/lib/anthropic.ts server/src/lib/anthropic.test.ts server/src/mcp/tools/getQuote.ts server/src/mcp/tools/getQuote.test.ts server/src/manifest/descriptor.ts
git commit -m "feat(mcp): get_quote LLM fallback (labelled 'estimate' with disclaimer) + anthropic helper"
```

---

## Task 7: Continuation token helpers (domain-separated HMAC)

**Files:**
- Create: `server/src/lib/continuationToken.ts`
- Create: `server/src/lib/continuationToken.test.ts`

**Contract:**
- Payload shape: `{ ticket: string, business_slug: string, agent_id?: string, ts: number, scope: "confirm" | "continue" }`.
- Token = `base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(prefix + encodedPayload, key))`.
- `prefix = "a2a-continuation:v1:"` (ASCII) — this is the domain separator; attribution tokens don't prefix, so the two HMACs never collide even on the same signing key.
- Expiry: 3600 seconds (1h) from `ts`. `verifyContinuationToken` throws `"expired" | "bad_signature" | "malformed"` strings on failure; callers log and return 401/400.
- Uses `TOKEN_SIGNING_KEY` env var (same as attribution; domain separation is in the prefix).

- [ ] **Step 1: Write the failing test**

Create `server/src/lib/continuationToken.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mintContinuationToken, verifyContinuationToken, CONTINUATION_HMAC_PREFIX } from "./continuationToken.js";

const KEY = "test-signing-key-s9";

describe("continuation token — mint + verify", () => {
  it("round-trip verifies", () => {
    const tok = mintContinuationToken(
      { ticket: "r_abc", business_slug: "acme", agent_id: "claude-desktop", scope: "continue" },
      KEY
    );
    const payload = verifyContinuationToken(tok, KEY);
    expect(payload.ticket).toBe("r_abc");
    expect(payload.business_slug).toBe("acme");
    expect(payload.scope).toBe("continue");
    expect(typeof payload.ts).toBe("number");
  });

  it("rejects tampered signature", () => {
    const tok = mintContinuationToken({ ticket: "r_1", business_slug: "x", scope: "confirm" }, KEY);
    const parts = tok.split(".");
    const tampered = parts[0] + "." + parts[1]!.slice(0, -1) + (parts[1]!.slice(-1) === "A" ? "B" : "A");
    expect(() => verifyContinuationToken(tampered, KEY)).toThrow("bad_signature");
  });

  it("rejects a token signed with a DIFFERENT prefix (attribution-token spoof)", () => {
    // Build a token using the attribution-token signing scheme (no prefix).
    // It must NOT verify as a continuation token.
    const payload = { ticket: "r_1", business_slug: "x", scope: "confirm" as const, ts: Math.floor(Date.now()/1000) };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    // Sign WITHOUT the prefix (simulating an attribution-style signer).
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const sig = crypto.createHmac("sha256", KEY).update(encoded).digest("base64url");
    const spoofed = `${encoded}.${sig}`;
    expect(() => verifyContinuationToken(spoofed, KEY)).toThrow("bad_signature");
  });

  it("rejects expired tokens (>3600s old)", () => {
    const old = mintContinuationToken(
      { ticket: "r_1", business_slug: "x", scope: "confirm" },
      KEY,
      { overrideTs: Math.floor(Date.now() / 1000) - 3601 }
    );
    expect(() => verifyContinuationToken(old, KEY)).toThrow("expired");
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyContinuationToken("not-a-token", KEY)).toThrow("malformed");
    expect(() => verifyContinuationToken("only.one", KEY)).toThrow(/bad_signature|malformed/);
  });

  it("exports the prefix as a named const for documentation", () => {
    expect(CONTINUATION_HMAC_PREFIX).toBe("a2a-continuation:v1:");
  });
});
```

- [ ] **Step 2: Run it, fail on missing module**

```
cd server && npx vitest run src/lib/continuationToken.test.ts
```

- [ ] **Step 3: Implement**

Create `server/src/lib/continuationToken.ts`:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC input prefix — the DOMAIN SEPARATOR between attribution tokens and
 * continuation tokens. Attribution tokens sign the base64url payload string
 * directly (see server/src/lib/tracked-url.ts). Continuation tokens prepend
 * this literal ASCII string, so on the same signing key the HMACs can never
 * collide and an attribution token cannot be replayed as a continuation token
 * or vice versa.
 */
export const CONTINUATION_HMAC_PREFIX = "a2a-continuation:v1:";

const EXPIRY_SECONDS = 3600; // 1 hour

export interface ContinuationPayload {
  ticket: string;
  business_slug: string;
  agent_id?: string;
  scope: "confirm" | "continue";
  ts: number; // Unix seconds; set by mintContinuationToken
}

export type ContinuationError = "malformed" | "bad_signature" | "expired";

export function mintContinuationToken(
  claim: Omit<ContinuationPayload, "ts">,
  signingKey: string,
  opts?: { overrideTs?: number }
): string {
  const payload: ContinuationPayload = {
    ...claim,
    ts: opts?.overrideTs ?? Math.floor(Date.now() / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", signingKey)
    .update(CONTINUATION_HMAC_PREFIX + encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyContinuationToken(token: string, signingKey: string): ContinuationPayload {
  const dot = token.lastIndexOf(".");
  if (dot < 1 || dot === token.length - 1) throw "malformed" satisfies ContinuationError;

  const encoded = token.slice(0, dot);
  const givenSig = token.slice(dot + 1);
  const expectedSig = createHmac("sha256", signingKey)
    .update(CONTINUATION_HMAC_PREFIX + encoded)
    .digest("base64url");

  const a = Buffer.from(givenSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw "bad_signature" satisfies ContinuationError;

  let payload: ContinuationPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ContinuationPayload;
  } catch {
    throw "malformed" satisfies ContinuationError;
  }
  if (
    typeof payload.ticket !== "string" ||
    typeof payload.business_slug !== "string" ||
    typeof payload.ts !== "number" ||
    (payload.scope !== "confirm" && payload.scope !== "continue") ||
    (payload.agent_id !== undefined && typeof payload.agent_id !== "string")
  ) {
    throw "malformed" satisfies ContinuationError;
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - payload.ts > EXPIRY_SECONDS) throw "expired" satisfies ContinuationError;
  return payload;
}
```

- [ ] **Step 4: Run tests + typecheck**

```
cd server && npx vitest run src/lib/continuationToken.test.ts && npx tsc --noEmit
```

Expected: 6/6 green.

- [ ] **Step 5: Full suite**

```
cd server && npx vitest run
```

Expected: green.

- [ ] **Step 6: Commit**

```
git add server/src/lib/continuationToken.ts server/src/lib/continuationToken.test.ts
git commit -m "feat(lib): continuation tokens with domain-separated HMAC prefix"
```

---

## Task 8: `reserve_slot` tool

**Files:**
- Create: `server/src/mcp/tools/reserveSlot.ts`
- Create: `server/src/mcp/tools/reserveSlot.test.ts`
- Modify: `server/src/manifest/tools.ts`
- Modify: `server/src/manifest/descriptor.ts`
- Modify: `server/src/routes/mcp.ts`

**Contract:**
- Input: `{slug, window_start, window_end, agent_id?, customer_contact, idempotency_key}`.
- Output: `{reservation_id, status: "held", confirmation_token, expires_at}`.
- Idempotency: if `idempotency_key` already exists, return the existing reservation (same reservation_id + re-minted confirmation_token) without inserting.
- Expiry: 15 min (`900s`) from `requested_at`.
- Uses `mintContinuationToken({ticket: reservation_id, business_slug, agent_id, scope: "confirm"}, TOKEN_SIGNING_KEY)`.
- TOKEN_SIGNING_KEY env var: falls back to `"dev-insecure-key"` in non-production (same pattern as existing attribution token code), logs a warning. Prod deploy REQUIRES it set.

- [ ] **Step 1: Write the failing test**

Create `server/src/mcp/tools/reserveSlot.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../db/migrations.js";

// We inject a fresh in-memory DB per test by re-importing the module and pointing getDb at it.

async function fresh() {
  process.env.DATABASE_PATH = ":memory:";
  process.env.TOKEN_SIGNING_KEY = "test-key-s9";
  const dbMod = await import("../../db.js");
  const db = (dbMod as unknown as { __getRawForTest?: () => Database.Database }).__getRawForTest?.();
  if (db) applyMigrations(db);
  // Seed a business
  dbMod.getDb().prepare(`
    INSERT INTO businesses (id, slug, name, api_key) VALUES ('b1','acme','Acme','k1')
    ON CONFLICT(slug) DO NOTHING
  `).run();
  return dbMod;
}

describe("reserve_slot", () => {
  it("creates a held reservation and returns a confirmation_token", async () => {
    await fresh();
    const { handleReserveSlot } = await import("./reserveSlot.js");
    const res = await handleReserveSlot({
      slug: "acme",
      window_start: 1776215400,
      window_end: 1776215400 + 1800,
      agent_id: "claude-desktop",
      customer_contact: { name: "Alice", email: "a@x.com" },
      idempotency_key: "k-1",
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content[0] as { text: string }).text) as {
      reservation_id: string; status: string; confirmation_token: string; expires_at: number;
    };
    expect(body.status).toBe("held");
    expect(body.reservation_id).toMatch(/^r_/);
    expect(body.confirmation_token.split(".").length).toBe(2);
    expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now()/1000));
  });

  it("idempotency: same idempotency_key returns the same reservation_id", async () => {
    await fresh();
    const { handleReserveSlot } = await import("./reserveSlot.js");
    const args = {
      slug: "acme", window_start: 1776215400, window_end: 1776215400 + 1800,
      customer_contact: { name: "Alice" }, idempotency_key: "k-dup",
    };
    const a = JSON.parse(((await handleReserveSlot(args)).content[0] as { text: string }).text);
    const b = JSON.parse(((await handleReserveSlot(args)).content[0] as { text: string }).text);
    expect(b.reservation_id).toBe(a.reservation_id);
  });

  it("rejects unknown business", async () => {
    await fresh();
    const { handleReserveSlot } = await import("./reserveSlot.js");
    const res = await handleReserveSlot({
      slug: "nope", window_start: 1, window_end: 2,
      customer_contact: {}, idempotency_key: "k-bad",
    });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Add a `__getRawForTest` accessor to `db.ts`**

Modify `server/src/db.ts`. Export at module level (guarded for non-test to discourage accidental use):

```typescript
// Test-only: expose the raw better-sqlite3 handle so tests can run migrations
// inline without importing the private module state. Not for production callers.
export function __getRawForTest(): unknown {
  return getDb();
}
```

(This is a deliberate narrow escape hatch — keeps tests from duplicating the getDb wiring.)

- [ ] **Step 3: Implement `reserve_slot`**

Create `server/src/mcp/tools/reserveSlot.ts`:

```typescript
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { reserveSlotInput } from "../../manifest/tools.js";
import { mintContinuationToken } from "../../lib/continuationToken.js";
import { sweepExpiredReservations } from "../../jobs/expirySweeper.js";
import type { ReservationRow } from "../../db.js";

const HOLD_SECONDS = 900; // 15 min

function signingKey(): string {
  const k = process.env.TOKEN_SIGNING_KEY;
  if (k) return k;
  if (process.env.NODE_ENV === "production") {
    throw new Error("TOKEN_SIGNING_KEY must be set in production");
  }
  return "dev-insecure-key";
}

export async function handleReserveSlot(
  input: z.infer<typeof reserveSlotInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const db = getDb();
  // Clean expired rows before we might insert.
  sweepExpiredReservations(db);

  const biz = db.prepare(`SELECT slug FROM businesses WHERE slug = ?`).get(input.slug);
  if (!biz) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }] };
  }

  // Idempotency check
  const existing = db.prepare(`SELECT * FROM reservations WHERE idempotency_key = ?`).get(input.idempotency_key) as ReservationRow | undefined;
  if (existing) {
    const confirmation_token = mintContinuationToken(
      { ticket: existing.id, business_slug: existing.business_slug, agent_id: existing.agent_id ?? undefined, scope: "confirm" },
      signingKey()
    );
    return {
      content: [{ type: "text", text: JSON.stringify({
        reservation_id: existing.id,
        status: existing.status,
        confirmation_token,
        expires_at: existing.expires_at,
        idempotent_replay: true,
      }) }],
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const reservation_id = `r_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const expires_at = now + HOLD_SECONDS;
  const confirmation_token = mintContinuationToken(
    { ticket: reservation_id, business_slug: input.slug, agent_id: input.agent_id, scope: "confirm" },
    signingKey()
  );

  db.prepare(`
    INSERT INTO reservations (id, business_slug, agent_id, requested_at, window_start, window_end,
      status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)
  `).run(
    reservation_id, input.slug, input.agent_id ?? null, now,
    input.window_start, input.window_end,
    confirmation_token, JSON.stringify(input.customer_contact),
    input.idempotency_key, expires_at
  );

  return {
    content: [{ type: "text", text: JSON.stringify({
      reservation_id, status: "held", confirmation_token, expires_at,
    }) }],
  };
}

export function registerReserveSlot(server: McpServer): void {
  server.tool(
    "reserve_slot",
    "Create a 15-minute HELD reservation. Return a confirmation_token the agent posts to /a2a/confirm to flip to CONFIRMED.",
    reserveSlotInput.shape,
    async (args) => handleReserveSlot(args)
  );
}
```

- [ ] **Step 4: Add the zod shape**

Modify `server/src/manifest/tools.ts`:

```typescript
export const reserveSlotInput = z.object({
  slug: z.string().min(1),
  window_start: z.number().int().positive(),
  window_end: z.number().int().positive(),
  agent_id: z.string().optional(),
  customer_contact: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  idempotency_key: z.string().min(1),
});
export type ReserveSlotInput = z.infer<typeof reserveSlotInput>;
```

- [ ] **Step 5: Add descriptor entry + wire up**

Modify `server/src/manifest/descriptor.ts`:

```typescript
import { reserveSlotInput } from "./tools.js";
```

Append to `DESCRIPTORS`:

```typescript
{
  name: "reserve_slot",
  description: "Create a 15-min HELD reservation; returns a signed confirmation_token for the agent to post back to /a2a/confirm.",
  inputZod: reserveSlotInput,
  outputSchema: {
    type: "object",
    properties: {
      reservation_id: { type: "string" },
      status: { type: "string" },
      confirmation_token: { type: "string" },
      expires_at: { type: "number" },
    },
  },
  idempotent: true, // idempotency_key enforces at-most-once semantics
  estimated_latency_ms: 100,
  estimated_cost_cents: 0,
},
```

Modify `server/src/routes/mcp.ts`:

```typescript
import { registerReserveSlot } from "../mcp/tools/reserveSlot.js";
```

Inside `createMcpServer()`, after `registerGetQuote(server);`:

```typescript
  registerReserveSlot(server);
```

- [ ] **Step 6: Task 9 implements `sweepExpiredReservations` — stub for now**

To unblock this task, create `server/src/jobs/expirySweeper.ts` with the minimal signature:

```typescript
import type Database from "better-sqlite3";

/** Implemented in full in Task 9. Current stub: no-op to satisfy import. */
export function sweepExpiredReservations(_db: Database.Database): void {
  // stub — Task 9 replaces this body
}
```

- [ ] **Step 7: Run suite + typecheck**

```
cd server && npx vitest run && npx tsc --noEmit
```

Expected: all green; drift test asserts 5 tools.

- [ ] **Step 8: Commit**

```
git add server/src/mcp/tools/reserveSlot.ts server/src/mcp/tools/reserveSlot.test.ts server/src/manifest/tools.ts server/src/manifest/descriptor.ts server/src/routes/mcp.ts server/src/db.ts server/src/jobs/expirySweeper.ts
git commit -m "feat(mcp): reserve_slot tool with idempotency and 15-min HELD semantics"
```

---

## Task 9: Expiry sweeper

**Files:**
- Modify: `server/src/jobs/expirySweeper.ts` (replace stub)
- Create: `server/src/jobs/expirySweeper.test.ts`

**Contract:** `sweepExpiredReservations(db)` synchronously updates rows with `status='held' AND expires_at < now` to `status='expired'`. Returns the number of rows flipped. Safe to call on every `reserve_slot` entry (O(k) where k is number of stale rows).

- [ ] **Step 1: Write the failing test**

Create `server/src/jobs/expirySweeper.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { sweepExpiredReservations } from "./expirySweeper.js";

function seed(db: Database.Database, rows: Array<{ id: string; status: string; expires_at: number }>) {
  const stmt = db.prepare(`
    INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
      status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
    VALUES (?, 'x', 0, 0, 0, ?, 't', '{}', ?, ?)
  `);
  for (const r of rows) stmt.run(r.id, r.status, r.id + "-key", r.expires_at);
}

describe("sweepExpiredReservations", () => {
  it("flips held rows whose expires_at is in the past", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const past = Math.floor(Date.now()/1000) - 10;
    const future = Math.floor(Date.now()/1000) + 10000;
    seed(db, [
      { id: "r1", status: "held", expires_at: past },
      { id: "r2", status: "held", expires_at: future },
      { id: "r3", status: "confirmed", expires_at: past }, // not touched — already confirmed
    ]);
    const n = sweepExpiredReservations(db);
    expect(n).toBe(1);
    const r1 = db.prepare("SELECT status FROM reservations WHERE id='r1'").get() as { status: string };
    expect(r1.status).toBe("expired");
    const r2 = db.prepare("SELECT status FROM reservations WHERE id='r2'").get() as { status: string };
    expect(r2.status).toBe("held");
    const r3 = db.prepare("SELECT status FROM reservations WHERE id='r3'").get() as { status: string };
    expect(r3.status).toBe("confirmed");
  });

  it("returns 0 and makes no writes when nothing is stale", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    seed(db, [{ id: "r1", status: "held", expires_at: Math.floor(Date.now()/1000) + 1000 }]);
    expect(sweepExpiredReservations(db)).toBe(0);
  });
});
```

- [ ] **Step 2: Replace the stub with the real implementation**

Replace the body of `server/src/jobs/expirySweeper.ts`:

```typescript
import type Database from "better-sqlite3";

/**
 * Synchronous sweep: flip status='held' → 'expired' for any reservation whose
 * expires_at is in the past. Returns number of rows updated.
 * Called on entry to reserve_slot so holds don't pile up; no cron needed in v1.
 */
export function sweepExpiredReservations(db: Database.Database): number {
  const now = Math.floor(Date.now() / 1000);
  const res = db.prepare(`
    UPDATE reservations SET status='expired' WHERE status='held' AND expires_at < ?
  `).run(now);
  return res.changes;
}
```

- [ ] **Step 3: Run tests**

```
cd server && npx vitest run src/jobs/expirySweeper.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 4: Full suite + typecheck**

```
cd server && npx vitest run && npx tsc --noEmit
```

Expected: green.

- [ ] **Step 5: Commit**

```
git add server/src/jobs/expirySweeper.ts server/src/jobs/expirySweeper.test.ts
git commit -m "feat(jobs): sweepExpiredReservations — sync sweep on reserve_slot entry"
```

---

## Task 10: Notify adapters (Twilio SMS + SES email via fetch)

**Files:**
- Create: `server/src/lib/notify.ts`
- Create: `server/src/lib/notify.test.ts`

**Contract:**
- `sendSms({to, body})` → `{delivered: boolean, reason: string, ticket_id?: string}`.
- `sendEmail({to, subject, body})` → same shape.
- Twilio: POST `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json` with basic auth. Body URL-encoded.
- SES: POST `https://email.${region}.amazonaws.com/` with AWS SigV4 auth — we intentionally skip that complexity; SES send goes via the HTTP POST to SES SMTP endpoint OR via AWS SDK. Since we forbid SDKs and SigV4 is >200 lines to hand-roll, v1 ONLY implements the "no-op when env absent" path for SES and emits SMS via Twilio. Email real-send is deferred to a follow-up (TODO noted; a user-approved `@aws-sdk/client-ses` dep is the path forward).

- [ ] **Step 1: Write the failing test**

Create `server/src/lib/notify.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const origFetch = globalThis.fetch;

describe("notify — sendSms", () => {
  beforeEach(() => { delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM_NUMBER; });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("returns not_configured when TWILIO_ACCOUNT_SID is absent", async () => {
    const { sendSms } = await import("./notify.js");
    const res = await sendSms({ to: "+15555550123", body: "hi" });
    expect(res).toEqual({ delivered: false, reason: "not_configured" });
  });

  it("POSTs to Twilio and returns delivered:true on HTTP 201", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM_NUMBER = "+15555551000";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ sid: "SM123" }),
    }) as unknown as typeof fetch;
    const { sendSms } = await import("./notify.js");
    const res = await sendSms({ to: "+15555550123", body: "hi" });
    expect(res).toEqual({ delivered: true, reason: "ok", ticket_id: "SM123" });
    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toMatch(/api\.twilio\.com.*Messages\.json/);
  });

  it("returns delivered:false on non-2xx", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM_NUMBER = "+15555551000";
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: "bad" }) }) as unknown as typeof fetch;
    const { sendSms } = await import("./notify.js");
    const res = await sendSms({ to: "+1", body: "x" });
    expect(res.delivered).toBe(false);
    expect(res.reason).toMatch(/http_/);
  });
});

describe("notify — sendEmail", () => {
  it("returns not_configured (v1 email send not implemented)", async () => {
    const { sendEmail } = await import("./notify.js");
    const res = await sendEmail({ to: "a@x.com", subject: "hi", body: "hi" });
    expect(res.delivered).toBe(false);
    expect(res.reason).toMatch(/not_(configured|implemented)/);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/src/lib/notify.ts`:

```typescript
export interface NotifyResult {
  delivered: boolean;
  reason: string;
  ticket_id?: string;
}

/**
 * SMS via Twilio REST. No SDK — fetch + HTTP Basic auth.
 * Returns NotifyResult; never throws. Caller logs + continues.
 * Env gate: if TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER not set → {delivered:false, reason:"not_configured"}.
 */
export async function sendSms(opts: { to: string; body: string }): Promise<NotifyResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !tok || !from) return { delivered: false, reason: "not_configured" };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${tok}`).toString("base64");
  const params = new URLSearchParams({ To: opts.to, From: from, Body: opts.body });
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!resp.ok) return { delivered: false, reason: `http_${resp.status}` };
    const body = (await resp.json()) as { sid?: string };
    return { delivered: true, reason: "ok", ticket_id: body.sid };
  } catch (err) {
    return { delivered: false, reason: "fetch_error" };
  }
}

/**
 * Email via SES.
 * v1: not implemented — AWS SigV4 is >200 lines hand-rolled and we forbid new
 * SDK deps without user approval. Follow-up ticket: approve @aws-sdk/client-ses
 * or introduce a local SigV4 helper.
 * Always returns {delivered:false, reason:"not_implemented"}; caller falls through.
 */
export async function sendEmail(_opts: { to: string; subject: string; body: string }): Promise<NotifyResult> {
  return { delivered: false, reason: "not_implemented" };
}
```

- [ ] **Step 3: Run tests**

```
cd server && npx vitest run src/lib/notify.test.ts
```

Expected: 4/4 pass.

- [ ] **Step 4: Full suite + typecheck**

```
cd server && npx vitest run && npx tsc --noEmit
```

Expected: green.

- [ ] **Step 5: Commit**

```
git add server/src/lib/notify.ts server/src/lib/notify.test.ts
git commit -m "feat(lib): notify adapters — Twilio SMS via fetch; SES deferred (no SDK deps)"
```

---

## Task 11: `/a2a/confirm` + `/a2a/continue/:token` endpoints

**Files:**
- Create: `server/src/routes/a2a.ts`
- Create: `server/src/routes/a2a.test.ts`
- Modify: `server/src/testApp.ts` (mount `a2aRouter`)

**Routes:**
- `POST /a2a/confirm` — body `{confirmation_token}`. Verifies the token (scope: "confirm"), flips `reservations.status` from 'held' → 'confirmed' for the matching ticket. Returns `{reservation_id, status}`. 400 malformed, 401 bad_signature, 404 unknown ticket, 409 already confirmed/expired.
- `POST /a2a/continue/:token` — verifies the URL-embedded token (scope: "continue"), returns the continuation payload envelope + any `handoffs` row data. This is the "agent-mode handoff" consumer — Task 12 mints the URL that lands here.

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/a2a.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { mintContinuationToken } from "../lib/continuationToken.js";

describe("POST /a2a/confirm", () => {
  let app: import("express").Express;
  const KEY = "test-key-a2a";

  beforeAll(async () => {
    process.env.DATABASE_PATH ??= ":memory:";
    process.env.ANTHROPIC_API_KEY = "t";
    process.env.TOKEN_SIGNING_KEY = KEY;
    const { createTestApp } = await import("../testApp.js");
    app = createTestApp();

    // Seed a held reservation
    const { getDb } = await import("../db.js");
    const { applyMigrations } = await import("../db/migrations.js");
    // applyMigrations is called inside getDb() chain — but double-calling is idempotent per migration runner.
    // Ensure schema exists:
    const { __getRawForTest } = await import("../db.js");
    applyMigrations(__getRawForTest() as import("better-sqlite3").Database);
    getDb().prepare(`
      INSERT INTO businesses (id, slug, name, api_key) VALUES ('b1','acme','Acme','k')
      ON CONFLICT(slug) DO NOTHING
    `).run();
    getDb().prepare(`
      INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
      VALUES ('r_heldone', 'acme', 1, 1, 2, 'held', 'x', '{}', 'ik-1', 9999999999)
    `).run();
  });

  it("flips held → confirmed on valid token", async () => {
    const tok = mintContinuationToken(
      { ticket: "r_heldone", business_slug: "acme", scope: "confirm" },
      "test-key-a2a"
    );
    const res = await request(app).post("/a2a/confirm").send({ confirmation_token: tok });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reservation_id: "r_heldone", status: "confirmed" });
  });

  it("returns 409 if already confirmed", async () => {
    const tok = mintContinuationToken(
      { ticket: "r_heldone", business_slug: "acme", scope: "confirm" },
      "test-key-a2a"
    );
    const res = await request(app).post("/a2a/confirm").send({ confirmation_token: tok });
    expect(res.status).toBe(409);
  });

  it("returns 401 on bad signature", async () => {
    const res = await request(app).post("/a2a/confirm").send({ confirmation_token: "aaa.bbb" });
    expect([400, 401]).toContain(res.status);
  });

  it("returns 400 on missing token", async () => {
    const res = await request(app).post("/a2a/confirm").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /a2a/continue/:token", () => {
  let app: import("express").Express;
  const KEY = "test-key-a2a";

  beforeAll(async () => {
    process.env.DATABASE_PATH ??= ":memory:";
    process.env.ANTHROPIC_API_KEY = "t";
    process.env.TOKEN_SIGNING_KEY = KEY;
    const { createTestApp } = await import("../testApp.js");
    app = createTestApp();
  });

  it("returns the decoded payload for a valid continue-scoped token", async () => {
    const tok = mintContinuationToken(
      { ticket: "h_1", business_slug: "acme", scope: "continue" },
      KEY
    );
    const res = await request(app).post(`/a2a/continue/${encodeURIComponent(tok)}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ticket).toBe("h_1");
    expect(res.body.business_slug).toBe("acme");
  });

  it("returns 401 for a confirm-scoped token presented here", async () => {
    const tok = mintContinuationToken(
      { ticket: "h_1", business_slug: "acme", scope: "confirm" },
      KEY
    );
    const res = await request(app).post(`/a2a/continue/${encodeURIComponent(tok)}`).send({});
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests, expect fail**

```
cd server && npx vitest run src/routes/a2a.test.ts
```

Expected: 404s everywhere (routes don't exist).

- [ ] **Step 3: Implement the router**

Create `server/src/routes/a2a.ts`:

```typescript
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { verifyContinuationToken } from "../lib/continuationToken.js";
import { getDb } from "../db.js";

export const a2aRouter = Router();

function signingKey(): string {
  const k = process.env.TOKEN_SIGNING_KEY;
  if (k) return k;
  if (process.env.NODE_ENV === "production") {
    throw new Error("TOKEN_SIGNING_KEY must be set in production");
  }
  return "dev-insecure-key";
}

const confirmBody = z.object({ confirmation_token: z.string().min(1) });

a2aRouter.post("/a2a/confirm", (req: Request, res: Response) => {
  const parsed = confirmBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
  }
  let payload;
  try {
    payload = verifyContinuationToken(parsed.data.confirmation_token, signingKey());
  } catch (err) {
    const code = err === "expired" || err === "malformed" ? 400 : 401;
    return res.status(code).json({ error: String(err) });
  }
  if (payload.scope !== "confirm") {
    return res.status(401).json({ error: "wrong_scope" });
  }
  const row = getDb().prepare(`SELECT id, status FROM reservations WHERE id = ?`).get(payload.ticket) as { id: string; status: string } | undefined;
  if (!row) return res.status(404).json({ error: "reservation_not_found" });
  if (row.status !== "held") return res.status(409).json({ error: "not_confirmable", current_status: row.status });
  getDb().prepare(`UPDATE reservations SET status='confirmed' WHERE id = ?`).run(row.id);
  return res.status(200).json({ reservation_id: row.id, status: "confirmed" });
});

a2aRouter.post("/a2a/continue/:token", (req: Request, res: Response) => {
  let payload;
  try {
    payload = verifyContinuationToken(req.params.token ?? "", signingKey());
  } catch (err) {
    const code = err === "expired" || err === "malformed" ? 400 : 401;
    return res.status(code).json({ error: String(err) });
  }
  if (payload.scope !== "continue") {
    return res.status(401).json({ error: "wrong_scope" });
  }
  // v1: echo the payload. Task 12 will enrich with handoffs-row data if present.
  return res.status(200).json({
    ticket: payload.ticket,
    business_slug: payload.business_slug,
    agent_id: payload.agent_id ?? null,
    ts: payload.ts,
  });
});
```

- [ ] **Step 4: Mount in `testApp.ts`**

Modify `server/src/testApp.ts`. Add import:

```typescript
import { a2aRouter } from "./routes/a2a.js";
```

After `app.use(mcpRouter);`:

```typescript
  app.use(a2aRouter);
```

- [ ] **Step 5: Run tests**

```
cd server && npx vitest run src/routes/a2a.test.ts
```

Expected: 6/6 pass.

- [ ] **Step 6: Full suite + typecheck**

```
cd server && npx vitest run && npx tsc --noEmit
```

Expected: green.

- [ ] **Step 7: Commit**

```
git add server/src/routes/a2a.ts server/src/routes/a2a.test.ts server/src/testApp.ts
git commit -m "feat(a2a): /a2a/confirm flips held→confirmed; /a2a/continue/:token consumes agent handoff"
```

---

## Task 12: `initiate_handoff` tool (both modes)

**Files:**
- Create: `server/src/mcp/tools/initiateHandoff.ts`
- Create: `server/src/mcp/tools/initiateHandoff.test.ts`
- Modify: `server/src/manifest/tools.ts`
- Modify: `server/src/manifest/descriptor.ts`
- Modify: `server/src/routes/mcp.ts`

**Input shape (discriminated union via zod):**

```typescript
{ slug, reservation_id?, mode: "human", payload: { message: string } }
{ slug, reservation_id?, mode: "agent",   payload: { purpose: string } }
```

**Behavior:**
- `mode: "human"`: read `businesses.lead_routing_json`, pick preferred channel (`sms` or `email`), call `notify.sendSms`/`sendEmail`. Insert a `handoffs` row; return `{mode:"human", delivered_via, ticket_id}` (ticket_id = the notify result's ticket_id or a generated handoff id on `not_configured`).
- `mode: "agent"`: mint a continuation URL (`${apiBase}/a2a/continue/${continuationToken}`), insert a `handoffs` row, return `{mode:"agent", continuation_url, expires_at, handshake_token}`. The handshake_token equals the URL's token substring — redundant but explicit for clients that want to verify out-of-band.
- Both: unknown slug → `isError: true`.

- [ ] **Step 1: Write the failing test**

Create `server/src/mcp/tools/initiateHandoff.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

async function fresh() {
  process.env.DATABASE_PATH = ":memory:";
  process.env.TOKEN_SIGNING_KEY = "test-key-ih";
  process.env.API_BASE_URL = "https://api.test";
  const dbMod = await import("../../db.js");
  const { applyMigrations } = await import("../../db/migrations.js");
  applyMigrations((dbMod as unknown as { __getRawForTest: () => import("better-sqlite3").Database }).__getRawForTest());
  dbMod.getDb().prepare(`
    INSERT INTO businesses (id, slug, name, api_key, lead_routing_json)
    VALUES ('b1','acme','Acme','k', json('{"preferred":"sms","sms_to":"+15555550123"}'))
    ON CONFLICT(slug) DO NOTHING
  `).run();
  return dbMod;
}

describe("initiate_handoff — human mode", () => {
  it("calls notify.sendSms and writes handoffs row", async () => {
    await fresh();
    vi.doMock("../../lib/notify.js", () => ({
      sendSms: vi.fn().mockResolvedValue({ delivered: true, reason: "ok", ticket_id: "SM1" }),
      sendEmail: vi.fn(),
    }));
    vi.resetModules();
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "acme", mode: "human", payload: { message: "User wants a callback" },
    });
    const body = JSON.parse((res.content[0] as { text: string }).text) as { mode: string; delivered_via: string; ticket_id: string };
    expect(body.mode).toBe("human");
    expect(body.delivered_via).toBe("sms");
    expect(body.ticket_id).toBe("SM1");
  });

  it("falls through gracefully when notify returns not_configured", async () => {
    await fresh();
    vi.doMock("../../lib/notify.js", () => ({
      sendSms: vi.fn().mockResolvedValue({ delivered: false, reason: "not_configured" }),
      sendEmail: vi.fn(),
    }));
    vi.resetModules();
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "acme", mode: "human", payload: { message: "test" },
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content[0] as { text: string }).text);
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("not_configured");
  });
});

describe("initiate_handoff — agent mode", () => {
  it("mints a continuation URL and writes handoffs row", async () => {
    await fresh();
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "acme", mode: "agent", payload: { purpose: "price negotiation" },
    });
    const body = JSON.parse((res.content[0] as { text: string }).text) as { mode: string; continuation_url: string; expires_at: number; handshake_token: string };
    expect(body.mode).toBe("agent");
    expect(body.continuation_url).toMatch(/^https:\/\/api\.test\/a2a\/continue\//);
    expect(body.handshake_token.split(".").length).toBe(2);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/src/mcp/tools/initiateHandoff.ts`:

```typescript
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { initiateHandoffInput } from "../../manifest/tools.js";
import { mintContinuationToken } from "../../lib/continuationToken.js";
import { sendSms, sendEmail } from "../../lib/notify.js";

function apiBase(): string {
  return process.env.API_BASE_URL ?? "https://api.advocatemcp.com";
}
function signingKey(): string {
  const k = process.env.TOKEN_SIGNING_KEY;
  if (k) return k;
  if (process.env.NODE_ENV === "production") throw new Error("TOKEN_SIGNING_KEY must be set in production");
  return "dev-insecure-key";
}

interface LeadRouting {
  preferred?: "sms" | "email";
  sms_to?: string;
  email_to?: string;
}

export async function handleInitiateHandoff(
  input: z.infer<typeof initiateHandoffInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const db = getDb();
  const biz = db.prepare(`SELECT slug, lead_routing_json FROM businesses WHERE slug = ?`).get(input.slug) as { slug: string; lead_routing_json: string | null } | undefined;
  if (!biz) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "business_not_found" }) }] };
  }

  const handoff_id = `h_${randomUUID().replace(/-/g,"").slice(0,20)}`;

  if (input.mode === "human") {
    let routing: LeadRouting = {};
    if (biz.lead_routing_json) {
      try { routing = JSON.parse(biz.lead_routing_json) as LeadRouting; } catch { /* ignore */ }
    }
    const channel = routing.preferred ?? "sms";
    const notifyRes = channel === "sms"
      ? await sendSms({ to: routing.sms_to ?? "", body: input.payload.message })
      : await sendEmail({ to: routing.email_to ?? "", subject: "New lead", body: input.payload.message });

    db.prepare(`
      INSERT INTO handoffs (id, business_slug, reservation_id, mode, delivered_via, ticket_id, agent_id)
      VALUES (?, ?, ?, 'human', ?, ?, ?)
    `).run(handoff_id, input.slug, input.reservation_id ?? null, channel, notifyRes.ticket_id ?? handoff_id, null);

    if (notifyRes.delivered) {
      return { content: [{ type: "text", text: JSON.stringify({
        mode: "human", delivered_via: channel, ticket_id: notifyRes.ticket_id ?? handoff_id,
      }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({
      mode: "human", delivered: false, reason: notifyRes.reason, handoff_id,
    }) }] };
  }

  // mode === "agent"
  const token = mintContinuationToken(
    { ticket: handoff_id, business_slug: input.slug, scope: "continue" },
    signingKey()
  );
  const continuation_url = `${apiBase()}/a2a/continue/${token}`;
  const expires_at = Math.floor(Date.now()/1000) + 3600;

  db.prepare(`
    INSERT INTO handoffs (id, business_slug, reservation_id, mode, continuation_url, handshake_token, agent_id)
    VALUES (?, ?, ?, 'agent', ?, ?, ?)
  `).run(handoff_id, input.slug, input.reservation_id ?? null, continuation_url, token, null);

  return { content: [{ type: "text", text: JSON.stringify({
    mode: "agent", continuation_url, expires_at, handshake_token: token,
  }) }] };
}

export function registerInitiateHandoff(server: McpServer): void {
  server.tool(
    "initiate_handoff",
    "Begin a handoff from the agent to either a human operator (SMS/email via lead_routing_json) or another agent (signed continuation URL).",
    initiateHandoffInput.shape,
    async (args) => handleInitiateHandoff(args)
  );
}
```

- [ ] **Step 3: Add the zod shape**

Modify `server/src/manifest/tools.ts`:

```typescript
export const initiateHandoffInput = z.discriminatedUnion("mode", [
  z.object({
    slug: z.string().min(1),
    reservation_id: z.string().optional(),
    mode: z.literal("human"),
    payload: z.object({ message: z.string().min(1) }),
  }),
  z.object({
    slug: z.string().min(1),
    reservation_id: z.string().optional(),
    mode: z.literal("agent"),
    payload: z.object({ purpose: z.string().min(1) }),
  }),
]);
export type InitiateHandoffInput = z.infer<typeof initiateHandoffInput>;
```

**Note on descriptor:** `zodToJsonSchema` does not yet handle `ZodDiscriminatedUnion`. Before landing this shape in DESCRIPTORS, extend the converter:

- [ ] **Step 4: Extend `zodToJsonSchema` for `ZodDiscriminatedUnion`**

Modify `server/src/manifest/schema.ts`. Inside `zodToJsonSchema`:

```typescript
  if (def.typeName === "ZodDiscriminatedUnion") {
    const options = (def as { options?: ZodTypeAny[] }).options ?? [];
    return {
      oneOf: options.map((o) => zodToJsonSchema(o)),
    };
  }
```

Append a test in `server/src/manifest/schema.test.ts`:

```typescript
  it("converts discriminated union to oneOf", () => {
    const u = z.discriminatedUnion("k", [
      z.object({ k: z.literal("a"), a: z.string() }),
      z.object({ k: z.literal("b"), b: z.string() }),
    ]);
    const out = zodToJsonSchema(u);
    expect(out).toHaveProperty("oneOf");
    expect((out as { oneOf: unknown[] }).oneOf).toHaveLength(2);
  });
```

**And** extend the converter's `ZodObject` branch to emit `ZodLiteral` fields as `const`:

```typescript
  if (def.typeName === "ZodLiteral") {
    const value = (def as { value?: unknown }).value;
    return { const: value };
  }
```

- [ ] **Step 5: Descriptor entry**

Modify `server/src/manifest/descriptor.ts`:

```typescript
import { initiateHandoffInput } from "./tools.js";
```

Append to DESCRIPTORS:

```typescript
{
  name: "initiate_handoff",
  description: "Start a handoff to a human (SMS/email via tenant routing) or another agent (signed continuation URL).",
  inputZod: initiateHandoffInput,
  outputSchema: {
    oneOf: [
      {
        type: "object",
        properties: {
          mode: { const: "human" },
          delivered_via: { type: "string" },
          ticket_id: { type: "string" },
        },
      },
      {
        type: "object",
        properties: {
          mode: { const: "agent" },
          continuation_url: { type: "string" },
          expires_at: { type: "number" },
          handshake_token: { type: "string" },
        },
      },
    ],
  },
  idempotent: false, // each call creates a new handoffs row + notify side effect
  estimated_latency_ms: 300,
  estimated_cost_cents: 1,
},
```

- [ ] **Step 6: Wire into MCP**

Modify `server/src/routes/mcp.ts`:

```typescript
import { registerInitiateHandoff } from "../mcp/tools/initiateHandoff.js";
```

Inside `createMcpServer()`, after `registerReserveSlot(server);`:

```typescript
  registerInitiateHandoff(server);
```

- [ ] **Step 7: Run tests + drift + typecheck**

```
cd server && npx vitest run && npx tsc --noEmit
```

Expected: all green; drift test asserts 6 tools (`get_availability`, `get_quote`, `initiate_handoff`, `query_business_agent`, `reserve_slot`, `search_businesses`).

- [ ] **Step 8: Commit**

```
git add server/src/mcp/tools/initiateHandoff.ts server/src/mcp/tools/initiateHandoff.test.ts server/src/manifest/tools.ts server/src/manifest/descriptor.ts server/src/manifest/schema.ts server/src/manifest/schema.test.ts server/src/routes/mcp.ts
git commit -m "feat(mcp): initiate_handoff tool (human + agent modes) + zod discriminated union in schema converter"
```

---

## Task 13: Documentation — update `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`

Add a new section after "For contributors adding a tool":

- [ ] **Step 1: Append the section**

Append to `AGENTS.md` (at worktree root):

```markdown
## Transactional tool surface (Session 9)

Four MCP tools let an agent acting on behalf of a user move from discovery to
commitment without leaving MCP:

| Tool | Shape | Side effect |
|---|---|---|
| `get_availability` | `{slug, window_start?, window_end?}` → `{slots[], source, generated_at}` | None (read-only) |
| `get_quote` | `{slug, service, params?}` → `{quote{low,high,currency,confidence,basis,disclaimer?}}` | None (may call Claude for fallback) |
| `reserve_slot` | `{slug, window_*, agent_id?, customer_contact, idempotency_key}` → `{reservation_id, status:"held", confirmation_token, expires_at}` | Writes `reservations` row; 15-min hold |
| `initiate_handoff` | `{slug, mode:"human"\|"agent", ...}` → human: `{delivered_via, ticket_id}`; agent: `{continuation_url, expires_at, handshake_token}` | Writes `handoffs` row; notify side effect on human mode |

### Two extra endpoints

- `POST /a2a/confirm` — body `{confirmation_token}`. Flips reservation `held`→`confirmed`.
- `POST /a2a/continue/:token` — consumes the agent-mode handoff URL; returns the decoded continuation payload.

### HMAC domain separation

Attribution tokens (`/r/:token` on the worker) and continuation tokens (confirmation + handoff) share the same `TOKEN_SIGNING_KEY` but are domain-separated by an HMAC prefix (`"a2a-continuation:v1:"`). A token minted for one purpose CANNOT verify for the other. This means one env var to rotate, zero cross-use attack surface.

### Notify adapters

- SMS: Twilio REST via fetch (HTTP Basic auth). Gate: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`. Absent env → `{delivered:false, reason:"not_configured"}`.
- Email: deferred to v1.x — SES via AWS SigV4 is >200 lines hand-rolled and the project forbids new SDK dependencies without approval.

### Idempotency

`reserve_slot` is the only tool with mutation-idempotency — repeated calls with the same `idempotency_key` return the existing reservation. `initiate_handoff` is NOT idempotent (each call writes a new `handoffs` row + notify side effect); agents should not retry on timeout without user consent.
```

- [ ] **Step 2: Commit**

```
git add AGENTS.md
git commit -m "docs(agents): document Session 9 transactional surface + HMAC domain separation"
```

---

## Final verification

- [ ] **Run the full server suite**

```
cd server && npx vitest run
```

Expected: all green. Target count ~175 (134 baseline + ~40 new across 13 tasks).

- [ ] **Typecheck**

```
cd server && npx tsc --noEmit
```

Expected: clean.

- [ ] **Worker baseline — untouched by Session 9**

```
cd worker && npm test && npx tsc --noEmit
```

Expected: 134/134 unchanged; typecheck clean.

- [ ] **Drift test assertion**

```
cd server && npx vitest run src/manifest/descriptor.test.ts
```

Expected: the drift test prints 6 tool names sorted: `get_availability, get_quote, initiate_handoff, query_business_agent, reserve_slot, search_businesses`.

- [ ] **Manual acceptance**

```
cd server && DATABASE_PATH=:memory: TOKEN_SIGNING_KEY=dev ANTHROPIC_API_KEY=x npx tsx -e '
import("./src/testApp.js").then(async ({ createTestApp }) => {
  const app = createTestApp();
  const { createServer } = await import("http");
  const s = createServer(app);
  s.listen(3099);
  const r = await fetch("http://localhost:3099/.well-known/mcp.json");
  const j = await r.json();
  console.log("tools:", j.tools.map(t => t.name).sort());
  s.close();
});
'
```

Expected output: `tools: [ 'get_availability', 'get_quote', 'initiate_handoff', 'query_business_agent', 'reserve_slot', 'search_businesses' ]`.

---

## Self-Review

**Spec coverage (against master plan Session 9 spec):**

| Spec row | Task |
|---|---|
| `get_availability` synthetic from hours_json | Task 4 |
| `get_quote` deterministic + LLM fallback | Tasks 5 + 6 |
| `reserve_slot` 15-min held + idempotency | Task 8 |
| `initiate_handoff` (human + agent modes both in v1) | Task 12 |
| `reservations` table | Task 1 |
| `handoffs` table | Task 2 |
| `businesses.availability_webhook_url` nullable column | Task 3 |
| `/a2a/confirm` endpoint | Task 11 |
| `/a2a/continue/:token` endpoint | Task 11 |
| Continuation URL domain-separated signing | Task 7 |
| Notify via fetch (no SDK deps) | Task 10 |
| Expiry sweeper | Task 9 |
| Manifest drift test confirms 6 tools | Task 12 Step 7 |
| p95 targets (deterministic quote <200ms, availability <150ms, reserve_slot <100ms) | Acceptance criteria; v1 implementation stays within budget by being pure-SQL / pure-function on hot path |
| Cost target (≥70% deterministic quote hit) | Descriptor cost comment at Task 6 Step 8; measured in Session 11 |

**Placeholder scan:** No `TBD`, `TODO except where explicitly flagged (SES deferred)`, `implement later`. Every step has complete code.

**Type-consistency:**
- `mintContinuationToken` / `verifyContinuationToken` same signatures across Tasks 7, 8, 11, 12 ✓
- `ReservationRow` / `HandoffRow` shapes match migration columns in Tasks 1, 2 vs Tasks 8, 11, 12 ✓
- `CONTINUATION_HMAC_PREFIX` literal `"a2a-continuation:v1:"` used consistently ✓
- `sendSms` / `sendEmail` / `NotifyResult` shape same across Tasks 10 and 12 ✓
- `deterministicQuote` return type `Quote | null` same across Tasks 5 and 6 ✓

**Known non-blocking items surfaced:**
- SES send deferred; documented in `AGENTS.md` and in `notify.ts`. Follow-up ticket to land when user approves `@aws-sdk/client-ses`.
- `zodToJsonSchema` now supports `ZodRecord` (Task 5) and `ZodDiscriminatedUnion` + `ZodLiteral` (Task 12). Future shapes (e.g., `ZodArray` of complex objects) may still need incremental extension — that's the cost of hand-rolling the converter per Session 8 design decision.
- Continuation token expiry is fixed at 1h. If a follow-up needs longer handoff windows, parameterize `EXPIRY_SECONDS` — but any change ALSO needs updating `/a2a/continue` consumers that trust expiry.
- The `__getRawForTest` escape hatch in `db.ts` (Task 8 Step 2) is a test-only seam. If a migration-heavy Session 10/11 needs it too, promote to a documented pattern; if not, remove after Session 11.

Plan complete.
