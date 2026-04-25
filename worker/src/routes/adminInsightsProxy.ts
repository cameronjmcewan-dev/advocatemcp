/**
 * /api/admin/insights-proxy/* — thin Worker proxy for Railway's admin
 * insights endpoints.
 *
 * The Railway server (server/src/routes/admin/insights.ts) exposes the
 * Phase 2 internal dashboard: overview KPIs, top-clusters, profile-gaps,
 * trends, embeddings-health. Those endpoints are gated behind Bearer
 * ADMIN_API_KEY so exposing the Railway hostname + key directly to a
 * browser is a non-starter.
 *
 * This Worker route forwards the request from the authenticated
 * Pages-side admin console to Railway, injecting ADMIN_API_KEY
 * server-side. The admin-role gate here re-uses the session already
 * verified for /api/client/* — a non-admin caller gets 403 before any
 * outbound fetch.
 *
 * Allowlist: only five known insights sub-paths. Anything else gets a
 * 404 from the Worker, preventing this proxy from becoming a general
 * shell against Railway.
 */

import type { Env } from "../types";
import { withCors, handleCorsPreflight } from "../lib/cors";
import { jsonErr } from "./onboard";
import { getSessionFromRequest } from "./authApi";

const ALLOWED_INSIGHTS_PATHS = new Set<string>([
  "overview",
  "top-queries",
  "top-clusters",
  "top-competitors",
  "profile-gaps",
  "trends",
  "embeddings-health",
]);

export function handleAdminInsightsProxyPreflight(request: Request): Response {
  return handleCorsPreflight(request, { credentials: true });
}

export async function handleAdminInsightsProxy(
  request: Request,
  env: Env,
  subpath: string,
): Promise<Response> {
  // Session gate — admin only. Same session shape as every other
  // /api/client/* handler.
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) {
    return withCors(jsonErr(401, "unauthorized", "Session required"), request, { credentials: true });
  }
  if (ctx.role !== "admin") {
    return withCors(jsonErr(403, "forbidden", "Admin only"), request, { credentials: true });
  }

  if (!ALLOWED_INSIGHTS_PATHS.has(subpath)) {
    return withCors(jsonErr(404, "not_found", "Unknown insights path"), request, { credentials: true });
  }

  const adminKey = env.ADMIN_API_KEY;
  if (!adminKey) {
    return withCors(
      jsonErr(503, "not_configured", "ADMIN_API_KEY not configured on Worker"),
      request,
      { credentials: true },
    );
  }

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  // Preserve incoming query string (e.g. ?limit=25&days=30).
  const incoming = new URL(request.url);
  const upstreamUrl = `${base}/admin/insights/${subpath}${incoming.search}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${adminKey}`,
        "Accept":        "application/json",
      },
    });

    // Stream the body through, preserving status + content-type. The
    // upstream JSON is already the shape the admin console expects.
    const body = await upstream.text();
    const headers = new Headers({
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    });
    return withCors(
      new Response(body, { status: upstream.status, headers }),
      request,
      { credentials: true },
    );
  } catch (err) {
    console.error(JSON.stringify({
      event: "admin_insights_proxy_error",
      subpath,
      error: String(err instanceof Error ? err.message : err),
    }));
    return withCors(
      jsonErr(502, "upstream_unreachable", "Insights upstream failed"),
      request,
      { credentials: true },
    );
  }
}

// ── Export the minimal set of JSON-first admin-only endpoints so the
// Pages admin console can render without a second auth token in the
// browser. Helpers above are the actual implementation.
export async function apiAdminOverview(request: Request, env: Env): Promise<Response> {
  return handleAdminInsightsProxy(request, env, "overview");
}

export async function apiAdminTopClusters(request: Request, env: Env): Promise<Response> {
  return handleAdminInsightsProxy(request, env, "top-clusters");
}

export async function apiAdminEmbeddingsHealth(request: Request, env: Env): Promise<Response> {
  return handleAdminInsightsProxy(request, env, "embeddings-health");
}

export async function apiAdminTrends(request: Request, env: Env): Promise<Response> {
  return handleAdminInsightsProxy(request, env, "trends");
}

// ── POST /api/admin/experiments/format-judge ─────────────────────────────
// Worker-side proxy to Railway's POST /admin/experiments/format-judge
// so admins can trigger format-judge experiments from the dashboard
// without exposing ADMIN_API_KEY to the browser.
//
// Same admin-role + ADMIN_API_KEY gate as the insights proxy. POST body
// flows through unchanged. Response streams through.

export async function handleAdminExperimentFormatJudge(
  request: Request,
  env: Env,
): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) {
    return withCors(jsonErr(401, "unauthorized", "Session required"), request, { credentials: true });
  }
  if (ctx.role !== "admin") {
    return withCors(jsonErr(403, "forbidden", "Admin only"), request, { credentials: true });
  }

  const adminKey = env.ADMIN_API_KEY;
  if (!adminKey) {
    return withCors(
      jsonErr(503, "not_configured", "ADMIN_API_KEY not configured on Worker"),
      request,
      { credentials: true },
    );
  }

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  const upstreamUrl = `${base}/admin/experiments/format-judge`;

  // Forward the POST body verbatim. Body may be {} (use defaults) or
  // { profile_slugs, queries, variant_ids, judges }.
  let body = "{}";
  try { body = await request.text(); } catch { /* keep default */ }
  if (!body || !body.trim()) body = "{}";

  try {
    // Format-judge is slow — Railway runs N trials sequentially against
    // Claude. 30 trials at ~5s each = 2.5 minutes. The Worker default
    // fetch timeout is 30 minutes for subrequests so we're fine, but
    // browser fetch may hang up earlier — caller should be aware.
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${adminKey}`,
        "Content-Type":  "application/json",
        "Accept":        "application/json",
      },
      body,
    });

    const text = await upstream.text();
    const headers = new Headers({
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    });
    return withCors(
      new Response(text, { status: upstream.status, headers }),
      request,
      { credentials: true },
    );
  } catch (err) {
    console.error(JSON.stringify({
      event: "admin_format_judge_error",
      error: String(err instanceof Error ? err.message : err),
    }));
    return withCors(
      jsonErr(502, "upstream_unreachable", "format-judge upstream failed"),
      request,
      { credentials: true },
    );
  }
}

export function handleAdminExperimentFormatJudgePreflight(request: Request): Response {
  return handleCorsPreflight(request, { credentials: true });
}
