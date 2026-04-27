import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendEmail, ResendError } from "./resend.js";

describe("sendEmail", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { process.env.RESEND_API_KEY = "re_test"; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    vi.restoreAllMocks();
  });

  const base = {
    from:    "digest@advocatemcp.com",
    to:      "owner@example.com",
    subject: "Your weekly radar",
    html:    "<p>hi</p>",
    text:    "hi",
  };

  it("returns the Resend message id on success", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "msg_abc123" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const r = await sendEmail(base);
    expect(r.id).toBe("msg_abc123");
  });

  it("forwards from/to/subject/html/text/reply_to to Resend", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ id: "msg_xyz" }), { status: 200 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await sendEmail({ ...base, replyTo: "max@advocate-mcp.com" });

    const [, init] = (fetchSpy as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe(base.from);
    expect(body.to).toEqual([base.to]);
    expect(body.subject).toBe(base.subject);
    expect(body.html).toBe(base.html);
    expect(body.text).toBe(base.text);
    expect(body.reply_to).toBe("max@advocate-mcp.com");
  });

  it("throws ResendError on non-2xx with status + body preserved", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_from" }), { status: 422 }),
    ) as unknown as typeof fetch;

    try {
      await sendEmail(base);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResendError);
      expect((err as ResendError).status).toBe(422);
      expect((err as ResendError).body).toContain("invalid_from");
    }
  });

  it("throws if RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendEmail(base)).rejects.toThrow(/RESEND_API_KEY/);
  });

  it("throws descriptive error when response is not JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<html>edge</html>", { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(sendEmail(base)).rejects.toThrow(/json parse failed/);
  });

  it("throws when JSON response lacks an id field", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(sendEmail(base)).rejects.toThrow(/missing id/);
  });
});
