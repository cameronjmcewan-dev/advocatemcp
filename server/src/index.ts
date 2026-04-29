import "dotenv/config";
// Sentry MUST come before any other imports so it can auto-instrument
// http, express, fs, etc. on the way in. The instrument module is a
// sideeffect-only import — it calls Sentry.init() at module-eval time.
import "./instrument.js";
import * as Sentry from "@sentry/node";
import cron from "node-cron";
import { createTestApp } from "./testApp.js";
import { getDb } from "./db.js";
import { startReputationRollupSchedule } from "./jobs/reputationRollup.js";
import { startFaqBackfillSchedule } from "./jobs/faqBackfill.js";
import { startSyntheticPagesBuilderSchedule } from "./jobs/syntheticPagesBuilder.js";
import { startComparisonPagesBuilderSchedule } from "./jobs/comparisonPagesBuilder.js";
import { pollAll } from "./jobs/competitorRadar.js";
import { startWeeklyDigestSchedule } from "./jobs/weeklyDigest.js";
import { startBetaEndingSchedule } from "./jobs/betaEndingEmail.js";
import { startMonthlyPerformanceReviewSchedule } from "./jobs/monthlyPerformanceReview.js";
import { startBackfillSchedule } from "./jobs/backfillQueries.js";
import { startEmbeddingsBackfillSchedule } from "./jobs/backfillEmbeddings.js";
import { startClusterSchedule } from "./jobs/clusterQueries.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}
if (!process.env.API_KEY) {
  console.warn("⚠️  API_KEY is not set — server-level auth disabled. Set API_KEY in Railway env vars.");
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BASE = process.env.API_BASE_URL ?? `http://localhost:${PORT}`;

const app = createTestApp();

// Apr 28 2026 verification endpoint. GET /__sentry-test forces a
// synthetic captureMessage + flush so we can verify the DSN is wired
// correctly without waiting for organic traffic OR boot timing. The
// flush is critical — `captureMessage` queues the event and returns
// an ID synchronously, but the transport delivers async; on a long-
// running Express process the queue eventually drains, but we want
// the test to confirm delivery before responding.
app.get("/__sentry-test", async (_req, res) => {
  const id = Sentry.captureException(
    new Error(`server test event ${new Date().toISOString()}`),
  );
  const flushed = await Sentry.flush(5000);
  // Echo back the DSN host + project ID so we can confirm the
  // server is sending events to the project we expect.
  let dsn_host = "unknown";
  let project_id = "unknown";
  let parse_err = "none";
  const dsn = process.env.SENTRY_DSN ?? "";
  try {
    if (dsn) {
      const u = new URL(dsn);
      dsn_host = u.host;
      project_id = u.pathname.replace(/^\//, "");
    }
  } catch (e: any) { parse_err = String(e?.message ?? e); }
  const dsn_redacted = dsn
    .replace(/(\/\/)[^@]+@/, "$1<KEY>@")
    .slice(0, 200);
  res.json({
    ok:               true,
    sentry_event_id:  id,
    flushed,
    dsn_configured:   !!process.env.SENTRY_DSN,
    dsn_length:       dsn.length,
    dsn_starts_with:  dsn.slice(0, 8),
    dsn_redacted,
    dsn_host,
    project_id,
    parse_err,
  });
});

app.get("/", (_req, res) => {
  res.json({
    service: "AdvocateMCP Agent API",
    version: "1.0.0",
    description:
      "Intercepts AI search crawler traffic and routes it to conversational business agents.",
    endpoints: {
      "POST /register": "Register a new business agent",
      "POST /agents/:slug/query": "Query a business agent",
      "GET  /agents/:slug/profile": "Public structured business profile",
      "GET  /analytics/:slug": "View analytics (requires API key)",
      "POST /mcp": "MCP server endpoint (Streamable HTTP)",
      "GET  /mcp": "MCP server info + SSE handshake",
      "GET  /.well-known/ai-agent.json": "AI agent discovery spec",
      "GET  /registry": "Public list of all registered businesses",
      "GET  /health": "Health check",
    },
    docs: "https://advocatemcp.com/docs",
    mcp_endpoint: `${BASE}/mcp`,
  });
});

// ── 404 handler (must be last) ──
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Sentry's express error handler. Captures any unhandled error from
// route handlers + the cron jobs above. Must come AFTER all the
// `app.use(...)` and route definitions but BEFORE any user-defined
// error handler. (We don't have one today, but this position is the
// canonical Sentry placement.)
Sentry.setupExpressErrorHandler(app);

// Session 11: kick off the 15-minute agent_reputation rollup so /admin/agents
// has fresh data without depending on an external cron. Idempotent + unref'd.
startReputationRollupSchedule(getDb());

// Phase 1 (Layer 1 instrumentation): daily backfill for queries.intent_v2 +
// industry_code on rows that missed inline enrichment (historical data,
// or rows where classifyAndPersist failed). Gated on ANTHROPIC_API_KEY so
// a dev/test deploy without the key silently skips. Daily budget guard
// inside the job protects against a runaway classifier bill.
startBackfillSchedule();
startEmbeddingsBackfillSchedule();
startClusterSchedule();

// Session 4 (Competitor Radar): cron-driven Perplexity poll loop.
// Default schedule = Mon/Wed/Fri at 04:00 UTC. Cron is gated on
// PERPLEXITY_API_KEY presence so dev/test deploys without the key are silent.
const CRON_SCHEDULE = process.env.POLL_SCHEDULE_CRON ?? "0 4 * * 1,3,5";
if (process.env.PERPLEXITY_API_KEY && cron.validate(CRON_SCHEDULE)) {
  cron.schedule(CRON_SCHEDULE, () => {
    pollAll().catch((err) => console.error("[radar] pollAll threw:", err));
  });
  console.log(`[radar] scheduled: ${CRON_SCHEDULE}`);
} else {
  console.warn("[radar] cron NOT scheduled — missing PERPLEXITY_API_KEY or invalid POLL_SCHEDULE_CRON");
}

// P5: weekly Competitor Radar digest. Mondays 14:00 UTC by default.
// Gated on RESEND_API_KEY so dev/test deploys without the key stay silent.
startWeeklyDigestSchedule();
startBetaEndingSchedule();
// Monthly executive review email (Apr 27 2026). 1st of each month at
// 09:00 UTC. Pro/Enterprise only; active-beta tenants get the weekly
// digest's beta variant instead so they don't double-up. Same RESEND
// gate as the schedules above.
startMonthlyPerformanceReviewSchedule();

// FAQ backfill (Apr 28 2026 — Phase 1 grey-hat AI optimization).
// Daily 03:00 UTC. Gated on FEATURE_FAQS_V2 + ANTHROPIC_API_KEY.
// Generates leading-question Q&As for every business with NULL
// faqs_json so existing tenants get the multi-entry FAQPage schema
// without re-onboarding.
startFaqBackfillSchedule();

// Synthetic landing pages builder (Apr 28 2026 — Phase 3 grey-hat).
// Daily 02:00 UTC. Gated on FEATURE_SYNTHETIC_PAGES + ANTHROPIC_API_KEY.
// Generates up to tier-cap pages per Pro+ tenant: Base 10, Pro 40,
// Enterprise 150 soft / 500 hard. Per-service + per-location sub-caps
// keep content distinct. Each row is fact-validated before going live.
startSyntheticPagesBuilderSchedule();

// Comparison pages builder (Apr 28 2026 — Phase 4 grey-hat).
// 1st of each month at 03:00 UTC. Gated on FEATURE_COMPARISON_PAGES +
// ANTHROPIC_API_KEY. Strict validator: each row must reference ≥3
// differentiators that pair non-null facts on BOTH sides + have a
// public source URL on each side. Banned-phrase regex blocks
// disparaging language.
startComparisonPagesBuilderSchedule();

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║           AdvocateMCP Server — Ready             ║
╠══════════════════════════════════════════════════╣
║  Server:     http://localhost:${PORT}               ║
║  MCP:        http://localhost:${PORT}/mcp           ║
║  Register:   POST http://localhost:${PORT}/register ║
║  Registry:   http://localhost:${PORT}/registry      ║
║  Well-known: http://localhost:${PORT}/.well-known/ai-agent.json  ║
╚══════════════════════════════════════════════════╝
`);
});
