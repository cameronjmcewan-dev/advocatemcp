import { describe, it, expect } from "vitest";
import { mintContinuationToken, verifyContinuationToken, CONTINUATION_HMAC_PREFIX } from "./continuationToken.js";
import { createHmac } from "node:crypto";

const KEY = "test-signing-key-s9";

describe("continuation token — mint + verify", () => {
  it("round-trip verifies", () => {
    const tok = mintContinuationToken(
      { ticket: "r_abc", business_slug: "acme", agent_id: "claude-desktop", scope: "continue" },
      KEY
    );
    const payload = verifyContinuationToken(tok, KEY);
    expect(payload.ticket).toBe("r_abc");
    expect(payload.business_slug).toBe("acme");
    expect(payload.scope).toBe("continue");
    expect(typeof payload.ts).toBe("number");
  });

  it("rejects tampered signature", () => {
    const tok = mintContinuationToken({ ticket: "r_1", business_slug: "x", scope: "confirm" }, KEY);
    const parts = tok.split(".");
    const tampered = parts[0] + "." + parts[1]!.slice(0, -1) + (parts[1]!.slice(-1) === "A" ? "B" : "A");
    expect(() => verifyContinuationToken(tampered, KEY)).toThrow("bad_signature");
  });

  it("rejects a token signed WITHOUT the domain prefix (attribution-token spoof)", () => {
    const payload = { ticket: "r_1", business_slug: "x", scope: "confirm" as const, ts: Math.floor(Date.now()/1000) };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", KEY).update(encoded).digest("base64url"); // no prefix — attribution-style
    const spoofed = `${encoded}.${sig}`;
    expect(() => verifyContinuationToken(spoofed, KEY)).toThrow("bad_signature");
  });

  it("rejects expired tokens (>3600s old)", () => {
    const old = mintContinuationToken(
      { ticket: "r_1", business_slug: "x", scope: "confirm" },
      KEY,
      { overrideTs: Math.floor(Date.now() / 1000) - 3601 }
    );
    expect(() => verifyContinuationToken(old, KEY)).toThrow("expired");
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyContinuationToken("not-a-token", KEY)).toThrow("malformed");
    expect(() => verifyContinuationToken("only.one", KEY)).toThrow(/bad_signature|malformed/);
  });

  it("exports the prefix as a named const for documentation", () => {
    expect(CONTINUATION_HMAC_PREFIX).toBe("a2a-continuation:v1:");
  });
});
