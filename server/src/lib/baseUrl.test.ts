import { describe, it, expect, afterEach } from "vitest";
import { getApiBaseUrl } from "./baseUrl.js";

const ORIG_API_BASE_URL = process.env.API_BASE_URL;
const ORIG_NODE_ENV = process.env.NODE_ENV;

describe("getApiBaseUrl", () => {
  afterEach(() => {
    if (ORIG_API_BASE_URL === undefined) {
      delete process.env.API_BASE_URL;
    } else {
      process.env.API_BASE_URL = ORIG_API_BASE_URL;
    }
    if (ORIG_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIG_NODE_ENV;
    }
  });

  it("returns the env value when set, regardless of NODE_ENV", () => {
    process.env.API_BASE_URL = "https://example.test";
    process.env.NODE_ENV = "production";
    expect(getApiBaseUrl()).toBe("https://example.test");
  });

  it("returns the env value when set in dev too", () => {
    process.env.API_BASE_URL = "https://dev.example.test";
    process.env.NODE_ENV = "development";
    expect(getApiBaseUrl()).toBe("https://dev.example.test");
  });

  it("throws when env is unset in production — refuses to publish a fallback URL", () => {
    delete process.env.API_BASE_URL;
    process.env.NODE_ENV = "production";
    expect(() => getApiBaseUrl()).toThrow(/API_BASE_URL/);
  });

  it("falls back to http://localhost:3000 when env unset in dev", () => {
    delete process.env.API_BASE_URL;
    process.env.NODE_ENV = "development";
    expect(getApiBaseUrl()).toBe("http://localhost:3000");
  });

  it("falls back to http://localhost:3000 when env unset and NODE_ENV is undefined", () => {
    delete process.env.API_BASE_URL;
    delete process.env.NODE_ENV;
    expect(getApiBaseUrl()).toBe("http://localhost:3000");
  });
});
