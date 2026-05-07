/**
 * Cross-references CRM contacts with click_events to classify each
 * contact's first-touch as AI or unknown, then aggregates LTV per
 * source class. Pure function — takes contacts + click_events rows,
 * returns aggregated bucket.
 *
 * Same time-window approach as revenue attribution (Phase 4):
 * compare contact.createdAt against click_events.timestamp within
 * 24h before. If any AI-classified click exists, mark 'ai'. Else
 * 'unknown'. NEVER claims 'human' attribution we can't prove.
 *
 * Returns aggregate roll-up only — no per-contact data leaves the
 * function. The endpoint then returns this aggregate to the frontend.
 */

import { classifyTrafficSource } from "./aiTrafficClassifier";
import type { HubspotContact } from "./hubspot";

export interface LtvBucket {
  contact_count:        number;
  customer_count:       number;    // subset of contact_count where lifecycleStage==='customer'
  total_revenue_cents:  number;    // SUM of contact.totalRevenue across the bucket (in cents)
  avg_ltv_cents:        number;    // total_revenue_cents / customer_count, rounded; 0 if no customers
}

export interface LtvAggregateResult {
  ai:      LtvBucket;
  unknown: LtvBucket;
  /** Contacts that couldn't be classified (e.g. createdAt missing/invalid). */
  errored: number;
}

const ATTRIBUTION_WINDOW_HOURS = 24;

export function aggregateLtv(
  contacts:    HubspotContact[],
  clickEvents: Array<{ ref: string | null; timestamp: string }>,
): LtvAggregateResult {
  const ai: LtvBucket      = { contact_count: 0, customer_count: 0, total_revenue_cents: 0, avg_ltv_cents: 0 };
  const unknown: LtvBucket = { contact_count: 0, customer_count: 0, total_revenue_cents: 0, avg_ltv_cents: 0 };
  let errored = 0;

  for (const c of contacts) {
    const createdMs = new Date(c.createdAt).getTime();
    if (isNaN(createdMs)) {
      errored++;
      continue;
    }

    const windowStart = createdMs - ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000;

    let isAi = false;
    for (const click of clickEvents) {
      const clickMs = new Date(click.timestamp).getTime();
      if (clickMs >= windowStart && clickMs <= createdMs && click.ref) {
        if (classifyTrafficSource(click.ref, "referral") === "ai") {
          isAi = true;
          break;
        }
      }
    }

    const bucket = isAi ? ai : unknown;
    bucket.contact_count += 1;
    if (c.lifecycleStage === "customer") {
      bucket.customer_count += 1;
    }
    bucket.total_revenue_cents += Math.round((c.totalRevenue ?? 0) * 100);
  }

  ai.avg_ltv_cents =
    ai.customer_count > 0
      ? Math.round(ai.total_revenue_cents / ai.customer_count)
      : 0;
  unknown.avg_ltv_cents =
    unknown.customer_count > 0
      ? Math.round(unknown.total_revenue_cents / unknown.customer_count)
      : 0;

  return { ai, unknown, errored };
}
