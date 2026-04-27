import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateGoDaddyCredential,
  createGoDaddyRecord,
  setupGoDaddyForwarding,
  applyGoDaddyRecords,
} from "./godaddy";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("validateGoDaddyCredential — format guards", () => {
  it("rejects empty key or secret", async () => {
    expect((await validateGoDaddyCredential({ key: "", secret: "abc12345678901234" }, "acme.com")).reason)
      .toBe("credential_format_invalid");
    expect((await validateGoDaddyCredential({ key: "abc12345678", secret: "" }, "acme.com")).reason)
      .toBe("credential_format_invalid");
  });

  it("rejects credentials with disallowed characters", async () => {
    const r = await validateGoDaddyCredential(
      { key: "valid_key_format_123", secret: "has space in it" },
      "acme.com",
    );
    expect(r.reason).toBe("credential_format_invalid");
  });
});

describe("validateGoDaddyCredential — auth outcomes", () => {
  it("returns credential_invalid_or_revoked on 401", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;
    const r = await validateGoDaddyCredential(
      { key: "good_key_format_abc", secret: "good_secret_format_xyz" },
      "acme.com",
    );
    expect(r.reason).toBe("credential_invalid_or_revoked");
  });

  it("returns domain_not_found_for_credential on 404", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    const r = await validateGoDaddyCredential(
      { key: "good_key_format_abc", secret: "good_secret_format_xyz" },
      "acme.com",
    );
    expect(r.reason).toBe("domain_not_found_for_credential");
  });

  it("returns ok with active status when domain check succeeds", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ domain: "acme.com", status: "ACTIVE" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const r = await validateGoDaddyCredential(
      { key: "good_key_format_abc", secret: "good_secret_format_xyz" },
      "acme.com",
    );
    expect(r.ok).toBe(true);
    expect(r.domain).toBe("acme.com");
    expect(r.forwarding_supported).toBe(true);
  });

  it("strips leading www. before domain lookup", async () => {
    let observedUrl = "";
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      observedUrl = String(url);
      return new Response(
        JSON.stringify({ domain: "acme.com", status: "ACTIVE" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await validateGoDaddyCredential(
      { key: "good_key_format_abc", secret: "good_secret_format_xyz" },
      "www.acme.com",
    );
    expect(r.ok).toBe(true);
    expect(observedUrl).toContain("/domains/acme.com");
    expect(observedUrl).not.toContain("www.acme.com");
  });

  it("returns domain_not_active when status is not ACTIVE", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ domain: "acme.com", status: "PENDING_TRANSFER" }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const r = await validateGoDaddyCredential(
      { key: "good_key_format_abc", secret: "good_secret_format_xyz" },
      "acme.com",
    );
    expect(r.reason).toBe("domain_not_active");
  });
});

describe("createGoDaddyRecord — idempotency + conflict", () => {
  it("returns already_exists when record matches", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([{ type: "CNAME", name: "www", data: "customers.advocatemcp.com", ttl: 600 }]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const r = await createGoDaddyRecord(
      { key: "k", secret: "s" },
      "acme.com",
      { type: "CNAME", name: "www", data: "customers.advocatemcp.com" },
    );
    expect(r.ok).toBe(true);
    expect(r.already_exists).toBe(true);
  });

  it("flags a conflict when an existing record has different data", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([{ type: "CNAME", name: "www", data: "elsewhere.example.com" }]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const r = await createGoDaddyRecord(
      { key: "k", secret: "s" },
      "acme.com",
      { type: "CNAME", name: "www", data: "customers.advocatemcp.com" },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^record_conflict_/);
  });

  it("creates a new record when none exists", async () => {
    let putCalled = false;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCalled = true;
        return new Response("", { status: 200 });
      }
      // GET list returns empty array
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await createGoDaddyRecord(
      { key: "k", secret: "s" },
      "acme.com",
      { type: "TXT", name: "_cf-custom-hostname", data: "abc-123" },
    );
    expect(r.ok).toBe(true);
    expect(r.already_exists).toBeUndefined();
    expect(putCalled).toBe(true);
  });

  it("surfaces permission_denied on 403 to PUT", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("forbidden", { status: 403 });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await createGoDaddyRecord(
      { key: "k", secret: "s" },
      "acme.com",
      { type: "TXT", name: "_x", data: "y" },
    );
    expect(r.reason).toBe("permission_denied");
  });
});

describe("setupGoDaddyForwarding", () => {
  it("returns ok on 200", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const r = await setupGoDaddyForwarding(
      { key: "k", secret: "s" },
      "acme.com",
      { target_url: "https://www.acme.com" },
    );
    expect(r.ok).toBe(true);
  });

  it("returns forwarding_not_available on 404 (forwarding API unavailable)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const r = await setupGoDaddyForwarding(
      { key: "k", secret: "s" },
      "acme.com",
      { target_url: "https://www.acme.com" },
    );
    expect(r.reason).toBe("forwarding_not_available");
  });

  it("returns permission_denied on 403", async () => {
    globalThis.fetch = vi.fn(async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const r = await setupGoDaddyForwarding(
      { key: "k", secret: "s" },
      "acme.com",
      { target_url: "https://www.acme.com" },
    );
    expect(r.reason).toBe("permission_denied");
  });
});

describe("applyGoDaddyRecords — orchestration", () => {
  it("creates records + sets up forwarding when forwardingTarget is given", async () => {
    let forwardingHit = false;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/forwards/")) {
        forwardingHit = true;
        return new Response("", { status: 200 });
      }
      if (init?.method === "PUT") return new Response("", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await applyGoDaddyRecords(
      { key: "k", secret: "s" },
      "acme.com",
      [
        { type: "CNAME", name: "www", data: "customers.advocatemcp.com" },
        { type: "TXT", name: "_cf-custom-hostname", data: "abc-123" },
      ],
      "https://www.acme.com",
    );
    expect(r.overall_ok).toBe(true);
    expect(forwardingHit).toBe(true);
    expect(r.forwarding?.ok).toBe(true);
  });

  it("stops early on permission_denied", async () => {
    let putCount = 0;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCount++;
        return new Response("forbidden", { status: 403 });
      }
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await applyGoDaddyRecords(
      { key: "k", secret: "s" },
      "acme.com",
      [
        { type: "CNAME", name: "www", data: "customers.advocatemcp.com" },
        { type: "TXT", name: "_cf-custom-hostname", data: "abc-123" },
      ],
    );
    expect(r.overall_ok).toBe(false);
    expect(putCount).toBe(1); // stopped after first permission_denied
    expect(r.results.length).toBe(1);
  });

  it("skips forwarding when records had failures", async () => {
    let forwardingHit = false;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/forwards/")) {
        forwardingHit = true;
        return new Response("", { status: 200 });
      }
      if (init?.method === "PUT") return new Response("err", { status: 500 });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await applyGoDaddyRecords(
      { key: "k", secret: "s" },
      "acme.com",
      [{ type: "CNAME", name: "www", data: "customers.advocatemcp.com" }],
      "https://www.acme.com",
    );
    expect(r.overall_ok).toBe(false);
    expect(forwardingHit).toBe(false); // skipped because record creation failed
  });
});
