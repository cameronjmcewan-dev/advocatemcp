/**
 * Auth + credential-exposure tests for the /onboard admin surface.
 *
 * Two handlers:
 *   - handleOnboardPage    (GET  /onboard)            — onboardPage.ts
 *   - handleBasicOnboard   (POST /api/onboard/basic)  — stripe.ts
 *
 * Contract enforced here:
 *   - The served wizard HTML never embeds a credential (the admin secret was
 *     formerly hardcoded into the page's client-side apiFetch helper and
 *     shipped to every visitor). Authentication rides the portal session
 *     cookie instead.
 *   - Both surfaces gate on an ADMIN *session* (getSessionFromRequest →
 *     role === "admin"), never a client-supplied header secret. Auth is
 *     driven entirely by the session — flipping the session flips the
 *     outcome — so there is no hardcoded comparison constant to leak.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../types";

vi.mock("./authApi", () => ({
  getSessionFromRequest: vi.fn(),
}));

import { getSessionFromRequest } from "./authApi";
import { handleOnboardPage } from "./onboardPage";
import { handleBasicOnboard } from "./stripe";

const mockedSession = vi.mocked(getSessionFromRequest);

// A representative admin secret injected into the test env. If any handler
// ever embeds it in served output, the credential-exposure assertions fail.
const REPRESENTATIVE_ADMIN_SECRET = "REPRESENTATIVE-ADMIN-SECRET-MUST-NOT-APPEAR-IN-HTML";

// Shape of a real credential literal (32-char high-entropy alnum), used only
// to assert served HTML contains no such literal — never a real value.
const CREDENTIAL_LITERAL_SHAPE = /['"][A-Za-z0-9]{32,}['"]/;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_SECRET: REPRESENTATIVE_ADMIN_SECRET,
    ...overrides,
  } as unknown as Env;
}

function adminSession() {
  return { user_id: "admin-1", email: "admin@advocate.test", role: "admin" } as Awaited<
    ReturnType<typeof getSessionFromRequest>
  >;
}

function clientSession() {
  return { user_id: "client-1", email: "client@advocate.test", role: "client" } as Awaited<
    ReturnType<typeof getSessionFromRequest>
  >;
}

beforeEach(() => {
  mockedSession.mockReset();
});

describe("handleOnboardPage (GET /onboard)", () => {
  function request(): Request {
    return new Request("https://customers.advocatemcp.com/onboard");
  }

  it("redirects to /login when there is no session", async () => {
    mockedSession.mockResolvedValue(null);
    const response = await handleOnboardPage(request(), makeEnv());
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("redirects to /login for a non-admin session", async () => {
    mockedSession.mockResolvedValue(clientSession());
    const response = await handleOnboardPage(request(), makeEnv());
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("serves the wizard HTML for an admin session", async () => {
    mockedSession.mockResolvedValue(adminSession());
    const response = await handleOnboardPage(request(), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never embeds a credential in the served HTML", async () => {
    mockedSession.mockResolvedValue(adminSession());
    const response = await handleOnboardPage(request(), makeEnv());
    const body = await response.text();

    // The representative admin secret must never reach the client.
    expect(body).not.toContain(REPRESENTATIVE_ADMIN_SECRET);
    // No admin-secret header assignment survives in client JS.
    expect(body).not.toContain("X-Admin-Secret");
    // No high-entropy 32+ char literal (a credential shape) in the output.
    expect(body).not.toMatch(CREDENTIAL_LITERAL_SHAPE);
    // The wizard now authenticates via the same-origin session cookie.
    expect(body).toContain("credentials");
  });
});

describe("handleBasicOnboard (POST /api/onboard/basic)", () => {
  function request(init: RequestInit = {}): Request {
    return new Request("https://customers.advocatemcp.com/api/onboard/basic", {
      method: "POST",
      ...init,
    });
  }

  it("rejects with 401 when there is no session", async () => {
    mockedSession.mockResolvedValue(null);
    const response = await handleBasicOnboard(request(), makeEnv());
    expect(response.status).toBe(401);
  });

  it("rejects with 403 for a non-admin session", async () => {
    mockedSession.mockResolvedValue(clientSession());
    const response = await handleBasicOnboard(request(), makeEnv());
    expect(response.status).toBe(403);
  });

  it("rejects with 401 even when a correct-looking X-Admin-Secret header is sent but no session exists", async () => {
    // Proves the header-secret path is gone: auth is session-only.
    mockedSession.mockResolvedValue(null);
    const response = await handleBasicOnboard(
      request({ headers: { "X-Admin-Secret": REPRESENTATIVE_ADMIN_SECRET } }),
      makeEnv(),
    );
    expect(response.status).toBe(401);
  });

  it("passes auth for an admin session, then enforces JSON content-type (415)", async () => {
    mockedSession.mockResolvedValue(adminSession());
    const response = await handleBasicOnboard(
      request({ body: "not-json", headers: { "Content-Type": "text/plain" } }),
      makeEnv(),
    );
    expect(response.status).toBe(415);
  });

  it("passes auth for an admin session, then rejects a body missing required fields (400)", async () => {
    mockedSession.mockResolvedValue(adminSession());
    const response = await handleBasicOnboard(
      request({ body: JSON.stringify({}), headers: { "Content-Type": "application/json" } }),
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });
});
