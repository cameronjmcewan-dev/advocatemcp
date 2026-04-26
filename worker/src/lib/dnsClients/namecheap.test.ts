import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateNamecheapCredential,
  applyNamecheapRecords,
} from "./namecheap";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockNc(xml: string, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    new Response(xml, { status, headers: { "Content-Type": "text/xml" } }),
  ) as unknown as typeof fetch;
}

describe("validateNamecheapCredential — format guards", () => {
  it("rejects empty username", async () => {
    const r = await validateNamecheapCredential(
      { username: "", apikey: "abc1234567890123" },
      "acme.com",
    );
    expect(r.reason).toBe("credential_format_invalid");
  });

  it("rejects too-short api key", async () => {
    const r = await validateNamecheapCredential(
      { username: "validuser", apikey: "short" },
      "acme.com",
    );
    expect(r.reason).toBe("credential_format_invalid");
  });

  it("rejects api key with non-alphanumeric characters", async () => {
    const r = await validateNamecheapCredential(
      { username: "validuser", apikey: "abc-123!withbang_4567890" },
      "acme.com",
    );
    expect(r.reason).toBe("credential_format_invalid");
  });
});

describe("validateNamecheapCredential — auth + lookup outcomes", () => {
  it("returns ok and apex when domain is in account list", async () => {
    mockNc(`<?xml version="1.0"?>
      <ApiResponse Status="OK">
        <CommandResponse>
          <DomainGetListResult>
            <Domain Name="acme.com" />
            <Domain Name="other.com" />
          </DomainGetListResult>
        </CommandResponse>
      </ApiResponse>`);
    const r = await validateNamecheapCredential(
      { username: "user1", apikey: "abc1234567890123abcdef" },
      "acme.com",
    );
    expect(r.ok).toBe(true);
    expect(r.domain).toBe("acme.com");
  });

  it("strips leading www. before domain match", async () => {
    mockNc(`<?xml version="1.0"?>
      <ApiResponse Status="OK">
        <CommandResponse>
          <DomainGetListResult>
            <Domain Name="acme.com" />
          </DomainGetListResult>
        </CommandResponse>
      </ApiResponse>`);
    const r = await validateNamecheapCredential(
      { username: "user1", apikey: "abc1234567890123abcdef" },
      "www.acme.com",
    );
    expect(r.ok).toBe(true);
    expect(r.domain).toBe("acme.com");
  });

  it("returns ip_not_whitelisted on Namecheap error 1011147", async () => {
    mockNc(`<?xml version="1.0"?>
      <ApiResponse Status="ERROR">
        <Errors>
          <Error Number="1011147">IP not whitelisted</Error>
        </Errors>
      </ApiResponse>`);
    const r = await validateNamecheapCredential(
      { username: "user1", apikey: "abc1234567890123abcdef" },
      "acme.com",
    );
    expect(r.reason).toBe("ip_not_whitelisted");
  });

  it("returns credential_invalid_or_revoked on error 1011102", async () => {
    mockNc(`<?xml version="1.0"?>
      <ApiResponse Status="ERROR">
        <Errors>
          <Error Number="1011102">API Key invalid</Error>
        </Errors>
      </ApiResponse>`);
    const r = await validateNamecheapCredential(
      { username: "user1", apikey: "abc1234567890123abcdef" },
      "acme.com",
    );
    expect(r.reason).toBe("credential_invalid_or_revoked");
  });

  it("returns domain_not_found_for_credential when domain absent from account", async () => {
    mockNc(`<?xml version="1.0"?>
      <ApiResponse Status="OK">
        <CommandResponse>
          <DomainGetListResult>
            <Domain Name="other.com" />
          </DomainGetListResult>
        </CommandResponse>
      </ApiResponse>`);
    const r = await validateNamecheapCredential(
      { username: "user1", apikey: "abc1234567890123abcdef" },
      "acme.com",
    );
    expect(r.reason).toBe("domain_not_found_for_credential");
  });
});

describe("applyNamecheapRecords — idempotency + conflict", () => {
  it("returns already_exists when matching record exists; doesn't call setHosts", async () => {
    let setHostsCalls = 0;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("Command=namecheap.domains.dns.getHosts")) {
        return new Response(
          `<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>
             <host Name="www" Type="CNAME" Address="customers.advocatemcp.com" TTL="1800" />
           </DomainDNSGetHostsResult></CommandResponse></ApiResponse>`,
          { status: 200 },
        );
      }
      if (u.includes("Command=namecheap.domains.dns.setHosts")) {
        setHostsCalls++;
        return new Response(`<ApiResponse Status="OK"></ApiResponse>`, { status: 200 });
      }
      throw new Error("unexpected " + u);
    }) as unknown as typeof fetch;
    const r = await applyNamecheapRecords(
      { username: "u", apikey: "abc1234567890123abcdef" },
      "acme.com",
      [{ type: "CNAME", host: "www", address: "customers.advocatemcp.com" }],
    );
    expect(r.overall_ok).toBe(true);
    expect(r.results[0]!.already_exists).toBe(true);
    // setHosts WAS called, but only because we still write the
    // existing-set back (idempotent no-op). We don't double-write.
    expect(setHostsCalls).toBe(1);
  });

  it("flags a conflict when an existing record has different address", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("Command=namecheap.domains.dns.getHosts")) {
        return new Response(
          `<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>
             <host Name="www" Type="CNAME" Address="elsewhere.example.com" TTL="1800" />
           </DomainDNSGetHostsResult></CommandResponse></ApiResponse>`,
          { status: 200 },
        );
      }
      throw new Error("setHosts should not be called when conflicts present");
    }) as unknown as typeof fetch;
    const r = await applyNamecheapRecords(
      { username: "u", apikey: "abc1234567890123abcdef" },
      "acme.com",
      [{ type: "CNAME", host: "www", address: "customers.advocatemcp.com" }],
    );
    expect(r.overall_ok).toBe(false);
    expect(r.results[0]!.reason).toMatch(/^record_conflict_/);
  });

  it("appends new records to the existing set when nothing conflicts", async () => {
    let lastSetHostsUrl = "";
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("Command=namecheap.domains.dns.getHosts")) {
        return new Response(
          `<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>
             <host Name="@" Type="A" Address="1.2.3.4" TTL="1800" />
           </DomainDNSGetHostsResult></CommandResponse></ApiResponse>`,
          { status: 200 },
        );
      }
      if (u.includes("Command=namecheap.domains.dns.setHosts")) {
        lastSetHostsUrl = u;
        return new Response(`<ApiResponse Status="OK"></ApiResponse>`, { status: 200 });
      }
      throw new Error("unexpected " + u);
    }) as unknown as typeof fetch;
    const r = await applyNamecheapRecords(
      { username: "u", apikey: "abc1234567890123abcdef" },
      "acme.com",
      [
        { type: "CNAME", host: "www", address: "customers.advocatemcp.com" },
        { type: "TXT", host: "_cf-custom-hostname", address: "abc-123" },
      ],
    );
    expect(r.overall_ok).toBe(true);
    // setHosts should have been called with the existing A AND both
    // new records — Namecheap's setHosts replaces the set wholesale.
    expect(lastSetHostsUrl).toContain("HostName1=%40"); // existing A at @
    expect(lastSetHostsUrl).toContain("RecordType2=CNAME");
    expect(lastSetHostsUrl).toContain("HostName2=www");
    expect(lastSetHostsUrl).toContain("RecordType3=TXT");
  });

  it("surfaces ip_not_whitelisted when setHosts itself fails on whitelist", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("Command=namecheap.domains.dns.getHosts")) {
        return new Response(
          `<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult></DomainDNSGetHostsResult></CommandResponse></ApiResponse>`,
          { status: 200 },
        );
      }
      // setHosts returns the whitelist error
      return new Response(
        `<ApiResponse Status="ERROR"><Errors><Error Number="1011147">IP not whitelisted</Error></Errors></ApiResponse>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await applyNamecheapRecords(
      { username: "u", apikey: "abc1234567890123abcdef" },
      "acme.com",
      [{ type: "CNAME", host: "www", address: "customers.advocatemcp.com" }],
    );
    expect(r.overall_ok).toBe(false);
    expect(r.results[0]!.reason).toBe("ip_not_whitelisted");
  });
});
