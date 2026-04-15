import { describe, it, expect } from "vitest";
import { AGENT_IDENTITY_HEADER, resolveAgentId } from "./agentIdentity.js";
import type { Request } from "express";

function fakeReq(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

describe("AGENT_IDENTITY_HEADER", () => {
  it("is a stable lowercase constant", () => {
    expect(AGENT_IDENTITY_HEADER).toBe("x-agent-identity");
  });
});

describe("resolveAgentId ranking", () => {
  it("returns header value when present, ignoring tool arg", () => {
    const req = fakeReq({ "x-agent-identity": "claude-desktop" });
    expect(resolveAgentId(req, "cursor")).toBe("claude-desktop");
  });

  it("falls back to tool arg when no header", () => {
    const req = fakeReq();
    expect(resolveAgentId(req, "cursor")).toBe("cursor");
  });

  it("returns undefined when neither is set", () => {
    const req = fakeReq();
    expect(resolveAgentId(req, undefined)).toBeUndefined();
  });

  it("treats empty header as absent", () => {
    const req = fakeReq({ "x-agent-identity": "" });
    expect(resolveAgentId(req, "cursor")).toBe("cursor");
  });

  it("trims whitespace from both sources", () => {
    const req = fakeReq({ "x-agent-identity": "  claude-desktop  " });
    expect(resolveAgentId(req, undefined)).toBe("claude-desktop");
    expect(resolveAgentId(fakeReq(), "  cursor  ")).toBe("cursor");
  });
});
