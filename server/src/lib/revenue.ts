/**
 * Revenue attribution computation — shared between the dashboard analytics
 * endpoint (`GET /agents/:slug/revenue-summary`) and the monthly performance
 * review email builder (`server/src/jobs/monthlyReviewBuilder.ts`).
 *
 * Two tracking modes coexist (per the founder's "honest pricing" directive):
 *
 *   1. Verified — the customer's booking system POSTs HMAC-signed events to
 *      `/api/revenue-event/<slug>` (worker route). Each delivery is a row
 *      in `revenue_events`. The dashboard renders these with a green
 *      "Verified" pill.
 *
 *   2. Estimated — the customer set `avg_booking_value_cents` on their
 *      profile. We multiply confirmed reservations in the window by that
 *      AOV and label the result with an amber "Estimated" pill so it
 *      can't be confused with verified actuals (liability-safe framing).
 *
 *   3. Unconfigured — neither verified events nor an AOV exist. We
 *      DELIBERATELY do not show dollar values for these tenants. The
 *      dashboard shows a booking count only with a CTA to add an AOV.
 *
 * The "verified preempts estimated" rule is intentional: any tenant with
 * even one verified webhook event in the window flips to verified mode
 * for the entire window. This prevents the awkward case where a partial
 * webhook integration produces a mix of "verified $X plus estimated $Y"
 * that's confusing and easy to misread.
 *
 * All time inputs are ISO-8601 strings to match the rest of the analytics
 * stack. Internally we convert to epoch seconds for the reservations join
 * (reservations.requested_at is INTEGER unix epoch).
 */

import type Database from "better-sqlite3";

export type RevenueSource = "verified" | "estimated" | "unconfigured";

export interface RevenueWindow {
  /** Which computation path produced these numbers. UI uses this to
   * pick the green / amber / no-pill rendering and to decide whether
   * to show dollar values at all. */
  source: RevenueSource;
  /** Total dollars in cents. NULL only when source === 'unconfigured'. */
  amount_cents: number | null;
  /** Number of underlying events: verified webhook deliveries when source
   * is 'verified', otherwise the count of confirmed reservations in the
   * window (which is also what 'unconfigured' tenants see as a count). */
  event_count: number;
  /** ISO-4217 from businesses.revenue_currency (defaulted to USD by the
   * column). Useful for the UI to format with the right symbol. */
  currency: string;
  /** Customer-supplied AOV in cents — present only when source ===
   * 'estimated'. UI uses it for the tooltip ("$XXX × N bookings"). */
  aov_cents: number | null;
  /** ISO timestamps of the queried window — echo-back so the caller
   * (dashboard or email builder) doesn't have to remember what it asked
   * for when formatting "this month vs last month". */
  window_start: string;
  window_end:   string;
}

interface ComputeArgs {
  db:     Database.Database;
  slug:   string;
  /** ISO timestamp, inclusive lower bound. */
  fromISO: string;
  /** ISO timestamp, inclusive upper bound. */
  toISO:   string;
}

/**
 * Compute the revenue summary for one tenant over a window.
 *
 * Performance: two SQLite queries when verified events exist, three when
 * we fall back to the estimated path. All hit indices created in
 * migration 029 (idx_revenue_events_slug_occurred,
 * idx_reservations_slug_window) so it's microseconds even at scale.
 */
export function computeRevenueWindow(args: ComputeArgs): RevenueWindow {
  const { db, slug, fromISO, toISO } = args;

  // Pull the three tenant-level config values in one round-trip. Defaults
  // are applied here rather than relying on JS truthy checks because
  // SQLite returns null for unset columns even after our DEFAULT clause
  // (the default only fires on INSERT, not on rows that pre-date the
  // ALTER TABLE migration).
  const tenant = db
    .prepare(
      `SELECT avg_booking_value_cents, revenue_currency
         FROM businesses
        WHERE slug = ?`,
    )
    .get(slug) as
    | { avg_booking_value_cents: number | null; revenue_currency: string | null }
    | undefined;

  const currency = tenant?.revenue_currency ?? "USD";

  // Verified path — sum revenue_events first. If any rows exist, that's
  // authoritative for the window; we don't mix verified and estimated.
  const verified = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents,
              COUNT(*)                       AS event_count
         FROM revenue_events
        WHERE business_slug = ?
          AND occurred_at >= ?
          AND occurred_at <= ?`,
    )
    .get(slug, fromISO, toISO) as { total_cents: number; event_count: number };

  if (verified.event_count > 0) {
    return {
      source:       "verified",
      amount_cents: verified.total_cents,
      event_count:  verified.event_count,
      currency,
      aov_cents:    null,
      window_start: fromISO,
      window_end:   toISO,
    };
  }

  // Estimated path — count confirmed reservations × AOV. requested_at is
  // INTEGER unix epoch on the reservations table, so we convert the ISO
  // bounds with strftime in the WHERE clause to keep the index usable.
  // (If we did `datetime(requested_at, 'unixepoch') BETWEEN ? AND ?`,
  // SQLite would full-scan; the form below uses requested_at directly.)
  const fromEpoch = Math.floor(Date.parse(fromISO) / 1000);
  const toEpoch   = Math.floor(Date.parse(toISO)   / 1000);
  const confirmed = db
    .prepare(
      `SELECT COUNT(*) AS confirmed_count
         FROM reservations
        WHERE business_slug = ?
          AND status         = 'confirmed'
          AND requested_at  >= ?
          AND requested_at  <= ?`,
    )
    .get(slug, fromEpoch, toEpoch) as { confirmed_count: number };

  const aov = tenant?.avg_booking_value_cents ?? null;

  if (aov !== null && aov > 0) {
    return {
      source:       "estimated",
      amount_cents: confirmed.confirmed_count * aov,
      event_count:  confirmed.confirmed_count,
      currency,
      aov_cents:    aov,
      window_start: fromISO,
      window_end:   toISO,
    };
  }

  // Unconfigured — booking count only, no dollar value (per the
  // founder's liability-safe rule: never display unverified dollars).
  return {
    source:       "unconfigured",
    amount_cents: null,
    event_count:  confirmed.confirmed_count,
    currency,
    aov_cents:    null,
    window_start: fromISO,
    window_end:   toISO,
  };
}
