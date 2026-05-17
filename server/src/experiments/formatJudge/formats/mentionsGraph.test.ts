/**
 * Phase 4 mentions-graph helper tests.
 *
 * Updated contract (May 2026):
 *   - `mentions[]` contains COMPARISON pages only. Synthetic /
 *     programmatic-SEO rows are deliberately omitted because AI search
 *     engines downweight hosts whose graphs are stuffed with template-
 *     generated "best X in Y" URLs.
 *   - `sameAs[]` contains every customer-hosted page (synthetic OR
 *     comparison) — sameAs is an entity-equivalence claim, independent
 *     of citation-quality concerns.
 *   - advocatemcp.com-hosted rows never go to sameAs (would conflate
 *     platform identity with the customer's).
 *   - Empty inputs yield empty arrays.
 */

import { describe, expect, it } from "vitest";
import { buildMentionsGraph } from "./shared.js";

describe("buildMentionsGraph", () => {
  it("returns empty arrays when there are no pages", () => {
    const g = buildMentionsGraph([], [], "customer.com");
    expect(g.mentions).toEqual([]);
    expect(g.sameAs).toEqual([]);
  });

  it("OMITS synthetic (programmatic SEO) pages from mentions[] but keeps them in sameAs[] when on customer host", () => {
    // Two synthetic rows: one on advocatemcp.com (cross-host promo) and
    // one mirrored on the customer's own domain. NEITHER appears in
    // mentions[] — both are programmatic-SEO templates. Only the
    // customer-hosted one feeds sameAs[] as an entity-equivalence claim.
    const g = buildMentionsGraph(
      [
        { host: "advocatemcp.com", path: "/best-x-in-y", title: "Best X in Y" },
        { host: "customer.com",    path: "/best-x-in-y", title: "Best X in Y" },
      ],
      [],
      "customer.com",
    );
    expect(g.mentions).toEqual([]); // No synthetic entries in mentions.
    expect(g.sameAs).toEqual(["https://customer.com/best-x-in-y"]);
  });

  it("OMITS advocatemcp.com synthetic pages from both mentions[] and sameAs[]", () => {
    // Pre-change behavior had this row appearing in mentions[]. The new
    // contract drops synthetic rows from mentions entirely, AND because
    // it's on advocatemcp.com it never qualified for sameAs anyway →
    // both arrays empty.
    const g = buildMentionsGraph(
      [{ host: "advocatemcp.com", path: "/best-x-in-y", title: "Best X" }],
      [],
      "customer.com",
    );
    expect(g.mentions).toEqual([]);
    expect(g.sameAs).toEqual([]);
  });

  it("includes COMPARISON pages in mentions[] (high-signal contextual content stays)", () => {
    // Comparison pages are NOT programmatic — they're hand-shaped
    // contextual content (/compare/a-vs-b) that AI search engines
    // actively weight upward. Always emit them.
    const g = buildMentionsGraph(
      [],
      [
        { host: "advocatemcp.com", path: "/compare/foo-vs-bar" },
        { host: "customer.com",    path: "/compare/foo-vs-bar" },
      ],
      "customer.com",
    );
    expect(g.mentions).toHaveLength(2);
    expect(g.mentions[0]).toEqual({ "@type": "WebPage", url: "https://advocatemcp.com/compare/foo-vs-bar" });
    expect(g.mentions[1]).toEqual({ "@type": "WebPage", url: "https://customer.com/compare/foo-vs-bar" });
    expect(g.sameAs).toEqual(["https://customer.com/compare/foo-vs-bar"]);
  });

  it("works when the business has no customer host (advocatemcp.com only)", () => {
    // Synthetic row on advocatemcp.com, no customer host configured →
    // both arrays empty. The previous contract emitted to mentions[]
    // even on advocatemcp.com; the new contract does not.
    const g = buildMentionsGraph(
      [{ host: "advocatemcp.com", path: "/best-x-in-y", title: "X" }],
      [],
      null,
    );
    expect(g.mentions).toEqual([]);
    expect(g.sameAs).toEqual([]);
  });

  it("synthetic + comparison together: mentions[] has only comparisons, sameAs[] has both customer-hosted entries", () => {
    // Integration case mirroring real production data: tenant has both
    // synthetic templates AND comparison pages on their own domain
    // AND on advocatemcp.com. mentions[] gets every comparison entry,
    // sameAs[] gets every customer-hosted entry of either type.
    const g = buildMentionsGraph(
      [
        { host: "advocatemcp.com", path: "/best-plumber-austin", title: "Best Plumber Austin" },
        { host: "customer.com",    path: "/best-plumber-austin", title: "Best Plumber Austin" },
      ],
      [
        { host: "advocatemcp.com", path: "/compare/acme-vs-zenith" },
        { host: "customer.com",    path: "/compare/acme-vs-zenith" },
      ],
      "customer.com",
    );
    expect(g.mentions).toEqual([
      { "@type": "WebPage", url: "https://advocatemcp.com/compare/acme-vs-zenith" },
      { "@type": "WebPage", url: "https://customer.com/compare/acme-vs-zenith" },
    ]);
    expect(g.sameAs).toEqual([
      "https://customer.com/best-plumber-austin",
      "https://customer.com/compare/acme-vs-zenith",
    ]);
  });
});
