import { describe, it, expect, vi, afterEach } from "vitest";
import { detectDnsProvider, providerDisplayName } from "./dnsProvider";

/* dnsProvider.test.ts — unit tests for the NS-based provider detector.
 *
 * We mock globalThis.fetch since detectDnsProvider hits Cloudflare's DoH
 * endpoint. Each test stubs a different DoH response shape and asserts
 * the classifier picks the right provider id. */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockDohAnswer(nsRecords: string[]) {
  globalThis.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({
        Status: 0,
        Answer: nsRecords.map((ns) => ({
          name: "example.com.",
          type: 2,
          TTL: 3600,
          data: ns + ".",
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/dns-json" } },
    ),
  ) as unknown as typeof fetch;
}

describe("detectDnsProvider — known providers", () => {
  it("identifies GoDaddy via domaincontrol.com", async () => {
    mockDohAnswer(["ns35.domaincontrol.com", "ns36.domaincontrol.com"]);
    const r = await detectDnsProvider("workmancopyco.com");
    expect(r.provider).toBe("godaddy");
    expect(r.nameservers).toContain("ns35.domaincontrol.com");
  });

  it("identifies GoDaddy via secureserver.net (legacy)", async () => {
    mockDohAnswer(["ns1.secureserver.net", "ns2.secureserver.net"]);
    const r = await detectDnsProvider("acme.com");
    expect(r.provider).toBe("godaddy");
  });

  it("identifies Squarespace via squarespacedns.com", async () => {
    mockDohAnswer(["ns1.squarespacedns.com", "ns2.squarespacedns.com"]);
    expect((await detectDnsProvider("acme.com")).provider).toBe("squarespace");
  });

  it("identifies Namecheap via registrar-servers.com", async () => {
    mockDohAnswer(["dns1.registrar-servers.com", "dns2.registrar-servers.com"]);
    expect((await detectDnsProvider("acme.com")).provider).toBe("namecheap");
  });

  it("identifies Cloudflare via *.ns.cloudflare.com", async () => {
    mockDohAnswer(["lola.ns.cloudflare.com", "max.ns.cloudflare.com"]);
    expect((await detectDnsProvider("acme.com")).provider).toBe("cloudflare");
  });

  it("identifies Wix via wixdns.net", async () => {
    mockDohAnswer(["ns1.wixdns.net", "ns2.wixdns.net"]);
    expect((await detectDnsProvider("acme.com")).provider).toBe("wix");
  });

  it("identifies AWS Route 53 via awsdns- pattern", async () => {
    mockDohAnswer(["ns-123.awsdns-12.com", "ns-456.awsdns-34.org"]);
    expect((await detectDnsProvider("acme.com")).provider).toBe("route53");
  });

  it("identifies Google Domains via domains.google", async () => {
    mockDohAnswer(["ns-cloud-a1.googledomains.com", "ns-cloud-b2.googledomains.com"]);
    expect((await detectDnsProvider("acme.com")).provider).toBe("google-domains");
  });
});

describe("detectDnsProvider — fallback paths", () => {
  it("returns 'other' when no NS records match any known pattern", async () => {
    mockDohAnswer(["ns1.exotic-host-xyz.com", "ns2.exotic-host-xyz.com"]);
    const r = await detectDnsProvider("acme.com");
    expect(r.provider).toBe("other");
    expect(r.nameservers.length).toBe(2);
  });

  it("returns 'other' on empty input", async () => {
    const r = await detectDnsProvider("");
    expect(r.provider).toBe("other");
    expect(r.nameservers).toEqual([]);
  });

  it("returns 'other' when DoH returns a non-2xx response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("error", { status: 502 }),
    ) as unknown as typeof fetch;
    const r = await detectDnsProvider("acme.com");
    expect(r.provider).toBe("other");
  });

  it("returns 'other' when DoH returns no Answer array", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ Status: 0 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const r = await detectDnsProvider("acme.com");
    expect(r.provider).toBe("other");
    expect(r.nameservers).toEqual([]);
  });

  it("never throws on fetch error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network blip");
    }) as unknown as typeof fetch;
    const r = await detectDnsProvider("acme.com");
    expect(r.provider).toBe("other");
  });

  it("returns 'other' if fetch times out (AbortError)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("Aborted", "AbortError");
    }) as unknown as typeof fetch;
    const r = await detectDnsProvider("acme.com");
    expect(r.provider).toBe("other");
  });
});

describe("detectDnsProvider — input normalization", () => {
  it("lowercases and trims input before sending to DoH", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      // Spy: confirm the URL has the lowercased trimmed name.
      expect(url).toContain("name=acme.com");
      return new Response(
        JSON.stringify({ Status: 0, Answer: [] }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await detectDnsProvider("  Acme.COM  ");
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("providerDisplayName", () => {
  it("returns human-readable names for every provider id", () => {
    expect(providerDisplayName("godaddy")).toBe("GoDaddy");
    expect(providerDisplayName("squarespace")).toBe("Squarespace");
    expect(providerDisplayName("namecheap")).toBe("Namecheap");
    expect(providerDisplayName("cloudflare")).toBe("Cloudflare");
    expect(providerDisplayName("google-domains")).toBe("Google Domains");
    expect(providerDisplayName("wix")).toBe("Wix");
    expect(providerDisplayName("route53")).toBe("AWS Route 53");
    expect(providerDisplayName("shopify")).toBe("Shopify");
    expect(providerDisplayName("ionos")).toBe("IONOS");
    expect(providerDisplayName("hostgator")).toBe("HostGator");
    expect(providerDisplayName("bluehost")).toBe("Bluehost");
  });

  it("falls back gracefully for the 'other' bucket", () => {
    expect(providerDisplayName("other")).toBe("your DNS provider");
  });
});
