import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../db/migrations.js";
import { _setDbForTesting } from "../../db.js";
import { adminRouter } from "./index.js";

vi.mock("../../lib/dnsProbe.js");
vi.mock("../../lib/liveProbe.js");

describe("POST /admin/probe-domain", () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
    process.env.ADMIN_API_KEY = "admin-test-key";
    // requireApiKeyEarly (guarding /admin/faqs + /admin/competitors) checks
    // X-API-Key or Bearer against API_KEY before requireAdmin runs.
    // Without this, every /admin/* request 401s before reaching requireAdmin.
    process.env.API_KEY = "server-test-key";
    app = express();
    app.use(express.json());
    app.use(adminRouter);
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setDbForTesting(null);
    db.close();
    delete process.env.ADMIN_API_KEY;
    delete process.env.API_KEY;
  });

  it("returns 401 without admin key", async () => {
    // Pass X-API-Key to satisfy requireApiKeyEarly, omit Bearer so requireAdmin rejects.
    const res = await request(app)
      .post("/admin/probe-domain")
      .set("X-API-Key", "server-test-key")
      .send({ domain: "example.com", slug: "example" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with unified status when both probes succeed", async () => {
    const { probeDns } = await import("../../lib/dnsProbe.js");
    const { probeLive } = await import("../../lib/liveProbe.js");
    vi.mocked(probeDns).mockResolvedValue({ ok: true, resolved_target: "customers.advocatemcp.com" });
    vi.mocked(probeLive).mockResolvedValue({ ok: true, status_code: 200, latency_ms: 123, marker_present: true });

    const res = await request(app)
      .post("/admin/probe-domain")
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key")
      .send({ domain: "example.com", slug: "example" });

    expect(res.status).toBe(200);
    expect(res.body.domain).toBe("example.com");
    expect(res.body.slug).toBe("example");
    expect(res.body.checked_at).toBeDefined();
    expect(res.body.all_green).toBe(true);
    expect(res.body.signals.dns.state).toBe("ok");
    expect(res.body.signals.dns.message).toBe("Your CNAME is pointing the right way.");
    expect(res.body.signals.live_request.state).toBe("ok");
    expect(res.body.signals.live_request.message).toBe("Live and serving (123ms).");
    expect(res.body.signals.cf_hostname.state).toBe("waiting");
    expect(res.body.signals.cf_hostname.message).toBe("Waiting on Cloudflare hostname status (filled in by worker).");
    expect(res.body.signals.cf_ssl.state).toBe("waiting");
    expect(res.body.signals.cf_ssl.message).toBe("Waiting on Cloudflare SSL status (filled in by worker).");
    expect(res.body.signals.worker_route.state).toBe("waiting");
    expect(res.body.signals.worker_route.message).toBe("Waiting on Worker route status (filled in by worker).");
  });

  it("returns 200 with dns.state='err' and specific message when CNAME target wrong", async () => {
    const { probeDns } = await import("../../lib/dnsProbe.js");
    const { probeLive } = await import("../../lib/liveProbe.js");
    vi.mocked(probeDns).mockResolvedValue({ ok: false, resolved_target: "wrong.target.com", error: "wrong target" });
    vi.mocked(probeLive).mockResolvedValue({ ok: true, status_code: 200, latency_ms: 50, marker_present: true });

    const res = await request(app)
      .post("/admin/probe-domain")
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key")
      .send({ domain: "example.com", slug: "example" });

    expect(res.status).toBe(200);
    expect(res.body.all_green).toBe(false);
    expect(res.body.signals.dns.state).toBe("err");
    expect(res.body.signals.dns.message).toBe(
      "Your CNAME points to wrong.target.com — should be customers.advocatemcp.com.",
    );
    expect(res.body.signals.dns.detail.resolved_target).toBe("wrong.target.com");
    expect(res.body.signals.dns.detail.expected_target).toBe("customers.advocatemcp.com");
  });

  it("returns 200 with dns.state='waiting' (not 'err') when no CNAME found yet", async () => {
    const { probeDns } = await import("../../lib/dnsProbe.js");
    const { probeLive } = await import("../../lib/liveProbe.js");
    vi.mocked(probeDns).mockResolvedValue({ ok: false, error: "no CNAME record found" });
    vi.mocked(probeLive).mockResolvedValue({ ok: true, status_code: 200, latency_ms: 50, marker_present: true });

    const res = await request(app)
      .post("/admin/probe-domain")
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key")
      .send({ domain: "example.com", slug: "example" });

    expect(res.status).toBe(200);
    expect(res.body.all_green).toBe(false);
    expect(res.body.signals.dns.state).toBe("waiting");
    expect(res.body.signals.dns.message).toBe(
      "Waiting for your CNAME record to propagate. Usually 5–30 minutes.",
    );
  });

  it("returns 200 with live_request.state='err' and 'responding but not reaching worker' message when status=200 + marker_present=false", async () => {
    const { probeDns } = await import("../../lib/dnsProbe.js");
    const { probeLive } = await import("../../lib/liveProbe.js");
    vi.mocked(probeDns).mockResolvedValue({ ok: true, resolved_target: "customers.advocatemcp.com" });
    vi.mocked(probeLive).mockResolvedValue({
      ok: false,
      status_code: 200,
      latency_ms: 80,
      marker_present: false,
      error: "marker missing — request reached the domain but not our worker",
    });

    const res = await request(app)
      .post("/admin/probe-domain")
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key")
      .send({ domain: "example.com", slug: "example" });

    expect(res.status).toBe(200);
    expect(res.body.all_green).toBe(false);
    expect(res.body.signals.live_request.state).toBe("err");
    expect(res.body.signals.live_request.message).toBe(
      "Your domain is responding, but the request isn't reaching our worker. Check DNS + CF hostname status above.",
    );
  });

  it("returns 400 on invalid body (missing domain)", async () => {
    const res = await request(app)
      .post("/admin/probe-domain")
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key")
      .send({ slug: "example" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid body");
  });
});
