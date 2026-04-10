/**
 * Tests for worker/src/lib/origin-discovery.ts
 *
 * All tests inject a `fetchFn` rather than stubbing globalThis.fetch because
 * Node's Response constructor doesn't let you set `url`, which makes real
 * Response instances unusable for redirect-final-URL tests. Instead we pass
 * plain object literals matching the FetchResponseLike interface — the
 * production code only reads `status`, `url`, and `body.cancel()`, so the
 * minimal shape is sufficient and documented at the type level.
 */

import { describe, it, expect, vi } from "vitest";
import { discoverOriginUrl, type FetchFn, type FetchResponseLike } from "./origin-discovery.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeResponse(url: string, status = 200): FetchResponseLike {
  return {
    status,
    url,
    body: { cancel: vi.fn() },
  };
}

function fetchReturning(response: FetchResponseLike): FetchFn {
  return vi.fn().mockResolvedValue(response) as unknown as FetchFn;
}

function fetchRejecting(err: Error): FetchFn {
  return vi.fn().mockRejectedValue(err) as unknown as FetchFn;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("discoverOriginUrl", () => {
  // 1. Single-hop redirect success
  it("returns the final origin for a single-hop redirect", async () => {
    const fetchFn = fetchReturning(fakeResponse("https://example.squarespace.com/"));
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.originUrl).toBe("https://example.squarespace.com");
      expect(result.finalHostname).toBe("example.squarespace.com");
    }
  });

  // 2. Multi-hop redirect success (runtime collapses the chain; we only see final)
  it("returns the final origin for a multi-hop redirect chain", async () => {
    const fetchFn = fetchReturning(fakeResponse("https://example.squarespace.com/home"));
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // URL.origin strips path, so the /home suffix is dropped
      expect(result.originUrl).toBe("https://example.squarespace.com");
      expect(result.finalHostname).toBe("example.squarespace.com");
    }
  });

  // 3. No-redirect self-loop rejection
  it("rejects with self_loop when the domain is its own origin", async () => {
    const fetchFn = fetchReturning(fakeResponse("https://example.com/"));
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("self_loop");
      expect(result.status).toBe(400);
      expect(result.error).toContain("traffic loop");
      expect(result.error).toContain("Cloudflare");
    }
  });

  // 4. Case-insensitive self-loop check (belt and suspenders)
  it("rejects with self_loop even when hostnames differ only in case", async () => {
    const fetchFn = fetchReturning(fakeResponse("https://EXAMPLE.COM/landing"));
    const result = await discoverOriginUrl("Example.Com", { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("self_loop");
    }
  });

  // 5. HTTPS-to-HTTP downgrade rejection
  it("rejects with http_scheme when the final URL is HTTP", async () => {
    const fetchFn = fetchReturning(fakeResponse("http://legacy-host.com/"));
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("http_scheme");
      expect(result.status).toBe(400);
      expect(result.error).toContain("non-HTTPS");
    }
  });

  // 6. Worker-hostname loop rejection
  it("rejects with worker_loop when the final URL is a known Worker hostname", async () => {
    const fetchFn = fetchReturning(fakeResponse("https://customers.advocatemcp.com/page"));
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("worker_loop");
      expect(result.status).toBe(400);
      expect(result.error).toContain("AdvocateMCP Worker");
    }
  });

  // 7. 5xx rejection
  it("rejects with origin_5xx when the final response is a 5xx", async () => {
    const fetchFn = fetchReturning(fakeResponse("https://example.squarespace.com/", 503));
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("origin_5xx");
      expect(result.status).toBe(400);
      expect(result.detail.httpStatus).toBe(503);
    }
  });

  // 8. Network error
  it("rejects with fetch_failed on a network error", async () => {
    const fetchFn = fetchRejecting(new Error("ECONNREFUSED"));
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch_failed");
      expect(result.status).toBe(400);
      expect(result.error).toContain("could not reach");
    }
  });

  // 9. Timeout (AbortError)
  it("rejects with fetch_timeout when the fetch is aborted", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const fetchFn = fetchRejecting(abortErr);
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch_timeout");
      expect(result.status).toBe(400);
      expect(result.error).toContain("timed out");
    }
  });

  // 10. Accepts 2xx/3xx/4xx final statuses — 404 on a real cross-host is still a valid origin
  it("accepts a 4xx final status as long as the hostname is cross-host", async () => {
    const fetchFn = fetchReturning(fakeResponse("https://example.squarespace.com/not-found", 404));
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.originUrl).toBe("https://example.squarespace.com");
    }
  });

  // 11. Body is cancelled after response is read
  it("cancels the response body after reading metadata", async () => {
    const cancelSpy = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      url: "https://example.squarespace.com/",
      body: { cancel: cancelSpy },
    }) as unknown as FetchFn;
    await discoverOriginUrl("example.com", { fetchFn });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  // Additional: User-Agent is sent
  it("sends the AdvocateMCP-Discovery User-Agent header", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse("https://example.squarespace.com/")) as unknown as FetchFn;
    await discoverOriginUrl("example.com", { fetchFn });
    const call = vi.mocked(fetchFn).mock.calls[0];
    const init = call[1] as { headers?: Record<string, string> };
    expect(init.headers?.["User-Agent"]).toMatch(/^AdvocateMCP-Discovery\/1\.0/);
  });

  // Additional: start URL is built from the domain with https scheme
  it("fetches https://{domain} as the start URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse("https://example.squarespace.com/")) as unknown as FetchFn;
    await discoverOriginUrl("Example.com", { fetchFn });
    const call = vi.mocked(fetchFn).mock.calls[0];
    expect(call[0]).toBe("https://example.com");
  });

  // ── Regression: unresolvable domain misreported as self_loop ────────────────
  //
  // During manual Phase 2 E2E testing a call for a nonexistent-TLD domain was
  // reported as `self_loop` with `finalHostname === input`. Root cause: when
  // Cloudflare Workers' fetch encounters an unresolvable domain, it does NOT
  // throw — it returns a synthetic Cloudflare error response (5xx status with
  // the input URL preserved in response.url). That slipped past the catch
  // block, reached the rejection checks, and hit `self_loop` because
  // `finalHostname === normalizedDomain` — before ever reaching the 5xx check
  // lower down.
  //
  // The semantic fix is to distinguish three cases:
  //
  //   1. No cross-host redirect + 2xx/3xx/4xx  → self_loop   (real site, no redirect, correct rejection)
  //   2. No cross-host redirect + 5xx          → fetch_failed (synthetic Workers response, DNS/network failure)
  //   3. Cross-host redirect + 5xx             → origin_5xx  (real origin having trouble)
  //
  // These tests lock in all three cases. Case 3 is already covered by the
  // existing "rejects with origin_5xx when the final response is a 5xx" test
  // above, which uses a cross-host redirect and therefore is unaffected by
  // the fix.

  // Case: fetch throws TypeError (undici/Node default behavior). Already
  // correct today — included as a safety lock so a future refactor can't
  // break the catch-block branch.
  it("labels an unresolvable domain as fetch_failed when fetch throws TypeError", async () => {
    const fetchFn = fetchRejecting(new TypeError("fetch failed"));
    const result = await discoverOriginUrl("this-domain-definitely-does-not-exist-99999.nonexistenttld", { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch_failed");
    }
  });

  // Case: fetch returns a synthetic Cloudflare 530 with the input URL
  // preserved. This is the actual production symptom. Must produce
  // fetch_failed, not self_loop.
  it("labels an unresolvable domain as fetch_failed when fetch returns a synthetic 5xx with the input URL", async () => {
    const nonexistent = "this-domain-definitely-does-not-exist-99999.nonexistenttld";
    const fetchFn = fetchReturning(fakeResponse(`https://${nonexistent}`, 530));
    const result = await discoverOriginUrl(nonexistent, { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch_failed");
      expect(result.error).toContain("could not reach");
    }
  });

  // Boundary: exactly status 500. The `status >= 500` check must include
  // 500 itself — this is the boundary that breaks most often when someone
  // refactors a comparison operator. Must produce fetch_failed for a
  // same-host 500, not self_loop, not origin_5xx.
  it("labels a same-host HTTP 500 as fetch_failed (5xx boundary: inclusive of 500)", async () => {
    const fetchFn = fetchReturning(fakeResponse("https://example.com/", 500));
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch_failed");
    }
  });

  // Boundary companion: exactly status 499 on the same host stays in the
  // self_loop bucket. 4xx on the input domain means the site is actually
  // responding, just with a client error — that's a legitimate no-redirect
  // case and the customer needs to hear "your site is its own origin",
  // not "your site is unreachable".
  it("labels a same-host HTTP 499 as self_loop (5xx boundary: exclusive of 499)", async () => {
    const fetchFn = fetchReturning(fakeResponse("https://example.com/", 499));
    const result = await discoverOriginUrl("example.com", { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("self_loop");
    }
  });
});
