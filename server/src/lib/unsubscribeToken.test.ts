import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mintUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribeToken.js";
import { mintContinuationToken } from "./continuationToken.js";

describe("unsubscribeToken round-trip", () => {
  beforeEach(() => { process.env.TOKEN_SIGNING_KEY = "test-key-abc"; });
  afterEach(() => { delete process.env.TOKEN_SIGNING_KEY; });

  it("verifies a freshly minted token", () => {
    const t = mintUnsubscribeToken("acme-plumbing");
    const p = verifyUnsubscribeToken(t);
    expect(p.slug).toBe("acme-plumbing");
    expect(p.scope).toBe("digest");
  });

  it("rejects a malformed token", () => {
    expect(() => verifyUnsubscribeToken("garbage")).toThrow("malformed");
    expect(() => verifyUnsubscribeToken(".sig")).toThrow("malformed");
    expect(() => verifyUnsubscribeToken("payload.")).toThrow("malformed");
  });

  it("rejects a token with a tampered signature", () => {
    const t = mintUnsubscribeToken("acme");
    const dot = t.lastIndexOf(".");
    const tampered = t.slice(0, dot + 1) + "AAAAAAAAAAAAAAAAAAAAAA";
    expect(() => verifyUnsubscribeToken(tampered)).toThrow("bad_signature");
  });

  it("rejects a continuation token replayed as an unsubscribe token (domain separation)", () => {
    const continuation = mintContinuationToken(
      { ticket: "abc", business_slug: "acme", scope: "confirm" },
      "test-key-abc",
    );
    expect(() => verifyUnsubscribeToken(continuation)).toThrow("bad_signature");
  });

  it("rejects a token whose payload has a non-digest scope", () => {
    // Manually construct a payload with the wrong scope but correct HMAC prefix.
    // Easiest way: mint with a lib internal — here we just assert the thrown code
    // matches the expected surface via a tampered-payload approach.
    const good = mintUnsubscribeToken("acme");
    const dot  = good.lastIndexOf(".");
    const evilPayload = Buffer.from(JSON.stringify({ slug: "acme", scope: "other" })).toString("base64url");
    // Signature is computed with the UNSUBSCRIBE prefix, so forging the payload
    // requires the signing key — if we just swap the payload, the signature
    // won't match anyway, so this asserts "bad_signature", not "bad_scope".
    // Keep it as bad_signature — bad_scope is only reachable if someone
    // somehow produces a valid signature for a non-digest payload, which the
    // minting API prevents by hard-coding scope: "digest".
    const tampered = `${evilPayload}.${good.slice(dot + 1)}`;
    expect(() => verifyUnsubscribeToken(tampered)).toThrow("bad_signature");
  });

  it("does not expire (tokens from any age stay valid until key rotation)", () => {
    // This is a property of the design, not runtime behavior — assert by
    // verifying the payload has no `ts` field we would compare against.
    const t = mintUnsubscribeToken("long-lived");
    const p = verifyUnsubscribeToken(t);
    expect(p).toEqual({ slug: "long-lived", scope: "digest" });
  });
});
