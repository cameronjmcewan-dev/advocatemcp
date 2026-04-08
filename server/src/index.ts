import "dotenv/config";
import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import { agentRouter } from "./routes/agent.js";
import { mcpRouter } from "./routes/mcp.js";
import { registerRouter } from "./routes/register.js";
import { analyticsRouter } from "./routes/analytics.js";
import { wellknownRouter } from "./routes/wellknown.js";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";

// ── Validate required env vars at startup ──
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}
if (!process.env.API_KEY) {
  console.warn("⚠️  API_KEY is not set — server-level auth disabled. Set API_KEY in Railway env vars.");
}

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BASE = process.env.API_BASE_URL ?? `http://localhost:${PORT}`;

// ── Security headers (no external dep) ──
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options",   "nosniff");
  res.setHeader("X-Frame-Options",          "DENY");
  res.setHeader("X-XSS-Protection",         "1; mode=block");
  res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");
  res.setHeader("Referrer-Policy",          "no-referrer");
  res.setHeader("Content-Security-Policy",  "default-src 'none'");
  next();
});

// ── CORS ──
const WORKER_ORIGIN = "https://advocatemcp-worker.advocatecameron.workers.dev";
app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server calls (no Origin header) and the Worker origin
    if (!origin || origin === WORKER_ORIGIN) { cb(null, true); return; }
    cb(new Error("CORS: origin not allowed"));
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
}));

// ── Body parsing + rate limiting ──
app.use(express.json());
app.use(rateLimitMiddleware);

// ── Initialize DB (creates tables + runs migrations) ──
getDb();

// ── Routes ──
app.use(wellknownRouter);   // /.well-known/ai-agent.json, /registry  (public)
app.use(registerRouter);    // POST /register                          (requireApiKey)
app.use(agentRouter);       // GET /agents/:slug/profile, POST /query  (requireApiKey)
app.use(analyticsRouter);   // GET /analytics, GET /analytics/:slug    (requireApiKey)
app.use(mcpRouter);         // POST /mcp, GET /mcp

// ── Health check (public) ──
app.get("/health", (_req, res) => {
  const db = getDb();
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM businesses").get() as { count: number };
  res.json({
    status:         "ok",
    service:        "AdvocateMCP",
    version:        "1.0.0",
    uptime_seconds: Math.floor(process.uptime()),
    registry_count: count,
  });
});

// ── Root info ──
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

// ── 404 handler ──
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Start server ──
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
