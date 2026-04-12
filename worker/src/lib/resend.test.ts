/**
 * Tests for worker/src/lib/resend.ts
 *
 * Pure function tests with mocked fetch. No real Resend API calls.
 * vi.spyOn(globalThis, 'fetch') intercepts the outbound HTTP request
 * so we can verify the request shape and simulate success / error /
 * network failure responses.
 *
 * Six tests covering:
 *   1. Successful send → ok:true with Resend email ID
 *   2. Resend 4xx → ok:false, retryable:false
 *   3. Resend 5xx → ok:false, retryable:true
 *   4. Network failure (fetch throws) → ok:false, retryable:true
 *   5. Email HTML contains the activation URL
 *   6. Authorization header carries the API key
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { sendActivationEmail } from "./resend";

const TEST_KEY = "re_test_fake_key_123";
const TEST_TO = "customer@example.com";
const TEST_URL = "https://customers.advocatemcp.com/activate?t=abc123";

function mockFetch(status: number, body: unknown): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendActivationEmail", () => {
  // 1. Successful send
  it("returns ok:true with the Resend email ID on 200", async () => {
    mockFetch(200, { id: "email_abc123" });
    const result = await sendActivationEmail(TEST_KEY, TEST_TO, TEST_URL);

    expect(result.ok).toBe(true);
    expect(result.id).toBe("email_abc123");
    expect(result.retryable).toBe(false);
  });

  // 2. Resend 4xx — permanent failure
  it("returns ok:false, retryable:false on 422", async () => {
    mockFetch(422, { statusCode: 422, message: "Invalid email address", name: "validation_error" });
    const result = await sendActivationEmail(TEST_KEY, TEST_TO, TEST_URL);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain("422");
    expect(result.error).toContain("Invalid email address");
  });

  // 3. Resend 5xx — retryable
  it("returns ok:false, retryable:true on 500", async () => {
    mockFetch(500, { statusCode: 500, message: "Internal server error" });
    const result = await sendActivationEmail(TEST_KEY, TEST_TO, TEST_URL);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("500");
  });

  // 4. Network failure
  it("returns ok:false, retryable:true on fetch throw", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("DNS resolution failed"));
    const result = await sendActivationEmail(TEST_KEY, TEST_TO, TEST_URL);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("DNS resolution failed");
  });

  // 5. Email HTML contains the activation URL
  it("includes the activation URL in the email HTML body", async () => {
    mockFetch(200, { id: "email_xyz" });
    await sendActivationEmail(TEST_KEY, TEST_TO, TEST_URL);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const reqInit = fetchCall[1] as RequestInit;
    const body = JSON.parse(reqInit.body as string) as { html: string; to: string[] };

    expect(body.html).toContain(TEST_URL);
    expect(body.to).toEqual([TEST_TO]);
  });

  // 6. Authorization header carries the API key
  it("sends the correct Authorization: Bearer header", async () => {
    mockFetch(200, { id: "email_xyz" });
    await sendActivationEmail(TEST_KEY, TEST_TO, TEST_URL);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const reqInit = fetchCall[1] as RequestInit;
    const headers = reqInit.headers as Record<string, string>;

    expect(headers["Authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  // 7. Hosted template includes the hosted URL and "Set your password" copy
  it("uses the hosted template when tenantType is 'hosted'", async () => {
    mockFetch(200, { id: "email_hosted_1" });
    const hostedUrl = "https://test-biz.hosted.advocatemcp.com";
    await sendActivationEmail(TEST_KEY, TEST_TO, TEST_URL, "hosted", hostedUrl);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const reqInit = fetchCall[1] as RequestInit;
    const body = JSON.parse(reqInit.body as string) as { html: string };

    expect(body.html).toContain(hostedUrl);
    expect(body.html).toContain("Set your password");
    expect(body.html).toContain("live on AI search");
    // Should NOT contain the DNS-specific copy
    expect(body.html).not.toContain("point your domain at our worker");
  });

  // 8. DNS template does NOT include hosted URL copy
  it("uses the DNS template when tenantType is 'dns'", async () => {
    mockFetch(200, { id: "email_dns_1" });
    await sendActivationEmail(TEST_KEY, TEST_TO, TEST_URL, "dns");

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const reqInit = fetchCall[1] as RequestInit;
    const body = JSON.parse(reqInit.body as string) as { html: string };

    expect(body.html).toContain("point your domain at our worker");
    expect(body.html).toContain("Activate your account");
    // Should NOT contain the hosted-specific copy
    expect(body.html).not.toContain("live on AI search");
  });
});
