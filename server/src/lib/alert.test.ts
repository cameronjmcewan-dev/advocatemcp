import { describe, it, expect, afterEach, vi } from "vitest";
import { sendBudgetAlert } from "./alert.js";

describe("sendBudgetAlert", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_EMAIL_TO;
    delete process.env.ALERT_EMAIL_FROM;
    vi.restoreAllMocks();
  });

  it("POSTs to Resend when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY  = "re_test";
    process.env.ALERT_EMAIL_TO  = "ops@example.com";
    process.env.ALERT_EMAIL_FROM = "noreply@example.com";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await sendBudgetAlert("[radar] budget cap hit", "spent $10.01");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["ops@example.com"]);
    expect(body.subject).toBe("[radar] budget cap hit");
  });

  it("logs to stderr and does not throw when RESEND_API_KEY is missing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await sendBudgetAlert("subject", "body");
    expect(errSpy).toHaveBeenCalled();
  });
});
