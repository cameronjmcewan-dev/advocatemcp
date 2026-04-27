/**
 * POST /admin/revenue-events/mirror — Worker → Railway mirror endpoint.
 *
 * Worker is the canonical receiver for HMAC-signed customer webhooks
 * (writes to D1 first for sub-50ms ack). After every successful D1
 * insert, the worker POSTs the event here so Railway's revenue_events
 * table stays in lockstep. Without this mirror the monthly review
 * email cron (which reads from Railway only) would always show zero
 * verified revenue regardless of webhook activity.
 *
 * Auth: ADMIN_API_KEY bearer (same as the rest of /admin/*). The
 * worker holds the same key in its `API_KEY` env var.
 *
 * Idempotency: INSERT-OR-IGNORE on (business_slug, external_ref) so
 * a worker retry after a Railway 5xx doesn't double-count.
 */

import { Router, type Request, type Response } from "express";
import { getDb } from "../../db.js";

export const adminRevenueEventsRouter = Router();

interface MirrorBody {
  business_slug:  string;
  id:             string;
  reservation_id: string | null;
  amount_cents:   number;
  currency:       string;
  occurred_at:    string;
  external_ref:   string;
}

function isMirrorBody(b: unknown): b is MirrorBody {
  if (!b || typeof b !== "object") return false;
  const r = b as Record<string, unknown>;
  return (
    typeof r.business_slug === "string" && r.business_slug.length > 0 &&
    typeof r.id === "string" && r.id.length > 0 &&
    (r.reservation_id === null || typeof r.reservation_id === "string") &&
    typeof r.amount_cents === "number" && Number.isInteger(r.amount_cents) && r.amount_cents >= 0 &&
    typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency) &&
    typeof r.occurred_at === "string" && !Number.isNaN(Date.parse(r.occurred_at)) &&
    typeof r.external_ref === "string" && r.external_ref.length > 0 && r.external_ref.length <= 200
  );
}

adminRevenueEventsRouter.post("/admin/revenue-events/mirror", (req: Request, res: Response) => {
  if (!isMirrorBody(req.body)) {
    res.status(400).json({ error: "validation", message: "invalid body shape" });
    return;
  }
  const b = req.body;

  // Sanity check the business exists. If not, log + 200 (the worker
  // already accepted the webhook; we don't want it to retry forever).
  const tenant = getDb()
    .prepare("SELECT slug FROM businesses WHERE slug = ?")
    .get(b.business_slug) as { slug: string } | undefined;
  if (!tenant) {
    console.warn(`[revenue-mirror] unknown_tenant slug=${b.business_slug} external_ref=${b.external_ref}`);
    res.status(200).json({ ok: true, mirrored: false, reason: "unknown_tenant" });
    return;
  }

  // INSERT OR IGNORE — UNIQUE(business_slug, external_ref) on the table
  // means worker retries are safe. We log mirrored=true|false so an
  // operator can spot persistent dedup behavior in Railway logs.
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO revenue_events
         (id, business_slug, reservation_id, amount_cents, currency,
          occurred_at, source, external_ref)
       VALUES (?, ?, ?, ?, ?, ?, 'webhook', ?)`,
    )
    .run(
      b.id,
      b.business_slug,
      b.reservation_id,
      b.amount_cents,
      b.currency,
      b.occurred_at,
      b.external_ref,
    );

  const mirrored = result.changes > 0;
  console.log(
    `[revenue-mirror] slug=${b.business_slug} external_ref=${b.external_ref} mirrored=${mirrored} amount_cents=${b.amount_cents}`,
  );
  res.json({ ok: true, mirrored });
});
