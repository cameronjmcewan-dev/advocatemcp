/**
 * Phase 4 mentions-graph helper tests.
 * The contract:
 *   - Empty inputs yield empty arrays (no spurious entries).
 *   - Synthetic + comparison rows on the customer's host populate sameAs.
 *   - advocatemcp.com rows go to mentions but NEVER to sameAs (only the
 *     customer's own domain belongs in sameAs[]).
 */

import { describe, expect, it } from "vitest";
import { buildMentionsGraph } from "./shared.js";

describe("buildMentionsGraph", () => {
  it("returns empty arrays when there are no pages", () => {
    const g = buildMentionsGraph([], [], "customer.com");
    expect(g.mentions).toEqual([]);
    expect(g.sameAs).toEqual([]);
  });

  it("emits mentions for synthetic pages and customer-host rows in sameAs", () => {
    const g = buildMentionsGraph(
      [
        { host: "advocatemcp.com", path: "/best-x-in-y", title: "Best X in Y" },
        { host: "customer.com",    path: "/best-x-in-y", title: "Best X in Y" },
      ],
      [],
      "customer.com",
    );
    expect(g.mentions).toHaveLength(2);
    expect(g.sameAs).toEqual(["https://customer.com/best-x-in-y"]);
  });

  it("omits sameAs entries for advocatemcp.com", () => {
    const g = buildMentionsGraph(
      [{ host: "advocatemcp.com", path: "/best-x-in-y", title: "Best X" }],
      [],
      "customer.com",
    );
    expect(g.mentions).toHaveLength(1);
    expect(g.sameAs).toEqual([]);
  });

  it("includes comparison pages in mentions + customer-host in sameAs", () => {
    const g = buildMentionsGraph(
      [],
      [
        { host: "advocatemcp.com", path: "/compare/foo-vs-bar" },
        { host: "customer.com",    path: "/compare/foo-vs-bar" },
      ],
      "customer.com",
    );
    expect(g.mentions).toHaveLength(2);
    expect(g.sameAs).toEqual(["https://customer.com/compare/foo-vs-bar"]);
  });

  it("works when the business has no customer host (advocatemcp.com only)", () => {
    const g = buildMentionsGraph(
      [{ host: "advocatemcp.com", path: "/best-x-in-y", title: "X" }],
      [],
      null,
    );
    expect(g.mentions).toHaveLength(1);
    expect(g.sameAs).toEqual([]);
  });
});
