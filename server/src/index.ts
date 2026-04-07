import "dotenv/config";
import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import { agentRouter } from "./routes/agent.js";
import { mcpRouter } from "./routes/mcp.js";
import { registerRouter } from "./routes/register.js";
import { analyticsRouter } from "./routes/analytics.js";
import { wellknownRouter } from "./routes/wellknown.js";

// ── Validate required env vars at startup ──
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BASE = process.env.API_BASE_URL ?? `http://localhost:${PORT}`;

// ── Middleware ──
app.use(cors());
app.use(express.json());

// ── Initialize DB (creates tables if needed) ──
getDb();

// ── Routes ──
app.use(wellknownRouter);   // /.well-known/ai-agent.json, /registry
app.use(registerRouter);    // POST /register
app.use(agentRouter);       // POST /agents/:slug/query
app.use(analyticsRouter);   // GET  /analytics/:slug
app.use(mcpRouter);         // POST /mcp, GET /mcp

// ── Health check ──
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "AdvocateMCP", version: "1.0.0" });
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
