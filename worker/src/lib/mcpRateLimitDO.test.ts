import { describe, it, expect, vi } from "vitest";
import { McpRateLimiterDO, checkMcpRateLimit } from "./mcpRateLimitDO.js";
import type { Env } from "../types";

/**
 * Unit tests for the DO wrapper. The sliding-window algorithm itself is
 * exercised by mcpRateLimit.test.ts — these tests cover the fetch()
 * handler's request parsing, response shape, and the caller-side fail-
 * open helper.
 *
 * A `DurableObjectState` + `Env` are required by the DurableObject
 * superclass constructor. We pass minimal stubs since neither is
 * accessed by this DO's fetch() handler.
 */

function newDO(): McpRateLimiterDO {
  const stateStub = {} as unknown as DurableObjectState;
  const envStub   = {} as unknown as Env;
  return new McpRateLimiterDO(stateStub, envStub);
}

describe("McpRateLimiterDO.fetch", () => {
  it("POST /check with { ip } returns an allowed decision on first hit", async () => {
    const doInstance = newDO();
    const resp = await doInstance.fetch(new Request("https://x/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ip: "1.2.3.4" }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { allowed: boolean; limit: number; remaining: number; retryAfter: number };
    expect(body.allowed).toBe(true);
    expect(body.remaining).toBeLessThan(body.limit);
    expect(body.retryAfter).toBe(0);
  });

  it("accumulates across requests — same DO instance counts every hit", async () => {
    const doInstance = newDO();
    const post = () => doInstance.fetch(new Request("https://x/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ip: "9.9.9.9" }),
    }));
    const first  = await (await post()).json() as { remaining: number };
    const second = await (await post()).json() as { remaining: number };
    expect(second.remaining).toBe(first.remaining - 1);
  });

  it("returns 404 for unknown paths", async () => {
    const doInstance = newDO();
    const resp = await doInstance.fetch(new Request("https://x/other", { method: "POST" }));
    expect(resp.status).toBe(404);
  });

  it("returns 404 for non-POST methods on /check", async () => {
    const doInstance = newDO();
    const resp = await doInstance.fetch(new Request("https://x/check", { method: "GET" }));
    expect(resp.status).toBe(404);
  });

  it("returns 400 bad_json when the body is not JSON", async () => {
    const doInstance = newDO();
    const resp = await doInstance.fetch(new Request("https://x/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:    "not-json",
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string };
    expect(body.error).toBe("bad_json");
  });

  it("treats a missing ip as an empty string (allowed but uncounted)", async () => {
    const doInstance = newDO();
    const resp = await doInstance.fetch(new Request("https://x/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({}),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { allowed: boolean; remaining: number; limit: number };
    expect(body.allowed).toBe(true);
    expect(body.remaining).toBe(body.limit);
  });
});

describe("checkMcpRateLimit", () => {
  it("returns null when MCP_RATE_LIMITER binding is missing (fail-open)", async () => {
    const env = {} as unknown as Env;
    const decision = await checkMcpRateLimit(env, "1.2.3.4");
    expect(decision).toBeNull();
  });

  it("returns the DO's decision when the stub fetch succeeds", async () => {
    const fakeDecision = { allowed: true, limit: 60, remaining: 59, retryAfter: 0 };
    const env = {
      MCP_RATE_LIMITER: {
        idFromName: (_name: string) => ({ toString: () => "id-abc" }),
        get: (_id: unknown) => ({
          fetch: vi.fn(async () => new Response(JSON.stringify(fakeDecision), { status: 200 })),
        }),
      },
    } as unknown as Env;

    const decision = await checkMcpRateLimit(env, "1.2.3.4");
    expect(decision).toEqual(fakeDecision);
  });

  it("returns null (fail-open) when the stub fetch throws", async () => {
    const env = {
      MCP_RATE_LIMITER: {
        idFromName: (_name: string) => ({ toString: () => "id-abc" }),
        get: (_id: unknown) => ({
          fetch: vi.fn(async () => { throw new Error("DO outage"); }),
        }),
      },
    } as unknown as Env;

    const decision = await checkMcpRateLimit(env, "1.2.3.4");
    expect(decision).toBeNull();
  });

  it("returns null (fail-open) when the stub returns a non-2xx response", async () => {
    const env = {
      MCP_RATE_LIMITER: {
        idFromName: (_name: string) => ({ toString: () => "id-abc" }),
        get: (_id: unknown) => ({
          fetch: vi.fn(async () => new Response("oops", { status: 500 })),
        }),
      },
    } as unknown as Env;

    const decision = await checkMcpRateLimit(env, "1.2.3.4");
    expect(decision).toBeNull();
  });

  it("uses a fixed DO id name so all invocations hit the same instance", async () => {
    let capturedName: string | null = null;
    const env = {
      MCP_RATE_LIMITER: {
        idFromName: (name: string) => { capturedName = name; return { toString: () => "id" }; },
        get: (_id: unknown) => ({
          fetch: vi.fn(async () => new Response(JSON.stringify({ allowed: true, limit: 60, remaining: 59, retryAfter: 0 }))),
        }),
      },
    } as unknown as Env;
    await checkMcpRateLimit(env, "1.1.1.1");
    await checkMcpRateLimit(env, "2.2.2.2");
    expect(capturedName).toBe("mcp-rate-limiter-v1");
  });
});
