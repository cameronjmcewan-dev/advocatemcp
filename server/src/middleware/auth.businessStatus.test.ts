/**
 * Tests for SOC 2 CC6.2/CC6.3 business_status enforcement added in
 * server/src/middleware/auth.ts (migration 038).
 *
 * Verifies all three Bearer-accepting middlewares fail-closed for blocked
 * statuses ('cancelled', 'suspended') and pass through for non-blocked
 * statuses ('active', 'cancelling', 'past_due', null/legacy).
 *
 * The fake DB now also covers the migration 039 CC6.1 dual-read path
 * (api_key_prefix lookup + api_key_hash verify). Test rows that want to
 * exercise the modern path supply api_key_hash + api_key_prefix; rows
 * with only `api_key` exercise the legacy plaintext fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { hashApiKey } from "../lib/apiKeyHash.js";

interface FakeRow {
  id: number;
  slug: string;
  api_key: string | null;
  api_key_hash: string | null;
  api_key_prefix: string | null;
  business_status: string | null;
}

const fake = new Map<string, FakeRow>();

function addRow(opts: {
  slug: string;
  rawKey: string;
  status: string | null;
  legacy?: boolean;
}): void {
  const id = fake.size + 1;
  if (opts.legacy) {
    fake.set(opts.slug, {
      id,
      slug: opts.slug,
      api_key: opts.rawKey,
      api_key_hash: null,
      api_key_prefix: null,
      business_status: opts.status,
    });
  } else {
    const { hash, prefix } = hashApiKey(opts.rawKey);
    fake.set(opts.slug, {
      id,
      slug: opts.slug,
      api_key: opts.rawKey, // still populated during the dual-read transition
      api_key_hash: hash,
      api_key_prefix: prefix,
      business_status: opts.status,
    });
  }
}

vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return {
    ...actual,
    getDb: () => ({
      prepare: (sql: string) => ({
        all: (...args: unknown[]) => {
          // resolveBusinessByApiKey hot path
          if (sql.includes("FROM businesses WHERE api_key_prefix = ?")) {
            const [prefix] = args as [string];
            return [...fake.values()].filter((r) => r.api_key_prefix === prefix);
          }
          return [];
        },
        get: (...args: unknown[]) => {
          // resolveBusinessByApiKey legacy fallback
          if (
            sql.includes("FROM businesses WHERE api_key = ? AND api_key_hash IS NULL")
          ) {
            const [key] = args as [string];
            for (const r of fake.values()) {
              if (r.api_key === key && r.api_key_hash === null) return r;
            }
            return undefined;
          }
          return undefined;
        },
        run: (...args: unknown[]) => {
          // opportunistic backfill in resolveBusinessByApiKey
          if (
            sql.includes("UPDATE businesses SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?")
          ) {
            const [hash, prefix, id] = args as [string, string, number];
            for (const r of fake.values()) {
              if (r.id === id) {
                r.api_key_hash = hash;
                r.api_key_prefix = prefix;
                return { changes: 1 };
              }
            }
            return { changes: 0 };
          }
          return { changes: 0 };
        },
      }),
    }),
  };
});

import {
  requireApiKey,
  requireSlugApiKey,
  requireSlugOrAdminKey,
} from "./auth.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/r/any", requireApiKey, (_req, res) => { res.json({ ok: true }); });
  app.get("/r/slug/:slug", requireSlugApiKey, (_req, res) => { res.json({ ok: true }); });
  app.get("/r/either/:slug", requireSlugOrAdminKey, (_req, res) => { res.json({ ok: true }); });
  return app;
}

describe("auth middleware — business_status enforcement", () => {
  beforeEach(() => {
    fake.clear();
    delete process.env.API_KEY;
  });

  afterEach(() => {
    delete process.env.API_KEY;
  });

  // ── requireApiKey ────────────────────────────────────────────────────────

  it("requireApiKey: 200 for active subscription (modern hash path)", async () => {
    addRow({ slug: "acme", rawKey: "k_active_modern_111111", status: "active" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_active_modern_111111");
    expect(res.status).toBe(200);
  });

  it("requireApiKey: 200 for legacy plaintext-only row", async () => {
    addRow({ slug: "legacy", rawKey: "k_legacy_22222222", status: "active", legacy: true });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_legacy_22222222");
    expect(res.status).toBe(200);
    // Backfill should have populated the hash columns.
    expect(fake.get("legacy")?.api_key_hash).not.toBeNull();
    expect(fake.get("legacy")?.api_key_prefix).toBe("k_legacy");
  });

  it("requireApiKey: 200 for null status (column default / pre-migration row)", async () => {
    addRow({ slug: "old", rawKey: "k_oldstatus_3333", status: null });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_oldstatus_3333");
    expect(res.status).toBe(200);
  });

  it("requireApiKey: 200 for cancelling (still within paid period)", async () => {
    addRow({ slug: "acme", rawKey: "k_canc_44444444", status: "cancelling" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_canc_44444444");
    expect(res.status).toBe(200);
  });

  it("requireApiKey: 200 for past_due", async () => {
    addRow({ slug: "acme", rawKey: "k_pd_55555555", status: "past_due" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_pd_55555555");
    expect(res.status).toBe(200);
  });

  it("requireApiKey: 401 subscription_inactive for cancelled status", async () => {
    addRow({ slug: "acme", rawKey: "k_cx_66666666", status: "cancelled" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_cx_66666666");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("subscription_inactive");
  });

  it("requireApiKey: 401 subscription_inactive for suspended status", async () => {
    addRow({ slug: "acme", rawKey: "k_sus_77777777", status: "suspended" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_sus_77777777");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("subscription_inactive");
  });

  it("requireApiKey: 401 for an unknown key", async () => {
    addRow({ slug: "acme", rawKey: "k_real_88888888", status: "active" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_unknown_99999999");
    expect(res.status).toBe(401);
  });

  it("requireApiKey: 401 if the prefix collides but the hash does not verify", async () => {
    // Two keys with the same 8-char prefix; the verifier should reject the impostor.
    addRow({ slug: "acme", rawKey: "k_match_11", status: "active" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_match_zz");
    expect(res.status).toBe(401);
  });

  it("requireApiKey: server admin key bypasses the status check entirely", async () => {
    process.env.API_KEY = "server-admin-key";
    const res = await request(makeApp()).get("/r/any").set("X-API-Key", "server-admin-key");
    expect(res.status).toBe(200);
  });

  // ── requireSlugApiKey ───────────────────────────────────────────────────

  it("requireSlugApiKey: 200 for active", async () => {
    addRow({ slug: "acme", rawKey: "k_slug_aa11", status: "active" });
    const res = await request(makeApp()).get("/r/slug/acme").set("Authorization", "Bearer k_slug_aa11");
    expect(res.status).toBe(200);
  });

  it("requireSlugApiKey: 401 when the key matches but for a DIFFERENT slug (no privilege escalation)", async () => {
    addRow({ slug: "acme", rawKey: "k_acme_aa22", status: "active" });
    addRow({ slug: "beta", rawKey: "k_beta_bb22", status: "active" });
    const res = await request(makeApp()).get("/r/slug/beta").set("Authorization", "Bearer k_acme_aa22");
    expect(res.status).toBe(401);
  });

  it("requireSlugApiKey: 401 subscription_inactive for cancelled", async () => {
    addRow({ slug: "acme", rawKey: "k_slug_aa33", status: "cancelled" });
    const res = await request(makeApp()).get("/r/slug/acme").set("Authorization", "Bearer k_slug_aa33");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("subscription_inactive");
  });

  // ── requireSlugOrAdminKey ───────────────────────────────────────────────

  it("requireSlugOrAdminKey: 200 for active tenant Bearer", async () => {
    addRow({ slug: "acme", rawKey: "k_either_11", status: "active" });
    const res = await request(makeApp()).get("/r/either/acme").set("Authorization", "Bearer k_either_11");
    expect(res.status).toBe(200);
  });

  it("requireSlugOrAdminKey: 401 for cancelled tenant Bearer", async () => {
    addRow({ slug: "acme", rawKey: "k_either_22", status: "cancelled" });
    const res = await request(makeApp()).get("/r/either/acme").set("Authorization", "Bearer k_either_22");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("subscription_inactive");
  });

  it("requireSlugOrAdminKey: admin X-API-Key bypasses status check", async () => {
    process.env.API_KEY = "server-admin-key";
    addRow({ slug: "acme", rawKey: "k_unused_xx", status: "cancelled" });
    const res = await request(makeApp()).get("/r/either/acme").set("X-API-Key", "server-admin-key");
    expect(res.status).toBe(200);
  });

  it("requireSlugOrAdminKey: 401 for legacy key with mismatched slug", async () => {
    addRow({ slug: "acme", rawKey: "k_legacy_aa", status: "active", legacy: true });
    const res = await request(makeApp()).get("/r/either/beta").set("Authorization", "Bearer k_legacy_aa");
    expect(res.status).toBe(401);
  });
});
