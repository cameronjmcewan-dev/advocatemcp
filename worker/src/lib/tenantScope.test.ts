/**
 * Tests for the SOC 2 H1 tenant-scope helpers in tenantScope.ts.
 *
 * Two helpers under test:
 *   - resolveTenantScope: full resolve with 403/audit/impersonation matrix.
 *   - auditAdminImpersonation: thin one-liner for the legacy
 *     `(slug ? businesses.find ...) ?? businesses[0]` pattern in portal.ts.
 *
 * The fake D1 stubs the SQL surface getActiveBusinesses + getUserBusinesses
 * issue, plus the audit_events INSERT.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveTenantScope, auditAdminImpersonation } from "./tenantScope";
import type { AuthContext } from "../routes/authApi";

interface FakeBusiness {
  id: string;
  slug: string;
  business_name: string;
  api_key: string;
  created_at: string;
}

interface FakeStore {
  /** Every business that exists, keyed by slug. */
  active: Map<string, FakeBusiness>;
  /** Slugs each user is granted access to via user_business_access. */
  userAccess: Map<string, Set<string>>;
  /** event_type values from each audit_events INSERT. */
  audit: { event_type: string; target_id: string | null; metadata: unknown }[];
}

function biz(slug: string): FakeBusiness {
  return {
    id: `biz_${slug}`,
    slug,
    business_name: `${slug.charAt(0).toUpperCase()}${slug.slice(1)} Inc`,
    api_key: `key_${slug}`,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeDb(store: FakeStore): D1Database {
  return {
    prepare(sql: string) {
      const norm = sql.replace(/\s+/g, " ").trim();

      const runAll = (params: unknown[]) => {
        // getActiveBusinesses (no .bind, fixed string)
        if (
          norm.includes("FROM businesses") &&
          norm.includes("api_key != 'pending'") &&
          !norm.includes("user_business_access")
        ) {
          return { results: [...store.active.values()] };
        }
        // getUserBusinesses (.bind(userId))
        if (
          norm.includes("FROM businesses b") &&
          norm.includes("JOIN user_business_access uba")
        ) {
          const userId = params[0] as string;
          const allowed = store.userAccess.get(userId) ?? new Set();
          return {
            results: [...store.active.values()].filter((b) => allowed.has(b.slug)),
          };
        }
        return { results: [] };
      };

      const runRun = (params: unknown[]) => {
        if (norm.startsWith("INSERT INTO audit_events")) {
          store.audit.push({
            event_type: params[4] as string,
            target_id: (params[6] as string) ?? null,
            metadata: params[7] ? JSON.parse(params[7] as string) : null,
          });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      };

      return {
        // .prepare(sql).all() — getActiveBusinesses path (no params)
        async all() { return runAll([]); },
        bind(...params: unknown[]) {
          return {
            async first<T>() { return null as T | null; },
            async all() { return runAll(params); },
            async run() { return runRun(params); },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeEnv(db: D1Database) {
  return { DB: db } as unknown as Parameters<typeof resolveTenantScope>[2];
}

function makeCtx(opts: { user_id: string; role: "admin" | "client" }): AuthContext {
  return {
    user_id: opts.user_id,
    email: `${opts.user_id}@example.com`,
    full_name: opts.user_id,
    role: opts.role,
    tenant_id: null,
    email_verified: 1,
    auth_method: "bearer",
  };
}

function req(url: string): Request {
  return new Request(url, { method: "GET" });
}

function emptyStore(): FakeStore {
  return { active: new Map(), userAccess: new Map(), audit: [] };
}

function seed(store: FakeStore, opts: {
  active: string[];
  access: Record<string, string[]>;
}) {
  for (const slug of opts.active) store.active.set(slug, biz(slug));
  for (const [user, slugs] of Object.entries(opts.access)) {
    store.userAccess.set(user, new Set(slugs));
  }
}

describe("resolveTenantScope", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("non-admin, no slug supplied -> picks their first business", async () => {
    const store = emptyStore();
    seed(store, { active: ["acme", "beta"], access: { u1: ["acme"] } });
    const r = await resolveTenantScope(
      makeCtx({ user_id: "u1", role: "client" }),
      req("https://x/api/client/metrics"),
      makeEnv(makeDb(store)),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.business.slug).toBe("acme");
    expect(store.audit).toHaveLength(0);
  });

  it("non-admin, no businesses -> 404 no_business", async () => {
    const store = emptyStore();
    seed(store, { active: ["other"], access: { u1: [] } });
    const r = await resolveTenantScope(
      makeCtx({ user_id: "u1", role: "client" }),
      req("https://x/api/client/metrics"),
      makeEnv(makeDb(store)),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.resp.status).toBe(404);
  });

  it("non-admin, supplied unauthorised slug -> 403 forbidden_slug", async () => {
    const store = emptyStore();
    seed(store, { active: ["acme", "other"], access: { u1: ["acme"] } });
    const r = await resolveTenantScope(
      makeCtx({ user_id: "u1", role: "client" }),
      req("https://x/api/client/metrics?slug=other"),
      makeEnv(makeDb(store)),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.resp.status).toBe(403);
      const body = await r.resp.json() as { error_code?: string };
      expect(body.error_code).toBe("forbidden_slug");
    }
    expect(store.audit).toHaveLength(0);
  });

  it("non-admin, supplied authorised slug -> uses that one, no audit", async () => {
    const store = emptyStore();
    seed(store, { active: ["acme", "beta"], access: { u1: ["acme", "beta"] } });
    const r = await resolveTenantScope(
      makeCtx({ user_id: "u1", role: "client" }),
      req("https://x/api/client/metrics?slug=beta"),
      makeEnv(makeDb(store)),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.business.slug).toBe("beta");
      expect(r.impersonating).toBe(false);
    }
    expect(store.audit).toHaveLength(0);
  });

  it("admin, supplied slug they OWN -> uses it, no audit", async () => {
    const store = emptyStore();
    seed(store, {
      active: ["acme", "other"],
      access: { admin1: ["acme"] },
    });
    const r = await resolveTenantScope(
      makeCtx({ user_id: "admin1", role: "admin" }),
      req("https://x/api/client/metrics?slug=acme"),
      makeEnv(makeDb(store)),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.business.slug).toBe("acme");
      expect(r.impersonating).toBe(false);
    }
    expect(store.audit).toHaveLength(0);
  });

  it("admin, supplied slug they DO NOT own -> uses it + writes audit row", async () => {
    const store = emptyStore();
    seed(store, {
      active: ["acme", "other"],
      access: { admin1: ["acme"] },
    });
    const r = await resolveTenantScope(
      makeCtx({ user_id: "admin1", role: "admin" }),
      req("https://x/api/client/profile?slug=other"),
      makeEnv(makeDb(store)),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.business.slug).toBe("other");
      expect(r.impersonating).toBe(true);
    }
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0].event_type).toBe("auth.tenant_impersonation");
    expect(store.audit[0].target_id).toBe("other");
    const meta = store.audit[0].metadata as Record<string, unknown>;
    expect(meta.method).toBe("GET");
    expect(meta.path).toBe("/api/client/profile");
    expect(meta.admin_email).toBe("admin1@example.com");
    expect(meta.owned_slugs).toEqual(["acme"]);
  });

  it("admin, slug not in active set at all -> 404", async () => {
    const store = emptyStore();
    seed(store, { active: ["acme"], access: { admin1: ["acme"] } });
    const r = await resolveTenantScope(
      makeCtx({ user_id: "admin1", role: "admin" }),
      req("https://x/api/client/metrics?slug=nonexistent"),
      makeEnv(makeDb(store)),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.resp.status).toBe(404);
    expect(store.audit).toHaveLength(0);
  });

  it("admin, no slug supplied -> picks their own first business", async () => {
    const store = emptyStore();
    seed(store, {
      active: ["acme", "beta", "gamma"],
      access: { admin1: ["acme"] },
    });
    const r = await resolveTenantScope(
      makeCtx({ user_id: "admin1", role: "admin" }),
      req("https://x/api/client/metrics"),
      makeEnv(makeDb(store)),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.business.slug).toBe("acme");
      expect(r.impersonating).toBe(false);
    }
    expect(store.audit).toHaveLength(0);
  });

  it("admin with no own businesses + no slug -> first active business as fallback", async () => {
    const store = emptyStore();
    seed(store, {
      active: ["acme", "beta"],
      access: { admin1: [] },
    });
    const r = await resolveTenantScope(
      makeCtx({ user_id: "admin1", role: "admin" }),
      req("https://x/api/client/metrics"),
      makeEnv(makeDb(store)),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.business.slug).toBe("acme");
      // No slug supplied so this isn't impersonation — it's the dashboard
      // showing the first available business to a freshly-promoted admin.
      expect(r.impersonating).toBe(false);
    }
  });
});

describe("auditAdminImpersonation", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("non-admin role -> no-op, returns false", async () => {
    const store = emptyStore();
    const ok = await auditAdminImpersonation(
      makeCtx({ user_id: "u1", role: "client" }),
      req("https://x/api/client/profile?slug=other"),
      makeEnv(makeDb(store)),
      "other",
    );
    expect(ok).toBe(false);
    expect(store.audit).toHaveLength(0);
  });

  it("admin acting on a tenant they OWN -> no-op, returns false", async () => {
    const store = emptyStore();
    seed(store, { active: ["acme"], access: { admin1: ["acme"] } });
    const ok = await auditAdminImpersonation(
      makeCtx({ user_id: "admin1", role: "admin" }),
      req("https://x/api/client/metrics?slug=acme"),
      makeEnv(makeDb(store)),
      "acme",
    );
    expect(ok).toBe(false);
    expect(store.audit).toHaveLength(0);
  });

  it("admin acting on a tenant outside their own access -> writes audit + returns true", async () => {
    const store = emptyStore();
    seed(store, { active: ["acme", "other"], access: { admin1: ["acme"] } });
    const ok = await auditAdminImpersonation(
      makeCtx({ user_id: "admin1", role: "admin" }),
      req("https://x/api/client/profile?slug=other"),
      makeEnv(makeDb(store)),
      "other",
    );
    expect(ok).toBe(true);
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0].event_type).toBe("auth.tenant_impersonation");
    expect(store.audit[0].target_id).toBe("other");
    const meta = store.audit[0].metadata as Record<string, unknown>;
    expect(meta.method).toBe("GET");
    expect(meta.path).toBe("/api/client/profile");
    expect(meta.admin_email).toBe("admin1@example.com");
  });
});
