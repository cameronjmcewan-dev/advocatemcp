import { describe, it, expect, vi, afterEach } from "vitest";
import { validateIonosCredential, applyIonosRecords, IONOS_APEX_A_IPS } from "./ionos";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("validateIonosCredential — format guards", () => {
  it("rejects empty key", async () => {
    expect((await validateIonosCredential({ apiKey: "" }, "acme.com")).reason).toBe("credential_format_invalid");
  });

  it("rejects key without a dot separator (PublicPrefix.Secret format expected)", async () => {
    const r = await validateIonosCredential({ apiKey: "abcdef1234567890abcdef" }, "acme.com");
    expect(r.reason).toBe("credential_format_invalid");
  });

  it("rejects too-short key", async () => {
    const r = await validateIonosCredential({ apiKey: "a.b" }, "acme.com");
    expect(r.reason).toBe("credential_format_invalid");
  });
});

describe("validateIonosCredential — auth + lookup", () => {
  it("returns ok with zone id when domain is in the account", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([
          { id: "zone-aaa", name: "acme.com", type: "NATIVE" },
          { id: "zone-bbb", name: "other.com", type: "NATIVE" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const r = await validateIonosCredential(
      { apiKey: "publicprefix.thisisthelongersecretpartof.thekey1234567890" },
      "acme.com",
    );
    expect(r.ok).toBe(true);
    expect(r.zone_id).toBe("zone-aaa");
    expect(r.zone_name).toBe("acme.com");
  });

  it("strips leading www. before zone match", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "zone-aaa", name: "acme.com" }]), { status: 200 }),
    ) as unknown as typeof fetch;
    const r = await validateIonosCredential(
      { apiKey: "publicprefix.thisisthelongersecretpartof.thekey1234567890" },
      "www.acme.com",
    );
    expect(r.ok).toBe(true);
    expect(r.zone_id).toBe("zone-aaa");
  });

  it("returns credential_invalid_or_revoked on 401", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unauth", { status: 401 })) as unknown as typeof fetch;
    const r = await validateIonosCredential(
      { apiKey: "publicprefix.thisisthelongersecretpartof.thekey1234567890" },
      "acme.com",
    );
    expect(r.reason).toBe("credential_invalid_or_revoked");
  });

  it("returns domain_not_found_for_credential when zone not in list", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "zone-other", name: "other.com" }]), { status: 200 }),
    ) as unknown as typeof fetch;
    const r = await validateIonosCredential(
      { apiKey: "publicprefix.thisisthelongersecretpartof.thekey1234567890" },
      "acme.com",
    );
    expect(r.reason).toBe("domain_not_found_for_credential");
  });
});

describe("applyIonosRecords", () => {
  it("returns already_exists when record content matches", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith("/zones/zone-aaa")) {
        return new Response(
          JSON.stringify({
            id: "zone-aaa",
            name: "acme.com",
            records: [{ id: "r1", type: "CNAME", name: "www.acme.com", content: "customers.advocatemcp.com" }],
          }),
          { status: 200 },
        );
      }
      throw new Error("unexpected " + u);
    }) as unknown as typeof fetch;
    const r = await applyIonosRecords(
      { apiKey: "p.s" },
      "zone-aaa",
      [{ type: "CNAME", name: "www.acme.com", content: "customers.advocatemcp.com" }],
    );
    expect(r.overall_ok).toBe(true);
    expect(r.results[0]!.already_exists).toBe(true);
  });

  it("flags a conflict when existing record has different content", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "z",
          name: "acme.com",
          records: [{ id: "r1", type: "CNAME", name: "www.acme.com", content: "elsewhere.example.com" }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const r = await applyIonosRecords(
      { apiKey: "p.s" },
      "z",
      [{ type: "CNAME", name: "www.acme.com", content: "customers.advocatemcp.com" }],
    );
    expect(r.overall_ok).toBe(false);
    expect(r.results[0]!.reason).toMatch(/^record_conflict_/);
  });

  it("PATCHes new records when none exist", async () => {
    let patchSeen = false;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchSeen = true;
        return new Response("[]", { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: "z", name: "acme.com", records: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await applyIonosRecords(
      { apiKey: "p.s" },
      "z",
      [
        { type: "CNAME", name: "www.acme.com", content: "customers.advocatemcp.com" },
        { type: "TXT", name: "_cf-custom-hostname.acme.com", content: "abc-123" },
      ],
    );
    expect(r.overall_ok).toBe(true);
    expect(patchSeen).toBe(true);
  });

  it("returns permission_denied when PATCH 403s", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response("forbidden", { status: 403 });
      return new Response(JSON.stringify({ id: "z", name: "acme.com", records: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await applyIonosRecords(
      { apiKey: "p.s" },
      "z",
      [{ type: "CNAME", name: "www.acme.com", content: "customers.advocatemcp.com" }],
    );
    expect(r.overall_ok).toBe(false);
    expect(r.results[0]!.reason).toBe("permission_denied");
  });
});

describe("IONOS_APEX_A_IPS", () => {
  it("exposes our anycast apex IPs", () => {
    expect(IONOS_APEX_A_IPS.length).toBeGreaterThan(0);
    expect(IONOS_APEX_A_IPS).toContain("104.21.44.57");
  });
});
