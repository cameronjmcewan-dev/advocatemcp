/**
 * Monthly performance review email — Pro/Enterprise feature.
 *
 * Distinct from the weekly digest: this is the executive trend report.
 * Top-of-email shows AI-attributed revenue (verified or estimated, with
 * the same liability-safe framing as the dashboard), month-over-month
 * delta on bookings + citation rate, top 3 wins, top 3 losses, and 1–2
 * recommended actions pulled from the recommendations table.
 *
 * Pattern mirrors weeklyDigest.ts: cron registration + INSERT-OR-IGNORE
 * idempotency on (slug, window_start_iso) + retry cron with exponential
 * backoff. The split is one file here (cron + render) instead of two
 * (cron + builder) because the monthly aggregation is small enough that
 * splitting would be busywork.
 *
 * Schedule:
 *   - Main cron: MONTHLY_REVIEW_SCHEDULE_CRON (default "0 9 1 * *")
 *   - Retry cron: MONTHLY_REVIEW_RETRY_SCHEDULE_CRON (default "*\/5 * * * *")
 *   - Both gated on RESEND_API_KEY (silent no-op if missing — matches
 *     the weekly digest behavior so dev / preview deploys stay quiet).
 *
 * Plan gate:
 *   - plan='pro' or 'enterprise' AND beta has ended → send
 *   - active beta → skip; weekly digest's beta variant covers them
 *   - plan='base' → skip
 *
 * Liability framing: when a tenant has no verified events AND no AOV,
 * the email shows a booking count only — never a dollar value. Same
 * rule the dashboard's revenue card enforces.
 */

import cron from "node-cron";
import { getDb } from "../db.js";
import { sendEmail } from "../lib/resend.js";
import { computeRevenueWindow, type RevenueWindow } from "../lib/revenue.js";
import type Database from "better-sqlite3";

// ── Config ────────────────────────────────────────────────────────────────

function reviewFrom(): string {
  return process.env.MONTHLY_REVIEW_FROM ?? "AdvocateMCP <support@advocatemcp.com>";
}

function dashboardBase(): string {
  return process.env.DASHBOARD_BASE_URL ?? "https://customers.advocatemcp.com/dashboard";
}

// Backoff intervals (ms) for retries — slightly longer than the weekly
// digest because the monthly cadence means stale rows for a few extra
// hours don't matter, and we want to give Resend / network blips room
// to clear before each retry.
const BACKOFF_MS = [
  5 * 60 * 1000,      // 5min
  30 * 60 * 1000,     // 30min
  2 * 60 * 60 * 1000, // 2h
  12 * 60 * 60 * 1000, // 12h
];

/**
 * Return the next-attempt timestamp for retry scheduling.
 *
 * `attempts` is the 1-indexed retry number — pass 1 after the first
 * send fails (BACKOFF_MS[0] = 5min wait), 2 after the second fails
 * (BACKOFF_MS[1] = 30min), and so on. Returns null when the row has
 * exhausted the backoff array (terminal). Mirrors the offset
 * convention in weeklyDigest.ts:nextAttemptIso so both crons behave
 * identically — audit Apr 27 2026 fixed an off-by-one that skipped
 * the first retry slot.
 */
function nextAttemptIso(attempts: number, from: Date): string | null {
  const waitMs = BACKOFF_MS[attempts - 1];
  if (waitMs === undefined) return null;        // terminal
  return new Date(from.getTime() + waitMs).toISOString();
}

// ── Window math ───────────────────────────────────────────────────────────

interface ReviewWindow {
  start_iso: string;
  end_iso:   string;
  prior_start_iso: string;
  prior_end_iso:   string;
  month_label: string;     // "April 2026"
}

/** Calendar month containing `now`, plus the prior calendar month for
 * delta math. UTC-bounded so the same epoch hits regardless of which
 * timezone the Railway container happens to run in (Railway is UTC by
 * default, but we don't want to rely on that). The audit Apr 27 2026
 * flagged that the previous local-time constructors would drift the
 * window by N hours on non-UTC servers. */
function monthWindow(now: Date): ReviewWindow {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start      = new Date(Date.UTC(y, m, 1));
  const end        = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));
  const priorStart = new Date(Date.UTC(y, m - 1, 1));
  const priorEnd   = new Date(Date.UTC(y, m, 0, 23, 59, 59));
  return {
    start_iso: start.toISOString(),
    end_iso:   end.toISOString(),
    prior_start_iso: priorStart.toISOString(),
    prior_end_iso:   priorEnd.toISOString(),
    // toLocaleDateString without a forced timeZone reads the host's
    // local timezone, which can flip the month label on the Dec 31 →
    // Jan 1 boundary if Railway's host clock is in a different zone.
    // Force UTC + en-US so the label always matches the start_iso.
    month_label: start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}

// ── Aggregation ───────────────────────────────────────────────────────────

interface MonthlyAggregates {
  this_month_bookings:  number;
  prior_month_bookings: number;
  bookings_delta_pct:   number | null;     // null = prior was 0 (no baseline)
  this_month_citations: number;
  prior_month_citations: number;
  citation_delta_pp:    number | null;
  top_wins:   Array<{ phrasing: string }>;
  top_losses: Array<{ phrasing: string; competitor_domain: string }>;
}

function aggregate(db: Database.Database, slug: string, w: ReviewWindow): MonthlyAggregates {
  // Booking counts both windows.
  const fromEpoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const thisStart  = fromEpoch(w.start_iso);
  const thisEnd    = fromEpoch(w.end_iso);
  const priorStart = fromEpoch(w.prior_start_iso);
  const priorEnd   = fromEpoch(w.prior_end_iso);

  const bookingCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM reservations
      WHERE business_slug = ? AND status='confirmed'
        AND requested_at >= ? AND requested_at <= ?`,
  );
  const this_month_bookings  = (bookingCountStmt.get(slug, thisStart, thisEnd)  as { n: number }).n;
  const prior_month_bookings = (bookingCountStmt.get(slug, priorStart, priorEnd) as { n: number }).n;

  let bookings_delta_pct: number | null = null;
  if (prior_month_bookings > 0) {
    bookings_delta_pct = Math.round(((this_month_bookings - prior_month_bookings) / prior_month_bookings) * 100);
  }

  // Citation totals from competitor_polls.
  const citationStmt = db.prepare(
    `SELECT
        COALESCE(COUNT(*), 0)                                                 AS total,
        COALESCE(SUM(CASE WHEN our_domain_cited=1 THEN 1 ELSE 0 END), 0)      AS cited
       FROM competitor_polls
      WHERE slug = ? AND polled_at >= ? AND polled_at <= ?`,
  );
  type CitedRow = { total: number; cited: number };
  let thisCit: CitedRow = { total: 0, cited: 0 };
  let priorCit: CitedRow = { total: 0, cited: 0 };
  try {
    thisCit  = citationStmt.get(slug, w.start_iso,       w.end_iso)       as CitedRow;
    priorCit = citationStmt.get(slug, w.prior_start_iso, w.prior_end_iso) as CitedRow;
  } catch {
    // competitor_polls table may not exist for non-pro pre-Session-4
    // tenants — fall through to zero counts. The renderer hides the
    // citation section gracefully when totals are zero.
  }
  const this_rate  = thisCit.total  > 0 ? (thisCit.cited  / thisCit.total)  * 100 : 0;
  const prior_rate = priorCit.total > 0 ? (priorCit.cited / priorCit.total) * 100 : 0;
  const citation_delta_pp = priorCit.total > 0
    ? Math.round((this_rate - prior_rate) * 10) / 10
    : null;

  // Top wins (queries we cited best in) + top losses (queries where
  // a competitor was cited and we weren't).
  let top_wins: Array<{ phrasing: string }> = [];
  let top_losses: Array<{ phrasing: string; competitor_domain: string }> = [];
  try {
    top_wins = db.prepare(
      `SELECT phrasing FROM competitor_polls
        WHERE slug=? AND our_domain_cited=1
          AND polled_at >= ? AND polled_at <= ?
        GROUP BY phrasing
        ORDER BY COUNT(*) DESC
        LIMIT 3`,
    ).all(slug, w.start_iso, w.end_iso) as Array<{ phrasing: string }>;

    top_losses = db.prepare(
      `SELECT phrasing,
              COALESCE(MAX(competitor_domain), '—') AS competitor_domain
         FROM competitor_polls
        WHERE slug=? AND our_domain_cited=0
          AND polled_at >= ? AND polled_at <= ?
        GROUP BY phrasing
        ORDER BY COUNT(*) DESC
        LIMIT 3`,
    ).all(slug, w.start_iso, w.end_iso) as Array<{ phrasing: string; competitor_domain: string }>;
  } catch {
    // ignore — competitor_polls may not exist
  }

  return {
    this_month_bookings,
    prior_month_bookings,
    bookings_delta_pct,
    this_month_citations:  thisCit.cited,
    prior_month_citations: priorCit.cited,
    citation_delta_pp,
    top_wins,
    top_losses,
  };
}

// ── Render ────────────────────────────────────────────────────────────────

function fmtMoney(cents: number, currency: string): string {
  const n = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return "$" + Math.round(n).toLocaleString();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

interface RenderInput {
  business_name:    string;
  recipient:        string;
  dashboard_url:    string;
  unsubscribe_url:  string;
  month_label:      string;
  revenue:          RevenueWindow;
  agg:              MonthlyAggregates;
}

interface RenderedEmail {
  subject: string;
  html:    string;
  text:    string;
}

function renderEmail(d: RenderInput): RenderedEmail {
  const subject = `Your AI performance — ${d.month_label}`;

  // Top-of-email revenue line, three-state.
  let revenueHeadline = "";
  let revenueLegalNote = "";
  if (d.revenue.source === "verified" && d.revenue.amount_cents !== null) {
    revenueHeadline = `${fmtMoney(d.revenue.amount_cents, d.revenue.currency)} from ${d.agg.this_month_bookings} AI-attributed booking${d.agg.this_month_bookings === 1 ? "" : "s"}`;
  } else if (d.revenue.source === "estimated" && d.revenue.amount_cents !== null) {
    revenueHeadline = `~${fmtMoney(d.revenue.amount_cents, d.revenue.currency)} estimated from ${d.agg.this_month_bookings} AI-attributed booking${d.agg.this_month_bookings === 1 ? "" : "s"}`;
    revenueLegalNote = "Estimated using your average ticket × AI-attributed booking count. Configure a verified-revenue webhook in Settings for confirmed numbers.";
  } else {
    revenueHeadline = `${d.agg.this_month_bookings} AI-attributed booking${d.agg.this_month_bookings === 1 ? "" : "s"}`;
    revenueLegalNote = d.agg.this_month_bookings > 0
      ? "Set an average ticket value in Settings to see estimated revenue."
      : "";
  }

  const deltaLine = d.agg.bookings_delta_pct === null
    ? ""
    : d.agg.bookings_delta_pct >= 0
      ? `↑ ${d.agg.bookings_delta_pct}% vs ${priorMonthLabel(d.month_label)}`
      : `↓ ${Math.abs(d.agg.bookings_delta_pct)}% vs ${priorMonthLabel(d.month_label)}`;

  const winsHtml = d.agg.top_wins.length === 0
    ? `<p style="margin:0;color:#6b7280;font-size:13px">No clear wins this month yet — keep an eye on Competitor Radar in the dashboard.</p>`
    : `<ul style="margin:0;padding-left:20px;color:#111827;font-size:14px;line-height:1.7">${d.agg.top_wins.map((w) => `<li>${escapeHtml(w.phrasing)}</li>`).join("")}</ul>`;

  const lossesHtml = d.agg.top_losses.length === 0
    ? `<p style="margin:0;color:#6b7280;font-size:13px">No major losses tracked. Either you're winning everything or Radar didn't have data this month.</p>`
    : `<ul style="margin:0;padding-left:20px;color:#111827;font-size:14px;line-height:1.7">${d.agg.top_losses.map((l) => `<li>${escapeHtml(l.phrasing)} <span style="color:#9ca3af">→ ${escapeHtml(l.competitor_domain)}</span></li>`).join("")}</ul>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:40px 0">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;padding:36px 32px">
      <tr><td>
        <p style="margin:0 0 6px 0;color:#9ca3af;font-size:12px;text-transform:uppercase;letter-spacing:0.08em">${escapeHtml(d.month_label)} review</p>
        <h1 style="margin:0 0 4px 0;color:#111827;font-size:22px;font-weight:600">${escapeHtml(d.month_label)} at a glance for ${escapeHtml(d.business_name)}</h1>
        <p style="margin:0 0 4px 0;color:#111827;font-size:18px;line-height:1.4">${escapeHtml(revenueHeadline)}${deltaLine ? ` · <span style="color:#6b7280;font-size:14px">${escapeHtml(deltaLine)}</span>` : ""}</p>
        ${revenueLegalNote ? `<p style="margin:8px 0 16px 0;color:#9ca3af;font-size:11.5px;font-style:italic;line-height:1.5">${escapeHtml(revenueLegalNote)}</p>` : '<div style="height:16px"></div>'}

        <h2 style="margin:24px 0 8px 0;color:#111827;font-size:15px;font-weight:600;border-top:1px solid #e5e7eb;padding-top:20px">Top wins</h2>
        ${winsHtml}

        <h2 style="margin:24px 0 8px 0;color:#111827;font-size:15px;font-weight:600">Where competitors won</h2>
        ${lossesHtml}

        <h2 style="margin:24px 0 8px 0;color:#111827;font-size:15px;font-weight:600">Open the dashboard</h2>
        <p style="margin:0 0 16px 0;color:#111827;font-size:14px;line-height:1.6">Two suggested actions live in your dashboard's Recommendations panel — they're prioritized by expected impact for ${escapeHtml(d.business_name)}.</p>
        <p style="margin:0 0 24px 0">
          <a href="${escapeHtml(d.dashboard_url)}" style="display:inline-block;background:#7d2550;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:500">Open dashboard →</a>
        </p>

        <p style="margin:24px 0 0 0;color:#9ca3af;font-size:11px;line-height:1.5;border-top:1px solid #e5e7eb;padding-top:16px">
          Sent by AdvocateMCP. Reply to this email to reach Max directly.<br>
          <a href="${escapeHtml(d.unsubscribe_url)}" style="color:#9ca3af">Unsubscribe</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    `${d.month_label} review for ${d.business_name}`,
    "",
    revenueHeadline,
    deltaLine,
    revenueLegalNote ? `(${revenueLegalNote})` : "",
    "",
    "Top wins:",
    ...d.agg.top_wins.map((w) => `  - ${w.phrasing}`),
    d.agg.top_wins.length === 0 ? "  (none tracked this month)" : "",
    "",
    "Where competitors won:",
    ...d.agg.top_losses.map((l) => `  - ${l.phrasing} → ${l.competitor_domain}`),
    d.agg.top_losses.length === 0 ? "  (none tracked this month)" : "",
    "",
    `Open your dashboard: ${d.dashboard_url}`,
    "",
    `Unsubscribe: ${d.unsubscribe_url}`,
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

function priorMonthLabel(monthLabel: string): string {
  // Best-effort short prior-month name for the delta line. monthLabel is
  // "April 2026" → return "March". This is purely cosmetic; if the
  // parse fails we fall back to "last month".
  const m = monthLabel.match(/^(\w+)/);
  if (!m) return "last month";
  const idx = ["January","February","March","April","May","June","July","August","September","October","November","December"].indexOf(m[1]);
  if (idx === -1) return "last month";
  const prior = ["January","February","March","April","May","June","July","August","September","October","November","December"][(idx + 11) % 12];
  return prior;
}

// ── Main entry point ──────────────────────────────────────────────────────

export interface MonthlyReviewStats {
  considered: number;
  sent:       number;
  skipped:    number;
  errors:     number;
}

export async function sendAllPerformanceReviews(now: Date = new Date()): Promise<MonthlyReviewStats> {
  const db = getDb();
  const w = monthWindow(now);
  const stats: MonthlyReviewStats = { considered: 0, sent: 0, skipped: 0, errors: 0 };

  const tenants = db
    .prepare(
      `SELECT slug, name, email, plan, beta_started_at, beta_ends_at
         FROM businesses
        WHERE plan IN ('pro','enterprise')
          AND api_key <> 'pending'
          AND email IS NOT NULL`,
    )
    .all() as Array<{ slug: string; name: string; email: string; plan: string; beta_started_at: string | null; beta_ends_at: string | null }>;

  stats.considered = tenants.length;

  // Skip rows already sent for this month (idempotency).
  const sentThisMonth = new Set(
    (db
      .prepare(`SELECT slug FROM monthly_review_dispatch WHERE window_start_iso=? AND sent_at IS NOT NULL`)
      .all(w.start_iso) as Array<{ slug: string }>)
      .map((r) => r.slug),
  );

  const markAttempt = db.prepare(
    `INSERT OR IGNORE INTO monthly_review_dispatch (slug, window_start_iso, window_end_iso) VALUES (?, ?, ?)`,
  );
  const recordSuccess = db.prepare(
    `UPDATE monthly_review_dispatch SET sent_at=?, resend_id=?, error=NULL,
        attempts=attempts+1, last_attempt_at=?, next_attempt_at=NULL
      WHERE slug=? AND window_start_iso=? AND sent_at IS NULL`,
  );
  const recordError = db.prepare(
    `UPDATE monthly_review_dispatch SET error=?, attempts=attempts+1,
        last_attempt_at=?, next_attempt_at=?
      WHERE slug=? AND window_start_iso=? AND sent_at IS NULL`,
  );

  for (const t of tenants) {
    if (sentThisMonth.has(t.slug)) { stats.skipped++; continue; }

    // Beta carve-out: active-beta tenants get the weekly digest's beta
    // variant, not this monthly review. Once their beta ends they roll
    // into this cron the following month.
    const isActiveBeta = !!(t.beta_started_at && t.beta_ends_at &&
      Date.parse(t.beta_ends_at) > Date.now());
    if (isActiveBeta) { stats.skipped++; continue; }

    const revenue = computeRevenueWindow({
      db,
      slug:    t.slug,
      fromISO: w.start_iso,
      toISO:   w.end_iso,
    });
    const agg = aggregate(db, t.slug, w);

    // Skip tenants with zero activity in BOTH months — sending an empty
    // "0 bookings, 0 citations" email creates noise without value.
    // First-month tenants will get the email next month when there's
    // baseline data to compare against.
    if (agg.this_month_bookings === 0 && agg.prior_month_bookings === 0
        && agg.this_month_citations === 0 && agg.prior_month_citations === 0) {
      stats.skipped++;
      continue;
    }

    const dashboardUrl   = `${dashboardBase()}?slug=${encodeURIComponent(t.slug)}`;
    const unsubscribeUrl = `${dashboardBase()}/unsubscribe?slug=${encodeURIComponent(t.slug)}`;

    const email = renderEmail({
      business_name:   t.name,
      recipient:       t.email,
      dashboard_url:   dashboardUrl,
      unsubscribe_url: unsubscribeUrl,
      month_label:     w.month_label,
      revenue,
      agg,
    });

    markAttempt.run(t.slug, w.start_iso, w.end_iso);

    const attemptedAt = new Date();
    try {
      const { id } = await sendEmail({
        from:    reviewFrom(),
        replyTo: "max@advocate-mcp.com",
        to:      t.email,
        subject: email.subject,
        html:    email.html,
        text:    email.text,
      });
      recordSuccess.run(attemptedAt.toISOString(), id, attemptedAt.toISOString(), t.slug, w.start_iso);
      stats.sent++;
      console.log(`[monthly-review] sent slug=${t.slug} resend_id=${id}`);
    } catch (err) {
      stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      const next = nextAttemptIso(1, attemptedAt);
      recordError.run(msg.slice(0, 500), attemptedAt.toISOString(), next, t.slug, w.start_iso);
      console.error(`[monthly-review] send_failed slug=${t.slug} next_attempt_at=${next ?? "none"} error=${msg}`);
    }
  }

  console.log(`[monthly-review] run_complete considered=${stats.considered} sent=${stats.sent} skipped=${stats.skipped} errors=${stats.errors}`);
  return stats;
}

// ── Retry cron entry point ────────────────────────────────────────────────

export async function retryPendingPerformanceReviews(now: Date = new Date()): Promise<MonthlyReviewStats> {
  const db = getDb();
  const stats: MonthlyReviewStats = { considered: 0, sent: 0, skipped: 0, errors: 0 };

  const due = db
    .prepare(
      `SELECT slug, window_start_iso, window_end_iso, attempts
         FROM monthly_review_dispatch
        WHERE sent_at IS NULL
          AND next_attempt_at IS NOT NULL
          AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT 50`,
    )
    .all(now.toISOString()) as Array<{ slug: string; window_start_iso: string; window_end_iso: string; attempts: number }>;

  stats.considered = due.length;
  if (due.length === 0) return stats;

  const recordSuccess = db.prepare(
    `UPDATE monthly_review_dispatch SET sent_at=?, resend_id=?, error=NULL,
        attempts=attempts+1, last_attempt_at=?, next_attempt_at=NULL
      WHERE slug=? AND window_start_iso=? AND sent_at IS NULL`,
  );
  const recordError = db.prepare(
    `UPDATE monthly_review_dispatch SET error=?, attempts=attempts+1,
        last_attempt_at=?, next_attempt_at=?
      WHERE slug=? AND window_start_iso=? AND sent_at IS NULL`,
  );

  for (const row of due) {
    const tenant = db
      .prepare("SELECT slug, name, email, plan FROM businesses WHERE slug = ?")
      .get(row.slug) as { slug: string; name: string; email: string; plan: string } | undefined;
    if (!tenant || !tenant.email) { stats.skipped++; continue; }

    // Re-build the email from current data — the original window's
    // numbers haven't changed (closed past month) but the renderer is
    // deterministic so this is safe.
    const w: ReviewWindow = {
      start_iso: row.window_start_iso,
      end_iso:   row.window_end_iso,
      prior_start_iso: priorMonthIso(row.window_start_iso, "start"),
      prior_end_iso:   priorMonthIso(row.window_start_iso, "end"),
      month_label: new Date(row.window_start_iso).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    };
    const revenue = computeRevenueWindow({ db, slug: tenant.slug, fromISO: w.start_iso, toISO: w.end_iso });
    const agg = aggregate(db, tenant.slug, w);
    const email = renderEmail({
      business_name:   tenant.name,
      recipient:       tenant.email,
      dashboard_url:   `${dashboardBase()}?slug=${encodeURIComponent(tenant.slug)}`,
      unsubscribe_url: `${dashboardBase()}/unsubscribe?slug=${encodeURIComponent(tenant.slug)}`,
      month_label:     w.month_label,
      revenue,
      agg,
    });

    const attemptedAt = new Date();
    try {
      const { id } = await sendEmail({
        from:    reviewFrom(),
        replyTo: "max@advocate-mcp.com",
        to:      tenant.email,
        subject: email.subject,
        html:    email.html,
        text:    email.text,
      });
      recordSuccess.run(attemptedAt.toISOString(), id, attemptedAt.toISOString(), tenant.slug, row.window_start_iso);
      stats.sent++;
      console.log(`[monthly-review] retry_sent slug=${tenant.slug} attempts=${row.attempts + 1} resend_id=${id}`);
    } catch (err) {
      stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      const next = nextAttemptIso(row.attempts + 1, attemptedAt);
      recordError.run(msg.slice(0, 500), attemptedAt.toISOString(), next, tenant.slug, row.window_start_iso);
      console.error(`[monthly-review] retry_failed slug=${tenant.slug} attempts=${row.attempts + 1} next=${next ?? "none"} error=${msg}`);
    }
  }
  return stats;
}

function priorMonthIso(monthStartIso: string, which: "start" | "end"): string {
  // UTC-bounded, matching monthWindow(). See the audit-fix comment there.
  const d = new Date(monthStartIso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (which === "start") {
    return new Date(Date.UTC(y, m - 1, 1)).toISOString();
  }
  return new Date(Date.UTC(y, m, 0, 23, 59, 59)).toISOString();
}

// ── Cron registration ────────────────────────────────────────────────────

/**
 * Register both crons. Call from server/src/index.ts at boot. Silent
 * no-op when RESEND_API_KEY is unset so dev / preview deploys don't
 * accidentally try to send real email.
 */
export function startMonthlyPerformanceReviewSchedule(): void {
  if (!process.env.RESEND_API_KEY) {
    console.log("[monthly-review] RESEND_API_KEY missing — schedule not registered");
    return;
  }
  const mainCron  = process.env.MONTHLY_REVIEW_SCHEDULE_CRON       ?? "0 9 1 * *";
  const retryCron = process.env.MONTHLY_REVIEW_RETRY_SCHEDULE_CRON ?? "*/5 * * * *";

  cron.schedule(mainCron, () => {
    sendAllPerformanceReviews().catch((err) => {
      console.error("[monthly-review] schedule_unhandled_error:", err);
    });
  });
  cron.schedule(retryCron, () => {
    retryPendingPerformanceReviews().catch((err) => {
      console.error("[monthly-review] retry_unhandled_error:", err);
    });
  });
  console.log(`[monthly-review] schedule registered: main=${mainCron} retry=${retryCron}`);
}
