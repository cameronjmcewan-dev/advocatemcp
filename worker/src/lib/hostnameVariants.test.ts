import { describe, it, expect } from "vitest";
import {
  normalizeHostname,
  deriveHostnameVariants,
  classifyVariant,
} from "./hostnameVariants.js";

describe("normalizeHostname", () => {
  it("strips protocol, path, query, hash, port", () => {
    expect(normalizeHostname("https://www.acme.com/x?y=1#z")).toBe("www.acme.com");
    expect(normalizeHostname("http://acme.com:8080/foo")).toBe("acme.com");
  });

  it("lowercases the hostname", () => {
    expect(normalizeHostname("WWW.Acme.Com")).toBe("www.acme.com");
  });

  it("trims whitespace", () => {
    expect(normalizeHostname("  acme.com  ")).toBe("acme.com");
  });

  it("rejects empty / dotless / localhost / IP / leading-dot inputs", () => {
    expect(normalizeHostname("")).toBeNull();
    expect(normalizeHostname("acme")).toBeNull();
    expect(normalizeHostname("localhost")).toBeNull();
    expect(normalizeHostname("127.0.0.1")).toBeNull();
    expect(normalizeHostname(".acme.com")).toBeNull();
    expect(normalizeHostname("acme.com.")).toBeNull();
    expect(normalizeHostname("ac..me.com")).toBeNull();
    expect(normalizeHostname("acme com")).toBeNull(); // space in body
  });
});

describe("deriveHostnameVariants — gTLD apex cases", () => {
  it("acme.com → both apex and www variants", () => {
    expect(deriveHostnameVariants("acme.com")).toEqual(["acme.com", "www.acme.com"]);
  });

  it("www.acme.com → strips www and produces both", () => {
    expect(deriveHostnameVariants("www.acme.com")).toEqual(["acme.com", "www.acme.com"]);
  });

  it("WCC's actual case: workmancopyco.com → both", () => {
    expect(deriveHostnameVariants("workmancopyco.com")).toEqual([
      "workmancopyco.com",
      "www.workmancopyco.com",
    ]);
  });

  it("WCC's www variant: www.workmancopyco.com → both", () => {
    expect(deriveHostnameVariants("www.workmancopyco.com")).toEqual([
      "workmancopyco.com",
      "www.workmancopyco.com",
    ]);
  });
});

describe("deriveHostnameVariants — multi-label TLD apex cases", () => {
  it("acme.co.uk → both apex and www", () => {
    expect(deriveHostnameVariants("acme.co.uk")).toEqual([
      "acme.co.uk",
      "www.acme.co.uk",
    ]);
  });

  it("www.acme.co.uk → strips www, produces both", () => {
    expect(deriveHostnameVariants("www.acme.co.uk")).toEqual([
      "acme.co.uk",
      "www.acme.co.uk",
    ]);
  });

  it("acme.com.au → both", () => {
    expect(deriveHostnameVariants("acme.com.au")).toEqual([
      "acme.com.au",
      "www.acme.com.au",
    ]);
  });
});

describe("deriveHostnameVariants — custom subdomains stay as-is", () => {
  it("shop.acme.com → only shop.acme.com (don't auto-add apex/www)", () => {
    expect(deriveHostnameVariants("shop.acme.com")).toEqual(["shop.acme.com"]);
  });

  it("blog.acme.co.uk → only itself (4-label, not www-prefixed)", () => {
    expect(deriveHostnameVariants("blog.acme.co.uk")).toEqual(["blog.acme.co.uk"]);
  });

  it("nested subdomain stays as-is", () => {
    expect(deriveHostnameVariants("api.v2.acme.com")).toEqual(["api.v2.acme.com"]);
  });
});

describe("deriveHostnameVariants — hosted-tenant subdomains skip variant derivation", () => {
  it("foo.hosted.advocatemcp.com → only itself (no apex/www variant)", () => {
    expect(deriveHostnameVariants("foo.hosted.advocatemcp.com")).toEqual([
      "foo.hosted.advocatemcp.com",
    ]);
  });

  it("hyphenated hosted slug stays as-is", () => {
    expect(deriveHostnameVariants("workman-copy-co.hosted.advocatemcp.com")).toEqual([
      "workman-copy-co.hosted.advocatemcp.com",
    ]);
  });
});

describe("deriveHostnameVariants — invalid inputs return []", () => {
  it("empty string", () => {
    expect(deriveHostnameVariants("")).toEqual([]);
  });
  it("localhost", () => {
    expect(deriveHostnameVariants("localhost")).toEqual([]);
  });
  it("IPv4 literal", () => {
    expect(deriveHostnameVariants("10.0.0.1")).toEqual([]);
  });
});

describe("classifyVariant", () => {
  it("apex domains (2-label gTLD)", () => {
    expect(classifyVariant("acme.com")).toBe("apex");
    expect(classifyVariant("workmancopyco.com")).toBe("apex");
  });

  it("apex domains (multi-label TLD)", () => {
    expect(classifyVariant("acme.co.uk")).toBe("apex");
    expect(classifyVariant("acme.com.au")).toBe("apex");
  });

  it("www subdomains", () => {
    expect(classifyVariant("www.acme.com")).toBe("www");
    expect(classifyVariant("www.acme.co.uk")).toBe("www");
  });

  it("other subdomains", () => {
    expect(classifyVariant("shop.acme.com")).toBe("other");
    expect(classifyVariant("foo.hosted.advocatemcp.com")).toBe("other");
  });
});

describe("deriveHostnameVariants — input format normalization", () => {
  it("accepts URL with protocol and path, returns variant set", () => {
    expect(deriveHostnameVariants("https://www.acme.com/foo?bar=1")).toEqual([
      "acme.com",
      "www.acme.com",
    ]);
  });

  it("idempotent: re-running on each output element produces the same set", () => {
    const expected = ["acme.com", "www.acme.com"];
    expect(deriveHostnameVariants("acme.com")).toEqual(expected);
    expect(deriveHostnameVariants("www.acme.com")).toEqual(expected);
    // Either variant fed back in produces the same variant set.
    for (const v of expected) {
      expect(deriveHostnameVariants(v)).toEqual(expected);
    }
  });
});
