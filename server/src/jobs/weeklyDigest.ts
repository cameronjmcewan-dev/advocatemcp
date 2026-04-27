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
const DEFAULT_RETRY_SCHEDULE = "*/2 * * * *";  // every 2 min

/**
 * Exponential backoff applied after each failed attempt (Phase F Part 3).
 * Index = (attempts so far) - 1. After the fifth entry (attempts=5) the
 * row is marked terminal (next_attempt_at=NULL) and will not retry until
 * next week's window creates a new row. Total wall-clock ceiling from
 * the initial failure to the final attempt is ~7h — well short of the
 * 24h between a Monday digest send and the following Tuesday morning,
 * so every row either lands or gives up before next week's batch.
 */
const BACKOFF_MS = [
  2  * 60 * 1000,   // 1 → 2  min
  10 * 60 * 1000,   // 2 → 10 min
  60 * 60 * 1000,   // 3 → 1  h
  6  * 60 * 60 * 1000, // 4 → 6 h
];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;  // 5 total (1 initial + 4 retries)

function nextAttemptIso(attempts: number, from: Date): string | null {
  const waitMs = BACKOFF_MS[attempts - 1];
  if (waitMs === undefined) return null;  // terminal
  return new Date(from.getTime() + waitMs).toISOString();
}

export interface SendAllDigestsStats {
  considered: number;
  sent:       number;
  skipped:    number;
  errors:     number;
}

export interface RetryDigestsStats {
  considered: number;
  sent:       number;
  skipped:    number;
  errors:     number;
  terminal:   number;  // rows that hit MAX_ATTEMPTS and gave up this run
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
  // Phase F Part 3: attempts bumps on every send — success or failure — and
  // next_attempt_at is cleared on success (terminal state) or scheduled on
  // failure so the retry cron picks it up.
  const recordSuccess = db.prepare(
    `UPDATE radar_digests SET sent_at=?, resend_id=?, error=NULL,
        attempts=attempts+1, last_attempt_at=?, next_attempt_at=NULL
      WHERE slug=? AND window_start_iso=? AND sent_at IS NULL`,
  );
  const recordError = db.prepare(
    `UPDATE radar_digests SET error=?, attempts=attempts+1,
        last_attempt_at=?, next_attempt_at=?
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

    const attemptedAt = new Date();
    try {
      const { id } = await sendEmail({
        // From-address is on the Resend-verified domain (advocatemcp.com).
        // replyTo routes customer replies to the real support inbox so the
        // visible support contact stays consistent across all touchpoints.
        from:    digestFrom(),
        replyTo: "max@advocate-mcp.com",
        to:      payload.recipient,
        subject: payload.subject,
        html:    payload.html,
        text:    payload.text,
      });
      recordSuccess.run(attemptedAt.toISOString(), id, attemptedAt.toISOString(), slug, window.start_iso);
      stats.sent++;
      console.log(`[digest] sent slug=${slug} resend_id=${id} polls=${payload.totals.polls} cited=${payload.totals.cited}`);
    } catch (err) {
      stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      // Initial attempt failed — schedule retry #1 (attempts becomes 1, so
      // the next wait is BACKOFF_MS[0]).
      const next = nextAttemptIso(1, attemptedAt);
      recordError.run(msg.slice(0, 500), attemptedAt.toISOString(), next, slug, window.start_iso);
      console.error(`[digest] send_failed slug=${slug} next_attempt_at=${next ?? "none"} error=${msg}`);
    }
  }

  console.log(
    `[digest] run_complete considered=${stats.considered} sent=${stats.sent} skipped=${stats.skipped} errors=${stats.errors}`,
  );
  return stats;
}

/**
 * Retry cron entry point (Phase F Part 3). Picks up digest rows from prior
 * batches that failed to send and are now due for retry. Bounded per run so
 * a bad day doesn't turn into a thundering herd — the retry cron fires
 * every 2 min anyway, so any overflow gets picked up on the next tick.
 *
 * Idempotent: re-running within the same second is safe; the sent_at guard
 * in the UPDATE prevents double-send.
 */
export async function retryPendingDigests(
  now: Date = new Date(),
  maxPerRun: number = 20,
): Promise<RetryDigestsStats> {
  const db = getDb();
  const stats: RetryDigestsStats = { considered: 0, sent: 0, skipped: 0, errors: 0, terminal: 0 };

  const due = db.prepare(
    `SELECT slug, window_start_iso, window_end_iso, attempts
       FROM radar_digests
      WHERE sent_at IS NULL
        AND next_attempt_at IS NOT NULL
        AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
      LIMIT ?`,
  ).all(now.toISOString(), maxPerRun) as Array<{
    slug: string; window_start_iso: string; window_end_iso: string; attempts: number;
  }>;
  stats.considered = due.length;

  if (due.length === 0) return stats;

  const recordSuccess = db.prepare(
    `UPDATE radar_digests SET sent_at=?, resend_id=?, error=NULL,
        attempts=attempts+1, last_attempt_at=?, next_attempt_at=NULL
      WHERE slug=? AND window_start_iso=? AND sent_at IS NULL`,
  );
  const recordError = db.prepare(
    `UPDATE radar_digests SET error=?, attempts=attempts+1,
        last_attempt_at=?, next_attempt_at=?
      WHERE slug=? AND window_start_iso=? AND sent_at IS NULL`,
  );
  // Skip path for digests whose data has since evaporated — tenant
  // unsubscribed, switched to base plan, etc. Mark terminal so the retry
  // cron doesn't keep picking them up.
  const recordNoData = db.prepare(
    `UPDATE radar_digests SET error=?, attempts=attempts+1,
        last_attempt_at=?, next_attempt_at=NULL
      WHERE slug=? AND window_start_iso=? AND sent_at IS NULL`,
  );

  for (const row of due) {
    const attemptedAt = new Date();
    // Rebuild against the ORIGINAL window so the tenant sees the same data
    // the weekly cron would have sent — buildDigest reads live polls, and
    // we don't want "retried 3h later so numbers shifted" inconsistency.
    const unsubscribeUrl = `${unsubscribeBase()}/${mintUnsubscribeToken(row.slug)}`;
    const payload = buildDigest(row.slug, {
      window:         { start_iso: row.window_start_iso, end_iso: row.window_end_iso },
      dashboardUrl:   `${dashboardBase()}?slug=${encodeURIComponent(row.slug)}`,
      unsubscribeUrl,
    });

    if (!payload) {
      // Data gone — mark terminal with a clear error so ops can see why.
      recordNoData.run(
        "digest_no_data_at_retry",
        attemptedAt.toISOString(),
        row.slug,
        row.window_start_iso,
      );
      stats.skipped++;
      stats.terminal++;
      console.log(`[digest] retry_skipped_no_data slug=${row.slug} attempts=${row.attempts + 1}`);
      continue;
    }

    try {
      const { id } = await sendEmail({
        from:    digestFrom(),
        replyTo: "max@advocate-mcp.com",
        to:      payload.recipient,
        subject: payload.subject,
        html:    payload.html,
        text:    payload.text,
      });
      recordSuccess.run(attemptedAt.toISOString(), id, attemptedAt.toISOString(), row.slug, row.window_start_iso);
      stats.sent++;
      console.log(`[digest] retry_sent slug=${row.slug} attempts=${row.attempts + 1} resend_id=${id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextAttempts = row.attempts + 1;
      const next = nextAttempts >= MAX_ATTEMPTS ? null : nextAttemptIso(nextAttempts, attemptedAt);
      recordError.run(msg.slice(0, 500), attemptedAt.toISOString(), next, row.slug, row.window_start_iso);
      if (next === null) {
        stats.terminal++;
        console.error(`[digest] retry_terminal slug=${row.slug} attempts=${nextAttempts} error=${msg}`);
      } else {
        console.error(`[digest] retry_failed slug=${row.slug} attempts=${nextAttempts} next=${next} error=${msg}`);
      }
      stats.errors++;
    }
  }

  return stats;
}

/**
 * Boot-time cron registration. Gated on RESEND_API_KEY presence so local
 * dev and test deploys without the key are silent.
 *
 * Registers TWO schedules:
 *   1. Weekly digest send — Mon 14:00 UTC by default
 *   2. Retry sweep — every 2 min by default (Phase F Part 3)
 */
export function startWeeklyDigestSchedule(): void {
  const schedule      = process.env.DIGEST_SCHEDULE_CRON       ?? DEFAULT_SCHEDULE;
  const retrySchedule = process.env.DIGEST_RETRY_SCHEDULE_CRON ?? DEFAULT_RETRY_SCHEDULE;

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

  if (!cron.validate(retrySchedule)) {
    console.warn(`[digest] retry cron NOT scheduled — invalid schedule "${retrySchedule}"`);
    return;
  }
  cron.schedule(retrySchedule, () => {
    retryPendingDigests().catch((err) => console.error("[digest] retryPendingDigests threw:", err));
  });
  console.log(`[digest] retry scheduled: ${retrySchedule}`);
}
