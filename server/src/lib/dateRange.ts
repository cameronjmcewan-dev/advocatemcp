/**
 * Date range parser for analytics endpoints.
 *
 * Phase A of the Profound-style dashboard redesign (Apr 29 2026) — every
 * card on the new dashboard supports a global date range filter. This helper
 * gives every analytics endpoint a single canonical way to read + validate
 * the start_date / end_date query params.
 *
 * Resolution order (shared with the worker-side picker):
 *   1. Explicit start_date + end_date (ISO 8601, YYYY-MM-DD)
 *   2. range=7d / 30d / 90d / 365d shorthand → end=today, start=today-N
 *   3. Default: last 30 days
 *
 * All output dates are inclusive day-boundary ISO strings (YYYY-MM-DD).
 * The SQL caller decides whether to bound queries with `>= startDate` and
 * `<= endDate || ' 23:59:59'` or use SQLite's DATE() function.
 */

export interface DateRange {
  /** Inclusive start, ISO 8601 YYYY-MM-DD */
  start: string;
  /** Inclusive end, ISO 8601 YYYY-MM-DD */
  end: string;
  /** Number of inclusive days (1-based, so a single day = 1) */
  days: number;
}

const SHORTHAND_DAYS: Record<string, number> = {
  "7d":   7,
  "30d":  30,
  "90d":  90,
  "365d": 365,
};

const MAX_RANGE_DAYS = 365;

/** Format a Date as ISO YYYY-MM-DD using UTC. */
function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Validate a single ISO 8601 day string (YYYY-MM-DD). */
function validIsoDay(s: unknown): s is string {
  return typeof s === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && !Number.isNaN(new Date(s + "T00:00:00Z").getTime());
}

/**
 * Parse the date range from an Express-style query object. Throws when the
 * caller-supplied range is malformed; falls through to default 30 days when
 * nothing was supplied.
 *
 * @throws Error with .code='invalid_date_range' on bad input — caller should
 *         catch + return 400.
 */
export function parseDateRange(query: Record<string, unknown>): DateRange {
  const startQ = query.start_date;
  const endQ   = query.end_date;
  const rangeQ = query.range;

  // Path 1 — explicit start + end.
  if (startQ !== undefined || endQ !== undefined) {
    if (!validIsoDay(startQ)) throw rangeError("start_date must be ISO 8601 YYYY-MM-DD");
    if (!validIsoDay(endQ))   throw rangeError("end_date must be ISO 8601 YYYY-MM-DD");
    const start = startQ as string;
    const end   = endQ as string;
    if (end < start) throw rangeError("end_date must be on or after start_date");
    const days = daysBetween(start, end);
    if (days > MAX_RANGE_DAYS) throw rangeError(`range max ${MAX_RANGE_DAYS} days, got ${days}`);
    return { start, end, days };
  }

  // Path 2 — range shorthand.
  if (rangeQ !== undefined) {
    if (typeof rangeQ !== "string" || !(rangeQ in SHORTHAND_DAYS)) {
      throw rangeError(`range must be one of: ${Object.keys(SHORTHAND_DAYS).join(", ")}`);
    }
    const days = SHORTHAND_DAYS[rangeQ]!;
    const end = toIsoDay(new Date());
    const start = toIsoDay(new Date(Date.now() - (days - 1) * 86_400_000));
    return { start, end, days };
  }

  // Path 3 — default 30 days.
  const end = toIsoDay(new Date());
  const start = toIsoDay(new Date(Date.now() - 29 * 86_400_000));
  return { start, end, days: 30 };
}

/** Inclusive day count between two ISO YYYY-MM-DD strings. */
function daysBetween(start: string, end: string): number {
  const a = new Date(start + "T00:00:00Z").getTime();
  const b = new Date(end   + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

function rangeError(msg: string): Error & { code: string } {
  const err = new Error(msg) as Error & { code: string };
  err.code = "invalid_date_range";
  return err;
}

/** Convenience: SQL-friendly bounded clauses. The caller still composes the
 *  `WHERE` themselves; this just provides the bind values. The end date is
 *  treated as the END of the day so a row at 23:30 on the end day is included. */
export function sqlBounds(range: DateRange): { startSql: string; endSql: string } {
  return {
    startSql: range.start,                // 'YYYY-MM-DD' compares correctly with SQLite DATE()
    endSql:   range.end + " 23:59:59",    // inclusive of the end day's evening rows
  };
}
