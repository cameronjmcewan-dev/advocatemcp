import { describe, it, expect } from "vitest";
import { canonicalDomain, isCitationOfTenant } from "./domainMatch.js";

describe("canonicalDomain", () => {
  it.each([
    ["http://tenant.com/path",       "tenant.com"],
    ["https://www.tenant.com",       "tenant.com"],
    ["https://tenant.com/",          "tenant.com"],
    ["https://tenant.com?q=1",       "tenant.com"],
    ["https://tenant.com#frag",      "tenant.com"],
    ["https://tenant.com:8080",      "tenant.com"],
    ["tenant.com",                   "tenant.com"],
    ["WWW.TENANT.COM",               "tenant.com"],
    ["",                             ""],
    ["not a url",                    ""],
    ["shop.tenant.com",              "shop.tenant.com"],
    ["https://sub.tenant.co.uk/x",   "sub.tenant.co.uk"],
  ])("canonicalizes %s → %s", (input, expected) => {
    expect(canonicalDomain(input)).toBe(expected);
  });
});

describe("isCitationOfTenant", () => {
  it("matches on equal canonical domains", () => {
    expect(isCitationOfTenant("https://www.tenant.com/about", "tenant.com")).toBe(true);
  });
  it("returns false for different domains", () => {
    expect(isCitationOfTenant("https://yelp.com/biz/tenant", "tenant.com")).toBe(false);
  });
  it("returns false when subdomain differs (strict match v1)", () => {
    expect(isCitationOfTenant("https://shop.tenant.com", "tenant.com")).toBe(false);
  });
  it("returns false when tenant website is null", () => {
    expect(isCitationOfTenant("https://tenant.com", null)).toBe(false);
  });
  it("returns false on unparseable citation url", () => {
    expect(isCitationOfTenant("not a url", "tenant.com")).toBe(false);
  });
});
