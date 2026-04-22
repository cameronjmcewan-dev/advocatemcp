import { describe, it, expect, vi, beforeEach } from "vitest";

async function fresh() {
  process.env.DATABASE_PATH = ":memory:";
  process.env.TOKEN_SIGNING_KEY = "test-key-ih";
  process.env.API_BASE_URL = "https://api.test";
  const dbMod = await import("../../db.js");
  const { applyMigrations } = await import("../../db/migrations.js");
  applyMigrations(
    (dbMod as unknown as { __getRawForTest: () => import("better-sqlite3").Database }).__getRawForTest()
  );
  dbMod.getDb().prepare(`
    INSERT INTO businesses (slug, name, api_key, description, services, lead_routing_json)
    VALUES ('acme','Acme','k','d','s', json('{"preferred":"sms","sms_to":"+15555550123"}'))
    ON CONFLICT(slug) DO NOTHING
  `).run();
  return dbMod;
}

describe("initiate_handoff — human mode", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls notify.sendSms and writes handoffs row on delivered", async () => {
    vi.doMock("../../lib/notify.js", () => ({
      sendSms: vi.fn().mockResolvedValue({ delivered: true, reason: "ok", ticket_id: "SM1" }),
      sendEmail: vi.fn(),
    }));
    await fresh();
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "acme",
      mode: "human",
      payload: { message: "User wants a callback" },
    } as unknown as Parameters<typeof handleInitiateHandoff>[0]);
    const body = JSON.parse((res.content[0] as { text: string }).text) as {
      mode: string;
      delivered_via: string;
      ticket_id: string;
    };
    expect(body.mode).toBe("human");
    expect(body.delivered_via).toBe("sms");
    expect(body.ticket_id).toBe("SM1");
  });

  it("returns delivered:false with reason:no_recipient_configured when lead_routing has no sms_to", async () => {
    const sendSmsSpy = vi.fn();
    vi.doMock("../../lib/notify.js", () => ({
      sendSms: sendSmsSpy,
      sendEmail: vi.fn(),
    }));
    process.env.DATABASE_PATH = ":memory:";
    process.env.TOKEN_SIGNING_KEY = "test-key-ih";
    process.env.API_BASE_URL = "https://api.test";
    const dbMod = await import("../../db.js");
    const { applyMigrations } = await import("../../db/migrations.js");
    applyMigrations(
      (dbMod as unknown as { __getRawForTest: () => import("better-sqlite3").Database }).__getRawForTest()
    );
    // Business with SMS preferred but no sms_to configured.
    dbMod.getDb().prepare(`
      INSERT INTO businesses (slug, name, api_key, description, services, lead_routing_json)
      VALUES ('noroute','NoRoute','k','d','s', json('{"preferred":"sms"}'))
      ON CONFLICT(slug) DO NOTHING
    `).run();
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "noroute",
      mode: "human",
      payload: { message: "test" },
    } as unknown as Parameters<typeof handleInitiateHandoff>[0]);
    expect(res.isError).toBeFalsy();
    // Must NOT have called the notify adapter with an empty recipient —
    // that would let Twilio reject with an opaque http_400.
    expect(sendSmsSpy).not.toHaveBeenCalled();
    const body = JSON.parse((res.content[0] as { text: string }).text) as {
      delivered: boolean;
      reason: string;
      channel: string;
    };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("no_recipient_configured");
    expect(body.channel).toBe("sms");
    // Row still written for audit.
    const row = dbMod.getDb().prepare(`SELECT delivered_via FROM handoffs WHERE business_slug='noroute'`).get() as { delivered_via: string } | undefined;
    expect(row?.delivered_via).toBe("sms");
  });

  it("returns delivered:false, writes row, does not isError on not_configured", async () => {
    vi.doMock("../../lib/notify.js", () => ({
      sendSms: vi.fn().mockResolvedValue({ delivered: false, reason: "not_configured" }),
      sendEmail: vi.fn(),
    }));
    await fresh();
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "acme",
      mode: "human",
      payload: { message: "test" },
    } as unknown as Parameters<typeof handleInitiateHandoff>[0]);
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content[0] as { text: string }).text) as {
      delivered: boolean;
      reason: string;
    };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("not_configured");
  });
});

describe("initiate_handoff — human mode, onboarding/wizard shape", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function seedWithRouting(routingJson: string, slug = "wiz") {
    process.env.DATABASE_PATH = ":memory:";
    process.env.TOKEN_SIGNING_KEY = "test-key-ih";
    process.env.API_BASE_URL = "https://api.test";
    const dbMod = await import("../../db.js");
    const { applyMigrations } = await import("../../db/migrations.js");
    applyMigrations(
      (dbMod as unknown as { __getRawForTest: () => import("better-sqlite3").Database }).__getRawForTest()
    );
    dbMod.getDb().prepare(`
      INSERT INTO businesses (slug, name, api_key, description, services, lead_routing_json)
      VALUES (?, ?, 'k', 'd', 's', ?)
      ON CONFLICT(slug) DO NOTHING
    `).run(slug, slug, routingJson);
    return dbMod;
  }

  it("preferred_channel=text routes SMS to phone field", async () => {
    const smsSpy = vi.fn().mockResolvedValue({ delivered: true, reason: "ok", ticket_id: "SM7" });
    vi.doMock("../../lib/notify.js", () => ({ sendSms: smsSpy, sendEmail: vi.fn() }));
    await seedWithRouting(`{"preferred_channel":"text","phone":"+15555551111"}`);
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "wiz", mode: "human", payload: { message: "new lead" },
    } as unknown as Parameters<typeof handleInitiateHandoff>[0]);
    expect(smsSpy).toHaveBeenCalledWith({ to: "+15555551111", body: "new lead" });
    const body = JSON.parse((res.content[0] as { text: string }).text) as { delivered_via: string };
    expect(body.delivered_via).toBe("sms");
  });

  it("preferred_channel=phone also routes to SMS (voice not deliverable)", async () => {
    const smsSpy = vi.fn().mockResolvedValue({ delivered: true, reason: "ok", ticket_id: "SM8" });
    vi.doMock("../../lib/notify.js", () => ({ sendSms: smsSpy, sendEmail: vi.fn() }));
    await seedWithRouting(`{"preferred_channel":"phone","phone":"+15555552222"}`);
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    await handleInitiateHandoff({
      slug: "wiz", mode: "human", payload: { message: "call me" },
    } as unknown as Parameters<typeof handleInitiateHandoff>[0]);
    expect(smsSpy).toHaveBeenCalledWith({ to: "+15555552222", body: "call me" });
  });

  it("preferred_channel=email routes email to email field", async () => {
    const emailSpy = vi.fn().mockResolvedValue({ delivered: true, reason: "ok", ticket_id: "E1" });
    vi.doMock("../../lib/notify.js", () => ({ sendSms: vi.fn(), sendEmail: emailSpy }));
    await seedWithRouting(`{"preferred_channel":"email","email":"leads@biz.com"}`);
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "wiz", mode: "human", payload: { message: "interested" },
    } as unknown as Parameters<typeof handleInitiateHandoff>[0]);
    expect(emailSpy).toHaveBeenCalledWith({ to: "leads@biz.com", subject: "New lead", body: "interested" });
    const body = JSON.parse((res.content[0] as { text: string }).text) as { delivered_via: string };
    expect(body.delivered_via).toBe("email");
  });

  it("preferred_channel=form returns form_routing_configured with form_url", async () => {
    const smsSpy = vi.fn();
    const emailSpy = vi.fn();
    vi.doMock("../../lib/notify.js", () => ({ sendSms: smsSpy, sendEmail: emailSpy }));
    await seedWithRouting(`{"preferred_channel":"form","form_url":"https://biz.example/contact"}`);
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "wiz", mode: "human", payload: { message: "x" },
    } as unknown as Parameters<typeof handleInitiateHandoff>[0]);
    expect(smsSpy).not.toHaveBeenCalled();
    expect(emailSpy).not.toHaveBeenCalled();
    const body = JSON.parse((res.content[0] as { text: string }).text) as {
      delivered: boolean; reason: string; channel: string; form_url: string;
    };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("form_routing_configured");
    expect(body.channel).toBe("form");
    expect(body.form_url).toBe("https://biz.example/contact");
  });

  it("preferred_channel=text with missing phone returns no_recipient_configured", async () => {
    const smsSpy = vi.fn();
    vi.doMock("../../lib/notify.js", () => ({ sendSms: smsSpy, sendEmail: vi.fn() }));
    await seedWithRouting(`{"preferred_channel":"text"}`);
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "wiz", mode: "human", payload: { message: "x" },
    } as unknown as Parameters<typeof handleInitiateHandoff>[0]);
    expect(smsSpy).not.toHaveBeenCalled();
    const body = JSON.parse((res.content[0] as { text: string }).text) as { reason: string; channel: string };
    expect(body.reason).toBe("no_recipient_configured");
    expect(body.channel).toBe("sms");
  });
});

describe("initiate_handoff — agent mode", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("mints continuation URL and writes handoffs row", async () => {
    await fresh();
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "acme",
      mode: "agent",
      payload: { purpose: "price negotiation" },
    } as unknown as Parameters<typeof handleInitiateHandoff>[0]);
    const body = JSON.parse((res.content[0] as { text: string }).text) as {
      mode: string;
      continuation_url: string;
      expires_at: number;
      handshake_token: string;
    };
    expect(body.mode).toBe("agent");
    expect(body.continuation_url).toMatch(/^https:\/\/api\.test\/a2a\/continue\//);
    expect(body.handshake_token.split(".").length).toBe(2);
  });

  it("returns isError on unknown slug", async () => {
    await fresh();
    const { handleInitiateHandoff } = await import("./initiateHandoff.js");
    const res = await handleInitiateHandoff({
      slug: "does-not-exist",
      mode: "agent",
      payload: { purpose: "x" },
    } as unknown as Parameters<typeof handleInitiateHandoff>[0]);
    expect(res.isError).toBe(true);
  });
});
