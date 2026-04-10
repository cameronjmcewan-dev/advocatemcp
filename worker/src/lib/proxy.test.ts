/**
 * Tests for worker/src/lib/proxy.ts
 *
 * All tests mock globalThis.fetch via vi.stubGlobal so no real network calls
 * are made. Request, Response, and Headers are available as globals in Node 18+
 * (same Web API surface as the Cloudflare Workers runtime).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { proxyToOrigin } from "./proxy.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(
  url = "https://example.com/page?q=1",
  init: RequestInit = {},
): Request {
  return new Request(url, { method: "GET", ...init });
}

function mockFetch(response: Response): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("proxyToOrigin", () => {
  it("passes through a 200 response with body and status", async () => {
    mockFetch(new Response("<html>Hello</html>", { status: 200 }));
    const req = makeRequest("https://example.com/page");
    const res = await proxyToOrigin(req, "https://realorigin.com", "example.com");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>Hello</html>");
  });

  it("passes through a 302 redirect without following it", async () => {
    mockFetch(
      new Response(null, {
        status: 302,
        headers: { Location: "https://realorigin.com/new-path" },
      }),
    );
    const req = makeRequest("https://example.com/old-path");
    const res = await proxyToOrigin(req, "https://realorigin.com", "example.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://realorigin.com/new-path");
  });

  it("returns 502 when the origin fetch throws a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const req = makeRequest("https://example.com/page");
    const res = await proxyToOrigin(req, "https://realorigin.com", "example.com");
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Origin fetch failed");
  });

  it("returns 501 for WebSocket upgrade requests", async () => {
    const req = makeRequest("https://example.com/ws", {
      headers: { Upgrade: "websocket" },
    });
    // fetch should never be called for WebSocket upgrades
    vi.stubGlobal("fetch", vi.fn());
    const res = await proxyToOrigin(req, "https://realorigin.com", "example.com");
    expect(res.status).toBe(501);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("overrides Cache-Control to no-store regardless of origin value", async () => {
    mockFetch(
      new Response("content", {
        status: 200,
        headers: { "Cache-Control": "max-age=3600, public" },
      }),
    );
    const req = makeRequest("https://example.com/page");
    const res = await proxyToOrigin(req, "https://realorigin.com", "example.com");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 508 when origin hostname matches the request hostname (self-loop)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const req = makeRequest("https://example.com/page");
    const res = await proxyToOrigin(req, "https://example.com", "example.com");
    expect(res.status).toBe(508);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Loop detected");
  });

  it("returns 508 when origin hostname is a known Worker hostname", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const req = makeRequest("https://example.com/page");
    const res = await proxyToOrigin(req, "https://customers.advocatemcp.com/", "example.com");
    expect(res.status).toBe(508);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
