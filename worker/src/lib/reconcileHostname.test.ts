/**
 * Tests for worker/src/lib/reconcileHostname.ts
 *
 * Dependency-inject the cfRequest function to avoid stubbing globalThis.fetch
 * (matches the FetchFn pattern in origin-discovery.test.ts).
 */

import { describe, it, expect, vi } from "vitest";
import { reconcileHostname, type CfRequestFn } from "./reconcileHostname.js";
import { desiredHostnameSpec } from "./hostnameSpec.js";
import type { Env } from "../types.js";

const env = {} as Env;  // reconcileHostname only passes env through to cfRequest

function cfRequestOk(data: Record<string, unknown>): CfRequestFn {
  return vi.fn().mockResolvedValue({ ok: true, data });
}

function cfRequestFail(message = "cf_error"): CfRequestFn {
  return vi.fn().mockResolvedValue({ ok: false, data: { error: message } });
}

describe("reconcileHostname", () => {
  const desired = desiredHostnameSpec("www.example.com");

  it("returns patched=false and fires no PATCH when cfResult matches spec", async () => {
    const actual = {
      id: "abc123",
      hostname: "www.example.com",
      custom_origin_server: "advocatemcp-worker.advocatecameron.workers.dev",
      ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
    };
    const cfRequest = cfRequestOk({});
    const result = await reconcileHostname(env, actual, desired, cfRequest);

    expect(result.ok).toBe(true);
    expect(result.patched).toBe(false);
    expect(result.drift).toEqual([]);
    expect(result.cfResult).toBe(actual);
    expect(cfRequest).not.toHaveBeenCalled();
  });

  it("PATCHes only the drifting fields when custom_origin_server is missing", async () => {
    const actual = {
      id: "abc123",
      hostname: "www.example.com",
      // custom_origin_server missing entirely (legacy record)
      ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
    };
    const patched = { ...actual, custom_origin_server: "advocatemcp-worker.advocatecameron.workers.dev" };
    const cfRequest = cfRequestOk({ result: patched });
    const result = await reconcileHostname(env, actual, desired, cfRequest);

    expect(result.ok).toBe(true);
    expect(result.patched).toBe(true);
    expect(result.drift).toEqual(["custom_origin_server"]);
    expect(result.cfResult).toEqual(patched);
    expect(cfRequest).toHaveBeenCalledTimes(1);
    expect(cfRequest).toHaveBeenCalledWith(
      env,
      "PATCH",
      "/abc123",
      { custom_origin_server: "advocatemcp-worker.advocatecameron.workers.dev" },
    );
  });

  it("PATCHes ssl.settings.min_tls_version when it drifts from spec", async () => {
    const actual = {
      id: "abc123",
      hostname: "www.example.com",
      custom_origin_server: "advocatemcp-worker.advocatecameron.workers.dev",
      ssl: { method: "txt", settings: { min_tls_version: "1.0" } },
    };
    const cfRequest = cfRequestOk({ result: { ...actual, ssl: { method: "txt", settings: { min_tls_version: "1.2" } } } });
    const result = await reconcileHostname(env, actual, desired, cfRequest);

    expect(result.patched).toBe(true);
    expect(result.drift).toEqual(["ssl.settings.min_tls_version"]);
    expect(cfRequest).toHaveBeenCalledWith(
      env,
      "PATCH",
      "/abc123",
      { ssl: { settings: { min_tls_version: "1.2" } } },
    );
  });

  it("returns ok=false with error when the PATCH call fails", async () => {
    const actual = {
      id: "abc123",
      hostname: "www.example.com",
      ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
    };
    const cfRequest = cfRequestFail("cf_unreachable");
    const result = await reconcileHostname(env, actual, desired, cfRequest);

    expect(result.ok).toBe(false);
    expect(result.patched).toBe(false);
    expect(result.error).toContain("cf_unreachable");
    expect(result.cfResult).toBe(actual);  // unchanged on failure
  });
});
