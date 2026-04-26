import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateCloudflareToken,
  createCloudflareRecord,
  applyCloudflareRecords,
} from "./cloudflare";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/* Mock helper that routes calls based on URL. Each test sets up the
 * routes it needs; unmatched URLs throw so tests fail loudly. */
function mockCf(routes: Record<string, (init?: RequestInit) => Response>) {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    for (const pattern of Object.keys(routes)) {
      if (u.includes(pattern)) return routes[pattern]!(init);
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe("validateCloudflareToken — format guards", () => {
  it("rejects empty / too-short tokens", async () => {
    expect((await validateCloudflareToken("", "acme.com")).reason).toBe("token_format_invalid");
    expect((await validateCloudflareToken("abc", "acme.com")).reason).toBe("token_format_invalid");
  });

  it("rejects tokens with disallowed characters", async () => {
    const r = await validateCloudflareToken("invalid token with spaces", "acme.com");
    expect(r.reason).toBe("token_format_invalid");
  });

  it("rejects tokens longer than the cap", async () => {
    const r = await validateCloudflareToken("a".repeat(300), "acme.com");
    expect(r.reason).toBe("token_format_invalid");
  });

  it("trims whitespace from a pasted token before validating", async () => {
    mockCf({
      "/user/tokens/verify": () => new Response(
        JSON.stringify({ success: true, result: { id: "abc", status: "active" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      "/zones?name=": () => new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "zone-123", name: "acme.com", status: "active" }],
        }),
        { status: 200 },
      ),
    });
    const r = await validateCloudflareToken("  AAAAAAAAAA-validishlooking_token-1234567890  ", "acme.com");
    expect(r.ok).toBe(true);
    expect(r.zone_id).toBe("zone-123");
  });
});

describe("validateCloudflareToken — auth + zone outcomes", () => {
  it("returns token_invalid_or_revoked on 401", async () => {
    mockCf({
      "/user/tokens/verify": () => new Response(
        JSON.stringify({ success: false }),
        { status: 401 },
      ),
    });
    const r = await validateCloudflareToken("AAAAAAAAAA-validlength-1234567890", "acme.com");
    expect(r.reason).toBe("token_invalid_or_revoked");
  });

  it("returns token_inactive when token status != active", async () => {
    mockCf({
      "/user/tokens/verify": () => new Response(
        JSON.stringify({ success: true, result: { id: "abc", status: "disabled" } }),
        { status: 200 },
      ),
    });
    const r = await validateCloudflareToken("AAAAAAAAAA-validlength-1234567890", "acme.com");
    expect(r.reason).toBe("token_inactive");
  });

  it("returns zone_not_found_for_token when /zones?name= is empty", async () => {
    mockCf({
      "/user/tokens/verify": () => new Response(
        JSON.stringify({ success: true, result: { id: "abc", status: "active" } }),
        { status: 200 },
      ),
      "/zones?name=": () => new Response(
        JSON.stringify({ success: true, result: [] }),
        { status: 200 },
      ),
    });
    const r = await validateCloudflareToken("AAAAAAAAAA-validlength-1234567890", "acme.com");
    expect(r.reason).toBe("zone_not_found_for_token");
  });

  it("strips leading www. before zone lookup", async () => {
    let observedUrl = "";
    mockCf({
      "/user/tokens/verify": () => new Response(
        JSON.stringify({ success: true, result: { id: "abc", status: "active" } }),
        { status: 200 },
      ),
      "/zones?name=": (init) => {
        // Capture the URL to verify www. was stripped.
        const lastFetch = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1);
        observedUrl = String(lastFetch?.[0] ?? "");
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ id: "z1", name: "acme.com", status: "active" }],
          }),
          { status: 200 },
        );
      },
    });
    const r = await validateCloudflareToken("AAAAAAAAAA-validlength-1234567890", "www.acme.com");
    expect(r.ok).toBe(true);
    expect(observedUrl).toContain("name=acme.com");
    expect(observedUrl).not.toContain("name=www.");
  });
});

describe("createCloudflareRecord — idempotency + conflict", () => {
  it("returns already_exists when an identical record is already in CF", async () => {
    mockCf({
      "/dns_records?type=CNAME": () => new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "rec-1", type: "CNAME", name: "www.acme.com", content: "customers.advocatemcp.com" }],
        }),
        { status: 200 },
      ),
    });
    const r = await createCloudflareRecord("token", "zone-1", {
      type: "CNAME",
      name: "www.acme.com",
      content: "customers.advocatemcp.com",
    });
    expect(r.ok).toBe(true);
    expect(r.already_exists).toBe(true);
    expect(r.record_id).toBe("rec-1");
  });

  it("flags a conflict when an existing record has different content", async () => {
    mockCf({
      "/dns_records?type=CNAME": () => new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "rec-2", type: "CNAME", name: "www.acme.com", content: "elsewhere.example.com" }],
        }),
        { status: 200 },
      ),
    });
    const r = await createCloudflareRecord("token", "zone-1", {
      type: "CNAME",
      name: "www.acme.com",
      content: "customers.advocatemcp.com",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^record_conflict_/);
  });

  it("creates a new record when none exists", async () => {
    // Use a method-aware mock — list (GET with ?type=CNAME) returns
    // empty, POST to /dns_records (no querystring) creates.
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ success: true, result: { id: "new-rec" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await createCloudflareRecord("token", "zone-1", {
      type: "CNAME",
      name: "www.acme.com",
      content: "customers.advocatemcp.com",
    });
    expect(r.ok).toBe(true);
    expect(r.already_exists).toBeUndefined();
    expect(r.record_id).toBe("new-rec");
  });
});

describe("applyCloudflareRecords — orchestration", () => {
  it("returns overall_ok=true when all records succeed", async () => {
    mockCf({
      "/dns_records": () => new Response(
        JSON.stringify({ success: true, result: [] }),
        { status: 200 },
      ),
    });
    // After list returns empty, the POST also goes through /dns_records
    // — the same mock route handles both because it doesn't filter on
    // method. We override with method-aware handling:
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ success: true, result: { id: "ok" } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ success: true, result: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await applyCloudflareRecords("token", "zone-1", [
      { type: "CNAME", name: "www.acme.com", content: "customers.advocatemcp.com" },
      { type: "TXT", name: "_cf-custom-hostname.acme.com", content: "abc-123" },
    ]);
    expect(r.overall_ok).toBe(true);
    expect(r.results.length).toBe(2);
  });

  it("stops early on permission_denied to avoid spamming 403s", async () => {
    let postCount = 0;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCount++;
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 9109, message: "Forbidden" }] }),
          { status: 403 },
        );
      }
      return new Response(
        JSON.stringify({ success: true, result: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await applyCloudflareRecords("token", "zone-1", [
      { type: "CNAME", name: "www.acme.com", content: "customers.advocatemcp.com" },
      { type: "CNAME", name: "acme.com", content: "customers.advocatemcp.com" },
      { type: "TXT", name: "_cf-custom-hostname.acme.com", content: "abc-123" },
    ]);
    expect(r.overall_ok).toBe(false);
    // Should have stopped after the first permission_denied — exactly
    // one POST attempt, not three.
    expect(postCount).toBe(1);
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.reason).toBe("permission_denied");
  });
});
