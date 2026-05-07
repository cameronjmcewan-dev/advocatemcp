/**
 * Tests for worker/src/lib/geoAggregator.ts
 */

import { describe, it, expect } from "vitest";
import { aggregateGeoRows } from "./geoAggregator.js";
import type { GA4GeoRow } from "./ga4.js";

describe("aggregateGeoRows", () => {
  it("1. single row produces one bucket with correct ai/human split", () => {
    const rows: GA4GeoRow[] = [
      { date: "2026-05-01", country: "United States", city: "New York", source: "perplexity.ai", medium: "referral", sessions: 10 },
    ];
    const out = aggregateGeoRows(rows);
    expect(out.size).toBe(1);
    const bucket = out.get("2026-05-01|United States|New York");
    expect(bucket).toBeDefined();
    expect(bucket!.ai_sessions).toBe(10);
    expect(bucket!.human_sessions).toBe(0);
    expect(bucket!.date).toBe("2026-05-01");
    expect(bucket!.country).toBe("United States");
    expect(bucket!.city).toBe("New York");
  });

  it("2. two rows with same (date, country, city) but different sources combine into one bucket", () => {
    const rows: GA4GeoRow[] = [
      { date: "2026-05-01", country: "Canada", city: "Toronto", source: "perplexity.ai", medium: "referral", sessions: 5 },
      { date: "2026-05-01", country: "Canada", city: "Toronto", source: "google", medium: "organic", sessions: 15 },
    ];
    const out = aggregateGeoRows(rows);
    expect(out.size).toBe(1);
    const bucket = out.get("2026-05-01|Canada|Toronto");
    expect(bucket).toBeDefined();
    expect(bucket!.ai_sessions).toBe(5);
    expect(bucket!.human_sessions).toBe(15);
  });

  it("3. two rows same (date, country) but different cities produce SEPARATE buckets", () => {
    const rows: GA4GeoRow[] = [
      { date: "2026-05-02", country: "United Kingdom", city: "London", source: "google", medium: "organic", sessions: 30 },
      { date: "2026-05-02", country: "United Kingdom", city: "Manchester", source: "google", medium: "organic", sessions: 12 },
    ];
    const out = aggregateGeoRows(rows);
    expect(out.size).toBe(2);
    expect(out.has("2026-05-02|United Kingdom|London")).toBe(true);
    expect(out.has("2026-05-02|United Kingdom|Manchester")).toBe(true);
    expect(out.get("2026-05-02|United Kingdom|London")!.human_sessions).toBe(30);
    expect(out.get("2026-05-02|United Kingdom|Manchester")!.human_sessions).toBe(12);
  });

  it("4. AI source classified correctly via medium=ai and source domain", () => {
    const rows: GA4GeoRow[] = [
      // AI via medium
      { date: "2026-05-03", country: "Australia", city: "Sydney", source: "some-source", medium: "ai", sessions: 8 },
      // AI via domain
      { date: "2026-05-03", country: "Australia", city: "Sydney", source: "chat.openai.com", medium: "referral", sessions: 4 },
      // Human
      { date: "2026-05-03", country: "Australia", city: "Sydney", source: "google", medium: "cpc", sessions: 20 },
    ];
    const out = aggregateGeoRows(rows);
    expect(out.size).toBe(1);
    const bucket = out.get("2026-05-03|Australia|Sydney");
    expect(bucket!.ai_sessions).toBe(12);    // 8 + 4
    expect(bucket!.human_sessions).toBe(20);
  });

  it("5. empty input returns empty map", () => {
    const out = aggregateGeoRows([]);
    expect(out.size).toBe(0);
  });

  it('6. country-only sentinel (city="") keys correctly and collapses into one bucket', () => {
    // The schema PK uses (slug, date, country, city) with city NOT NULL
    // DEFAULT ''. Country-only rows from anonymous traffic produce
    // city="" and the key must include the trailing "|" so two such rows
    // for the same country collapse into one bucket.
    const rows = [
      { date: "2026-05-04", country: "United States", city: "", source: "perplexity.ai", medium: "referral", sessions: 7 },
      { date: "2026-05-04", country: "United States", city: "", source: "google",        medium: "organic",  sessions: 13 },
      { date: "2026-05-04", country: "",              city: "", source: "(direct)",      medium: "(none)",   sessions: 4 },
    ];
    const out = aggregateGeoRows(rows);
    expect(out.size).toBe(2);
    const us = out.get("2026-05-04|United States|");
    expect(us).toBeDefined();
    expect(us!.ai_sessions).toBe(7);
    expect(us!.human_sessions).toBe(13);
    expect(us!.city).toBe("");
    const unknown = out.get("2026-05-04||");
    expect(unknown).toBeDefined();
    expect(unknown!.country).toBe("");
    expect(unknown!.city).toBe("");
    expect(unknown!.human_sessions).toBe(4);
  });
});
