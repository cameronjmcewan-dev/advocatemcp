/**
 * Unit tests for dateRange — locks down the resolution order, validation,
 * and edge cases (max-365-day cap, end < start, malformed dates).
 */

import { describe, expect, it } from "vitest";
import { parseDateRange, sqlBounds } from "./dateRange.js";

describe("parseDateRange — explicit start/end", () => {
  it("accepts well-formed start + end", () => {
    const r = parseDateRange({ start_date: "2026-04-01", end_date: "2026-04-29" });
    expect(r.start).toBe("2026-04-01");
    expect(r.end).toBe("2026-04-29");
    expect(r.days).toBe(29);
  });

  it("rejects end before start", () => {
    expect(() => parseDateRange({ start_date: "2026-04-29", end_date: "2026-04-01" }))
      .toThrowError(/end_date must be on or after/);
  });

  it("rejects malformed start", () => {
    expect(() => parseDateRange({ start_date: "april", end_date: "2026-04-29" }))
      .toThrowError(/start_date/);
  });

  it("rejects ranges over 365 days", () => {
    expect(() => parseDateRange({ start_date: "2024-01-01", end_date: "2026-01-02" }))
      .toThrowError(/365/);
  });

  it("accepts a single day (start === end)", () => {
    const r = parseDateRange({ start_date: "2026-04-29", end_date: "2026-04-29" });
    expect(r.days).toBe(1);
  });
});

describe("parseDateRange — range shorthand", () => {
  it("resolves 7d to today and 6 days back (7 inclusive)", () => {
    const r = parseDateRange({ range: "7d" });
    expect(r.days).toBe(7);
  });

  it("resolves 30d", () => {
    expect(parseDateRange({ range: "30d" }).days).toBe(30);
  });

  it("resolves 90d", () => {
    expect(parseDateRange({ range: "90d" }).days).toBe(90);
  });

  it("rejects unknown range strings", () => {
    expect(() => parseDateRange({ range: "1y" })).toThrowError(/range must be one of/);
  });
});

describe("parseDateRange — default", () => {
  it("returns 30-day default when no params are present", () => {
    const r = parseDateRange({});
    expect(r.days).toBe(30);
  });
});

describe("sqlBounds", () => {
  it("emits inclusive-of-end-day SQL bounds", () => {
    const r = parseDateRange({ start_date: "2026-04-01", end_date: "2026-04-29" });
    const b = sqlBounds(r);
    expect(b.startSql).toBe("2026-04-01");
    expect(b.endSql).toBe("2026-04-29 23:59:59");
  });
});
