/**
 * Tests for invalidateBotCache — best-effort server → worker callback
 * that bumps the per-slug cache version after profile / location
 * mutations. The contract is "never fails the parent request"; these
 * tests verify the failure-mode shapes don't leak as exceptions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invalidateBotCache } from "./botCacheInvalidation.js";

describe("invalidateBotCache", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: NodeJS.ProcessEnv;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("skips with a structured warning when SERVER_API_KEY is unset", async () => {
    delete process.env.API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;

    await invalidateBotCache("advocate");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const logCall = warnSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(logCall)).toMatchObject({
      bot_cache_invalidation: true,
      event: "skipped_no_server_key",
      slug: "advocate",
    });
  });

  it("calls the worker bump endpoint with X-API-Key + slug query param", async () => {
    process.env.API_KEY = "server-secret-key";
    process.env.WORKER_BASE_URL = "https://customers.example.com";
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ slug: "advocate", new_version: "vXYZ" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    globalThis.fetch = fetchMock as never;

    await invalidateBotCache("advocate");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe("https://customers.example.com/admin/cache/bump-version?slug=advocate");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("server-secret-key");

    // Success path logs at info level.
    expect(logSpy).toHaveBeenCalled();
    const successLog = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(successLog.event).toBe("bump_success");
    expect(successLog.new_version).toBe("vXYZ");
  });

  it("does NOT throw when the worker returns 5xx", async () => {
    process.env.API_KEY = "k";
    const fetchMock = vi.fn(async () => new Response("oops", { status: 502 }));
    globalThis.fetch = fetchMock as never;

    await expect(invalidateBotCache("advocate")).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    const warnPayload = JSON.parse(warnSpy.mock.calls[0]![0] as string);
    expect(warnPayload.event).toBe("bump_failed");
    expect(warnPayload.status).toBe(502);
  });

  it("does NOT throw when the worker fetch rejects", async () => {
    process.env.API_KEY = "k";
    globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as never;

    await expect(invalidateBotCache("advocate")).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    const warnPayload = JSON.parse(warnSpy.mock.calls[0]![0] as string);
    expect(warnPayload.event).toBe("bump_error");
    expect(warnPayload.error).toContain("network down");
  });

  it("URL-encodes the slug to defend against path-injection", async () => {
    process.env.API_KEY = "k";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as never;

    // Injection attempt — should land in the query string, encoded.
    await invalidateBotCache("ad/vocate?evil=1");

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("?slug=ad%2Fvocate%3Fevil%3D1");
  });
});
