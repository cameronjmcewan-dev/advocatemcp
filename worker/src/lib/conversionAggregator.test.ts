/**
 * Tests for worker/src/lib/conversionAggregator.ts
 */

import { describe, it, expect } from "vitest";
import { aggregateConversionRows } from "./conversionAggregator.js";
import type { GA4ConversionRow } from "./ga4.js";

// Helper to build a minimal GA4ConversionRow
function row(
  date: string,
  source: string,
  medium: string,
  eventName: string,
  eventCount: number,
  keyEvents: number,
  eventValue: number,
  currency: string,
): GA4ConversionRow {
  return { date, source, medium, eventName, eventCount, keyEvents, eventValue, currency };
}

describe("aggregateConversionRows", () => {
  it("1. single key_event row produces one bucket with correct fields", () => {
    const rows = [row("2026-05-01", "google", "organic", "purchase", 3, 3, 150.00, "USD")];
    const out = aggregateConversionRows(rows);
    expect(out.size).toBe(1);
    const bucket = out.get("2026-05-01|human|purchase");
    expect(bucket).toBeDefined();
    expect(bucket!.date).toBe("2026-05-01");
    expect(bucket!.source_class).toBe("human");
    expect(bucket!.event_name).toBe("purchase");
    expect(bucket!.event_count).toBe(3);
    expect(bucket!.total_revenue).toBeCloseTo(150.00);
    expect(bucket!.currency).toBe("USD");
  });

  it("2. two rows with same (date, source_class, event_name) sum eventCount and eventValue", () => {
    const rows = [
      row("2026-05-02", "google", "organic",  "sign_up", 5, 5, 0, ""),
      row("2026-05-02", "bing",   "organic",  "sign_up", 7, 7, 0, ""),
    ];
    const out = aggregateConversionRows(rows);
    // Both are human; should collapse into one bucket
    expect(out.size).toBe(1);
    const bucket = out.get("2026-05-02|human|sign_up");
    expect(bucket).toBeDefined();
    expect(bucket!.event_count).toBe(12);
    expect(bucket!.total_revenue).toBeCloseTo(0);
  });

  it("3. perplexity.ai source is classified as ai bucket", () => {
    const rows = [
      row("2026-05-03", "perplexity.ai", "referral", "purchase", 2, 2, 99.98, "USD"),
      row("2026-05-03", "google",        "organic",  "purchase", 8, 8, 399.92, "USD"),
    ];
    const out = aggregateConversionRows(rows);
    expect(out.size).toBe(2);
    const aiBucket    = out.get("2026-05-03|ai|purchase");
    const humanBucket = out.get("2026-05-03|human|purchase");
    expect(aiBucket).toBeDefined();
    expect(aiBucket!.event_count).toBe(2);
    expect(aiBucket!.total_revenue).toBeCloseTo(99.98);
    expect(humanBucket).toBeDefined();
    expect(humanBucket!.event_count).toBe(8);
  });

  it("4. mixed currency: 10 events USD + 3 events EUR → bucket currency is USD (dominant)", () => {
    const rows = [
      row("2026-05-04", "google", "organic", "purchase", 10, 10, 500.00, "USD"),
      row("2026-05-04", "bing",   "organic", "purchase",  3,  3,  90.00, "EUR"),
    ];
    const out = aggregateConversionRows(rows);
    expect(out.size).toBe(1);
    const bucket = out.get("2026-05-04|human|purchase");
    expect(bucket).toBeDefined();
    expect(bucket!.currency).toBe("USD");
    expect(bucket!.event_count).toBe(13);
    expect(bucket!.total_revenue).toBeCloseTo(590.00);
  });

  it("5. empty input → empty map", () => {
    const out = aggregateConversionRows([]);
    expect(out.size).toBe(0);
  });
});
