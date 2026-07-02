/**
 * Characterization tests for the /onboard admin-auth surface — captured
 * BEFORE the credential-exposure fix so the pre-change contract is recorded
 * and the surviving invariants (input validation ordering, HTML shape) are
 * protected through the auth-mechanism change.
 *
 * Two handlers:
 *   - handleOnboardPage    (GET  /onboard)            — onboardPage.ts
 *   - handleBasicOnboard   (POST /api/onboard/basic)  — stripe.ts
 *
 * Current (pre-fix) behavior locked in here:
 *   - the page is served to any caller with no auth, and
 *   - the endpoint authenticates against the env-sourced ADMIN_SECRET via an
 *     X-Admin-Secret header.
 *
 * The follow-up commit changes both to an admin-session model and rewrites
 * the auth assertions accordingly; the validation assertions carry over
 * unchanged.
 */

import { describe, it, expect } from "vitest";
import type { Env } from "../types";
import { handleOnboardPage } from "./onboardPage";
import { handleBasicOnboard } from "./stripe";

const ADMIN_SECRET = "test-admin-secret-value";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_SECRET,
    ...overrides,
  } as unknown as Env;
}

describe("handleOnboardPage (GET /onboard) — pre-fix behavior", () => {
  it("serves the wizard HTML with no auth", async () => {
    const request = new Request("https://customers.advocatemcp.com/onboard");
    const response = await handleOnboardPage(request, makeEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    // The wizard's client-side API helper currently sets an admin-secret
    // header — the exposure this PR removes.
    expect(body).toContain("X-Admin-Secret");
  });
});

describe("handleBasicOnboard (POST /api/onboard/basic) — pre-fix behavior", () => {
  function makeRequest(secret: string | undefined, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    if (secret !== undefined) headers.set("X-Admin-Secret", secret);
    return new Request("https://customers.advocatemcp.com/api/onboard/basic", {
      method: "POST",
      ...init,
      headers,
    });
  }

  it("rejects with 401 when the X-Admin-Secret header is missing", async () => {
    const response = await handleBasicOnboard(makeRequest(undefined), makeEnv());
    expect(response.status).toBe(401);
  });

  it("rejects with 401 when the X-Admin-Secret header is wrong", async () => {
    const response = await handleBasicOnboard(makeRequest("nope"), makeEnv());
    expect(response.status).toBe(401);
  });

  it("passes auth with the matching secret, then enforces JSON content-type (415)", async () => {
    const response = await handleBasicOnboard(
      makeRequest(ADMIN_SECRET, { body: "not-json", headers: { "Content-Type": "text/plain" } }),
      makeEnv(),
    );
    expect(response.status).toBe(415);
  });

  it("passes auth with the matching secret, then rejects a body missing required fields (400)", async () => {
    const response = await handleBasicOnboard(
      makeRequest(ADMIN_SECRET, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }),
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });
});
