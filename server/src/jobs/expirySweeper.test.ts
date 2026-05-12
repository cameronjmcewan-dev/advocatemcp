import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { sweepExpiredReservations, redactStalePii, startPiiSweepSchedule } from "./expirySweeper.js";

function seed(db: Database.Database, rows: Array<{ id: string; status: string; expires_at: number; window_end?: number; contact?: string | null }>) {
  const stmt = db.prepare(`
    INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
      status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
    VALUES (?, 'x', 0, 0, ?, ?, 't', ?, ?, ?)
  `);
  for (const r of rows) stmt.run(
    r.id,
    r.window_end ?? 0,
    r.status,
    r.contact === undefined ? '{"name":"Alice","email":"a@x.com"}' : r.contact,
    r.id + "-key",
    r.expires_at,
  );
}

describe("sweepExpiredReservations", () => {
  it("flips held rows whose expires_at is in the past", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const past = Math.floor(Date.now()/1000) - 10;
    const future = Math.floor(Date.now()/1000) + 10000;
    seed(db, [
      { id: "r1", status: "held", expires_at: past },
      { id: "r2", status: "held", expires_at: future },
      { id: "r3", status: "confirmed", expires_at: past },
    ]);
    const n = sweepExpiredReservations(db);
    expect(n).toBe(1);
    const r1 = db.prepare("SELECT status FROM reservations WHERE id='r1'").get() as { status: string };
    expect(r1.status).toBe("expired");
    const r2 = db.prepare("SELECT status FROM reservations WHERE id='r2'").get() as { status: string };
    expect(r2.status).toBe("held");
    const r3 = db.prepare("SELECT status FROM reservations WHERE id='r3'").get() as { status: string };
    expect(r3.status).toBe("confirmed");
  });

  it("returns 0 and makes no writes when nothing is stale", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    seed(db, [{ id: "r1", status: "held", expires_at: Math.floor(Date.now()/1000) + 1000 }]);
    expect(sweepExpiredReservations(db)).toBe(0);
  });
});

describe("redactStalePii", () => {
  // Policy (see AGENTS.md, Session 9):
  // - status='held'      AND expires_at < now - 24h:  replace with redaction sentinel
  // - status='expired'   AND expires_at < now - 7d:   replace with redaction sentinel
  // - status='confirmed' AND window_end < now - 90d:  replace with redaction sentinel
  // Sentinel: {"redacted":true,"redacted_at":<unix>} — preserves NOT NULL constraint
  // and provides an audit trail of when retention fired.
  const HOUR = 3600;
  const DAY = 86400;
  const now = Math.floor(Date.now() / 1000);
  const isRedacted = (s: string | null): boolean =>
    typeof s === "string" && /"redacted"\s*:\s*true/.test(s);

  it("redacts customer_contact_json on stale held rows (>24h past expires_at) but leaves fresh holds alone", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    seed(db, [
      { id: "r_old_held",   status: "held", expires_at: now - 25 * HOUR }, // stale → redact
      { id: "r_fresh_held", status: "held", expires_at: now - 1  * HOUR }, // <24h post-lapse → keep
      { id: "r_future_held",status: "held", expires_at: now + 10 * HOUR }, // not lapsed → keep
    ]);
    const n = redactStalePii(db);
    expect(n).toBe(1);
    const stale  = db.prepare("SELECT customer_contact_json FROM reservations WHERE id='r_old_held'").get() as { customer_contact_json: string };
    const fresh  = db.prepare("SELECT customer_contact_json FROM reservations WHERE id='r_fresh_held'").get() as { customer_contact_json: string };
    const future = db.prepare("SELECT customer_contact_json FROM reservations WHERE id='r_future_held'").get() as { customer_contact_json: string };
    expect(isRedacted(stale.customer_contact_json)).toBe(true);
    expect(isRedacted(fresh.customer_contact_json)).toBe(false);
    expect(isRedacted(future.customer_contact_json)).toBe(false);
    // Sentinel is parseable JSON with a redacted_at timestamp
    const parsed = JSON.parse(stale.customer_contact_json) as { redacted: boolean; redacted_at: number };
    expect(parsed.redacted).toBe(true);
    expect(parsed.redacted_at).toBeGreaterThan(now - 60);
  });

  it("redacts customer_contact_json on expired rows >7d past expires_at; leaves fresh expired alone", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    seed(db, [
      { id: "r_old_expired",   status: "expired", expires_at: now - 8 * DAY }, // stale → redact
      { id: "r_fresh_expired", status: "expired", expires_at: now - 6 * DAY }, // <7d → keep
    ]);
    const n = redactStalePii(db);
    expect(n).toBe(1);
    const stale = db.prepare("SELECT customer_contact_json FROM reservations WHERE id='r_old_expired'").get() as { customer_contact_json: string };
    const fresh = db.prepare("SELECT customer_contact_json FROM reservations WHERE id='r_fresh_expired'").get() as { customer_contact_json: string };
    expect(isRedacted(stale.customer_contact_json)).toBe(true);
    expect(isRedacted(fresh.customer_contact_json)).toBe(false);
  });

  it("redacts customer_contact_json on confirmed rows >90d past window_end; leaves fresh confirmed alone", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    seed(db, [
      { id: "r_old_confirmed",   status: "confirmed", expires_at: now, window_end: now - 91 * DAY }, // >90d → redact
      { id: "r_fresh_confirmed", status: "confirmed", expires_at: now, window_end: now - 30 * DAY }, // <90d → keep
    ]);
    const n = redactStalePii(db);
    expect(n).toBe(1);
    const stale = db.prepare("SELECT customer_contact_json FROM reservations WHERE id='r_old_confirmed'").get() as { customer_contact_json: string };
    const fresh = db.prepare("SELECT customer_contact_json FROM reservations WHERE id='r_fresh_confirmed'").get() as { customer_contact_json: string };
    expect(isRedacted(stale.customer_contact_json)).toBe(true);
    expect(isRedacted(fresh.customer_contact_json)).toBe(false);
  });

  it("is idempotent — re-running on already-redacted rows returns 0 changes", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    seed(db, [
      { id: "r1", status: "held", expires_at: now - 25 * HOUR },
    ]);
    expect(redactStalePii(db)).toBe(1);
    expect(redactStalePii(db)).toBe(0); // sentinel already present — WHERE clause skips it
  });

  it("does not touch rejected status (operational-audit-only — no contact stored at reject time anyway)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    seed(db, [
      { id: "r_rejected", status: "rejected", expires_at: now - 365 * DAY, contact: '{"name":"X"}' },
    ]);
    const n = redactStalePii(db);
    expect(n).toBe(0);
    const row = db.prepare("SELECT customer_contact_json FROM reservations WHERE id='r_rejected'").get() as { customer_contact_json: string };
    expect(row.customer_contact_json).toBe('{"name":"X"}');
  });
});

// SOC 2 H5: schedule-registration tests for startPiiSweepSchedule.
//
// Validates the env-override path + the validity check. We do NOT exercise
// the actual sweep work here — that's covered by the redactStalePii /
// sweepExpiredReservations tests above. The purpose of these tests is to
// catch regressions where startPiiSweepSchedule silently fails to wire the
// schedule (e.g. typo'd default cron, broken env override path).

vi.mock("node-cron", () => {
  const schedule = vi.fn();
  const validate = vi.fn((expr: string) =>
    /^(\S+\s+){4}\S+$/.test(expr.trim()),
  );
  return { default: { schedule, validate }, schedule, validate };
});

describe("startPiiSweepSchedule", () => {
  let cronMod: { schedule: ReturnType<typeof vi.fn>; validate: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    cronMod = (await import("node-cron")).default as unknown as {
      schedule: ReturnType<typeof vi.fn>;
      validate: ReturnType<typeof vi.fn>;
    };
    cronMod.schedule.mockReset();
    cronMod.validate.mockClear();
    delete process.env.PII_SWEEP_CRON;
  });

  afterEach(() => {
    delete process.env.PII_SWEEP_CRON;
  });

  it("registers the default 6-hour cron when PII_SWEEP_CRON is unset", () => {
    startPiiSweepSchedule();
    expect(cronMod.validate).toHaveBeenCalledWith("0 */6 * * *");
    expect(cronMod.schedule).toHaveBeenCalledTimes(1);
    expect(cronMod.schedule.mock.calls[0][0]).toBe("0 */6 * * *");
  });

  it("honours PII_SWEEP_CRON env override", () => {
    process.env.PII_SWEEP_CRON = "*/15 * * * *";
    startPiiSweepSchedule();
    expect(cronMod.schedule).toHaveBeenCalledTimes(1);
    expect(cronMod.schedule.mock.calls[0][0]).toBe("*/15 * * * *");
  });

  it("does NOT register when the env override is structurally invalid", () => {
    process.env.PII_SWEEP_CRON = "not-a-cron";
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    startPiiSweepSchedule();
    expect(cronMod.schedule).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});
