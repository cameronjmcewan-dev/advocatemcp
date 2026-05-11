/**
 * Tests for the audit_events helper (worker/src/lib/auditLog.ts).
 *
 * Verifies:
 *   - recordAuditEvent emits a single parameterised INSERT with the
 *     expected column ordering.
 *   - JSON-serialisation of metadata happens at the helper; the caller
 *     passes a plain object, the row carries a string.
 *   - Audit writes are swallowed on D1 failure (never throw).
 *   - hashClientIp produces a 64-char hex SHA-256 and the same input
 *     yields the same output (deterministic).
 *   - hashClientIp returns null for null / undefined.
 *   - clientIpFromRequest prefers CF-Connecting-IP, falls back to XFF.
 *   - requestIdFromRequest returns the CF-Ray header.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recordAuditEvent,
  hashClientIp,
  clientIpFromRequest,
  requestIdFromRequest,
} from "./auditLog";

interface CapturedBind {
  sql: string;
  params: unknown[];
}

function createCapturingDb(opts: { throwOnRun?: boolean } = {}): {
  db: D1Database;
  captured: CapturedBind[];
} {
  const captured: CapturedBind[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (opts.throwOnRun) throw new Error("d1 simulated failure");
              captured.push({ sql, params });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, captured };
}

describe("recordAuditEvent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts one row with parameterised columns in the expected order", async () => {
    const { db, captured } = createCapturingDb();
    await recordAuditEvent(db, {
      actorType: "user",
      actorId: "u_abc",
      eventType: "auth.login_success",
      targetType: "session",
      targetId: "s_xyz",
      metadata: { role: "admin", tenant_id: null },
      ipHash: "deadbeef",
      requestId: "ray_123",
    });
    expect(captured).toHaveLength(1);
    const row = captured[0];
    expect(row.sql).toContain("INSERT INTO audit_events");
    // Column order: id, occurred_at, actor_type, actor_id, event_type,
    // target_type, target_id, metadata_json, ip_hash, request_id.
    expect(row.params).toHaveLength(10);
    expect(typeof row.params[0]).toBe("string");           // id
    expect(typeof row.params[1]).toBe("string");           // occurred_at ISO
    expect(row.params[2]).toBe("user");
    expect(row.params[3]).toBe("u_abc");
    expect(row.params[4]).toBe("auth.login_success");
    expect(row.params[5]).toBe("session");
    expect(row.params[6]).toBe("s_xyz");
    expect(JSON.parse(row.params[7] as string)).toEqual({ role: "admin", tenant_id: null });
    expect(row.params[8]).toBe("deadbeef");
    expect(row.params[9]).toBe("ray_123");
  });

  it("passes null metadata through as null (not the literal string 'null')", async () => {
    const { db, captured } = createCapturingDb();
    await recordAuditEvent(db, {
      actorType: "system",
      eventType: "system.boot",
    });
    expect(captured[0].params[7]).toBeNull();
    // Optional fields default to null
    expect(captured[0].params[3]).toBeNull();   // actor_id
    expect(captured[0].params[5]).toBeNull();   // target_type
    expect(captured[0].params[6]).toBeNull();   // target_id
    expect(captured[0].params[8]).toBeNull();   // ip_hash
    expect(captured[0].params[9]).toBeNull();   // request_id
  });

  it("never throws even when the D1 INSERT fails — failures must not block the caller", async () => {
    const { db } = createCapturingDb({ throwOnRun: true });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      recordAuditEvent(db, { actorType: "system", eventType: "system.test_failure" }),
    ).resolves.toBeUndefined();
    expect(consoleErr).toHaveBeenCalled();
    const payload = JSON.parse(consoleErr.mock.calls[0][0] as string);
    expect(payload.event).toBe("audit_event_write_failed");
    expect(payload.attempted_event).toBe("system.test_failure");
  });

  it("drops metadata and still inserts the row when metadata is unserialisable", async () => {
    const { db, captured } = createCapturingDb();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await recordAuditEvent(db, {
      actorType: "system",
      eventType: "system.cyclic_meta",
      metadata: cyclic,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].params[7]).toBeNull();
    expect(consoleErr).toHaveBeenCalled();
    const payload = JSON.parse(consoleErr.mock.calls[0][0] as string);
    expect(payload.event).toBe("audit_event_metadata_unserialisable");
  });
});

describe("hashClientIp", () => {
  it("returns a 64-char hex SHA-256 for a non-empty input", async () => {
    const hex = await hashClientIp("203.0.113.42");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input → same output", async () => {
    const a = await hashClientIp("198.51.100.7");
    const b = await hashClientIp("198.51.100.7");
    expect(a).toBe(b);
  });

  it("returns null for null / undefined / empty string", async () => {
    expect(await hashClientIp(null)).toBeNull();
    expect(await hashClientIp(undefined)).toBeNull();
    expect(await hashClientIp("")).toBeNull();
  });
});

describe("clientIpFromRequest", () => {
  it("prefers CF-Connecting-IP", () => {
    const req = new Request("https://example.com", {
      headers: { "CF-Connecting-IP": "203.0.113.1", "X-Forwarded-For": "203.0.113.99" },
    });
    expect(clientIpFromRequest(req)).toBe("203.0.113.1");
  });

  it("falls back to the leftmost X-Forwarded-For entry", () => {
    const req = new Request("https://example.com", {
      headers: { "X-Forwarded-For": "203.0.113.5, 10.0.0.1" },
    });
    expect(clientIpFromRequest(req)).toBe("203.0.113.5");
  });

  it("returns null when neither header is present", () => {
    const req = new Request("https://example.com");
    expect(clientIpFromRequest(req)).toBeNull();
  });
});

describe("requestIdFromRequest", () => {
  it("returns the CF-Ray header", () => {
    const req = new Request("https://example.com", { headers: { "CF-Ray": "8abc-LHR" } });
    expect(requestIdFromRequest(req)).toBe("8abc-LHR");
  });

  it("returns null when CF-Ray is absent", () => {
    const req = new Request("https://example.com");
    expect(requestIdFromRequest(req)).toBeNull();
  });
});
