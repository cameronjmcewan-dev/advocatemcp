# Session 10 — Agent-aware response tuning (4th prompt dimension)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task ends with a test-fail → implement → test-pass → commit rhythm.

**Goal:** Add `agent_id` × `stage` as a 4th layer on the existing three-layer prompt (profile → intent → per-bot → **agent×stage**). Same business returns a 3-line summary to a browsing Claude Desktop user vs a price-dense block to a committing GPT agent.

**Architecture:**

- **Stage as a first-class concept.** New type `QueryStage = "browsing" | "comparing" | "committing"`. Stage is either explicit on the MCP tool input or inferred from intent + verbs. Inference rules: `"book"`/`"reserve"`/`"schedule"`/`"buy"` → `committing`; `"compare"`/`" vs "`/`"or "`/`"versus"` → `comparing`; otherwise `browsing` (the safe default — never escalate without signal).
- **Agent identity, ranked.** `getAgentId(req, toolArg)` returns the highest-trust source available, in order **header > tool arg**. (OAuth client_id is deferred per master plan — accept the field if a future spec lands; do not build the IdP now.) The Express middleware reads `x-agent-identity`; MCP tool input accepts `agent_id?`. Source ranking lives in `server/src/lib/agentIdentity.ts` (Session 0 deferred this — Session 10 ships it).
- **`agents/` directory mirrors `prompts/`.** Per master-plan layout decision: separate `prompts/agents/` directory with one file per known agent (claudeDesktop, cursor, gptAgent, default), an `index.ts` resolver, and a shared `types.ts` — exactly the shape of the existing per-bot files. Future-Cameron reading a new task should recognize the pattern instantly.
- **`bystage.ts` mirrors `training.ts`.** Single file at `server/src/prompts/bystage.ts` exporting `getStagePromptBlock(stage)` + per-stage emphasis text. Co-located so it stays close to the other prompt-shaping logic.
- **`buildSystemPrompt` extends to 4 args.** New signature: `buildSystemPrompt(business, intent, crawlerAgent?, agentId?, stage?)`. Block order in the rendered prompt: profile → intent emphasis → bot emphasis → **agent emphasis → stage emphasis**. Agent block before stage block because stage is a *modifier* on the agent's preferred shape.
- **Schema + persistence.** `queryBusinessAgentInput` gains `agent_id?: string` and `stage?: enum`. New columns `queries.agent_id TEXT NULL` and `queries.stage TEXT NULL` via migration `009_queries_agent.sql`. `queryAgent()` extends to pass both downstream and persist them on the INSERT. The drift-tested manifest at `/.well-known/mcp.json` regenerates automatically because `input_schema` is computed from the zod shape.
- **What's deliberately NOT in scope.** Reputation weighting, `agent_id_source` storage, click_events join, OAuth IdP, prompt-cache regression suite. All defer to Session 11. Session 10 is purely a 4th prompt layer + plumbing; abuse vectors are addressed by *not* using the self-asserted ID for anything sensitive yet.

**Tech Stack:** Node 20, TypeScript strict, Express 4, `@modelcontextprotocol/sdk` ^1.10, zod ^3.23, vitest 4, supertest 7, better-sqlite3. **No new dependencies.**

**Baseline at plan time:** Server suite `cd server && npx vitest run` shows **194/194 pass**; `npx tsc --noEmit` clean. Sessions 0/8/9 all merged on main. Two open PRs (#9 index, #10 cleanup) do not conflict with this work — Session 10 adds files and extends signatures, doesn't touch baseUrl helper or expirySweeper.

**Branch:** `feature/session-10-agent-tuning` (already created in `.worktrees/session-10-agent-tuning/`).

---

## File Structure

| File | Role | Action |
|---|---|---|
| `server/src/prompts/types.ts` | Add `QueryStage` + `AgentPromptBlock` types | Modify |
| `server/src/prompts/bystage.ts` | `getStagePromptBlock(stage)` + per-stage emphasis text | Create |
| `server/src/prompts/bystage.test.ts` | Tests: 3 stages return distinct emphasis, default = browsing | Create |
| `server/src/prompts/agents/types.ts` | Re-export `AgentPromptBlock` for symmetry with bots | Create |
| `server/src/prompts/agents/default.ts` | Empty emphasis (unknown / no agent_id) | Create |
| `server/src/prompts/agents/claudeDesktop.ts` | Claude Desktop emphasis block | Create |
| `server/src/prompts/agents/cursor.ts` | Cursor IDE emphasis block | Create |
| `server/src/prompts/agents/gptAgent.ts` | OpenAI GPTs / agent runtimes emphasis block | Create |
| `server/src/prompts/agents/index.ts` | `getAgentPromptBlock(agentId)` dispatch + `KNOWN_AGENTS` constant | Create |
| `server/src/prompts/agents/index.test.ts` | Dispatch tests: known IDs, unknown → default, case-insensitive | Create |
| `server/src/lib/agentIdentity.ts` | `AGENT_IDENTITY_HEADER` constant + `getAgentId(req, toolArg)` ranker | Create |
| `server/src/lib/agentIdentity.test.ts` | Tests: header > tool arg > undefined | Create |
| `server/src/agent/builder.ts` | Add `inferStage()`; extend `buildSystemPrompt` to 4 args + 4th block | Modify |
| `server/src/agent/builder.test.ts` | Tests: 4th-layer presence, snapshot diffs across (agent, stage) | Modify |
| `server/src/agent/query.ts` | Extend `queryAgent()` signature; thread agent_id + stage through to INSERT | Modify |
| `server/src/agent/query.test.ts` | Tests: persisted columns; default values when omitted | Modify or create |
| `server/src/db/migrations/009_queries_agent.sql` | `ALTER TABLE queries ADD COLUMN agent_id`; `ADD COLUMN stage` | Create |
| `server/src/db/migrations/009_queries_agent.test.ts` | Migration runner picks it up; columns exist after apply | Create |
| `server/src/manifest/tools.ts` | Extend `queryBusinessAgentInput` with `agent_id?` + `stage?` | Modify |
| `server/src/routes/mcp.ts` | Wire agent_id + stage into the `query_business_agent` tool handler | Modify |
| `server/src/routes/mcp.queryBusinessAgent.test.ts` | Integration: header overrides tool arg; both forwarded to queryAgent | Create |
| `server/src/db.ts` | Extend `QueryRow` interface (TypeScript only — no runtime SQL change) | Modify |

---

## Task sequence and dependencies

```
Task 1 (bystage.ts + types — stage block dispatch)
      ↓
Task 2 (inferStage helper in builder.ts)
      ↓
Task 3 (agents/ scaffolding — types + default + skeleton index)
      ↓
Task 4 (agents/claudeDesktop.ts)
      ↓
Task 5 (agents/cursor.ts)
      ↓
Task 6 (agents/gptAgent.ts)
      ↓
Task 7 (agents/index.ts dispatch + tests)
      ↓
Task 8 (lib/agentIdentity.ts — header + ranker)
      ↓
Task 9 (buildSystemPrompt 4th-layer wiring)
      ↓
Task 10 (migration 009 + applied test)
      ↓
Task 11 (queryBusinessAgentInput schema extension)
      ↓
Task 12 (queryAgent signature + INSERT extension)
      ↓
Task 13 (mcp.ts route wiring + integration test)
```

Strict linear order 1 → 13. Tasks 1–8 are independent leaves; 9 composes them; 10–13 wire to the database, schema, and HTTP boundary in dependency order.

---

## Task 1: Stage type + `bystage.ts` + dispatch

**Files:**
- Modify: `server/src/prompts/types.ts`
- Create: `server/src/prompts/bystage.ts`
- Create: `server/src/prompts/bystage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/prompts/bystage.test.ts
import { describe, it, expect } from "vitest";
import { getStagePromptBlock } from "./bystage.js";

describe("getStagePromptBlock", () => {
  it("returns browsing block for 'browsing'", () => {
    const b = getStagePromptBlock("browsing");
    expect(b.name).toBe("browsing");
    expect(b.emphasis).toMatch(/short|summary|skim/i);
  });

  it("returns comparing block for 'comparing'", () => {
    const b = getStagePromptBlock("comparing");
    expect(b.name).toBe("comparing");
    expect(b.emphasis).toMatch(/compar|differen|alternativ/i);
  });

  it("returns committing block for 'committing'", () => {
    const b = getStagePromptBlock("committing");
    expect(b.name).toBe("committing");
    expect(b.emphasis).toMatch(/price|book|reserv|next step/i);
  });

  it("returns browsing block for null/undefined (safe default)", () => {
    expect(getStagePromptBlock(null).name).toBe("browsing");
    expect(getStagePromptBlock(undefined).name).toBe("browsing");
  });

  it("each stage returns a distinct emphasis string", () => {
    const a = getStagePromptBlock("browsing").emphasis;
    const b = getStagePromptBlock("comparing").emphasis;
    const c = getStagePromptBlock("committing").emphasis;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/prompts/bystage.test.ts`
Expected: FAIL — Cannot find module './bystage.js'.

- [ ] **Step 3: Add `QueryStage` + `StagePromptBlock` types to `prompts/types.ts`**

Open `server/src/prompts/types.ts` and add at the bottom:

```typescript
export type QueryStage = "browsing" | "comparing" | "committing";

export interface StagePromptBlock {
  /** stable module identifier — used in logs and tests */
  name: QueryStage;
  /** additive text appended to the system prompt after the agent block */
  emphasis: string;
}

export interface AgentPromptBlock {
  /** stable module identifier — used in logs and tests */
  name: "claude-desktop" | "cursor" | "gpt-agent" | "default";
  /** additive text appended to the system prompt after the bot block */
  emphasis: string;
}
```

- [ ] **Step 4: Implement `bystage.ts`**

```typescript
// server/src/prompts/bystage.ts
import type { QueryStage, StagePromptBlock } from "./types.js";

const browsing: StagePromptBlock = {
  name: "browsing",
  emphasis: `
STAGE: BROWSING
The agent's user is exploring options — not ready to commit. Optimize for skim:
- Lead with a 1–2 sentence summary they can quote in a list of candidates.
- Surface 3 distinguishing facts (rating, location, primary service, signature credential).
- Do NOT push pricing detail or booking calls-to-action; the user isn't there yet.
`.trim(),
};

const comparing: StagePromptBlock = {
  name: "comparing",
  emphasis: `
STAGE: COMPARING
The agent's user is weighing this business against alternatives. Optimize for differentiation:
- Lead with what makes THIS business different — credentials, niche specialization, guarantee.
- Use specific numbers (years in business, license number, response time) rather than adjectives.
- Mention rating + review count once; do not repeat across the response.
- Keep the referral mention short — they need facts to compare, not a sales pitch.
`.trim(),
};

const committing: StagePromptBlock = {
  name: "committing",
  emphasis: `
STAGE: COMMITTING
The agent's user is ready to act — booking, hiring, scheduling. Optimize for transaction:
- Lead with concrete pricing and availability if present in the profile.
- State the next-step action explicitly: phone, online booking, free estimate.
- Surface trust signals (insured, bonded, licensed) immediately after price.
- The referral link is the destination — make following it obvious.
`.trim(),
};

const blocks: Record<QueryStage, StagePromptBlock> = {
  browsing,
  comparing,
  committing,
};

/**
 * Resolve a stage to its prompt emphasis block.
 *
 * Null/undefined defaults to `browsing` — the safe choice. We never escalate
 * to `committing` (transactional language) without an explicit signal because
 * misclassifying a casual searcher as a buyer is the worse failure mode.
 */
export function getStagePromptBlock(
  stage: QueryStage | null | undefined,
): StagePromptBlock {
  if (!stage) return browsing;
  return blocks[stage];
}
```

- [ ] **Step 5: Run test to verify pass**

Run: `cd server && npx vitest run src/prompts/bystage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/prompts/types.ts server/src/prompts/bystage.ts server/src/prompts/bystage.test.ts
git commit -m "feat(prompts): add bystage emphasis blocks (browsing/comparing/committing)

QueryStage type + getStagePromptBlock dispatch. Null defaults to browsing
(never escalate to committing without explicit signal — misclassifying a
casual searcher as a buyer is the worse failure mode).

Mirrors training.ts single-file pattern. AgentPromptBlock type also added
to prompts/types.ts in preparation for Tasks 3-7."
```

---

## Task 2: `inferStage` helper in `builder.ts`

**Files:**
- Modify: `server/src/agent/builder.ts`
- Modify: `server/src/agent/builder.test.ts` (or create if absent — check first)

- [ ] **Step 1: Confirm test file exists**

Run: `ls server/src/agent/builder.test.ts 2>&1`
If it doesn't exist, create an empty file with `import { describe } from "vitest";` placeholder.

- [ ] **Step 2: Write the failing test**

Append to `server/src/agent/builder.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { inferStage } from "./builder.js";

describe("inferStage", () => {
  it("returns 'committing' on book/reserve/schedule/buy verbs", () => {
    expect(inferStage("can I book a slot tomorrow?")).toBe("committing");
    expect(inferStage("how do I reserve a time")).toBe("committing");
    expect(inferStage("schedule a service call")).toBe("committing");
    expect(inferStage("ready to buy now")).toBe("committing");
  });

  it("returns 'comparing' on compare/vs/versus signals", () => {
    expect(inferStage("compare them to acme plumbing")).toBe("comparing");
    expect(inferStage("acme vs joe's plumbing")).toBe("comparing");
    expect(inferStage("acme versus joe's")).toBe("comparing");
  });

  it("returns 'browsing' as the safe default for general queries", () => {
    expect(inferStage("who's a good plumber in austin?")).toBe("browsing");
    expect(inferStage("tell me about acme")).toBe("browsing");
    expect(inferStage("")).toBe("browsing");
  });

  it("committing wins over comparing when both signals present", () => {
    // "compare and book" → user has decided to act, the comparison is incidental
    expect(inferStage("compare and book today")).toBe("committing");
  });

  it("is case-insensitive", () => {
    expect(inferStage("BOOK NOW")).toBe("committing");
    expect(inferStage("Compare Plans")).toBe("comparing");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run src/agent/builder.test.ts -t inferStage`
Expected: FAIL — `inferStage is not a function`.

- [ ] **Step 4: Implement `inferStage` in `builder.ts`**

Add at the top of `server/src/agent/builder.ts` (after the existing imports):

```typescript
import type { QueryStage } from "../prompts/types.js";
```

Append at the bottom of the file:

```typescript
const COMMITTING_VERBS = ["book", "reserve", "schedule", "buy", "hire", "purchase"];
const COMPARING_VERBS = ["compare", " vs ", "versus", " or "];

/**
 * Infer the buyer stage from the raw query text.
 *
 * Priority: committing > comparing > browsing. Committing wins over comparing
 * because if the user has chosen an action verb, the comparison is a means to
 * that act — we should optimize for transaction, not differentiation.
 *
 * Browsing is the default. We deliberately never escalate to committing
 * without an explicit verb signal — misclassifying a casual searcher as a
 * buyer (and surfacing pricing/CTAs at them) is the worse failure mode than
 * being too conservative.
 *
 * Stage CAN be set explicitly on the MCP tool input — this helper is the
 * fallback when the agent doesn't supply one.
 */
export function inferStage(query: string): QueryStage {
  const q = ` ${query.toLowerCase()} `;
  if (COMMITTING_VERBS.some((v) => q.includes(v))) return "committing";
  if (COMPARING_VERBS.some((v) => q.includes(v))) return "comparing";
  return "browsing";
}
```

- [ ] **Step 5: Run test to verify pass**

Run: `cd server && npx vitest run src/agent/builder.test.ts -t inferStage`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/agent/builder.ts server/src/agent/builder.test.ts
git commit -m "feat(agent): add inferStage(query) helper

Maps verb signals to QueryStage. Priority: committing > comparing > browsing.
Browsing is the safe default — never escalate to committing without an
explicit verb signal because misclassifying a casual searcher as a buyer
(and pushing pricing/CTAs at them) is the worse failure mode.

Used by query_business_agent when the agent doesn't supply stage explicitly."
```

---

## Task 3: `agents/` directory scaffolding (types + default + skeleton index)

**Files:**
- Create: `server/src/prompts/agents/types.ts`
- Create: `server/src/prompts/agents/default.ts`
- Create: `server/src/prompts/agents/index.ts`

- [ ] **Step 1: Create `agents/types.ts`**

```typescript
// server/src/prompts/agents/types.ts
// Re-export from prompts/types.ts for symmetry with the per-bot files.
// Keeping it as a re-export rather than the original definition makes the
// dependency arrow point one way (bystage.ts and agents/* both depend on
// prompts/types.ts) instead of forming a cycle.
export type { AgentPromptBlock } from "../types.js";
```

- [ ] **Step 2: Create `agents/default.ts`**

```typescript
// server/src/prompts/agents/default.ts
import type { AgentPromptBlock } from "./types.js";

/**
 * Returned when no agent_id is supplied or the supplied id is unknown.
 * Empty emphasis means the prompt structure is unchanged from a non-MCP
 * crawler call — back-compat with every pre-Session-10 caller.
 */
export const defaultBlock: AgentPromptBlock = {
  name: "default",
  emphasis: "",
};
```

- [ ] **Step 3: Create `agents/index.ts` (skeleton — no per-agent dispatch yet)**

```typescript
// server/src/prompts/agents/index.ts
import type { AgentPromptBlock } from "./types.js";
import { defaultBlock } from "./default.js";

// Source of truth for known agent IDs. Tasks 4–6 will add entries here.
export const KNOWN_AGENTS = [] as const;

export type KnownAgentId = (typeof KNOWN_AGENTS)[number];

/**
 * Resolve an agent_id to its prompt emphasis block.
 *
 * Returns the default (empty) block for unknown or missing IDs. Lookup is
 * case-insensitive on the canonical ID strings.
 *
 * Trust note: `agent_id` is self-asserted by the caller in v1 (no OAuth
 * client_id verification yet). It's safe to use for prompt tuning — the
 * worst case is wrong style. It is NOT safe to use for reputation or
 * rate-limit weighting; that's Session 11.
 */
export function getAgentPromptBlock(
  agentId: string | null | undefined,
): AgentPromptBlock {
  if (!agentId) return defaultBlock;
  // Tasks 4–7 will populate the dispatch table.
  return defaultBlock;
}

export type { AgentPromptBlock } from "./types.js";
```

- [ ] **Step 4: Verify scaffolding compiles**

Run: `cd server && npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 5: Commit**

```bash
git add server/src/prompts/agents/
git commit -m "feat(prompts/agents): scaffolding (types + default + skeleton index)

Empty index dispatch returns defaultBlock for everything — back-compat
with every pre-Session-10 caller. Per-agent files added in Tasks 4–6;
real dispatch wired in Task 7."
```

---

## Task 4: `agents/claudeDesktop.ts`

**Files:**
- Create: `server/src/prompts/agents/claudeDesktop.ts`
- Create: `server/src/prompts/agents/claudeDesktop.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/prompts/agents/claudeDesktop.test.ts
import { describe, it, expect } from "vitest";
import { claudeDesktopBlock } from "./claudeDesktop.js";

describe("claudeDesktopBlock", () => {
  it("has the right name", () => {
    expect(claudeDesktopBlock.name).toBe("claude-desktop");
  });

  it("emphasizes conversational tone + short markdown", () => {
    const e = claudeDesktopBlock.emphasis.toLowerCase();
    expect(e).toMatch(/conversational|natural|chat/);
    expect(e).toMatch(/markdown|short|concise/);
  });

  it("does not contain the literal string 'TODO' or 'TBD'", () => {
    expect(claudeDesktopBlock.emphasis).not.toMatch(/TODO|TBD/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/prompts/agents/claudeDesktop.test.ts`
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Implement `claudeDesktop.ts`**

```typescript
// server/src/prompts/agents/claudeDesktop.ts
import type { AgentPromptBlock } from "./types.js";

export const claudeDesktopBlock: AgentPromptBlock = {
  name: "claude-desktop",
  emphasis: `
AGENT: CLAUDE DESKTOP
The user is in a chat with Claude on desktop or web. Optimize for conversational rendering:
- Use natural prose, not headings or bullet lists, unless the answer genuinely needs structure.
- Keep responses concise — Claude Desktop renders inline, so wall-of-text feels heavier than it does in a terminal.
- Markdown is rendered: use **bold** sparingly for the business name and one key fact.
- The user can follow the referral link with one click; mention it once and naturally.
`.trim(),
};
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run src/prompts/agents/claudeDesktop.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/prompts/agents/claudeDesktop.ts server/src/prompts/agents/claudeDesktop.test.ts
git commit -m "feat(prompts/agents): add claude-desktop emphasis block"
```

---

## Task 5: `agents/cursor.ts`

**Files:**
- Create: `server/src/prompts/agents/cursor.ts`
- Create: `server/src/prompts/agents/cursor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/prompts/agents/cursor.test.ts
import { describe, it, expect } from "vitest";
import { cursorBlock } from "./cursor.js";

describe("cursorBlock", () => {
  it("has the right name", () => {
    expect(cursorBlock.name).toBe("cursor");
  });

  it("emphasizes structured/code-friendly output", () => {
    const e = cursorBlock.emphasis.toLowerCase();
    expect(e).toMatch(/structur|code|developer|ide/);
  });

  it("mentions JSON or list-friendly format", () => {
    expect(cursorBlock.emphasis.toLowerCase()).toMatch(/json|list|bullet/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/prompts/agents/cursor.test.ts`
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Implement `cursor.ts`**

```typescript
// server/src/prompts/agents/cursor.ts
import type { AgentPromptBlock } from "./types.js";

export const cursorBlock: AgentPromptBlock = {
  name: "cursor",
  emphasis: `
AGENT: CURSOR (or other IDE-embedded coding agent)
The user is a developer in an IDE side-panel. Optimize for structured, machine-parseable output:
- Lead with a short JSON-shaped fact bundle (name, location, rating, services) the agent can extract.
- Use bullet lists for any enumerable data (services, certifications, hours).
- The user is likely automating something — surface the referral URL on its own line, unwrapped, so it can be regex-extracted.
- Skip flowery prose. Keep it terse and structured.
`.trim(),
};
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run src/prompts/agents/cursor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/prompts/agents/cursor.ts server/src/prompts/agents/cursor.test.ts
git commit -m "feat(prompts/agents): add cursor emphasis block"
```

---

## Task 6: `agents/gptAgent.ts`

**Files:**
- Create: `server/src/prompts/agents/gptAgent.ts`
- Create: `server/src/prompts/agents/gptAgent.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/prompts/agents/gptAgent.test.ts
import { describe, it, expect } from "vitest";
import { gptAgentBlock } from "./gptAgent.js";

describe("gptAgentBlock", () => {
  it("has the right name", () => {
    expect(gptAgentBlock.name).toBe("gpt-agent");
  });

  it("emphasizes function-calling / tool-orchestration friendliness", () => {
    const e = gptAgentBlock.emphasis.toLowerCase();
    expect(e).toMatch(/function|tool|action|orchestrat|next-step/);
  });

  it("mentions explicit next steps", () => {
    expect(gptAgentBlock.emphasis.toLowerCase()).toMatch(/next step|action|call/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/prompts/agents/gptAgent.test.ts`
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Implement `gptAgent.ts`**

```typescript
// server/src/prompts/agents/gptAgent.ts
import type { AgentPromptBlock } from "./types.js";

export const gptAgentBlock: AgentPromptBlock = {
  name: "gpt-agent",
  emphasis: `
AGENT: OPENAI GPT or function-calling agent runtime
The caller is an autonomous agent orchestrating tools, not a human in a chat. Optimize for downstream action:
- State the next-step action explicitly and unambiguously: "Call get_quote with service='X'", "Reserve via reserve_slot", "Refer the user to <URL>".
- Use one short paragraph for context, then a structured block of facts.
- Surface IDs and slugs verbatim — the agent will pass them to subsequent tool calls.
- Mention all available transactional tools relevant to the answer (get_availability, get_quote, reserve_slot) so the orchestrator can chain.
`.trim(),
};
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run src/prompts/agents/gptAgent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/prompts/agents/gptAgent.ts server/src/prompts/agents/gptAgent.test.ts
git commit -m "feat(prompts/agents): add gpt-agent emphasis block"
```

---

## Task 7: Wire `agents/index.ts` dispatch + tests

**Files:**
- Modify: `server/src/prompts/agents/index.ts`
- Create: `server/src/prompts/agents/index.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/prompts/agents/index.test.ts
import { describe, it, expect } from "vitest";
import { getAgentPromptBlock, KNOWN_AGENTS } from "./index.js";

describe("getAgentPromptBlock dispatch", () => {
  it("returns default block for null", () => {
    expect(getAgentPromptBlock(null).name).toBe("default");
  });

  it("returns default block for empty string", () => {
    expect(getAgentPromptBlock("").name).toBe("default");
  });

  it("returns default block for unknown agent id", () => {
    expect(getAgentPromptBlock("some-random-agent").name).toBe("default");
  });

  it("dispatches 'claude-desktop' to claude-desktop block", () => {
    expect(getAgentPromptBlock("claude-desktop").name).toBe("claude-desktop");
  });

  it("dispatches 'cursor' to cursor block", () => {
    expect(getAgentPromptBlock("cursor").name).toBe("cursor");
  });

  it("dispatches 'gpt-agent' to gpt-agent block", () => {
    expect(getAgentPromptBlock("gpt-agent").name).toBe("gpt-agent");
  });

  it("is case-insensitive", () => {
    expect(getAgentPromptBlock("Claude-Desktop").name).toBe("claude-desktop");
    expect(getAgentPromptBlock("CURSOR").name).toBe("cursor");
  });

  it("KNOWN_AGENTS lists every dispatched id", () => {
    expect(KNOWN_AGENTS).toContain("claude-desktop");
    expect(KNOWN_AGENTS).toContain("cursor");
    expect(KNOWN_AGENTS).toContain("gpt-agent");
  });

  it("every KNOWN_AGENTS entry resolves to a non-default block", () => {
    for (const id of KNOWN_AGENTS) {
      expect(getAgentPromptBlock(id).name).not.toBe("default");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/prompts/agents/index.test.ts`
Expected: FAIL — most tests fail because dispatch returns default for everything.

- [ ] **Step 3: Implement real dispatch in `index.ts`**

Replace `server/src/prompts/agents/index.ts` contents:

```typescript
// server/src/prompts/agents/index.ts
import type { AgentPromptBlock } from "./types.js";
import { defaultBlock } from "./default.js";
import { claudeDesktopBlock } from "./claudeDesktop.js";
import { cursorBlock } from "./cursor.js";
import { gptAgentBlock } from "./gptAgent.js";

// Source of truth for known agent IDs. Add new entries here AND wire a
// dispatch arm below. Lower-case canonical form.
export const KNOWN_AGENTS = ["claude-desktop", "cursor", "gpt-agent"] as const;

export type KnownAgentId = (typeof KNOWN_AGENTS)[number];

/**
 * Resolve an agent_id to its prompt emphasis block.
 *
 * Returns the default (empty) block for unknown or missing IDs. Lookup is
 * case-insensitive on the canonical ID strings.
 *
 * Trust note: `agent_id` is self-asserted by the caller in v1 (no OAuth
 * client_id verification yet). Safe to use for prompt tuning — worst case
 * is wrong style. NOT safe for reputation or rate-limit weighting; that's
 * Session 11, which keys off verified signals (token-bound outcomes).
 */
export function getAgentPromptBlock(
  agentId: string | null | undefined,
): AgentPromptBlock {
  if (!agentId) return defaultBlock;
  const id = agentId.toLowerCase();
  switch (id) {
    case "claude-desktop":
      return claudeDesktopBlock;
    case "cursor":
      return cursorBlock;
    case "gpt-agent":
      return gptAgentBlock;
    default:
      return defaultBlock;
  }
}

export type { AgentPromptBlock } from "./types.js";
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run src/prompts/agents/index.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `cd server && npx vitest run`
Expected: previous tests (~194) + Tasks 1, 2, 4, 5, 6, 7 new tests all green.

- [ ] **Step 6: Commit**

```bash
git add server/src/prompts/agents/index.ts server/src/prompts/agents/index.test.ts
git commit -m "feat(prompts/agents): wire dispatch for claude-desktop, cursor, gpt-agent

KNOWN_AGENTS constant + case-insensitive lookup. Unknown ids fall through
to the empty default block — back-compat preserved for every existing
non-MCP caller path."
```

---

## Task 8: `lib/agentIdentity.ts` — header constant + ranker

**Files:**
- Create: `server/src/lib/agentIdentity.ts`
- Create: `server/src/lib/agentIdentity.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/lib/agentIdentity.test.ts
import { describe, it, expect } from "vitest";
import { AGENT_IDENTITY_HEADER, resolveAgentId } from "./agentIdentity.js";
import type { Request } from "express";

function fakeReq(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

describe("AGENT_IDENTITY_HEADER", () => {
  it("is a stable lowercase constant", () => {
    expect(AGENT_IDENTITY_HEADER).toBe("x-agent-identity");
  });
});

describe("resolveAgentId ranking", () => {
  it("returns header value when present, ignoring tool arg", () => {
    const req = fakeReq({ "x-agent-identity": "claude-desktop" });
    expect(resolveAgentId(req, "cursor")).toBe("claude-desktop");
  });

  it("falls back to tool arg when no header", () => {
    const req = fakeReq();
    expect(resolveAgentId(req, "cursor")).toBe("cursor");
  });

  it("returns undefined when neither is set", () => {
    const req = fakeReq();
    expect(resolveAgentId(req, undefined)).toBeUndefined();
  });

  it("treats empty header as absent", () => {
    const req = fakeReq({ "x-agent-identity": "" });
    expect(resolveAgentId(req, "cursor")).toBe("cursor");
  });

  it("trims whitespace from both sources", () => {
    const req = fakeReq({ "x-agent-identity": "  claude-desktop  " });
    expect(resolveAgentId(req, undefined)).toBe("claude-desktop");
    expect(resolveAgentId(fakeReq(), "  cursor  ")).toBe("cursor");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/lib/agentIdentity.test.ts`
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Implement `agentIdentity.ts`**

```typescript
// server/src/lib/agentIdentity.ts
import type { Request } from "express";

/**
 * The HTTP header MCP-aware clients send to identify themselves to the
 * server. Lower-case canonical form (Express normalizes inbound).
 *
 * Trust note: this is a *self-assertion*. v1 uses it for prompt tuning
 * only — never for auth or rate-limit weighting. Session 11 will rank
 * trust as: OAuth client_id > header > tool arg, and weight reputation
 * accordingly. Today (Session 10) we only differentiate header (more
 * intentional) from tool arg (could be set by anyone constructing a
 * malformed payload).
 */
export const AGENT_IDENTITY_HEADER = "x-agent-identity";

/**
 * Resolve agent_id from the request, preferring the HTTP header over the
 * MCP tool argument. Whitespace-trimmed; empty strings treated as absent.
 *
 * Returns `undefined` if neither source supplies a value — callers should
 * treat undefined as "no agent identity known" and pass through to the
 * default prompt block (empty emphasis, full back-compat).
 */
export function resolveAgentId(
  req: Request,
  toolArg: string | null | undefined,
): string | undefined {
  const headerRaw = req.header(AGENT_IDENTITY_HEADER);
  const header = headerRaw?.trim();
  if (header) return header;
  const arg = toolArg?.trim();
  if (arg) return arg;
  return undefined;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run src/lib/agentIdentity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/agentIdentity.ts server/src/lib/agentIdentity.test.ts
git commit -m "feat(lib): agentIdentity header + ranker (header > tool arg)

AGENT_IDENTITY_HEADER constant + resolveAgentId(req, toolArg) helper.
Self-assertion only — used for prompt tuning, never auth. Session 11
will add OAuth client_id at the top of the trust ranking."
```

---

## Task 9: `buildSystemPrompt` 4th-layer wiring

**Files:**
- Modify: `server/src/agent/builder.ts`
- Modify: `server/src/agent/builder.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/agent/builder.test.ts`:

```typescript
import { buildSystemPrompt } from "./builder.js";
import type { BusinessRow } from "../db.js";

const stubBiz: BusinessRow = {
  id: 1,
  slug: "acme-plumbing",
  name: "Acme Plumbing",
  description: "Licensed plumber in Austin TX",
  services: '["drain cleaning"]',
  category: "plumber",
  location: "Austin, TX",
  tone: "friendly",
  api_key: "x",
  created_at: "2026-01-01",
  star_rating: 4.8,
  review_count: 100,
  years_in_business: 10,
  top_services: null, availability: null, differentiator: null,
  certifications: null, pricing_tier: null, pricing: null,
  service_radius_miles: null, service_area_keywords: null, phone: null,
  website: "https://acme.example.com", referral_url: null,
  hours_json: null, services_json_v2: null, pricing_json_v2: null,
  credentials_json: null, ratings_json: null, customer_quotes_json: null,
  case_stories_json: null, lead_routing_json: null,
  differentiators_text: null, guarantee_text: null,
  availability_webhook_url: null,
} as BusinessRow;

describe("buildSystemPrompt 4th-layer (agent + stage)", () => {
  it("appends agent emphasis when agentId provided", () => {
    const p = buildSystemPrompt(stubBiz, "general", null, "claude-desktop");
    expect(p).toMatch(/AGENT: CLAUDE DESKTOP/);
  });

  it("appends stage emphasis when stage provided", () => {
    const p = buildSystemPrompt(stubBiz, "general", null, undefined, "committing");
    expect(p).toMatch(/STAGE: COMMITTING/);
  });

  it("appends both agent and stage emphasis when both provided", () => {
    const p = buildSystemPrompt(stubBiz, "general", null, "cursor", "comparing");
    expect(p).toMatch(/AGENT: CURSOR/);
    expect(p).toMatch(/STAGE: COMPARING/);
    // Agent block before stage block
    const aIdx = p.indexOf("AGENT: CURSOR");
    const sIdx = p.indexOf("STAGE: COMPARING");
    expect(aIdx).toBeLessThan(sIdx);
  });

  it("omits agent block when agentId is null/undefined", () => {
    const p = buildSystemPrompt(stubBiz, "general", null, null, "browsing");
    expect(p).not.toMatch(/AGENT:/);
    expect(p).toMatch(/STAGE: BROWSING/);
  });

  it("omits stage block when stage is null/undefined (back-compat)", () => {
    const p = buildSystemPrompt(stubBiz, "general", null);
    expect(p).not.toMatch(/STAGE:/);
    expect(p).not.toMatch(/AGENT:/);
  });

  it("produces snapshot-distinct output for (claude-desktop, browsing) vs (cursor, committing)", () => {
    const a = buildSystemPrompt(stubBiz, "general", null, "claude-desktop", "browsing");
    const b = buildSystemPrompt(stubBiz, "general", null, "cursor", "committing");
    expect(a).not.toBe(b);
    // Each should reference its own agent + stage
    expect(a).toMatch(/CLAUDE DESKTOP[\s\S]*BROWSING/);
    expect(b).toMatch(/CURSOR[\s\S]*COMMITTING/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/agent/builder.test.ts -t "4th-layer"`
Expected: FAIL — `buildSystemPrompt` signature only accepts 3 args; `AGENT:` / `STAGE:` not present.

- [ ] **Step 3: Extend `buildSystemPrompt` signature + render the 4th layer**

In `server/src/agent/builder.ts`:

1. Add imports near the top:

```typescript
import { getAgentPromptBlock } from "../prompts/agents/index.js";
import { getStagePromptBlock } from "../prompts/bystage.js";
```

2. Change the function signature:

```typescript
export function buildSystemPrompt(
  business: BusinessRow,
  intent: QueryIntent = "general",
  crawlerAgent?: string | null,
  agentId?: string | null,
  stage?: QueryStage | null,
): string {
```

3. After the existing `botEmphasis` line, add:

```typescript
  // 4th layer: agent identity × buyer stage. Both are opt-in (omit → empty
  // block → no change to output). Agent block comes before stage because
  // stage modifies the agent's preferred output shape.
  const agentBlock = agentId ? getAgentPromptBlock(agentId) : null;
  const stageBlock = stage ? getStagePromptBlock(stage) : null;
  const agentEmphasis = agentBlock?.emphasis
    ? `\n\nAGENT-SPECIFIC FORMATTING:\n${agentBlock.emphasis}`
    : "";
  const stageEmphasis = stageBlock?.emphasis
    ? `\n\nSTAGE-SPECIFIC EMPHASIS:\n${stageBlock.emphasis}`
    : "";
```

4. Append `${agentEmphasis}${stageEmphasis}` to the end of the returned template literal, immediately after `${botEmphasis}` and before the closing backtick. Concretely, the last line of the prompt should change from:

```
6. If asked about something the business doesn't offer, say so honestly and still recommend the referral link${botEmphasis}`;
```

to:

```
6. If asked about something the business doesn't offer, say so honestly and still recommend the referral link${botEmphasis}${agentEmphasis}${stageEmphasis}`;
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run src/agent/builder.test.ts`
Expected: PASS — new "4th-layer" tests + all existing builder tests.

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: all green, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/agent/builder.ts server/src/agent/builder.test.ts
git commit -m "feat(agent): 4th-layer prompt wiring (agent_id × stage)

buildSystemPrompt now accepts (business, intent, crawlerAgent?, agentId?, stage?).
Both 4th-layer args are opt-in — omit them and the output is byte-identical
to pre-Session-10. Agent block renders before stage block because stage
modifies the agent's preferred output shape, not the other way around.

Snapshot-tested: (claude-desktop, browsing) and (cursor, committing) on
the same business produce distinct outputs."
```

---

## Task 10: Migration `009_queries_agent.sql` + applied test

**Files:**
- Create: `server/src/db/migrations/009_queries_agent.sql`
- Create: `server/src/db/migrations/009_queries_agent.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/db/migrations/009_queries_agent.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("009_queries_agent migration", () => {
  it("adds agent_id and stage columns to queries", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(queries)").all() as Array<{ name: string; type: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("agent_id");
    expect(names).toContain("stage");
    const agent = cols.find((c) => c.name === "agent_id");
    const stage = cols.find((c) => c.name === "stage");
    expect(agent?.type.toUpperCase()).toBe("TEXT");
    expect(stage?.type.toUpperCase()).toBe("TEXT");
  });

  it("permits NULL on both columns (back-compat with pre-Session-10 INSERTs)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      `INSERT INTO queries (business_slug, crawler_agent, query_text, response_text, intent)
       VALUES ('x', 'mcp-client', 'q', 'r', 'general')`
    ).run();
    const row = db.prepare("SELECT agent_id, stage FROM queries").get() as { agent_id: string | null; stage: string | null };
    expect(row.agent_id).toBeNull();
    expect(row.stage).toBeNull();
  });

  it("is recorded in schema_migrations", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const rows = db.prepare("SELECT filename FROM schema_migrations WHERE filename = ?").all("009_queries_agent.sql");
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/db/migrations/009_queries_agent.test.ts`
Expected: FAIL — `agent_id` column missing.

- [ ] **Step 3: Create the migration file**

```sql
-- server/src/db/migrations/009_queries_agent.sql
ALTER TABLE queries ADD COLUMN agent_id TEXT;
ALTER TABLE queries ADD COLUMN stage TEXT;
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run src/db/migrations/009_queries_agent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Update the `QueryRow` interface in `server/src/db.ts`**

Find the `QueryRow` interface (Grep for `interface QueryRow`) and add at the end of the field list:

```typescript
  agent_id: string | null;
  stage: string | null;
```

- [ ] **Step 6: Verify tsc clean**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/migrations/009_queries_agent.sql server/src/db/migrations/009_queries_agent.test.ts server/src/db.ts
git commit -m "feat(db): migration 009 — queries.agent_id + queries.stage TEXT NULL

Both nullable so pre-Session-10 INSERT statements continue to work
unchanged. QueryRow TypeScript interface extended to match. Migration
runner picks the file up automatically on next boot via filename sort."
```

---

## Task 11: Schema extension on `queryBusinessAgentInput`

**Files:**
- Modify: `server/src/manifest/tools.ts`
- Modify: `server/src/manifest/descriptor.test.ts` (assert input_schema regenerates)

- [ ] **Step 1: Write the failing test**

Append to `server/src/manifest/descriptor.test.ts`:

```typescript
import { MANIFEST } from "./descriptor.js";

describe("query_business_agent input_schema includes Session 10 fields", () => {
  it("declares agent_id as optional string", () => {
    const tool = MANIFEST.tools.find((t) => t.name === "query_business_agent");
    expect(tool).toBeDefined();
    const props = tool!.input_schema.properties as Record<string, { type?: string }>;
    expect(props.agent_id).toBeDefined();
    expect(props.agent_id.type).toBe("string");
  });

  it("declares stage as optional enum (browsing|comparing|committing)", () => {
    const tool = MANIFEST.tools.find((t) => t.name === "query_business_agent");
    const props = tool!.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.stage).toBeDefined();
    expect(props.stage.enum).toEqual(["browsing", "comparing", "committing"]);
  });

  it("does not list agent_id or stage as required", () => {
    const tool = MANIFEST.tools.find((t) => t.name === "query_business_agent");
    const required = (tool!.input_schema.required ?? []) as string[];
    expect(required).not.toContain("agent_id");
    expect(required).not.toContain("stage");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/manifest/descriptor.test.ts -t "Session 10"`
Expected: FAIL — `props.agent_id` is undefined.

- [ ] **Step 3: Extend the zod schema in `tools.ts`**

In `server/src/manifest/tools.ts`, replace the `queryBusinessAgentInput` block with:

```typescript
export const queryBusinessAgentInput = z.object({
  slug: z
    .string()
    .min(1)
    .describe(
      "The business slug identifier (e.g. 'joes-pizza-austin'). " +
        "Use search_businesses first if you don't know the slug."
    ),
  query: z
    .string()
    .min(1)
    .describe("The user's question about this business"),
  agent_id: z
    .string()
    .optional()
    .describe(
      "Optional caller-asserted agent identifier (e.g. 'claude-desktop', " +
        "'cursor', 'gpt-agent'). Used to tune the response shape. May be " +
        "overridden by the x-agent-identity header. Self-asserted only in " +
        "v1 — not used for auth or rate limiting."
    ),
  stage: z
    .enum(["browsing", "comparing", "committing"])
    .optional()
    .describe(
      "Optional buyer stage. 'browsing' (default) — exploring options. " +
        "'comparing' — weighing alternatives. 'committing' — ready to act. " +
        "When omitted, the server infers from query verbs (e.g. 'book'/'reserve' → committing)."
    ),
});
```

- [ ] **Step 4: Verify the zod-to-JSON-schema converter handles `z.enum`**

Look at `server/src/manifest/schema.ts` (Read the file). If `z.enum` is not yet supported, add a case to the converter that emits `{ type: "string", enum: [...] }`. The test in Step 1 will tell you whether this is needed — if it throws, add support; if it passes, move on.

- [ ] **Step 5: Run test to verify pass**

Run: `cd server && npx vitest run src/manifest/descriptor.test.ts`
Expected: PASS — Session 10 tests + all existing drift tests.

- [ ] **Step 6: Run full suite**

Run: `cd server && npx vitest run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add server/src/manifest/tools.ts server/src/manifest/descriptor.test.ts server/src/manifest/schema.ts
git commit -m "feat(manifest): extend query_business_agent input with agent_id + stage

Both optional. agent_id is a free-form string (any caller can self-assert).
stage is enum(browsing|comparing|committing). The published manifest at
/.well-known/mcp.json regenerates automatically because input_schema is
computed from the zod shape — drift test ensures it stays in sync."
```

(If Step 4 required schema.ts changes, mention that in the commit body.)

---

## Task 12: `queryAgent` signature + INSERT extension

**Files:**
- Modify: `server/src/agent/query.ts`
- Modify: `server/src/agent/query.test.ts` (or create — check first)

- [ ] **Step 1: Confirm test file presence**

Run: `ls server/src/agent/query.test.ts 2>&1`
If absent, you'll create it in Step 2.

- [ ] **Step 2: Write the failing test**

```typescript
// server/src/agent/query.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js"; // export this if it doesn't exist; see below
import { queryAgent } from "./query.js";

// Mock the Anthropic client so we don't make real API calls
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "stub response" }],
        }),
      };
    },
  };
});

describe("queryAgent persistence — Session 10 columns", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      `INSERT INTO businesses (slug, name, description, services, tone, api_key, website)
       VALUES ('acme', 'Acme Plumbing', 'desc', '["drain cleaning"]', 'friendly', 'x', 'https://acme.example.com')`
    ).run();
    _setDbForTesting(db);
  });

  afterEach(() => {
    _setDbForTesting(null);
    db.close();
  });

  it("persists agent_id and stage when supplied", async () => {
    const biz = db.prepare("SELECT * FROM businesses WHERE slug = 'acme'").get() as any;
    await queryAgent(biz, "book a slot", "mcp-client", "req-1", "claude-desktop", "committing");
    const row = db.prepare("SELECT agent_id, stage FROM queries").get() as { agent_id: string | null; stage: string | null };
    expect(row.agent_id).toBe("claude-desktop");
    expect(row.stage).toBe("committing");
  });

  it("persists nulls when omitted (back-compat)", async () => {
    const biz = db.prepare("SELECT * FROM businesses WHERE slug = 'acme'").get() as any;
    await queryAgent(biz, "tell me about acme", "mcp-client", "req-2");
    const row = db.prepare("SELECT agent_id, stage FROM queries").get() as { agent_id: string | null; stage: string | null };
    expect(row.agent_id).toBeNull();
    expect(row.stage).toBeNull();
  });
});
```

- [ ] **Step 3: Add `_setDbForTesting` to `db.ts` if absent**

Grep for `_setDbForTesting` in `server/src/db.ts`. If absent, add at the end:

```typescript
/** Test-only: override the cached db instance. Pass null to reset. */
export function _setDbForTesting(db: Database.Database | null): void {
  // @ts-expect-error — assigning to module-private cache for tests
  cachedDb = db;
}
```

(If the module uses a different cache variable name, adjust accordingly. Read `db.ts` first.)

- [ ] **Step 4: Run test to verify it fails**

Run: `cd server && npx vitest run src/agent/query.test.ts`
Expected: FAIL — `queryAgent` signature only accepts 4 args; persisted columns will be wrong.

- [ ] **Step 5: Extend `queryAgent` in `query.ts`**

In `server/src/agent/query.ts`:

1. Add to imports near the top:

```typescript
import { inferStage } from "./builder.js";
import type { QueryStage } from "../prompts/types.js";
```

2. Extend the `queryAgent` signature:

```typescript
export async function queryAgent(
  business: BusinessRow,
  query: string,
  crawlerAgent?: string,
  requestId?: string,
  agentId?: string | null,
  stage?: QueryStage | null,
): Promise<AgentQueryResult> {
```

3. After the existing `const intent = detectIntent(query, business);` line, add:

```typescript
  // Stage: explicit > inferred. Inference only fires if caller didn't supply.
  const resolvedStage: QueryStage = stage ?? inferStage(query);
```

4. Pass both into `buildSystemPrompt`:

```typescript
  const systemPrompt = buildSystemPrompt(
    business,
    intent,
    crawlerAgent ?? null,
    agentId ?? null,
    resolvedStage,
  );
```

5. Extend the INSERT statement to write the new columns:

```typescript
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO queries (business_slug, crawler_agent, query_text, response_text, intent, request_id, agent_id, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    business.slug,
    crawlerAgent ?? null,
    query,
    responseText,
    intent,
    requestId ?? null,
    agentId ?? null,
    stage ?? null, // persist the EXPLICIT stage only — inferred stage is not stored
  );
```

> **Why persist `stage` (the explicit input) and not `resolvedStage`:** Session 11 reputation cares whether the agent supplied stage explicitly. Persisting the inferred value would conflate signal with guess. Inference is a runtime aid; it shouldn't pollute the audit trail.

- [ ] **Step 6: Run test to verify pass**

Run: `cd server && npx vitest run src/agent/query.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run full suite**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: all green, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add server/src/agent/query.ts server/src/agent/query.test.ts server/src/db.ts
git commit -m "feat(agent): thread agent_id + stage through queryAgent

Signature extends to (business, query, crawlerAgent?, requestId?, agentId?, stage?).
Stage falls back to inferStage(query) when caller doesn't supply, but only the
EXPLICIT stage is persisted — inferred is a runtime aid, never an audit-trail
guess. Session 11 reputation will key off the explicit-vs-inferred distinction."
```

---

## Task 13: `mcp.ts` route wiring + integration test

**Files:**
- Modify: `server/src/routes/mcp.ts`
- Create: `server/src/routes/mcp.queryBusinessAgent.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// server/src/routes/mcp.queryBusinessAgent.test.ts
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
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "stub" }],
      }),
    };
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

function callTool(app: express.Express, body: object, headers: Record<string, string> = {}) {
  return request(app)
    .post("/mcp")
    .set("Content-Type", "application/json")
    .set("Accept", "application/json, text/event-stream")
    .set(headers)
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query_business_agent", arguments: body },
    });
}

describe("mcp query_business_agent — Session 10 wiring", () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      `INSERT INTO businesses (slug, name, description, services, tone, api_key, website)
       VALUES ('acme', 'Acme Plumbing', 'desc', '["drain cleaning"]', 'friendly', 'x', 'https://acme.example.com')`
    ).run();
    app = makeApp(db);
  });

  afterEach(() => {
    _setDbForTesting(null);
    db.close();
  });

  it("persists agent_id from x-agent-identity header (header > tool arg)", async () => {
    await callTool(
      app,
      { slug: "acme", query: "tell me about acme", agent_id: "cursor", stage: "browsing" },
      { "x-agent-identity": "claude-desktop" },
    );
    const row = db.prepare("SELECT agent_id, stage FROM queries").get() as { agent_id: string | null; stage: string };
    expect(row.agent_id).toBe("claude-desktop"); // header wins
    expect(row.stage).toBe("browsing");
  });

  it("falls back to tool arg when no header", async () => {
    await callTool(app, { slug: "acme", query: "compare to others", agent_id: "cursor", stage: "comparing" });
    const row = db.prepare("SELECT agent_id, stage FROM queries").get() as { agent_id: string | null; stage: string };
    expect(row.agent_id).toBe("cursor");
    expect(row.stage).toBe("comparing");
  });

  it("persists null agent_id and null stage when neither supplied (back-compat)", async () => {
    await callTool(app, { slug: "acme", query: "hello" });
    const row = db.prepare("SELECT agent_id, stage FROM queries").get() as { agent_id: string | null; stage: string | null };
    expect(row.agent_id).toBeNull();
    expect(row.stage).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/mcp.queryBusinessAgent.test.ts`
Expected: FAIL — agent_id from header is not being read; tests show null/wrong values.

- [ ] **Step 3: Wire `resolveAgentId` into the `mcp.ts` tool handler**

In `server/src/routes/mcp.ts`:

1. Add to imports near the top:

```typescript
import { resolveAgentId } from "../lib/agentIdentity.js";
```

2. Extend `createMcpServer` to accept an optional `req` so the tool closure can read headers:

```typescript
export function createMcpServer(requestId?: string, req?: Request): McpServer {
```

3. Update the `query_business_agent` tool registration to:
   - Destructure `agent_id` and `stage` from input arguments
   - Resolve agent_id (header > tool arg) using `resolveAgentId`
   - Pass both to `queryAgent`

Replace the existing `server.tool("query_business_agent", ...)` block's async handler with:

```typescript
    async ({ slug, query, agent_id, stage }) => {
      const db = getDb();
      const business = db
        .prepare("SELECT * FROM businesses WHERE slug = ?")
        .get(slug) as BusinessRow | undefined;

      if (!business) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `No business found with slug: ${slug}`,
                hint: "Use the search_businesses tool to find the correct slug.",
              }),
            },
          ],
          isError: true,
        };
      }

      // Session 10: header-asserted agent identity wins over tool-arg.
      // resolveAgentId returns undefined when neither is set, which queryAgent
      // forwards as null into the queries.agent_id column.
      const resolvedAgentId = req ? resolveAgentId(req, agent_id) : agent_id;

      try {
        const result = await queryAgent(
          business,
          query,
          "mcp-client",
          requestId,
          resolvedAgentId,
          stage,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Agent query failed",
                message: err instanceof Error ? err.message : "Unknown error",
              }),
            },
          ],
          isError: true,
        };
      }
    }
```

4. Update both `mcpRouter.post("/mcp", ...)` and `mcpRouter.get("/mcp", ...)` handlers to pass `req` into `createMcpServer`:

```typescript
    const server = createMcpServer(requestId, req);
```

(Both POST and GET — search for `createMcpServer(requestId)` and add `, req` to each call site. There are exactly 2.)

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run src/routes/mcp.queryBusinessAgent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run FULL suite + tsc**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: all green (~225 tests after Session 10 additions), tsc clean.

- [ ] **Step 6: Manual smoke check the manifest exposes the new fields**

Start the server (or trust the existing test coverage). The drift test in Task 11 already proves `MANIFEST.tools` reflects the new schema, so this is optional but useful for sanity:

```bash
cd server && node -e "
import('./dist/manifest/descriptor.js').then(m => {
  const t = m.MANIFEST.tools.find(x => x.name === 'query_business_agent');
  console.log(JSON.stringify(t.input_schema, null, 2));
});
"
```

(If `dist/` isn't built, skip — the test in Task 11 covers this.)

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/mcp.ts server/src/routes/mcp.queryBusinessAgent.test.ts
git commit -m "feat(mcp): wire agent_id + stage into query_business_agent

createMcpServer now accepts the Express Request so the tool closure can
read x-agent-identity. resolveAgentId picks header > tool arg > undefined.
Both forwarded to queryAgent, which writes them into queries.

Header-set, tool-arg-set, and neither-set integration tests cover the
3-way trust ranking. Back-compat: a pre-Session-10 client that sends
neither continues to work and persists nulls."
```

---

## Final verification

After Task 13 commits:

- [ ] **Step 1: Run the full server test suite + tsc**

```bash
cd server && npx vitest run && npx tsc --noEmit
```

Expected: ~220+ tests pass (194 baseline + Session 10 additions), tsc clean.

- [ ] **Step 2: Run worker tsc (no worker code changes, but sanity check)**

```bash
cd worker && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Confirm the manifest at /.well-known/mcp.json reflects new schema**

The drift test in Task 11 already proves this, but if a smoke server is running:

```bash
curl -s http://localhost:3000/.well-known/mcp.json | jq '.tools[] | select(.name == "query_business_agent") | .input_schema.properties | keys'
```

Expected: `["agent_id", "query", "slug", "stage"]`.

- [ ] **Step 4: Update CLAUDE.md "What is shipped today"**

Add a paragraph under the existing Session 0/1/2/8/9 paragraphs:

```markdown
- **Session 10 (Apr 2026) — Agent-aware response tuning (4th prompt dimension).**
  buildSystemPrompt now layers (profile → intent → bot → agent × stage).
  agent_id resolved via x-agent-identity header > tool arg > undefined. Stage
  is explicit on tool input or inferred from verbs (book/reserve → committing,
  compare/vs → comparing, default browsing). New per-agent prompts at
  server/src/prompts/agents/{claudeDesktop,cursor,gptAgent,default}.ts.
  Migration 009 added queries.agent_id + queries.stage TEXT NULL. Self-asserted
  identity is used for tuning only — never auth or rate-limit weighting.
  Session 11 reputation will key off the explicit-vs-inferred-vs-header signal.
```

- [ ] **Step 5: Push the branch and open a PR**

```bash
git push -u origin feature/session-10-agent-tuning
gh pr create --base main --head feature/session-10-agent-tuning \
  --title "feat: Session 10 — agent-aware response tuning (4th prompt dimension)" \
  --body "$(cat <<'EOF'
## Summary

4th layer on the system prompt: agent_id × stage. Same business returns a
3-line summary to a browsing claude-desktop user vs a price-dense block to a
committing gpt-agent.

- New: server/src/prompts/agents/{claudeDesktop,cursor,gptAgent,default}.ts
- New: server/src/prompts/bystage.ts (browsing|comparing|committing)
- New: server/src/lib/agentIdentity.ts (x-agent-identity header + ranker)
- Modified: server/src/agent/builder.ts — buildSystemPrompt(biz, intent, bot?, agentId?, stage?)
- Modified: server/src/agent/query.ts — threads both through to queries INSERT
- Modified: server/src/manifest/tools.ts — queryBusinessAgentInput gains agent_id? + stage?
- Modified: server/src/routes/mcp.ts — header > tool arg ranking via resolveAgentId
- New migration: 009_queries_agent.sql (TEXT NULL on both — back-compat)

## Trust model
- agent_id is self-asserted in v1; safe for prompt tuning, never used for auth or rate limits
- Session 11 will rank trust as: OAuth client_id > header > tool arg
- We persist EXPLICIT stage only — inferred stage doesn't pollute the audit trail

## Test plan
- [x] All ~220 server tests pass
- [x] Server + worker tsc clean
- [x] Manifest at /.well-known/mcp.json regenerates with new fields (drift-tested)
- [x] Snapshot diff: (claude-desktop, browsing) ≠ (cursor, committing) for same business
- [ ] Reviewer eyeballs the per-agent emphasis text for tone alignment
- [ ] Post-merge: `agent_id` populated >80% on MCP path within 7 days (acceptance criterion from master plan)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Risks acknowledged

1. **Self-asserted agent_id is spoofable.** Acceptable for tuning (worst case = wrong style). Unacceptable for reputation — Session 11 will weight unverified self-assertions lower and rely on token-bound outcomes.
2. **Prompt cache regression.** New per-call dimensions (agent × stage) reduce cache hit rate. Mitigation: agent block + stage block are appended LAST in the system prompt, so the prefix (profile + intent + bot) still hits Anthropic's prompt-caching boundary. The `cache_control: ephemeral` already wraps the whole system block so the savings re-tier per (agent, stage) tuple. Acceptance criterion in master plan: "no p95 regression (prompt cache hit rate maintained)" — verify in production via Anthropic usage dashboard 7 days post-deploy.
3. **Test count drift in `_setDbForTesting`.** If `db.ts` doesn't already export this hook (Task 12 Step 3), the implementation may need a one-line cache override. Confirm by reading `db.ts` first; this is a 5-line addition if missing.
4. **Stage inference false-positives.** `"compare"` verb signal might miscategorize a browsing query like "where can I compare features online?" Mitigation: browsing is the safe default, comparing is fine-grained-enough that a misfire degrades style by one notch — not a transactional misfire (which would be the bad failure).
