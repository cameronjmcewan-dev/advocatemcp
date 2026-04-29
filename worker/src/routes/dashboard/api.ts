/**
 * Dashboard CRUD endpoints (Phase B of the redesign).
 *
 * All routes require an authenticated portal session (cookie-bearer).
 * Ownership is enforced inline — every query is scoped to the current
 * user_id + a business the user has access to via user_business_access.
 *
 * Mounted from worker/src/routes/portal.ts.
 *
 * Apr 29 2026.
 */

import type { Env } from "../../types";
import {
  getDashboards,
  getDashboard,
  getOrSeedDefaultDashboard,
  createDashboard,
  updateDashboard,
  promoteDashboardToDefault,
  deleteDashboard,
  getUserBusinesses,
  getActiveBusinesses,
} from "../../portalDb";
import type { Business } from "../../portalDb";
import { getSessionFromRequest } from "../authApi";
import { withCors } from "../../lib/cors";

type SessionCtx = Awaited<ReturnType<typeof getSessionFromRequest>>;

async function getCtx(request: Request, env: Env): Promise<NonNullable<SessionCtx> | null> {
  const ctx = await getSessionFromRequest(request, env);
  return ctx ?? null;
}

/** Wrap a JSON Response with the shared CORS helper so the static site at
 *  advocatemcp.com (Cloudflare Pages) can call these endpoints under the
 *  same origin allowlist as /api/client/me, /api/client/metrics, etc.
 *  `credentials: true` so the bearer cookie travels cross-origin. */
function json(status: number, body: unknown, request: Request): Response {
  return withCors(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    request,
    { credentials: true },
  );
}

/** Resolve the active business for this request — same logic as
 *  apiMetrics: ?slug=... overrides; otherwise the first business the
 *  user has access to. Admins see every active business. Returns null
 *  when no match. */
async function resolveBusiness(
  request: Request, env: Env, ctx: NonNullable<SessionCtx>,
): Promise<Business | null> {
  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  return (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
}

/* ── GET /api/client/dashboards ────────────────────────────────────────── */
export async function listDashboards(request: Request, env: Env): Promise<Response> {
  const ctx = await getCtx(request, env);
  if (!ctx) return json(401, { error: "Unauthorized" }, request);
  const biz = await resolveBusiness(request, env, ctx);
  if (!biz) return json(404, { error: "No business found for this account" }, request);

  // Auto-seed the default dashboard on first call so a brand-new user
  // never sees an empty sidebar list.
  await getOrSeedDefaultDashboard(env.DB, ctx.user_id, biz.id);
  const rows = await getDashboards(env.DB, ctx.user_id, biz.id);
  return json(200, { business_slug: biz.slug, business_name: biz.business_name, dashboards: rows }, request);
}

/* ── GET /api/client/dashboards/:id ────────────────────────────────────── */
export async function getOneDashboard(
  request: Request, env: Env, idStr: string,
): Promise<Response> {
  const ctx = await getCtx(request, env);
  if (!ctx) return json(401, { error: "Unauthorized" }, request);
  const biz = await resolveBusiness(request, env, ctx);
  if (!biz) return json(404, { error: "No business found" }, request);
  const id = Number.parseInt(idStr, 10);
  if (!Number.isFinite(id)) return json(400, { error: "invalid_id" }, request);
  const row = await getDashboard(env.DB, id, ctx.user_id, biz.id);
  if (!row) return json(404, { error: "not_found" }, request);
  return json(200, { dashboard: row }, request);
}

/* ── POST /api/client/dashboards ───────────────────────────────────────── */
export async function postDashboard(request: Request, env: Env): Promise<Response> {
  const ctx = await getCtx(request, env);
  if (!ctx) return json(401, { error: "Unauthorized" }, request);
  const biz = await resolveBusiness(request, env, ctx);
  if (!biz) return json(404, { error: "No business found" }, request);

  let body: { name?: unknown; copy_from_id?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json(400, { error: "invalid_json" }, request); }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json(400, { error: "name_required" }, request);
  if (name.length > 100) return json(400, { error: "name_too_long" }, request);

  const copyFromId = typeof body.copy_from_id === "number" ? body.copy_from_id : null;

  try {
    const row = await createDashboard(env.DB, ctx.user_id, biz.id, name, copyFromId);
    return json(201, { dashboard: row }, request);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // D1's UNIQUE-violation error contains "UNIQUE constraint failed".
    if (/UNIQUE/i.test(msg)) return json(409, { error: "name_in_use" }, request);
    return json(500, { error: "create_failed", detail: msg }, request);
  }
}

/* ── PATCH /api/client/dashboards/:id ──────────────────────────────────── */
export async function patchDashboard(
  request: Request, env: Env, idStr: string,
): Promise<Response> {
  const ctx = await getCtx(request, env);
  if (!ctx) return json(401, { error: "Unauthorized" }, request);
  const biz = await resolveBusiness(request, env, ctx);
  if (!biz) return json(404, { error: "No business found" }, request);
  const id = Number.parseInt(idStr, 10);
  if (!Number.isFinite(id)) return json(400, { error: "invalid_id" }, request);

  let body: { name?: unknown; layout?: unknown; filters?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json(400, { error: "invalid_json" }, request); }

  const patch: { name?: string; layout_json?: string; filters_json?: string } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return json(400, { error: "invalid_name" }, request);
    patch.name = body.name.trim().slice(0, 100);
  }
  if (body.layout !== undefined) {
    if (!Array.isArray(body.layout)) return json(400, { error: "invalid_layout" }, request);
    // Light shape check — every entry must have a card_id string + size enum.
    for (const e of body.layout) {
      if (!e || typeof e !== "object") return json(400, { error: "invalid_layout_entry" }, request);
      const ee = e as { card_id?: unknown; size?: unknown };
      if (typeof ee.card_id !== "string") return json(400, { error: "invalid_layout_entry" }, request);
      if (!["sm","md","lg","xl"].includes(String(ee.size))) return json(400, { error: "invalid_layout_size" }, request);
    }
    patch.layout_json = JSON.stringify(body.layout);
  }
  if (body.filters !== undefined) {
    if (typeof body.filters !== "object" || body.filters === null) return json(400, { error: "invalid_filters" }, request);
    patch.filters_json = JSON.stringify(body.filters);
  }

  try {
    const row = await updateDashboard(env.DB, id, ctx.user_id, biz.id, patch);
    if (!row) return json(404, { error: "not_found" }, request);
    return json(200, { dashboard: row }, request);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) return json(409, { error: "name_in_use" }, request);
    return json(500, { error: "update_failed", detail: msg }, request);
  }
}

/* ── POST /api/client/dashboards/:id/promote-default ───────────────────── */
export async function promoteDashboard(
  request: Request, env: Env, idStr: string,
): Promise<Response> {
  const ctx = await getCtx(request, env);
  if (!ctx) return json(401, { error: "Unauthorized" }, request);
  const biz = await resolveBusiness(request, env, ctx);
  if (!biz) return json(404, { error: "No business found" }, request);
  const id = Number.parseInt(idStr, 10);
  if (!Number.isFinite(id)) return json(400, { error: "invalid_id" }, request);

  const row = await promoteDashboardToDefault(env.DB, id, ctx.user_id, biz.id);
  if (!row) return json(404, { error: "not_found" }, request);
  return json(200, { dashboard: row }, request);
}

/* ── DELETE /api/client/dashboards/:id ─────────────────────────────────── */
export async function deleteOneDashboard(
  request: Request, env: Env, idStr: string,
): Promise<Response> {
  const ctx = await getCtx(request, env);
  if (!ctx) return json(401, { error: "Unauthorized" }, request);
  const biz = await resolveBusiness(request, env, ctx);
  if (!biz) return json(404, { error: "No business found" }, request);
  const id = Number.parseInt(idStr, 10);
  if (!Number.isFinite(id)) return json(400, { error: "invalid_id" }, request);

  const result = await deleteDashboard(env.DB, id, ctx.user_id, biz.id);
  if (!result.ok) {
    if (result.reason === "not_found") return json(404, { error: "not_found" }, request);
    if (result.reason === "is_default") return json(409, { error: "is_default_promote_first" }, request);
  }
  return json(200, { ok: true }, request);
}
