import { describe, it, expect } from "vitest";
import { appendQuery } from "./appendQuery.js";

describe("appendQuery", () => {
  it("appends a key to a URL with no query string", () => {
    expect(appendQuery("https://example.com/path", "amcp_t", "abc"))
      .toBe("https://example.com/path?amcp_t=abc");
  });

  it("appends to a URL that already has a query string", () => {
    expect(appendQuery("https://example.com/?utm=x", "amcp_t", "abc"))
      .toBe("https://example.com/?utm=x&amcp_t=abc");
  });

  it("preserves the fragment", () => {
    expect(appendQuery("https://example.com/path#section", "k", "v"))
      .toBe("https://example.com/path?k=v#section");
  });

  it("replaces an existing value for the same key rather than duplicating", () => {
    expect(appendQuery("https://example.com/?amcp_t=old", "amcp_t", "new"))
      .toBe("https://example.com/?amcp_t=new");
  });

  it("URL-encodes special characters in the value", () => {
    const out = appendQuery("https://example.com/", "k", "a b&c");
    // URL serialization uses + for space and encodes &.
    expect(out).toMatch(/k=a(\+|%20)b%26c/);
  });

  it("returns the input unchanged if the URL is not parseable", () => {
    expect(appendQuery("not a url", "k", "v")).toBe("not a url");
    expect(appendQuery("", "k", "v")).toBe("");
  });
});
