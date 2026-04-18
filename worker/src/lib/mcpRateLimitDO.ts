/**
 * Durable Object rate limiter for the `/mcp` proxy (Session 3, v2).
 *
 * Upgrade from the in-memory per-isolate limiter at `mcpRateLimit.ts`:
 * every `/mcp` request routes to a single global DO instance, so rate
 * counters are globally coherent across all CF edge locations. Without
 * this, an attacker hitting N edge locations gets N × LIMIT; with it,
 * the per-IP cap is honored worldwide.
 *
 * Tradeoffs (accepted):
 *
 *   - All /mcp traffic hits one DO instance → adds 30–100ms of in-region
 *     routing latency per request. The MCP proxy already has 100–500ms
 *     of inherent latency (Railway + Claude) so this is a marginal add.
 *     If it ever becomes a problem, shard by IP prefix into N DOs.
 *
 *   - DO state is in-memory within the DO's lifetime, not persisted via
 *     the storage API. On DO hibernation (after ~30s idle) all counters
 *     reset. For sliding-window rate limiting this is fine — a freshly
 *     woken DO starts from zero and the first 60 reqs/min from any IP
 *     are allowed. The alternative (storage on every check) would add a
 *     blocking storage read/write to every request for negligible
 *     safety gain at v1 traffic volumes.
 *
 *   - Fail-open in the caller: if `env.MCP_RATE_LIMITER.fetch(...)`
 *     throws (DO outage, network blip, rollout), the caller proceeds
 *     without a rate-limit check and logs the miss. The alternative
 *     (fail-closed) would break `/mcp` entirely during any DO issue.
 *
 * The sliding-window algorithm itself is the same `McpRateLimiter` class
 * exercised by `mcpRateLimit.test.ts` — the DO is a thin singleton
 * wrapper, not a reimplementation. A DO outage falls back to the
 * in-memory limiter in the caller for best-effort enforcement.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { McpRateLimiter, type RateLimitDecision } from "./mcpRateLimit";

export class McpRateLimiterDO extends DurableObject<Env> {
  private readonly limiter = new McpRateLimiter();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/check" || request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    let body: { ip?: unknown };
    try {
      body = await request.json() as { ip?: unknown };
    } catch {
      return new Response(JSON.stringify({ error: "bad_json" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    const ip = typeof body.ip === "string" ? body.ip : "";
    const decision: RateLimitDecision = this.limiter.check(ip);
    return new Response(JSON.stringify(decision), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Resolve the single global DO stub. Using a fixed string id (rather than
 * `newUniqueId()`) means every Worker invocation in every region routes to
 * the SAME DO instance — that's the whole point of the upgrade.
 *
 * Returns `null` if the binding is absent (dev mode, missing config),
 * signalling the caller to fall back to the in-memory limiter rather than
 * blocking the request.
 */
export function getMcpRateLimiterStub(env: Env): DurableObjectStub<McpRateLimiterDO> | null {
  const ns = env.MCP_RATE_LIMITER;
  if (!ns) return null;
  const id = ns.idFromName("mcp-rate-limiter-v1");
  return ns.get(id) as unknown as DurableObjectStub<McpRateLimiterDO>;
}

/**
 * Ask the DO for a rate-limit decision. On any error — DO outage, network
 * hiccup, missing binding — return `null` so the caller can fail-open.
 * Never throws.
 */
export async function checkMcpRateLimit(env: Env, ip: string): Promise<RateLimitDecision | null> {
  const stub = getMcpRateLimiterStub(env);
  if (!stub) return null;
  try {
    const resp = await stub.fetch("https://mcp-rate-limiter/check", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ip }),
    });
    if (!resp.ok) return null;
    return await resp.json() as RateLimitDecision;
  } catch {
    return null;
  }
}
