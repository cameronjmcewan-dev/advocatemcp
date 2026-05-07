import { classifyTrafficSource } from "./aiTrafficClassifier";
import type { GA4ConversionRow } from "./ga4";

export interface ConversionBucket {
  date:          string;
  source_class:  "ai" | "human";
  event_name:    string;
  event_count:   number;
  total_revenue: number;
  currency:      string;
}

/**
 * Aggregate raw GA4 conversion rows into per-day per-event buckets,
 * classified AI vs Human via classifyTrafficSource.
 *
 * Currency handling: a single (date, source_class, event_name) tuple
 * should have ONE currency in practice. If GA4 ever returns mixed
 * currencies for the same event on the same day (rare — customer with
 * multi-currency Stripe), the bucket records the MOST-COMMON currency
 * (highest eventCount) and sums the values across mixed-currency rows.
 * The read endpoint will note multi-currency tenants and surface the
 * dominant currency.
 */
export function aggregateConversionRows(rows: GA4ConversionRow[]): Map<string, ConversionBucket> {
  // Main accumulator: keyed by "date|source_class|event_name"
  const out = new Map<string, ConversionBucket>();

  // Per-bucket currency vote: key → (currency → eventCount)
  const currencyVotes = new Map<string, Record<string, number>>();

  for (const r of rows) {
    const cls = classifyTrafficSource(r.source, r.medium);
    const key = `${r.date}|${cls}|${r.eventName}`;

    let bucket = out.get(key);
    if (!bucket) {
      bucket = {
        date:          r.date,
        source_class:  cls,
        event_name:    r.eventName,
        event_count:   0,
        total_revenue: 0,
        currency:      "",
      };
      out.set(key, bucket);
      currencyVotes.set(key, {});
    }

    bucket.event_count   += r.eventCount;
    bucket.total_revenue += r.eventValue;

    // Tally currency votes by eventCount so dominant currency wins
    if (r.currency) {
      const votes = currencyVotes.get(key)!;
      votes[r.currency] = (votes[r.currency] ?? 0) + r.eventCount;
    }
  }

  // Resolve dominant currency for each bucket
  for (const [key, bucket] of out.entries()) {
    const votes = currencyVotes.get(key) ?? {};
    const dominant = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    bucket.currency = dominant;
  }

  return out;
}
