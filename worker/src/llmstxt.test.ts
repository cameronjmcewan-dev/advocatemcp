/**
 * Tests for buildLlmsTxtResponse — the per-tenant /llms.txt route handler.
 *
 * Universally accessible markdown discovery file (llmstxt.org convention).
 * Generated from the same profile object that powers ai-agent.json, so any
 * tenant that already populated their profile gets a meaningful llms.txt
 * automatically. No per-tenant code or config.
 */

import { describe, it, expect } from "vitest";
import { buildLlmsTxtResponse } from "./index";

const env = {
  API_BASE_URL: "https://internal.example.com",
  PUBLIC_API_BASE_URL: "https://api.example.com",
} as unknown as Parameters<typeof buildLlmsTxtResponse>[1];

async function bodyOf(res: Response): Promise<string> {
  return res.text();
}

describe("buildLlmsTxtResponse — universal markdown discovery", () => {
  it("returns text/plain; charset=utf-8 with CORS + cache headers", async () => {
    const res = buildLlmsTxtResponse("acme", env, { name: "Acme Co" });
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("emits a platform-level fallback when slug is null", async () => {
    const res = buildLlmsTxtResponse(null, env);
    const body = await bodyOf(res);
    expect(body).toContain("# AdvocateMCP");
    expect(body).toContain("> AI search visibility platform");
    expect(body).toContain("/.well-known/ai-agent.json");
    expect(body).toContain("https://api.example.com/.well-known/mcp.json");
  });

  it("emits the same platform fallback when profile is null even with a slug", async () => {
    const res = buildLlmsTxtResponse("acme", env, null);
    const body = await bodyOf(res);
    expect(body).toContain("# AdvocateMCP");
    // Slug-less, profile-less requests should NOT name the tenant.
    expect(body).not.toContain("acme");
  });

  it("generates a per-tenant markdown body from profile fields", async () => {
    const res = buildLlmsTxtResponse("acme", env, {
      name: "Acme Widgets Co",
      description: "Acme makes widgets for the modern web. Founded 2026 in Austin, Texas.",
      location: "Austin, TX",
      phone: "(555) 555-0100",
      category: "widgets",
      services: ["Widget A", "Widget B", "Widget C"],
      referral_url: "https://acme.example/contact",
      availability: "Mon-Fri 9-5",
    });
    const body = await bodyOf(res);

    // H1 + summary blockquote with the first sentence.
    expect(body).toMatch(/^# Acme Widgets Co/);
    expect(body).toContain("> Acme makes widgets for the modern web.");

    // Subtitle line with location + phone.
    expect(body).toContain("Austin, TX · (555) 555-0100");

    // Services section with each service as a bullet.
    expect(body).toContain("## Services");
    expect(body).toContain("- Widget A");
    expect(body).toContain("- Widget B");
    expect(body).toContain("- Widget C");

    // Links section with the per-tenant agent endpoint built from publicApiBase.
    expect(body).toContain("## Links");
    expect(body).toContain("[Website](https://acme.example/contact)");
    expect(body).toContain("(/.well-known/ai-agent.json)");
    expect(body).toContain("https://api.example.com/agents/acme/query");
    expect(body).toContain("https://api.example.com/.well-known/mcp.json");

    // Details section with category + availability.
    expect(body).toContain("## Details");
    expect(body).toContain("- Category: widgets");
    expect(body).toContain("- Availability: Mon-Fri 9-5");

    // About section with the full description when it's multi-sentence.
    expect(body).toContain("## About");
    expect(body).toContain("Founded 2026 in Austin, Texas.");
  });

  it("skips sections gracefully when fields are missing", async () => {
    const res = buildLlmsTxtResponse("bare", env, { name: "Bare Co" });
    const body = await bodyOf(res);
    expect(body).toContain("# Bare Co");
    // No services → no Services section.
    expect(body).not.toContain("## Services");
    // No description → no blockquote.
    expect(body).not.toContain("> ");
    // Links section always renders (machine-readable + agent endpoint + manifest).
    expect(body).toContain("## Links");
    expect(body).toContain("https://api.example.com/agents/bare/query");
  });

  it("handles services as an array of objects (not just strings)", async () => {
    const res = buildLlmsTxtResponse("acme", env, {
      name: "Acme",
      services: [
        { name: "Service A", price: "$10" },
        { name: "Service B", price: "$20" },
        "Service C",
      ],
    });
    const body = await bodyOf(res);
    expect(body).toContain("- Service A");
    expect(body).toContain("- Service B");
    expect(body).toContain("- Service C");
  });

  it("handles services as a comma-separated single string", async () => {
    const res = buildLlmsTxtResponse("acme", env, {
      name: "Acme",
      services: "Service A, Service B, Service C",
    });
    const body = await bodyOf(res);
    expect(body).toContain("- Service A");
    expect(body).toContain("- Service B");
    expect(body).toContain("- Service C");
  });

  it("caps the services list at 25 entries to keep llms.txt scannable", async () => {
    const manyServices = Array.from({ length: 50 }, (_, i) => `Service ${i + 1}`);
    const res = buildLlmsTxtResponse("acme", env, {
      name: "Acme",
      services: manyServices,
    });
    const body = await bodyOf(res);
    expect(body).toContain("- Service 1");
    expect(body).toContain("- Service 25");
    expect(body).not.toContain("- Service 26");
    expect(body).not.toContain("- Service 50");
  });

  it("uses publicApiBase, never API_BASE_URL, for every quoted URL", async () => {
    // Regression catcher mirroring the wellknown.test.ts pattern. AI tools
    // will quote these URLs verbatim; they must always be the branded host.
    const internalOnly = {
      API_BASE_URL: "https://advocate-production-2887.up.railway.app",
      PUBLIC_API_BASE_URL: "https://api.advocatemcp.com",
    } as unknown as Parameters<typeof buildLlmsTxtResponse>[1];
    const res = buildLlmsTxtResponse("acme", internalOnly, { name: "Acme" });
    const body = await bodyOf(res);
    expect(body).not.toContain("railway.app");
    expect(body).not.toContain("advocate-production-2887");
    expect(body).toContain("https://api.advocatemcp.com");
  });

  it("falls back to https://api.advocatemcp.com when PUBLIC_API_BASE_URL is unset", async () => {
    const noPublic = {
      API_BASE_URL: "https://advocate-production-2887.up.railway.app",
    } as unknown as Parameters<typeof buildLlmsTxtResponse>[1];
    const res = buildLlmsTxtResponse("acme", noPublic, { name: "Acme" });
    const body = await bodyOf(res);
    expect(body).toContain("https://api.advocatemcp.com");
    expect(body).not.toContain("railway.app");
  });

  it("falls back to slug when profile has no name", async () => {
    const res = buildLlmsTxtResponse("fallback-slug", env, { description: "We sell things." });
    const body = await bodyOf(res);
    expect(body).toContain("# fallback-slug");
  });
});
