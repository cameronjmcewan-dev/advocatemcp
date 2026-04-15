import { describe, it, expect } from "vitest";
import { desiredHostnameSpec } from "./hostnameSpec.js";

describe("desiredHostnameSpec", () => {
  it("returns the canonical CF custom hostname config for a given hostname", () => {
    const spec = desiredHostnameSpec("www.workmancopyco.com");
    expect(spec).toEqual({
      hostname: "www.workmancopyco.com",
      custom_origin_server: "customers.advocatemcp.com",
      ssl: {
        method: "txt",
        type: "dv",
        settings: { min_tls_version: "1.2" },
      },
    });
  });

  it("passes through the hostname verbatim without lowercasing or trimming", () => {
    const spec = desiredHostnameSpec("Foo.Example.Com");
    expect(spec.hostname).toBe("Foo.Example.Com");
  });
});
