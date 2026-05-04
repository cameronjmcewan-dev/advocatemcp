import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { probeLive } from "./liveProbe.js";

describe("probeLive", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok when 200 + powered_by marker present", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ powered_by: "AdvocateMCP", agent_id: "x" }), { status: 200 }),
    );

    const result = await probeLive("www.example.com");

    expect(result.ok).toBe(true);
    expect(result.status_code).toBe(200);
    expect(result.marker_present).toBe(true);
    expect(typeof result.latency_ms).toBe("number");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.example.com/.well-known/ai-agent.json",
      expect.objectContaining({
        headers: expect.objectContaining({ "User-Agent": expect.stringMatching(/PerplexityBot/) }),
      }),
    );
  });

  it("returns err when 200 but no marker (not our worker)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ random: "site" }), { status: 200 }),
    );

    const result = await probeLive("www.example.com");

    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(200);
    expect(result.marker_present).toBe(false);
    expect(result.error).toMatch(/marker/i);
  });

  it("returns err when 200 but body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>not us</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );

    const result = await probeLive("www.example.com");

    expect(result.ok).toBe(false);
    expect(result.marker_present).toBe(false);
  });

  it("returns err on 5xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 502 }));

    const result = await probeLive("www.example.com");

    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(502);
    expect(result.error).toMatch(/HTTP 502/);
  });

  it("returns err on fetch failure (DNS, timeout, refused)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND www.example.com"));

    const result = await probeLive("www.example.com");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
  });
});
