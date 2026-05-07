/**
 * Tests for worker/src/lib/salesforce.ts
 *
 * No real network calls — all fetch calls are mocked via vi.spyOn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { refreshSalesforceAccessToken, fetchContactsWithRevenue } from "./salesforce.js";

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

const INSTANCE_URL = "https://acme.my.salesforce.com";

// ── refreshSalesforceAccessToken ──────────────────────────────────────────────

describe("refreshSalesforceAccessToken", () => {
  it("1. returns accessToken, expiresIn, and instanceUrl on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token:  "sf-at-abc123",
          instance_url:  INSTANCE_URL,
          expires_in:    7200,
          token_type:    "Bearer",
          id:            "https://login.salesforce.com/id/test/test",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await refreshSalesforceAccessToken(
      "my-refresh-token",
      "client-id",
      "client-secret",
    );

    expect(result.accessToken).toBe("sf-at-abc123");
    expect(result.expiresIn).toBe(7200);
    expect(result.instanceUrl).toBe(INSTANCE_URL);
  });

  it("2. throws on non-2xx response with salesforce: prefix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      refreshSalesforceAccessToken("bad-token", "client-id", "client-secret"),
    ).rejects.toThrow(/salesforce:/);
  });

  it("3. throws when access_token missing from response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ instance_url: INSTANCE_URL }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      refreshSalesforceAccessToken("refresh", "id", "secret"),
    ).rejects.toThrow(/no access_token/);
  });

  it("4. throws when instance_url missing from response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "sf-at-xyz" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      refreshSalesforceAccessToken("refresh", "id", "secret"),
    ).rejects.toThrow(/no instance_url/);
  });
});

// ── fetchContactsWithRevenue ──────────────────────────────────────────────────

describe("fetchContactsWithRevenue", () => {
  it("5. returns empty array when SOQL returns no records", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ records: [], totalSize: 0, done: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      instanceUrl:  INSTANCE_URL,
      createdAfter: "2026-01-01T00:00:00.000Z",
    });

    expect(contacts).toHaveLength(0);
  });

  it("6. returns contacts with lifecycleStage=lead and totalRevenue=0 when no closed-won opportunities", async () => {
    vi.spyOn(globalThis, "fetch")
      // contacts query
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            records: [{
              Id:          "003000000000001",
              Email:       "user@example.com",
              CreatedDate: "2026-04-01T10:00:00.000+0000",
            }],
            totalSize: 1,
            done:      true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // revenue aggregate query for contact — no closed-won opps
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ records: [{ revenue: null }], totalSize: 1, done: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      instanceUrl:  INSTANCE_URL,
      createdAfter: "2026-01-01T00:00:00.000Z",
    });

    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe("003000000000001");
    expect(contacts[0].email).toBe("user@example.com");
    expect(contacts[0].lifecycleStage).toBe("lead");
    expect(contacts[0].totalRevenue).toBe(0);
  });

  it("7. contacts with closed-won revenue get lifecycleStage=customer", async () => {
    vi.spyOn(globalThis, "fetch")
      // contacts query — one contact
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            records: [{
              Id:          "003000000000002",
              Email:       "biz@example.com",
              CreatedDate: "2026-03-15T08:30:00.000+0000",
            }],
            totalSize: 1,
            done:      true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // revenue aggregate — $1200 closed-won
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ records: [{ revenue: 1200 }], totalSize: 1, done: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      instanceUrl:  INSTANCE_URL,
      createdAfter: "2026-01-01T00:00:00.000Z",
    });

    expect(contacts).toHaveLength(1);
    expect(contacts[0].lifecycleStage).toBe("customer");
    expect(contacts[0].totalRevenue).toBe(1200);
  });

  it("8. revenue query failure returns 0 totalRevenue (non-fatal)", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            records: [{
              Id:          "003000000000003",
              Email:       "err@example.com",
              CreatedDate: "2026-02-01T00:00:00.000+0000",
            }],
            totalSize: 1,
            done:      true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // revenue query fails — should not throw
      .mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      instanceUrl:  INSTANCE_URL,
      createdAfter: "2026-01-01T00:00:00.000Z",
    });

    expect(contacts).toHaveLength(1);
    expect(contacts[0].totalRevenue).toBe(0);
    expect(contacts[0].lifecycleStage).toBe("lead");
  });

  it("9. maxContacts cap limits the number of contacts returned", async () => {
    vi.spyOn(globalThis, "fetch")
      // contacts query returns 3 but cap is 2
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            records: [
              { Id: "003000000000010", Email: "a@x.com", CreatedDate: "2026-04-01T00:00:00.000+0000" },
              { Id: "003000000000011", Email: "b@x.com", CreatedDate: "2026-04-02T00:00:00.000+0000" },
              { Id: "003000000000012", Email: "c@x.com", CreatedDate: "2026-04-03T00:00:00.000+0000" },
            ],
            totalSize: 3,
            done:      true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // revenue for first contact
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ records: [{ revenue: 0 }], totalSize: 1, done: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // revenue for second contact
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ records: [{ revenue: 0 }], totalSize: 1, done: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const contacts = await fetchContactsWithRevenue({
      accessToken:  "token",
      instanceUrl:  INSTANCE_URL,
      createdAfter: "2026-01-01T00:00:00.000Z",
      maxContacts:  2,
    });

    expect(contacts).toHaveLength(2);
    expect(contacts.map(c => c.id)).toEqual(["003000000000010", "003000000000011"]);
  });

  it("10. contacts query failure throws with salesforce: prefix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }]), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      fetchContactsWithRevenue({
        accessToken:  "expired-token",
        instanceUrl:  INSTANCE_URL,
        createdAfter: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/salesforce:/);
  });
});
