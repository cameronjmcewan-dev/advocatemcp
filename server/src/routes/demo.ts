/* Public demo routes — no auth, rate-limited.
 *
 * Powers the homepage live-MCP-demo widget on advocatemcp.com. Visitor
 * clicks "Watch an AI agent book your business" → JS calls these routes
 * → real Claude response + real availability slots come back in <4s.
 * That's the moneyshot vs static screenshots — mechanically true demo.
 *
 * Why a separate /demo namespace not /agent/:slug:
 *   - Agent routes require Bearer auth. Adding "but skip auth for slug=X"
 *     creates a footgun where a misconfig accidentally exposes every
 *     tenant. Separate namespace = explicit allowlist.
 *   - The demo tenant is hardcoded (DEMO_SLUG). Visitor can't choose,
 *     can't enumerate, can't probe other tenants.
 *   - Rate limits + budget tracking can be tuned independently.
 *
 * Cost model:
 *   - Per-IP rate limit: 3 calls/min, 10 calls/24h. Caps abuse.
 *   - Reserves $0.05/call from global budget kill-switch (same path
 *     as bot queries). When the daily $25 cap is hit, demo 503s with
 *     scope:"global" — same fail-mode as anywhere else.
 *   - Estimated load: 200 demos/month × 2 calls each (run + availability)
 *     = ~$4-8/month. Inside the existing $25/day cap by 100×.
 *
 * Demo runs are logged to demo_runs (Phase B.4) so we can measure
 * widget → /Pricing.html conversion.
 */

import { Router, type Request, type Response } from "express";
import { getDb, type BusinessRow } from "../db.js";
import { queryAgent } from "../agent/query.js";
import { synthSlots, type HoursJson } from "../mcp/tools/getAvailability.js";
import { checkLimit } from "../middleware/costRateLimit.js";
import {
  reserve as budgetReserve,
  record as budgetRecord,
  release as budgetRelease,
} from "../middleware/budgetKillSwitch.js";
import { z } from "zod";
import crypto from "crypto";

/* The single demo tenant. Hardcoded so visitors can't pivot to other
 * tenants by changing a URL. Override via DEMO_SLUG env if you want a
 * different demo profile. Defaults to WCC since that's the only real
 * customer right now (Apr 2026). */
const DEMO_SLUG = process.env.DEMO_SLUG ?? "workman-copy-co";

const DEMO_RUN_LIMITS = [
  { label: "demo:burst", cfg: { max: 3,  windowMs: 60_000 } },
  { label: "demo:daily", cfg: { max: 10, windowMs: 24 * 60 * 60_000 } },
];

const DEMO_RESERVATION_USD = 0.05;

const DemoQueryBody = z.object({
  query: z.string().trim().min(1).max(500),
});

export const demoRouter = Router();

/* IP fingerprint used as the rate-limit + analytics key. We hash so the
 * raw IP never lands in our logs/DB. Worker forwards the visitor IP via
 * X-Forwarded-For; if absent we fall back to socket.remoteAddress. */
function clientIpHash(req: Request): string {
  const raw = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "—")
    .split(",")[0]
    .trim();
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/* Best-effort write to demo_runs. Migration 026 creates the table; if
 * it doesn't exist yet (e.g. fresh dev DB) we silently no-op rather
 * than failing the demo response. */
function logDemoRun(opts: {
  ip_hash: string;
  demo_type: "agent_run" | "availability";
  outcome: "ok" | "error";
}): void {
  try {
    const db = getDb();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS demo_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT NOT NULL,
        ip_hash     TEXT NOT NULL,
        demo_type   TEXT NOT NULL,
        outcome     TEXT NOT NULL
      )
    `).run();
    db.prepare(
      `INSERT INTO demo_runs (ts, ip_hash, demo_type, outcome) VALUES (?,?,?,?)`,
    ).run(new Date().toISOString(), opts.ip_hash, opts.demo_type, opts.outcome);
  } catch {
    /* swallow */
  }
}

/* POST /demo/agent/run
 *
 * Body: { query: string }
 * Returns: { answer, business_name, demo_slug }
 *
 * Calls queryAgent against the demo tenant. Same path real bots take,
 * same model, same renderer. Visitor sees the actual production
 * response shape — not a screenshot.
 */
demoRouter.post("/demo/agent/run", async (req: Request, res: Response) => {
  const ipHash = clientIpHash(req);
  const gate = checkLimit({ key: `demo:${ipHash}`, limits: DEMO_RUN_LIMITS });
  if (!gate.allowed) {
    const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "rate_limited",
      message: `Demo limit reached (${gate.label}). Try again in ${retryAfterSec}s.`,
      retry_after_seconds: retryAfterSec,
    });
    return;
  }

  const parsed = DemoQueryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const { query } = parsed.data;

  const db = getDb();
  const business = db
    .prepare("SELECT * FROM businesses WHERE slug = ?")
    .get(DEMO_SLUG) as BusinessRow | undefined;
  if (!business) {
    res.status(503).json({
      error: "demo_unavailable",
      message: `Demo tenant '${DEMO_SLUG}' is not provisioned. Set DEMO_SLUG env or register the tenant.`,
    });
    return;
  }

  const budget = budgetReserve(DEMO_RESERVATION_USD);
  if (!budget.allowed) {
    res.status(503).json({
      error: "budget_exhausted",
      message: `Daily AI budget exhausted. Try again after UTC midnight.`,
      remaining_usd: budget.remainingUsd,
      cap_usd: budget.capUsd,
      scope: "global",
    });
    return;
  }

  try {
    const result = await queryAgent(business, query, "ChatGPT", undefined, undefined, undefined, undefined);
    // Record approximate spend ($0.01/call, same heuristic as production
    // bot queries). Refining to actual Anthropic-reported usage is the
    // same followup as for the bot-query path.
    budgetRecord(DEMO_RESERVATION_USD, 0.01);
    logDemoRun({ ip_hash: ipHash, demo_type: "agent_run", outcome: "ok" });
    res.json({
      ok: true,
      demo_slug: DEMO_SLUG,
      business_name: business.name,
      query,
      answer: result.response,
      referral_url: result.referral_url ?? null,
    });
  } catch (err) {
    budgetRelease(DEMO_RESERVATION_USD);
    logDemoRun({ ip_hash: ipHash, demo_type: "agent_run", outcome: "error" });
    console.error("[demo/agent/run] failed:", err);
    res.status(500).json({ error: "demo_failed", message: err instanceof Error ? err.message : String(err) });
  }
});

/* POST /demo/agent/availability
 *
 * Body: {} (date optional, defaults to today + 7 days window)
 * Returns: { slots: [{ start, end }], business_name, demo_slug }
 *
 * Pure function — no Claude call, no spend. Reads hours_json + timezone
 * from the demo tenant and emits 30-minute slots. Useful as the second
 * step of the homepage demo flow ("agent answer → here are real
 * available times").
 */
demoRouter.post("/demo/agent/availability", (req: Request, res: Response) => {
  const ipHash = clientIpHash(req);
  const gate = checkLimit({ key: `demo:${ipHash}`, limits: DEMO_RUN_LIMITS });
  if (!gate.allowed) {
    const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "rate_limited",
      message: `Demo limit reached (${gate.label}). Try again in ${retryAfterSec}s.`,
      retry_after_seconds: retryAfterSec,
    });
    return;
  }

  const db = getDb();
  const row = db
    .prepare(`SELECT name, hours_json, timezone FROM businesses WHERE slug = ?`)
    .get(DEMO_SLUG) as { name: string; hours_json: string | null; timezone: string | null } | undefined;
  if (!row) {
    res.status(503).json({
      error: "demo_unavailable",
      message: `Demo tenant '${DEMO_SLUG}' is not provisioned.`,
    });
    return;
  }

  let hours: HoursJson | null = null;
  try {
    hours = row.hours_json ? (JSON.parse(row.hours_json) as HoursJson) : null;
  } catch {
    hours = null;
  }

  // Today + 7 days window. synthSlots takes Unix seconds and handles
  // the timezone math; if hours_json is missing we still return an
  // empty slots list rather than 500ing — the widget shows "no slots
  // configured for this demo".
  const nowSec = Math.floor(Date.now() / 1000);
  const slots = hours
    ? synthSlots({
        hours,
        window_start: nowSec,
        window_end:   nowSec + 7 * 24 * 60 * 60,
        timezone:     row.timezone ?? undefined,
      })
    : [];

  // Surface as ISO strings for the widget — Unix-seconds isn't great UX.
  const niceSlots = slots.slice(0, 8).map((s) => ({
    start: new Date(s.start * 1000).toISOString(),
    end:   new Date(s.end * 1000).toISOString(),
  }));

  logDemoRun({ ip_hash: ipHash, demo_type: "availability", outcome: "ok" });
  res.json({
    ok: true,
    demo_slug: DEMO_SLUG,
    business_name: row.name,
    timezone: row.timezone,
    slots: niceSlots,
  });
});
