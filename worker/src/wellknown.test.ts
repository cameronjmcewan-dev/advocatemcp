import { describe, it, expect } from "vitest";
import { buildWellKnownResponse } from "./index";

// Minimal Env stub — only API_BASE_URL is read by buildWellKnownResponse + apiBase.
const env = { API_BASE_URL: "https://api.example.com" } as unknown as Parameters<
  typeof buildWellKnownResponse
>[1];

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text());
}

describe("buildWellKnownResponse — tenant ai-agent.json", () => {
  it("includes manifest_url pointing at central mcp.json for unknown domain", async () => {
    const res = buildWellKnownResponse(null, env);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.manifest_url).toBe("https://api.example.com/.well-known/mcp.json");
  });

  it("emits agent_id=null when no slug is resolved", async () => {
    const res = buildWellKnownResponse(null, env);
    const body = await bodyOf(res);
    expect(body).toHaveProperty("agent_id", null);
  });

  it("emits agent_id=<slug> when a slug is provided", async () => {
    const res = buildWellKnownResponse("acme", env);
    const body = await bodyOf(res);
    expect(body.agent_id).toBe("acme");
  });

  it("preserves every pre-existing field (pure addition, no breaking change)", async () => {
    const res = buildWellKnownResponse("acme", env, {
      name: "Acme Co",
      category: "widgets",
      location: "Austin, TX",
      description: "We make things.",
      services: ["a", "b"],
      referral_url: "https://acme.example/contact",
      availability: "Mon-Fri",
    });
    const body = await bodyOf(res);

    expect(body.spec_version).toBe("1.0");
    expect(body.spec_name).toBe("ai-agent-discovery");
    expect(body.agent_endpoint).toBe("https://api.example.com/agents/acme/query");
    expect(body.profile_endpoint).toBe("https://api.example.com/agents/acme/profile");
    expect(body.mcp_endpoint).toBe("https://api.example.com/mcp");
    expect(body.protocol).toBe("advocatemcp-v1");
    expect(body.capabilities).toEqual(["answer_queries", "referral", "availability"]);
    expect(typeof body.crawler_instructions).toBe("string");
    expect(body.powered_by).toBe("AdvocateMCP");

    // Profile fields still merged in when profile provided.
    expect(body.business_name).toBe("Acme Co");
    expect(body.business_category).toBe("widgets");
    expect(body.location).toBe("Austin, TX");
    expect(body.description).toBe("We make things.");
    expect(body.services).toEqual(["a", "b"]);
    expect(body.referral_url).toBe("https://acme.example/contact");
    expect(body.availability).toBe("Mon-Fri");
  });

  it("returns JSON content-type and CORS headers", async () => {
    const res = buildWellKnownResponse("acme", env);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
