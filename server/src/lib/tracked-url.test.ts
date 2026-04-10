/**
 * Tests for server/src/lib/tracked-url.ts
 *
 * KNOWN_TOKEN is a hardcoded reference value computed by a throwaway script
 * on 2026-04-10. If this test fails after a code change, the signing logic
 * diverged from the reference — do not update the constant, fix the code.
 *
 * Cross-environment safety: the same constant must appear verbatim in
 * worker/src/lib/tracked-url.test.ts so both environments can be verified
 * against a single source of truth.
 */

import { describe, it, expect } from "vitest";
import { buildToken, type TokenPayload } from "./tracked-url.js";

// ── Reference test vector ────────────────────────────────────────────────────

const KNOWN_KEY = "test-vector-key-advocatemcp-2026";

const KNOWN_PAYLOAD: TokenPayload = {
  dest: "https://example.com/order",
  ref: "PerplexityBot",
  slug: "joes-pizza",
  query_id: 42,
  ts: 1744000000,
};

const KNOWN_PAYLOAD_B64 =
  "eyJkZXN0IjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9vcmRlciIsInJlZiI6IlBlcnBsZXhpdHlCb3QiLCJzbHVnIjoiam9lcy1waXp6YSIsInF1ZXJ5X2lkIjo0MiwidHMiOjE3NDQwMDAwMDB9";

const KNOWN_SIGNATURE =
  "Nk5vjYKNQRuvt9SkFWhKZoonHQymMRje0E28TiYbxd0";

const KNOWN_TOKEN = `${KNOWN_PAYLOAD_B64}.${KNOWN_SIGNATURE}`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildToken", () => {
  it("produces the reference token for the known test vector", () => {
    expect(buildToken(KNOWN_PAYLOAD, KNOWN_KEY)).toBe(KNOWN_TOKEN);
  });

  it("payload segment decodes to the original JSON", () => {
    const token = buildToken(KNOWN_PAYLOAD, KNOWN_KEY);
    const [encodedPayload] = token.split(".");
    const decoded = JSON.parse(
      Buffer.from(encodedPayload!, "base64url").toString("utf8")
    ) as TokenPayload;
    expect(decoded).toEqual(KNOWN_PAYLOAD);
  });

  it("token has exactly two dot-separated segments", () => {
    const token = buildToken(KNOWN_PAYLOAD, KNOWN_KEY);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBeTruthy();
    expect(parts[1]).toBeTruthy();
  });

  it("uses no base64 padding characters", () => {
    const token = buildToken(KNOWN_PAYLOAD, KNOWN_KEY);
    expect(token).not.toContain("=");
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
  });

  it("different keys produce different tokens", () => {
    const t1 = buildToken(KNOWN_PAYLOAD, KNOWN_KEY);
    const t2 = buildToken(KNOWN_PAYLOAD, "other-key");
    expect(t1).not.toBe(t2);
    // Same payload segment, different signature
    expect(t1.split(".")[0]).toBe(t2.split(".")[0]);
    expect(t1.split(".")[1]).not.toBe(t2.split(".")[1]);
  });

  it("different payloads produce different tokens", () => {
    const p2 = { ...KNOWN_PAYLOAD, query_id: 99 };
    expect(buildToken(KNOWN_PAYLOAD, KNOWN_KEY)).not.toBe(
      buildToken(p2, KNOWN_KEY)
    );
  });
});
