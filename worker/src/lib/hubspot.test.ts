/**
 * Tests for worker/src/lib/hubspot.ts
 *
 * No real network calls — all fetch calls are mocked via vi.spyOn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { refreshHubspotAccessToken, fetchContactsWithRevenue } from "./hubspot.js";

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

// ── refreshHubspotAccessToken ─────────────────────────────────────────────────

describe("refreshHubspotAccessToken", () => {
  it("1. returns accessToken and expiresIn on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "hub-at-abc123", expires_in: 1800 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await refreshHubspotAccessToken(
      "my-refresh-token",
      "client-id",
      "client-secret",
    );

    expect(result.accessToken).toBe("hub-at-abc123");
    expect(result.expiresIn).toBe(1800);
  });

  it("2. throws on non-2xx response with hubspot: prefix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      refreshHubspotAccessToken("bad-token", "client-id", "client-secret"),
    ).rejects.toThrow(/hubspot:/);
  });

  it("3. throws when access_token missing from response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ expires_in: 1800 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      refreshHubspotAccessToken("refresh", "id", "secret"),
    ).rejects.toThrow(/no access_token/);
  });
});

// ── fetchContactsWithRevenue ──────────────────────────────────────────────────

describe("fetchContactsWithRevenue", () => {
  it("4. returns empty array when search returns no results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ results: [], paging: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      createdAfter: "2026-01-01T00:00:00.000Z",
    });

    expect(contacts).toHaveLength(0);
  });

  it("5. returns contacts with totalRevenue=0 when no deals are associated", async () => {
    // contacts/search response
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{
              id:         "c1",
              properties: { email: "user@example.com", createdate: "1746000000000", lifecyclestage: "lead" },
              createdAt:  "2026-01-01T12:00:00.000Z",
            }],
            paging: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // associations/deals response — empty
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      createdAfter: "2026-01-01T00:00:00.000Z",
    });

    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe("c1");
    expect(contacts[0].email).toBe("user@example.com");
    expect(contacts[0].lifecycleStage).toBe("lead");
    expect(contacts[0].totalRevenue).toBe(0);
  });

  it("6. sums revenue only from closed-won deals", async () => {
    vi.spyOn(globalThis, "fetch")
      // contacts search
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{
              id:         "c2",
              properties: { email: "biz@example.com", createdate: "1746000000000", lifecyclestage: "customer" },
              createdAt:  "2026-02-01T00:00:00.000Z",
            }],
            paging: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // associations/deals
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [{ id: "d1" }, { id: "d2" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // deal d1 — closed-won, $500
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ properties: { dealstage: "closedwon", amount: "500.00" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // deal d2 — not closed (ignore)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ properties: { dealstage: "presentationscheduled", amount: "1000.00" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      createdAfter: "2026-01-01T00:00:00.000Z",
    });

    expect(contacts).toHaveLength(1);
    expect(contacts[0].totalRevenue).toBe(500);
  });

  it("7. pagination: fetches second page when paging.next.after is present", async () => {
    vi.spyOn(globalThis, "fetch")
      // page 1 — one contact + next cursor
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{
              id:         "c3",
              properties: { email: "p1@example.com", createdate: "1746000000000", lifecyclestage: "subscriber" },
              createdAt:  "2026-01-01T00:00:00.000Z",
            }],
            paging: { next: { after: "cursor-abc" } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // c3 associations — empty
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      )
      // page 2 — one contact, no next cursor
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{
              id:         "c4",
              properties: { email: "p2@example.com", createdate: "1746000000000", lifecyclestage: "subscriber" },
              createdAt:  "2026-01-05T00:00:00.000Z",
            }],
            paging: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // c4 associations — empty
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      createdAfter: "2026-01-01T00:00:00.000Z",
    });

    expect(contacts).toHaveLength(2);
    expect(contacts.map(c => c.id)).toEqual(["c3", "c4"]);
  });

  it("8. maxContacts cap stops pagination early", async () => {
    vi.spyOn(globalThis, "fetch")
      // search returns 2 contacts — but cap is 1
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              { id: "c5", properties: { email: "a@x.com", createdate: "1746000000000", lifecyclestage: "lead" }, createdAt: "2026-01-01T00:00:00.000Z" },
              { id: "c6", properties: { email: "b@x.com", createdate: "1746000000000", lifecyclestage: "lead" }, createdAt: "2026-01-02T00:00:00.000Z" },
            ],
            paging: { next: { after: "cursor-next" } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // associations for c5
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      createdAfter: "2026-01-01T00:00:00.000Z",
      maxContacts:  1,
    });

    // Should stop after 1 contact despite getting 2 in the response
    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe("c5");
  });

  it("9. association fetch failure returns 0 revenue (non-fatal)", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{
              id:         "c7",
              properties: { email: "err@x.com", createdate: "1746000000000", lifecyclestage: "customer" },
              createdAt:  "2026-03-01T00:00:00.000Z",
            }],
            paging: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // associations endpoint returns error
      .mockResolvedValueOnce(
        new Response("Forbidden", { status: 403 }),
      );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      createdAfter: "2026-01-01T00:00:00.000Z",
    });

    expect(contacts).toHaveLength(1);
    // Should not throw — just return 0 revenue
    expect(contacts[0].totalRevenue).toBe(0);
  });
});
