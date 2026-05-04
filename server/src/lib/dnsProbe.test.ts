import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { probeDns } from "./dnsProbe";

describe("probeDns", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok when CNAME points to the expected target", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Answer: [
            { name: "www.example.com.", type: 5, data: "customers.advocatemcp.com." },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await probeDns("www.example.com", "customers.advocatemcp.com");

    expect(result.ok).toBe(true);
    expect(result.resolved_target).toBe("customers.advocatemcp.com");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloudflare-dns.com/dns-query?name=www.example.com&type=CNAME",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/dns-json" }) }),
    );
  });

  it("returns err when CNAME points to the wrong target", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Answer: [{ name: "www.example.com.", type: 5, data: "customers.wrongplace.io." }],
        }),
        { status: 200 },
      ),
    );

    const result = await probeDns("www.example.com", "customers.advocatemcp.com");

    expect(result.ok).toBe(false);
    expect(result.resolved_target).toBe("customers.wrongplace.io");
    expect(result.error).toMatch(/expected.*customers\.advocatemcp\.com/i);
  });

  it("returns err when no Answer is present", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Answer: [] }), { status: 200 }),
    );

    const result = await probeDns("www.example.com", "customers.advocatemcp.com");

    expect(result.ok).toBe(false);
    expect(result.resolved_target).toBeUndefined();
    expect(result.error).toMatch(/no CNAME/i);
  });

  it("returns err on fetch failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const result = await probeDns("www.example.com", "customers.advocatemcp.com");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/network down/);
  });

  it("is case-insensitive and tolerates trailing dots", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Answer: [{ name: "WWW.Example.COM.", type: 5, data: "Customers.AdvocateMCP.Com." }],
        }),
        { status: 200 },
      ),
    );

    const result = await probeDns("WWW.Example.COM", "customers.advocatemcp.com");

    expect(result.ok).toBe(true);
  });
});
