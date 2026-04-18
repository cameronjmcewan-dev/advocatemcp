/**
 * Weekly radar digest cron (P5).
 *
 * Runs Mondays at 14:00 UTC by default (7am PT, 10am ET). For each Pro
 * tenant with an email on file who isn't unsubscribed and has at least one
 * poll in the trailing 7 days, build the digest and send it via Resend.
 *
 * Idempotency: (slug, window_start_iso) is unique on `radar_digests`. If
 * this job runs twice on the same UTC day (operator re-runs, deploy
 * restart), the second attempt's INSERT OR IGNORE is a no-op and the
 * tenant receives exactly one digest per week.
 *
 * Failure isolation: one tenant's Resend error does not stop the batch.
 * Errors are recorded on the `radar_digests` row so operators can see
 * which tenants didn't receive this week's digest.
 */

import cron from "node-cron";
import { getDb } from "../db.js";
import { buildDigest, digestWindowForDate } from "./digestBuilder.js";
import { sendEmail } from "../lib/resend.js";
import { mintUnsubscribeToken } from "../lib/unsubscribeToken.js";

const DEFAULT_SCHEDULE = "0 14 * * 1";  // Mon 14:00 UTC

export interface SendAllDigestsStats {
  considered: number;
  sent:       number;
  skipped:    number;
  errors:     number;
}

function digestFrom(): string {
  return process.env.DIGEST_EMAIL_FROM ?? "radar@advocatemcp.com";
}

function dashboardBase(): string {
  return process.env.DASHBOARD_URL ?? "https://customers.advocatemcp.com/dashboard";
}

function unsubscribeBase(): string {
  return process.env.UNSUBSCRIBE_URL_BASE ?? "https://advocate-production-2887.up.railway.app/digest/unsubscribe";
}

/**
 * Entry point. Callable from cron, from tests, or from an admin endpoint
 * for smoke tests. Returns a stats summary so callers can log / assert.
 */
export async function sendAllDigests(now: Date = new Date()): Promise<SendAllDigestsStats> {
  const db = getDb();
  const window = digestWindowForDate(now, 7);

  const proTenants = db
    .prepare(`SELECT slug FROM businesses WHERE plan='pro' AND api_key <> 'pending'`)
    .all() as { slug: string }[];

  const stats: SendAllDigestsStats = { considered: proTenants.length, sent: 0, skipped: 0, errors: 0 };

  // Precheck idempotency in a single query so we don't even build digests
  // for tenants we've already emailed this week.
  const sentThisWindow = new Set(
    (db
      .prepare(`SELECT slug FROM radar_digests WHERE window_start_iso=? AND sent_at IS NOT NULL`)
      .all(window.start_iso) as { slug: string }[])
      .map((r) => r.slug),
  );

  const markAttempt = db.prepare(
    `INSERT OR IGNORE INTO radar_digests (slug, window_start_iso, window_end_iso) VALUES (?, ?, ?)`,
  );
  const recordSuccess = db.prepare(
    `UPDATE radar_digests SET sent_at=?, resend_id=?, error=NULL
      WHERE slug=? AND window_start_iso=? AND sent_at IS NULL`,
  );
  const recordError = db.prepare(
    `UPDATE radar_digests SET error=?
      WHERE slug=? AND window_start_iso=? AND sent_at IS NULL`,
  );

  for (const { slug } of proTenants) {
    if (sentThisWindow.has(slug)) { stats.skipped++; continue; }

    const unsubscribeUrl = `${unsubscribeBase()}/${mintUnsubscribeToken(slug)}`;
    const payload = buildDigest(slug, {
      window,
      dashboardUrl:   `${dashboardBase()}?slug=${encodeURIComponent(slug)}`,
      unsubscribeUrl,
    });

    if (!payload) { stats.skipped++; continue; }

    markAttempt.run(slug, window.start_iso, window.end_iso);

    try {
      const { id } = await sendEmail({
        from:    digestFrom(),
        to:      payload.recipient,
        subject: payload.subject,
        html:    payload.html,
        text:    payload.text,
      });
      recordSuccess.run(new Date().toISOString(), id, slug, window.start_iso);
      stats.sent++;
      console.log(`[digest] sent slug=${slug} resend_id=${id} polls=${payload.totals.polls} cited=${payload.totals.cited}`);
    } catch (err) {
      stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      recordError.run(msg.slice(0, 500), slug, window.start_iso);
      console.error(`[digest] send_failed slug=${slug} error=${msg}`);
    }
  }

  console.log(
    `[digest] run_complete considered=${stats.considered} sent=${stats.sent} skipped=${stats.skipped} errors=${stats.errors}`,
  );
  return stats;
}

/**
 * Boot-time cron registration. Gated on RESEND_API_KEY presence so local
 * dev and test deploys without the key are silent.
 */
export function startWeeklyDigestSchedule(): void {
  const schedule = process.env.DIGEST_SCHEDULE_CRON ?? DEFAULT_SCHEDULE;
  if (!process.env.RESEND_API_KEY) {
    console.warn("[digest] cron NOT scheduled — RESEND_API_KEY missing");
    return;
  }
  if (!cron.validate(schedule)) {
    console.warn(`[digest] cron NOT scheduled — invalid schedule "${schedule}"`);
    return;
  }
  cron.schedule(schedule, () => {
    sendAllDigests().catch((err) => console.error("[digest] sendAllDigests threw:", err));
  });
  console.log(`[digest] scheduled: ${schedule}`);
}
