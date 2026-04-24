/**
 * Tests for worker/src/lib/cors.ts
 *
 * Pure function tests. No network, no mocking, no D1. Constructs
 * Request and Response objects directly via the Web API constructors
 * available in Node 18+ and the Cloudflare Workers runtime.
 *
 * Six tests covering the ratified behavior:
 *
 *   1. Allowed origin echoes back in Access-Control-Allow-Origin
 *   2. Disallowed origin returns the default (https://advocatemcp.com)
 *   3. credentials: true sets Access-Control-Allow-Credentials: true
 *   4. credentials: false/undefined does NOT set the credentials header
 *   5. handleCorsPreflight returns 204 with headers
 *   6. withCors preserves body/status/statusText while merging headers
 */

import { describe, it, expect } from "vitest";
import { corsHeadersFor, withCors, handleCorsPreflight } from "./cors.js";

/** Helper — construct a Request with a specific Origin header. */
function makeRequest(origin: string | null): Request {
  const headers = new Headers();
  if (origin !== null) headers.set("Origin", origin);
  return new Request("https://customers.advocatemcp.com/api/client/me", {
    method: "GET",
    headers,
  });
}

describe("cors", () => {
  // 1. Allowed origin echoes back
  it("echoes an allowed origin in Access-Control-Allow-Origin", async () => {
    const request = makeRequest("https://advocatemcp.com");
    const headers = corsHeadersFor(request);
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://advocatemcp.com");
    expect(headers["Vary"]).toBe("Origin");

    // Verify localhost is also echoed (Phase D dev use)
    const localRequest = makeRequest("http://localhost:5173");
    const localHeaders = corsHeadersFor(localRequest);
    expect(localHeaders["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
  });

  // 2. Disallowed origin returns the default
  it("returns the default origin for an unknown Origin", async () => {
    const request = makeRequest("https://evil.example.com");
    const headers = corsHeadersFor(request);
    // Must NOT echo the attacker-controlled origin
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://advocatemcp.com");
    expect(headers["Access-Control-Allow-Origin"]).not.toBe("https://evil.example.com");
    // Vary still present so caches don't serve the wrong thing to a different origin
    expect(headers["Vary"]).toBe("Origin");

    // Also cover the "no Origin header at all" case — should fall back to default
    const noOriginRequest = makeRequest(null);
    const noOriginHeaders = corsHeadersFor(noOriginRequest);
    expect(noOriginHeaders["Access-Control-Allow-Origin"]).toBe("https://advocatemcp.com");
  });

  it("echoes any *.advocatemcp-site.pages.dev preview origin (branch alias)", async () => {
    const request = makeRequest("https://design-preview.advocatemcp-site.pages.dev");
    const headers = corsHeadersFor(request);
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://design-preview.advocatemcp-site.pages.dev",
    );
  });

  it("echoes a *.advocatemcp-site.pages.dev commit-SHA preview origin", async () => {
    const request = makeRequest("https://c0708e27.advocatemcp-site.pages.dev");
    const headers = corsHeadersFor(request);
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://c0708e27.advocatemcp-site.pages.dev",
    );
  });

  it("rejects a lookalike pretending to be a Pages subdomain", async () => {
    const request = makeRequest("https://advocatemcp-site.pages.dev.evil.com");
    const headers = corsHeadersFor(request);
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://advocatemcp.com");
  });

  it("rejects plain http on a Pages hostname (suffix must be https)", async () => {
    const request = makeRequest("http://design-preview.advocatemcp-site.pages.dev");
    const headers = corsHeadersFor(request);
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://advocatemcp.com");
  });

  // 3. credentials: true sets Allow-Credentials: true
  it("sets Access-Control-Allow-Credentials: true when credentials=true", async () => {
    const request = makeRequest("https://advocatemcp.com");
    const headers = corsHeadersFor(request, { credentials: true });
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  // 4. credentials not explicitly true does NOT set the header
  it("does NOT set Access-Control-Allow-Credentials when credentials is false or omitted", async () => {
    const request = makeRequest("https://advocatemcp.com");

    // No opts object
    const headersNoOpts = corsHeadersFor(request);
    expect(headersNoOpts["Access-Control-Allow-Credentials"]).toBeUndefined();

    // Empty opts object
    const headersEmptyOpts = corsHeadersFor(request, {});
    expect(headersEmptyOpts["Access-Control-Allow-Credentials"]).toBeUndefined();

    // Explicit credentials: false
    const headersFalse = corsHeadersFor(request, { credentials: false });
    expect(headersFalse["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  // 5. handleCorsPreflight returns 204
  it("handleCorsPreflight returns 204 with CORS headers", async () => {
    const request = makeRequest("https://advocatemcp.com");
    const response = handleCorsPreflight(request, { credentials: true });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://advocatemcp.com");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Vary")).toBe("Origin");

    // 204 responses carry no body
    const body = await response.text();
    expect(body).toBe("");
  });

  // 6. handleCorsPreflight with credentials sets Allow-Credentials on 204
  it("handleCorsPreflight with credentials: true sets Allow-Credentials header", async () => {
    const request = makeRequest("https://advocatemcp.com");
    const response = handleCorsPreflight(request, { credentials: true });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://advocatemcp.com");

    // Without credentials — must NOT set the header
    const noCredResponse = handleCorsPreflight(request);
    expect(noCredResponse.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  // 7. withCors with credentials merges Allow-Credentials onto the response
  it("withCors with credentials: true adds Allow-Credentials without losing other headers", async () => {
    const request = makeRequest("https://advocatemcp.com");
    const original = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Custom": "keep" },
    });

    const wrapped = withCors(original, request, { credentials: true });

    expect(wrapped.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("https://advocatemcp.com");
    // Pre-existing headers preserved
    expect(wrapped.headers.get("Content-Type")).toBe("application/json");
    expect(wrapped.headers.get("X-Custom")).toBe("keep");
  });

  // 8. withCors preserves body, status, and statusText while adding headers
  it("withCors preserves body/status/statusText and adds CORS headers", async () => {
    const request = makeRequest("https://advocatemcp.com");

    // Construct a Response with a specific body, status, statusText, and a
    // pre-existing non-CORS header that should survive the wrapping
    const original = new Response(JSON.stringify({ ok: true, answer: 42 }), {
      status: 201,
      statusText: "Created",
      headers: {
        "Content-Type": "application/json",
        "X-Custom-Header": "preserved",
      },
    });

    const wrapped = withCors(original, request);

    // Status and statusText preserved
    expect(wrapped.status).toBe(201);
    expect(wrapped.statusText).toBe("Created");

    // Original non-CORS headers preserved
    expect(wrapped.headers.get("Content-Type")).toBe("application/json");
    expect(wrapped.headers.get("X-Custom-Header")).toBe("preserved");

    // CORS headers added
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("https://advocatemcp.com");
    expect(wrapped.headers.get("Vary")).toBe("Origin");

    // Body preserved
    const body = await wrapped.json() as { ok: boolean; answer: number };
    expect(body.ok).toBe(true);
    expect(body.answer).toBe(42);
  });
});
