import { describe, it, expect, vi, beforeEach } from "vitest";
import { trafficImpactPayload } from "./trafficImpactPayload";
import type { Env } from "../types";
import type { Business } from "../portalDb";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeBiz(overrides: Partial<Business> = {}): Business {
  return {
    id:            "biz_test_001",
    slug:          "acme",
    business_name: "Acme Corp",
    api_key:       "key_abc",
    created_at:    "2026-04-14T22:43:00Z",
    ...overrides,
  };
}

type D1PreparedStmt = {
  bind: (...args: unknown[]) => D1PreparedStmt;
  all:  <T = unknown>() => Promise<{ results: T[] }>;
  first:<T = unknown>() => Promise<T | null>;
  run:  () => Promise<unknown>;
};

/**
 * Build a minimal D1Database stub.
 * `rows` is an array of row objects for .all(); `connRow` is for the
 * ga4_connections .first() call (pass null to simulate no GA4 connection).
 */
function makeDb(rows: unknown[], connRow: unknown): D1Database {
  // Each .prepare() creates a new statement stub. The stub tracks the
  // SQL string so we can verify date-filter args if needed.
  let capturedBindArgs: unknown[] = [];

  const stmt: D1PreparedStmt = {
    bind(...args: unknown[]) {
      capturedBindArgs = args;
      return this;
    },
    async all<T = unknown>() {
      return { results: rows as T[] };
    },
    async first<T = unknown>() {
      return connRow as T | null;
    },
    async run() {
      return {};
    },
  };

  const db = {
    prepare(_sql: string) {
      return stmt;
    },
    // Expose the captured bind args so tests can inspect them.
    _lastBindArgs() { return capturedBindArgs; },
  } as unknown as D1Database & { _lastBindArgs: () => unknown[] };

  return db;
}

function makeEnv(db: D1Database): Env {
  return {
    DB:           db,
    BUSINESS_MAP: {} as KVNamespace,
    TENANT_DATA:  {} as KVNamespace,
  } as unknown as Env;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("trafficImpactPayload", () => {
  it("returns daily rows, bleed_at, and ga4_connected=true when GA4 row exists", async () => {
    const rows = [
      {
        date:                     "2026-05-01",
        ai_sessions:              42,
        human_sessions:           1234,
        total_sessions:           1276,
        top_sources_json:         JSON.stringify([{ source: "perplexity.ai", medium: "referral", sessions: 42 }]),
        engagement_rate:          0.62,
        avg_session_duration_sec: 145,
        bounce_rate:              0.38,
        new_users:                900,
        returning_users:          376,
      },
      {
        date:                     "2026-05-02",
        ai_sessions:              10,
        human_sessions:           500,
        total_sessions:           510,
        top_sources_json:         null,
        engagement_rate:          null,
        avg_session_duration_sec: null,
        bounce_rate:              null,
        new_users:                0,
        returning_users:          0,
      },
    ];

    const db  = makeDb(rows, { 1: 1 });  // GA4 row present
    const env = makeEnv(db);
    const biz = makeBiz();
    const url = new URL("https://customers.advocatemcp.com/api/client/traffic-impact?slug=acme");

    const payload = await trafficImpactPayload(env, biz, url);

    expect(payload.slug).toBe("acme");
    expect(payload.bleed_at).toBe("2026-04-14T22:43:00Z");
    expect(payload.ga4_connected).toBe(true);
    expect(payload.daily).toHaveLength(2);

    const first = payload.daily[0];
    expect(first.date).toBe("2026-05-01");
    expect(first.ai).toBe(42);
    expect(first.human).toBe(1234);
    expect(first.total).toBe(1276);
    expect(first.top_sources).toEqual([{ source: "perplexity.ai", medium: "referral", sessions: 42 }]);

    // New engagement columns are passed through.
    expect(first.engagement_rate).toBe(0.62);
    expect(first.avg_session_duration_sec).toBe(145);
    expect(first.bounce_rate).toBe(0.38);
    expect(first.new_users).toBe(900);
    expect(first.returning_users).toBe(376);

    // Null columns on row 2 pass through as null / 0.
    const second = payload.daily[1];
    expect(second.engagement_rate).toBeNull();
    expect(second.avg_session_duration_sec).toBeNull();
    expect(second.bounce_rate).toBeNull();
    expect(second.new_users).toBe(0);
    expect(second.returning_users).toBe(0);

    // Null top_sources_json becomes an empty array.
    expect(second.top_sources).toEqual([]);
  });

  it("returns daily=[] and ga4_connected=false for empty / disconnected state", async () => {
    const db  = makeDb([], null);  // no rows, no GA4 connection
    const env = makeEnv(db);
    const biz = makeBiz({ created_at: "2026-03-01T00:00:00Z" });
    const url = new URL("https://customers.advocatemcp.com/api/client/traffic-impact");

    const payload = await trafficImpactPayload(env, biz, url);

    expect(payload.daily).toEqual([]);
    expect(payload.ga4_connected).toBe(false);
    expect(payload.bleed_at).toBe("2026-03-01T00:00:00Z");
  });

  it("applies a cutoff date when range=7d is supplied", async () => {
    // We want to verify the correct cutoff DATE string is passed to D1.
    // Freeze time so the expected date is deterministic.
    const NOW = new Date("2026-05-06T12:00:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const capturedArgs: unknown[][] = [];
    const stmt = {
      bind(...args: unknown[]) {
        capturedArgs.push(args);
        return this;
      },
      async all<T = unknown>() { return { results: [] as T[] }; },
      async first<T = unknown>() { return null as T | null; },
    };
    const db  = { prepare: () => stmt } as unknown as D1Database;
    const env = makeEnv(db);
    const biz = makeBiz();
    const url = new URL("https://customers.advocatemcp.com/api/client/traffic-impact?range=7d");

    await trafficImpactPayload(env, biz, url);

    vi.restoreAllMocks();

    // First .bind() call is for the traffic_daily query.
    // args[0] = slug, args[1] = cutoff date string.
    const firstCall = capturedArgs[0];
    expect(firstCall[0]).toBe("acme");
    const cutoff = firstCall[1] as string;
    expect(cutoff).toBe("2026-04-29");  // 7 days before 2026-05-06
  });

  it("returns 404-ready null when biz has no created_at (bleed_at=null)", async () => {
    const db  = makeDb([], { 1: 1 });
    const env = makeEnv(db);
    // Business with no created_at (edge case: legacy row)
    const biz: Business = {
      id:            "biz_legacy",
      slug:          "legacy",
      business_name: "Legacy Co",
      api_key:       "key_xyz",
      created_at:    undefined as unknown as string,
    };
    const url = new URL("https://customers.advocatemcp.com/api/client/traffic-impact?slug=legacy");

    const payload = await trafficImpactPayload(env, biz, url);

    expect(payload.bleed_at).toBeNull();
    expect(payload.slug).toBe("legacy");
    expect(payload.ga4_connected).toBe(true);
  });
});
