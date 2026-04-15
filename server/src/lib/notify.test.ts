import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendSms, sendEmail } from "./notify.js";

const origFetch = globalThis.fetch;

describe("notify — sendSms", () => {
  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("returns not_configured when TWILIO_ACCOUNT_SID is absent", async () => {
    const res = await sendSms({ to: "+15555550123", body: "hi" });
    expect(res).toEqual({ delivered: false, reason: "not_configured" });
  });

  it("POSTs to Twilio and returns delivered:true on HTTP 201", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM_NUMBER = "+15555551000";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ sid: "SM123" }),
    }) as unknown as typeof fetch;
    const res = await sendSms({ to: "+15555550123", body: "hi" });
    expect(res).toEqual({ delivered: true, reason: "ok", ticket_id: "SM123" });
    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toMatch(/api\.twilio\.com.*Messages\.json/);
  });

  it("returns delivered:false on non-2xx", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM_NUMBER = "+15555551000";
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: "bad" }) }) as unknown as typeof fetch;
    const res = await sendSms({ to: "+1", body: "x" });
    expect(res.delivered).toBe(false);
    expect(res.reason).toMatch(/http_/);
  });

  it("returns delivered:false with reason:missing_sid when Twilio omits sid", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM_NUMBER = "+15555551000";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    const res = await sendSms({ to: "+1", body: "x" });
    expect(res).toEqual({ delivered: false, reason: "missing_sid" });
  });
});

describe("notify — sendEmail", () => {
  it("returns not_configured (v1 email send not implemented)", async () => {
    const res = await sendEmail({ to: "a@x.com", subject: "hi", body: "hi" });
    expect(res.delivered).toBe(false);
    expect(res.reason).toMatch(/not_(configured|implemented)/);
  });
});
