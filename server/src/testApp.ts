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
import { profileScoreRouter } from "./routes/profileScore.js";
import { aiRecommendationsRouter } from "./routes/aiRecommendations.js";
import { digestRouter } from "./routes/digest.js";
import { demoRouter } from "./routes/demo.js";
import { decodeRouter } from "./routes/decode.js";
import { auditRouter } from "./routes/audit.js";
import { jsonLdRouter } from "./routes/jsonLd.js";
import { platformContextRouter } from "./routes/platformContext.js";
import { syntheticPagesRouter } from "./routes/syntheticPages.js";
import { comparisonPagesRouter } from "./routes/comparisonPages.js";
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
  // It's called from customer-owned third-party domains so it MUST bypass
  // the worker-only origin whitelist in
  // the global `cors()` middleware below. The router sets permissive ACAO
  // headers itself and exposes only non-sensitive fields.
  app.use(decodeRouter);

  // Public GEO Audit endpoint. Called from the /audit marketing page on
  // advocatemcp.com (different origin from api.advocatemcp.com) by anyone,
  // signed-up or not. Same reasoning as decode: mount before the
  // worker-only `cors()` middleware and set permissive ACAO inside the
  // router. Rate-limited + budget-capped inside the handler, not via
  // rateLimitMiddleware (this needs per-IP-per-day semantics, not
  // per-minute burst semantics).
  //
  // express.json() is below cors() — we need the body parser for POST.
  // Moving express.json() up.
  app.use(express.json({ limit: "1mb" }));
  app.use(auditRouter);

  // Schema.org JSON-LD — same public + any-origin rule as decode/audit.
  // Must be before the worker-only cors() below so Google's crawler and
  // the dashboard (on a different origin) can both fetch.
  app.use(jsonLdRouter);

  const WORKER_ORIGIN = "https://advocatemcp-worker.advocatecameron.workers.dev";
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || origin === WORKER_ORIGIN) { cb(null, true); return; }
      cb(new Error("CORS: origin not allowed"));
    },
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  }));

  // express.json() was moved above for the audit router to parse bodies.
  // Don't re-register it here — duplicate middleware parses bodies twice.

  getDb();

  app.use(wellknownRouter);
  app.use(wellknownMcpRouter);
  app.use(registerRouter);
  // Platform-context (Phase 2 grey-hat). Mount BEFORE agentRouter so its
  // GET /agents/:slug/context/:platform pattern matches first; agentRouter
  // has a more permissive GET /agents/:slug/* set that would otherwise
  // claim it. Public, no auth — same posture as /agents/:slug/profile.
  app.use(platformContextRouter);
  // Synthetic landing pages (Phase 3 grey-hat). GET /synthetic/:host/*
  // serves pre-rendered (intent × service × location) pages. Public, no
  // auth. Worker proxies inbound /best-{service}-(in|near)-{location}
  // patterns through to this route.
  app.use(syntheticPagesRouter);
  // Comparison pages (Phase 4 grey-hat). GET /compare/:host/* serves
  // {customer}-vs-{competitor} pages. Public, no auth, behind
  // FEATURE_COMPARISON_PAGES (default off — strict-validator gate
  // means no rows ship until competitors.verified_facts_json is
  // populated by an operator).
  app.use(comparisonPagesRouter);
  app.use(agentRouter);
  app.use(analyticsRouter);
  app.use(mcpRouter);
  app.use(a2aRouter);
  app.use(adminRouter);
  app.use(competitorRadarRouter);
  app.use(profileScoreRouter);
  app.use(aiRecommendationsRouter);
  app.use(digestRouter);
  app.use(demoRouter);

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
