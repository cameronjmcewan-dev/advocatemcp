/**
 * Push a business_status transition to the Railway server's
 * POST /agents/:slug/status endpoint so the server-side auth middleware
 * (server/src/middleware/auth.ts) can fail-closed for cancelled / suspended
 * subscriptions.
 *
 * Best-effort: a 4xx/5xx or network error MUST NOT throw or block the
 * calling Stripe webhook handler. The Worker D1 state has already been
 * updated by the time this is called; the server-side update is a soft
 * mirror. Two compensating controls if a sync fails:
 *   1. The Worker D1 row is authoritative for dashboard/portal access.
 *   2. The railwayReconciler cron (worker/src/cron/) can be extended to
 *      reconcile status drift on a schedule.
 *
 * Returns a discriminated union so the caller can audit the outcome.
 */

import type { Env } from "../types";

export type ServerStatusSyncResult =
  | { ok: true; previous_status: string; new_status: string; status_changed_at: string }
  | { ok: false; reason: "not_configured" | "network_error" | "http_error" | "unexpected"; detail?: string };

const SYNC_TIMEOUT_MS = 10_000;

export async function pushBusinessStatusToServer(
  env: Env,
  slug: string,
  newStatus: string,
): Promise<ServerStatusSyncResult> {
  if (!env.API_BASE_URL || !env.API_KEY) {
    return {
      ok: false,
      reason: "not_configured",
      detail: !env.API_BASE_URL ? "API_BASE_URL not set" : "API_KEY not set",
    };
  }

  const url = `${env.API_BASE_URL}/agents/${encodeURIComponent(slug)}/status`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": env.API_KEY,
      },
      body: JSON.stringify({ status: newStatus }),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: "network_error", detail: String(err) };
  }

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json() as { error?: string; message?: string };
      if (body.error || body.message) {
        detail += `: ${body.error ?? body.message}`;
      }
    } catch {
      // non-JSON body — keep the bare status
    }
    return { ok: false, reason: "http_error", detail };
  }

  try {
    const body = await resp.json() as {
      ok?: boolean;
      previous_status?: string;
      new_status?: string;
      status_changed_at?: string;
    };
    if (!body.ok || !body.new_status || !body.status_changed_at) {
      return { ok: false, reason: "unexpected", detail: "missing fields in 2xx response" };
    }
    return {
      ok: true,
      previous_status: body.previous_status ?? "active",
      new_status: body.new_status,
      status_changed_at: body.status_changed_at,
    };
  } catch (err) {
    return { ok: false, reason: "unexpected", detail: `JSON parse failed: ${String(err)}` };
  }
}
