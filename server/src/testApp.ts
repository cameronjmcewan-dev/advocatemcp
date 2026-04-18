import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import { agentRouter } from "./routes/agent.js";
import { mcpRouter } from "./routes/mcp.js";
import { registerRouter } from "./routes/register.js";
import { analyticsRouter } from "./routes/analytics.js";
import { wellknownRouter } from "./routes/wellknown.js";
import { wellknownMcpRouter } from "./routes/wellknownMcp.js";
import { a2aRouter } from "./routes/a2a.js";
import { adminRouter } from "./routes/admin/index.js";
import { competitorRadarRouter } from "./routes/competitorRadar.js";
import { digestRouter } from "./routes/digest.js";
import { decodeRouter } from "./routes/decode.js";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";
import { requestIdMiddleware } from "./lib/requestId.js";

/**
 * Build the Express app without calling `.listen()`. Shared by `index.ts`
 * (production entry) and by tests that want to exercise the middleware stack
 * end-to-end via supertest.
 *
 * Note: the 404 handler is intentionally NOT registered here. `index.ts`
 * mounts a `/` route after calling this function and then appends the 404
 * handler as the final middleware. Registering the 404 here would shadow
 * `/` in production.
 */
export function createTestApp(): express.Express {
  const app = express();

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options",   "nosniff");
    res.setHeader("X-Frame-Options",          "DENY");
    res.setHeader("X-XSS-Protection",         "1; mode=block");
    res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");
    res.setHeader("Referrer-Policy",          "no-referrer");
    res.setHeader("Content-Security-Policy",  "default-src 'none'");
    next();
  });

  // Rate limit + requestId run before every route (including the Session 5
  // decode endpoint below — we want the decode endpoint rate-limited too).
  app.use(rateLimitMiddleware);
  app.use(requestIdMiddleware);

  // Session 5 — `GET /r/:token/decode` is intentionally public + cross-origin.
  // It's called from customer-owned third-party domains (e.g.
  // workmancopyco.com) so it MUST bypass the worker-only origin whitelist in
  // the global `cors()` middleware below. The router sets permissive ACAO
  // headers itself and exposes only non-sensitive fields.
  app.use(decodeRouter);

  const WORKER_ORIGIN = "https://advocatemcp-worker.advocatecameron.workers.dev";
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || origin === WORKER_ORIGIN) { cb(null, true); return; }
      cb(new Error("CORS: origin not allowed"));
    },
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  }));

  app.use(express.json({ limit: "1mb" }));

  getDb();

  app.use(wellknownRouter);
  app.use(wellknownMcpRouter);
  app.use(registerRouter);
  app.use(agentRouter);
  app.use(analyticsRouter);
  app.use(mcpRouter);
  app.use(a2aRouter);
  app.use(adminRouter);
  app.use(competitorRadarRouter);
  app.use(digestRouter);

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

  return app;
}
