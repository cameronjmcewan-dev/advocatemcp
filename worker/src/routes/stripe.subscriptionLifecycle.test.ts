/**
 * Tests for the SOC 2 CC6.2 subscription-lifecycle handlers added in
 * worker/src/routes/stripe.ts:
 *
 *   - handleSubscriptionDeleted
 *   - handleSubscriptionUpdated
 *   - handleInvoicePaymentFailed
 *
 * Each handler must:
 *   1. Resolve the business row from stripe_subscription_id (or
 *      stripe_customer_id, for invoice events).
 *   2. Update business_status when the Stripe state warrants it.
 *   3. Write exactly one audit_events row.
 *
 * Mocks @sentry/cloudflare via vi.mock so captureException / captureMessage
 * don't fire real network calls during tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import {
  handleSubscriptionDeleted,
  handleSubscriptionUpdated,
  handleInvoicePaymentFailed,
} from "./stripe";
import type { Env } from "../types";

// ── Fake D1 — supports the SELECT + UPDATE businesses + INSERT audit_events
// shape that the handlers emit. Reuses the normalised SQL approach from
// stripe.test.ts.

interface FakeBusinessRow {
  id: string;
  slug: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  business_status: string;
}

interface CapturedAuditRow {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  event_type: string;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string | null;
  ip_hash: string | null;
  request_id: string | null;
}

function createFakeDb(initial: Partial<FakeBusinessRow>[] = []): {
  db: D1Database;
  businesses: Map<string, FakeBusinessRow>;
  auditRows: CapturedAuditRow[];
} {
  const businesses = new Map<string, FakeBusinessRow>();
  for (const row of initial) {
    if (!row.slug) continue;
    businesses.set(row.slug, {
      id: row.id ?? `biz_${row.slug}`,
      slug: row.slug,
      stripe_subscription_id: row.stripe_subscription_id ?? null,
      stripe_customer_id: row.stripe_customer_id ?? null,
      business_status: row.business_status ?? "active",
    });
  }
  const auditRows: CapturedAuditRow[] = [];

  const db = {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              // findBusinessBySubscriptionId
              if (
                normalized.startsWith("SELECT id, slug, business_status FROM businesses") &&
                normalized.includes("WHERE stripe_subscription_id = ?")
              ) {
                const target = params[0] as string;
                for (const row of businesses.values()) {
                  if (row.stripe_subscription_id === target) {
                    return {
                      id: row.id,
                      slug: row.slug,
                      business_status: row.business_status,
                    } as unknown as T;
                  }
                }
                return null;
              }
              // findBusinessByCustomerId
              if (
                normalized.startsWith("SELECT id, slug, business_status FROM businesses") &&
                normalized.includes("WHERE stripe_customer_id = ?")
              ) {
                const target = params[0] as string;
                for (const row of businesses.values()) {
                  if (row.stripe_customer_id === target) {
                    return {
                      id: row.id,
                      slug: row.slug,
                      business_status: row.business_status,
                    } as unknown as T;
                  }
                }
                return null;
              }
              return null;
            },
            async run() {
              // updateBusinessStatus
              if (
                normalized.startsWith("UPDATE businesses") &&
                normalized.includes("SET business_status") &&
                normalized.includes("status_changed_at")
              ) {
                const [newStatus, _changedAt, slug] = params as [string, string, string];
                const row = businesses.get(slug);
                if (row) row.business_status = newStatus;
                return { meta: { changes: row ? 1 : 0 } };
              }
              // audit_events INSERT
              if (normalized.startsWith("INSERT INTO audit_events")) {
                const [
                  id, occurred_at, actor_type, actor_id, event_type,
                  target_type, target_id, metadata_json, ip_hash, request_id,
                ] = params as string[];
                auditRows.push({
                  id, occurred_at,
                  actor_type, actor_id: actor_id ?? null,
                  event_type,
                  target_type: target_type ?? null,
                  target_id: target_id ?? null,
                  metadata_json: metadata_json ?? null,
                  ip_hash: ip_hash ?? null,
                  request_id: request_id ?? null,
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return { db, businesses, auditRows };
}

function makeEnv(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

describe("handleSubscriptionDeleted", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("marks the matched business cancelled and records one audit row", async () => {
    const { db, businesses, auditRows } = createFakeDb([
      {
        slug: "acme",
        stripe_subscription_id: "sub_123",
        stripe_customer_id: "cus_123",
        business_status: "active",
      },
    ]);
    await handleSubscriptionDeleted(
      makeEnv(db),
      { id: "sub_123", customer: "cus_123" },
      "evt_test_1",
      "ray_test_1",
    );
    expect(businesses.get("acme")?.business_status).toBe("cancelled");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].event_type).toBe("stripe.subscription_deleted");
    expect(auditRows[0].actor_type).toBe("stripe");
    expect(auditRows[0].actor_id).toBe("evt_test_1");
    expect(auditRows[0].target_type).toBe("business");
    expect(auditRows[0].target_id).toBe("acme");
    expect(auditRows[0].request_id).toBe("ray_test_1");
    const meta = JSON.parse(auditRows[0].metadata_json!);
    expect(meta.subscription_id).toBe("sub_123");
    expect(meta.previous_status).toBe("active");
    expect(meta.new_status).toBe("cancelled");
  });

  it("writes a `_unmatched` audit row when no business matches the subscription", async () => {
    const { db, businesses, auditRows } = createFakeDb([]);
    await handleSubscriptionDeleted(
      makeEnv(db),
      { id: "sub_unknown", customer: "cus_unknown" },
      "evt_test_2",
      null,
    );
    expect(businesses.size).toBe(0);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].event_type).toBe("stripe.subscription_deleted_unmatched");
    expect(auditRows[0].target_type).toBe("stripe_subscription");
    expect(auditRows[0].target_id).toBe("sub_unknown");
  });

  it("logs and bails (no audit row) when the subscription has no id", async () => {
    const { db, auditRows } = createFakeDb([]);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await handleSubscriptionDeleted(makeEnv(db), {}, "evt_test_3", null);
    expect(auditRows).toHaveLength(0);
    expect(consoleWarn).toHaveBeenCalled();
  });
});

describe("handleSubscriptionUpdated", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("transitions active+cancel_at_period_end → cancelling", async () => {
    const { db, businesses, auditRows } = createFakeDb([
      { slug: "acme", stripe_subscription_id: "sub_a", business_status: "active" },
    ]);
    await handleSubscriptionUpdated(
      makeEnv(db),
      { id: "sub_a", status: "active", cancel_at_period_end: true },
      "evt_u_1",
      null,
    );
    expect(businesses.get("acme")?.business_status).toBe("cancelling");
    expect(auditRows[0].event_type).toBe("stripe.subscription_updated");
    expect(JSON.parse(auditRows[0].metadata_json!).new_status).toBe("cancelling");
  });

  it("transitions past_due → past_due and records the audit", async () => {
    const { db, businesses, auditRows } = createFakeDb([
      { slug: "beta", stripe_subscription_id: "sub_b", business_status: "active" },
    ]);
    await handleSubscriptionUpdated(
      makeEnv(db),
      { id: "sub_b", status: "past_due", cancel_at_period_end: false },
      "evt_u_2",
      null,
    );
    expect(businesses.get("beta")?.business_status).toBe("past_due");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].event_type).toBe("stripe.subscription_updated");
  });

  it("does NOT write an audit row when the status is unchanged", async () => {
    const { db, businesses, auditRows } = createFakeDb([
      { slug: "gamma", stripe_subscription_id: "sub_g", business_status: "active" },
    ]);
    await handleSubscriptionUpdated(
      makeEnv(db),
      { id: "sub_g", status: "active", cancel_at_period_end: false },
      "evt_u_3",
      null,
    );
    expect(businesses.get("gamma")?.business_status).toBe("active");
    expect(auditRows).toHaveLength(0);
  });

  it("writes a `_unmatched` audit row when no business matches", async () => {
    const { db, auditRows } = createFakeDb([]);
    await handleSubscriptionUpdated(
      makeEnv(db),
      { id: "sub_orphan", status: "active", cancel_at_period_end: false },
      "evt_u_4",
      null,
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].event_type).toBe("stripe.subscription_updated_unmatched");
  });
});

describe("handleInvoicePaymentFailed", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("writes one audit row when the subscription matches a business", async () => {
    const { db, businesses, auditRows } = createFakeDb([
      {
        slug: "delta",
        stripe_subscription_id: "sub_d",
        stripe_customer_id: "cus_d",
        business_status: "active",
      },
    ]);
    await handleInvoicePaymentFailed(
      makeEnv(db),
      { subscription: "sub_d", customer: "cus_d", attempt_count: 1 },
      "evt_i_1",
      "ray_i_1",
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].event_type).toBe("stripe.invoice_payment_failed");
    expect(auditRows[0].target_type).toBe("business");
    expect(auditRows[0].target_id).toBe("delta");
    // Handler does not auto-suspend; subscription.updated handles state.
    expect(businesses.get("delta")?.business_status).toBe("active");
  });

  it("falls back to stripe_customer_id when subscription_id does not match", async () => {
    const { db, auditRows } = createFakeDb([
      {
        slug: "epsilon",
        stripe_subscription_id: "sub_old",
        stripe_customer_id: "cus_e",
        business_status: "active",
      },
    ]);
    await handleInvoicePaymentFailed(
      makeEnv(db),
      { subscription: "sub_new", customer: "cus_e", attempt_count: 2 },
      "evt_i_2",
      null,
    );
    expect(auditRows[0].event_type).toBe("stripe.invoice_payment_failed");
    expect(auditRows[0].target_id).toBe("epsilon");
  });

  it("writes `_unmatched` event when neither id matches", async () => {
    const { db, auditRows } = createFakeDb([]);
    await handleInvoicePaymentFailed(
      makeEnv(db),
      { subscription: "sub_x", customer: "cus_x", attempt_count: 1 },
      "evt_i_3",
      null,
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].event_type).toBe("stripe.invoice_payment_failed_unmatched");
  });
});
