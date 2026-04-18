import { Router } from "express";
import type { Request, Response } from "express";
import { sendAllDigests } from "../../jobs/weeklyDigest.js";
import { buildDigest, digestWindowForDate } from "../../jobs/digestBuilder.js";
import { mintUnsubscribeToken } from "../../lib/unsubscribeToken.js";
import { getDb } from "../../db.js";

export const adminDigestRouter = Router();

/**
 * POST /admin/digest/run-now
 *   ?dry_run=true   — iterate eligible tenants + build digests, but do not
 *                     call Resend. Returns the would-send recipient list +
 *                     per-tenant subject for template review.
 *
 * Without `dry_run`, this triggers the real weekly cron synchronously and
 * returns the same stats the scheduled run would log. Idempotent within a
 * UTC day via the `radar_digests` unique key — safe to call more than once.
 *
 * Bearer auth is enforced by `routes/admin/index.ts` one level up.
 */
adminDigestRouter.post("/digest/run-now", async (req: Request, res: Response) => {
  const dryRun = req.query.dry_run === "true" || req.query.dry_run === "1";

  if (!dryRun) {
    try {
      const stats = await sendAllDigests();
      res.json({ dry_run: false, ...stats });
      return;
    } catch (err) {
      res.status(500).json({
        error: "digest_run_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  // Dry run: replicate the cron's tenant selection, build a digest per
  // eligible tenant, report what WOULD have been sent. No Resend call.
  const db = getDb();
  const window = digestWindowForDate(new Date(), 7);
  const proTenants = db
    .prepare(`SELECT slug FROM businesses WHERE plan='pro' AND api_key <> 'pending'`)
    .all() as { slug: string }[];

  const would_send: Array<{ slug: string; recipient: string; subject: string; polls: number; cited: number }> = [];
  const skipped: Array<{ slug: string; reason: "buildDigest_returned_null" }> = [];

  for (const { slug } of proTenants) {
    const unsubscribeUrl = `https://advocate-production-2887.up.railway.app/digest/unsubscribe/${mintUnsubscribeToken(slug)}`;
    const payload = buildDigest(slug, { window, unsubscribeUrl });
    if (!payload) {
      skipped.push({ slug, reason: "buildDigest_returned_null" });
      continue;
    }
    would_send.push({
      slug,
      recipient: payload.recipient,
      subject:   payload.subject,
      polls:     payload.totals.polls,
      cited:     payload.totals.cited,
    });
  }

  res.json({
    dry_run:    true,
    considered: proTenants.length,
    would_send,
    skipped,
    window,
  });
});

/**
 * GET /admin/digest/preview/:slug — render a single tenant's digest HTML
 * into the response body so an operator can eyeball the template in a
 * browser. No Resend call, no write to radar_digests.
 *
 * The tenant must exist. `buildDigest` will still return null for an
 * unsubscribed / no-email / non-Pro / zero-poll tenant; in that case we
 * respond with 200 + a diagnostic JSON so the caller sees the skip reason.
 */
adminDigestRouter.get("/digest/preview/:slug", (req: Request, res: Response) => {
  const { slug } = req.params;
  const unsubscribeUrl = `https://advocate-production-2887.up.railway.app/digest/unsubscribe/${mintUnsubscribeToken(slug)}`;
  const payload = buildDigest(slug, { unsubscribeUrl });
  if (!payload) {
    res.json({
      slug,
      skipped: true,
      reason:  "buildDigest_returned_null (missing email, unsubscribed, non-Pro, or zero polls in window)",
    });
    return;
  }
  res
    .status(200)
    .set("Content-Type", "text/html")
    .set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'")
    .send(payload.html);
});
