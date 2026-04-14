// worker/src/routes/onboardDraft.test.ts
import { describe, it, expect, vi } from "vitest";
import { validateDraftPayload, handleSaveDraft } from "./onboardDraft.js";
import type { Env } from "../types.js";

describe("validateDraftPayload", () => {
  it("accepts a partial payload with email + step", () => {
    const r = validateDraftPayload({
      email: "a@b.com", step: 3, payload: { name: "A" },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects missing email", () => {
    const r = validateDraftPayload({ step: 1, payload: {} });
    expect(r.ok).toBe(false);
  });

  it("rejects step out of range", () => {
    const r = validateDraftPayload({ email: "a@b.com", step: 99, payload: {} });
    expect(r.ok).toBe(false);
  });

  it("rejects non-object payload", () => {
    const r = validateDraftPayload({ email: "a@b.com", step: 1, payload: "x" });
    expect(r.ok).toBe(false);
  });
});

// ── Integration: handleSaveDraft — fake D1 ────────────────────────────────────

describe("handleSaveDraft — D1 upsert integration", () => {
  it("calls INSERT … ON CONFLICT with correct bind params", async () => {
    // Track the bound parameters so we can assert on them
    const bindSpy = vi.fn().mockReturnValue({
      async run() { return { meta: { changes: 1 } }; },
    });
    const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });

    const fakeDb = { prepare: prepareSpy } as unknown as D1Database;
    const env = { DB: fakeDb } as unknown as Env;

    const req = new Request("https://customers.advocatemcp.com/api/onboard/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Test@Example.com", step: 3, payload: { name: "Acme" } }),
    });

    const resp = await handleSaveDraft(req, env);
    expect(resp.status).toBe(200);

    // The SQL passed to prepare should contain ON CONFLICT
    const sql: string = prepareSpy.mock.calls[0][0];
    expect(sql).toContain("ON CONFLICT(email) DO UPDATE SET");

    // bind receives: email (lowercased), payloadJson, step, created_at, updated_at
    const [email, payloadJson, step] = bindSpy.mock.calls[0];
    expect(email).toBe("test@example.com");
    expect(step).toBe(3);
    expect(JSON.parse(payloadJson as string)).toEqual({ name: "Acme" });
  });
});
