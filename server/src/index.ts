import "dotenv/config";
import cron from "node-cron";
import { createTestApp } from "./testApp.js";
import { getDb } from "./db.js";
import { startReputationRollupSchedule } from "./jobs/reputationRollup.js";
import { pollAll } from "./jobs/competitorRadar.js";
import { startWeeklyDigestSchedule } from "./jobs/weeklyDigest.js";
import { startBackfillSchedule } from "./jobs/backfillQueries.js";
import { startEmbeddingsBackfillSchedule } from "./jobs/backfillEmbeddings.js";

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
