import { describe, it, expect } from "vitest";
import { deterministicQuote } from "./getQuote.js";

const pricing = {
  ranges: [
    { service: "lawn mowing", low: 40, high: 40, currency: "USD" },
    { service: "lawn mowing", low: 60, high: 90, currency: "USD", params: { size: "large" } },
    { service: "hedge trimming", low: 30, high: 75, currency: "USD" },
  ],
};

describe("deterministicQuote", () => {
  it("returns exact when low === high on matched service", () => {
    const q = deterministicQuote({ service: "lawn mowing", params: {} }, pricing);
    expect(q).toEqual({ low: 40, high: 40, currency: "USD", confidence: "exact", basis: "pricing_json_v2" });
  });
  it("returns range when low < high", () => {
    const q = deterministicQuote({ service: "hedge trimming", params: {} }, pricing);
    expect(q).toEqual({ low: 30, high: 75, currency: "USD", confidence: "range", basis: "pricing_json_v2" });
  });
  it("respects param narrowing when the range declares params", () => {
    const q = deterministicQuote({ service: "lawn mowing", params: { size: "large" } }, pricing);
    expect(q).toEqual({ low: 60, high: 90, currency: "USD", confidence: "range", basis: "pricing_json_v2" });
  });
  it("is case/whitespace insensitive on service name", () => {
    const q = deterministicQuote({ service: "  LAWN MOWING  ", params: {} }, pricing);
    expect(q?.low).toBe(40);
  });
  it("returns null on service miss", () => {
    const q = deterministicQuote({ service: "window washing", params: {} }, pricing);
    expect(q).toBeNull();
  });
  it("returns null on param mismatch", () => {
    // Caller supplied a param; the size-free row requires empty params, size-large row requires large.
    const q = deterministicQuote({ service: "lawn mowing", params: { size: "small" } }, pricing);
    expect(q).toBeNull();
  });
});
