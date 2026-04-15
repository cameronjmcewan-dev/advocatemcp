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
