import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateRoute53Credential,
  applyRoute53Records,
  ROUTE53_APEX_A_IPS,
} from "./route53";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("validateRoute53Credential — format guards", () => {
  it("rejects empty access key or secret", async () => {
    expect((await validateRoute53Credential({ accessKeyId: "", secretAccessKey: "abcdefghij1234567890" }, "acme.com")).reason)
      .toBe("credential_format_invalid");
    expect((await validateRoute53Credential({ accessKeyId: "AKIAVALIDLOOKING1234", secretAccessKey: "" }, "acme.com")).reason)
      .toBe("credential_format_invalid");
  });

  it("rejects too-short access key", async () => {
    const r = await validateRoute53Credential({ accessKeyId: "AKIA", secretAccessKey: "abcdefghij1234567890" }, "acme.com");
    expect(r.reason).toBe("credential_format_invalid");
  });

  it("rejects characters outside the AWS key alphabet", async () => {
    const r = await validateRoute53Credential(
      { accessKeyId: "AKIA WITH SPACES INSIDE", secretAccessKey: "abcdefghij1234567890" },
      "acme.com",
    );
    expect(r.reason).toBe("credential_format_invalid");
  });
});

describe("validateRoute53Credential — auth + lookup outcomes", () => {
  it("returns ok and zone id when zone is found", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        `<?xml version="1.0"?>
        <ListHostedZonesByNameResponse>
          <HostedZones>
            <HostedZone>
              <Id>/hostedzone/Z1234ABCD</Id>
              <Name>acme.com.</Name>
              <Config><PrivateZone>false</PrivateZone></Config>
            </HostedZone>
          </HostedZones>
        </ListHostedZonesByNameResponse>`,
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const r = await validateRoute53Credential(
      { accessKeyId: "AKIAVALIDLOOKING1234", secretAccessKey: "secretvaluelongenough123" },
      "acme.com",
    );
    expect(r.ok).toBe(true);
    expect(r.hosted_zone_id).toBe("Z1234ABCD");
    expect(r.zone_name).toBe("acme.com");
  });

  it("strips leading www. before zone match", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        `<ListHostedZonesByNameResponse><HostedZones><HostedZone>
          <Id>/hostedzone/Z9999</Id><Name>acme.com.</Name>
        </HostedZone></HostedZones></ListHostedZonesByNameResponse>`,
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const r = await validateRoute53Credential(
      { accessKeyId: "AKIAVALIDLOOKING1234", secretAccessKey: "secretvaluelongenough123" },
      "www.acme.com",
    );
    expect(r.ok).toBe(true);
    expect(r.hosted_zone_id).toBe("Z9999");
  });

  it("returns credential_invalid_or_revoked on 403", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<Error><Code>InvalidClientTokenId</Code></Error>", { status: 403 }),
    ) as unknown as typeof fetch;
    const r = await validateRoute53Credential(
      { accessKeyId: "AKIAVALIDLOOKING1234", secretAccessKey: "secretvaluelongenough123" },
      "acme.com",
    );
    expect(r.reason).toBe("credential_invalid_or_revoked");
  });

  it("returns domain_not_found_for_credential when no matching zone", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        `<ListHostedZonesByNameResponse><HostedZones></HostedZones></ListHostedZonesByNameResponse>`,
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const r = await validateRoute53Credential(
      { accessKeyId: "AKIAVALIDLOOKING1234", secretAccessKey: "secretvaluelongenough123" },
      "acme.com",
    );
    expect(r.reason).toBe("domain_not_found_for_credential");
  });
});

describe("applyRoute53Records", () => {
  it("submits an UPSERT change batch and returns ok on 200", async () => {
    let observedBody = "";
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedBody = String(init?.body ?? "");
      return new Response(
        `<ChangeResourceRecordSetsResponse><ChangeInfo><Status>PENDING</Status></ChangeInfo></ChangeResourceRecordSetsResponse>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await applyRoute53Records(
      { accessKeyId: "AKIAVALIDLOOKING1234", secretAccessKey: "secretvaluelongenough123" },
      "Z1234ABCD",
      [
        { type: "CNAME", name: "www.acme.com.", values: ["customers.advocatemcp.com"] },
        { type: "TXT",   name: "_cf-custom-hostname.acme.com.", values: ["abc-123"] },
      ],
    );
    expect(r.overall_ok).toBe(true);
    expect(observedBody).toContain("<Action>UPSERT</Action>");
    expect(observedBody).toContain("<Type>CNAME</Type>");
    // TXT records get wrapped in escaped quotes per Route53 convention.
    expect(observedBody).toContain("&quot;abc-123&quot;");
  });

  it("returns permission_denied on 403", async () => {
    globalThis.fetch = vi.fn(async () => new Response("<Error/>", { status: 403 })) as unknown as typeof fetch;
    const r = await applyRoute53Records(
      { accessKeyId: "AKIAVALIDLOOKING1234", secretAccessKey: "secretvaluelongenough123" },
      "Z1234ABCD",
      [{ type: "CNAME", name: "www.acme.com.", values: ["customers.advocatemcp.com"] }],
    );
    expect(r.overall_ok).toBe(false);
    expect(r.results[0]!.reason).toBe("permission_denied");
  });

  it("flags conflicts when Route53 returns InvalidChangeBatch", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        `<ErrorResponse><Error><Code>InvalidChangeBatch</Code></Error></ErrorResponse>`,
        { status: 400 },
      ),
    ) as unknown as typeof fetch;
    const r = await applyRoute53Records(
      { accessKeyId: "AKIAVALIDLOOKING1234", secretAccessKey: "secretvaluelongenough123" },
      "Z1234ABCD",
      [{ type: "CNAME", name: "www.acme.com.", values: ["customers.advocatemcp.com"] }],
    );
    expect(r.results[0]!.reason).toBe("record_conflict");
  });
});

describe("ROUTE53_APEX_A_IPS", () => {
  it("exposes our anycast apex IPs for static-A apex routing", () => {
    expect(ROUTE53_APEX_A_IPS).toContain("104.21.44.57");
    expect(ROUTE53_APEX_A_IPS).toContain("172.67.195.220");
  });
});
