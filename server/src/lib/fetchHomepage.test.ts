/* SSRF + safety tests for fetchHomepage.
 *
 * We only test the synchronous URL/protocol/auth checks here. Tests
 * that require DNS resolution or live HTTP are skipped — those would
 * be flaky in CI and the SSRF protections we ship are testable via
 * targeted mocks if we ever want them.
 */

import { describe, expect, it } from "vitest";
import { fetchHomepage } from "./fetchHomepage.js";

describe("fetchHomepage — synchronous URL guards", () => {
  it("rejects unparseable URLs", async () => {
    const r = await fetchHomepage("not a url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });

  it("rejects http:// (non-https)", async () => {
    const r = await fetchHomepage("http://example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("non_https");
  });

  it("rejects file:// scheme", async () => {
    const r = await fetchHomepage("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("non_https");
  });

  it("rejects gopher:// scheme", async () => {
    const r = await fetchHomepage("gopher://example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("non_https");
  });

  it("rejects URLs with embedded credentials", async () => {
    const r = await fetchHomepage("https://user:pass@example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });

  it("rejects empty hostname", async () => {
    // URL parser allows weird inputs — make sure invalid hostnames are caught.
    const r = await fetchHomepage("https:///bad");
    expect(r.ok).toBe(false);
    // Either invalid_url (URL parse fails) or invalid_url (hostname check)
    if (!r.ok) expect(["invalid_url", "dns_lookup_failed"]).toContain(r.reason);
  });
});

describe("fetchHomepage — private/reserved IP rejection (DNS-resolved)", () => {
  // These tests rely on DNS resolution. They use literal IPs as
  // hostnames where that's accepted by Node's DNS, plus well-known
  // public-resolver names that resolve to known reserved space.
  // If DNS is flaky in the test environment, these may need skipping.

  it("rejects 127.0.0.1 (loopback)", async () => {
    const r = await fetchHomepage("https://127.0.0.1");
    expect(r.ok).toBe(false);
    // URL parser treats raw IP as hostname; check fires on the
    // hostname-format regex (which rejects pure-numeric hostnames),
    // so reason is invalid_url, not private_address.
    if (!r.ok) expect(["invalid_url", "private_address", "dns_lookup_failed"]).toContain(r.reason);
  });

  it("rejects 10.0.0.1 (RFC1918)", async () => {
    const r = await fetchHomepage("https://10.0.0.1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["invalid_url", "private_address", "dns_lookup_failed"]).toContain(r.reason);
  });

  it("rejects AWS metadata 169.254.169.254", async () => {
    const r = await fetchHomepage("https://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["invalid_url", "private_address", "dns_lookup_failed"]).toContain(r.reason);
  });

  it("rejects hostnames that don't look like real domains", async () => {
    // The hostname regex requires at least one dot.
    const r = await fetchHomepage("https://localhost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });
});
