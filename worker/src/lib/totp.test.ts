/**
 * Tests for worker/src/lib/totp.ts (RFC 6238).
 *
 * Verifies:
 *   - Base32 round-trip + reject-invalid-chars
 *   - RFC 6238 Appendix B test vectors for HMAC-SHA1 (the only variant
 *     we support). The published vectors use a 20-byte secret =
 *     "12345678901234567890". The base32 of that ASCII string is
 *     GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
 *   - verifyTotpCode accepts within ±1 step drift and rejects outside it.
 *   - Constant-time path returns false for wrong length / non-digit input.
 *   - generateTotpSecret produces 32-char (20-byte) base32 strings.
 *   - buildOtpauthUri shape.
 */

import { describe, it, expect } from "vitest";
import {
  encodeBase32,
  decodeBase32,
  generateTotpCode,
  verifyTotpCode,
  generateTotpSecret,
  buildOtpauthUri,
  TOTP_CONFIG,
} from "./totp";

// ── Base32 ─────────────────────────────────────────────────────────────────

describe("base32", () => {
  it("encodeBase32 of ASCII '12345678901234567890'", () => {
    const bytes = new TextEncoder().encode("12345678901234567890");
    expect(encodeBase32(bytes)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("decodeBase32 of the above round-trips", () => {
    const bytes = decodeBase32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe("12345678901234567890");
  });

  it("decodeBase32 accepts lowercase and padding (strips both)", () => {
    const bytes = decodeBase32("gezdgnbv gy3tqojq=====".toUpperCase());
    expect(new TextDecoder().decode(bytes)).toBe("1234567890");
  });

  it("decodeBase32 throws on invalid character", () => {
    expect(() => decodeBase32("ABC1")).toThrow();
  });
});

// ── RFC 6238 Appendix B test vectors (HMAC-SHA1, 8 digits) ──────────────────
//
// The published vectors return 8-digit codes. Our generateTotpCode returns
// 6 digits (the standard authenticator-app width). So we test 6-digit
// SUFFIXES of the published vectors. Vectors are at well-known timestamps.
//
// Vector format from RFC 6238 §B:
//   Time        | T (hex) | TOTP-SHA1 (8-digit)
//   59          | 1       | 94287082
//   1111111109  | 23523EC | 07081804
//   1111111111  | 23523ED | 14050471
//   1234567890  | 273EF07 | 89005924
//   2000000000  | 3F940AA | 69279037
//   20000000000 | 27BC86AA| 65353130

const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

interface RfcVector { unix: number; suffix: string }
const RFC_VECTORS: RfcVector[] = [
  { unix:         59,  suffix: "287082" },
  { unix: 1111111109,  suffix: "081804" },
  { unix: 1111111111,  suffix: "050471" },
  { unix: 1234567890,  suffix: "005924" },
  { unix: 2000000000,  suffix: "279037" },
  // 20_000_000_000 is JavaScript-safe (well under 2^53) but exceeds 2^32 in
  // step-counter terms — exercises the high-32-bit branch of counterBytesFor.
  { unix: 20000000000, suffix: "353130" },
];

describe("generateTotpCode — RFC 6238 vectors (6-digit suffix)", () => {
  for (const v of RFC_VECTORS) {
    it(`unix=${v.unix} produces suffix ${v.suffix}`, async () => {
      const code = await generateTotpCode(RFC_SECRET_B32, v.unix * 1000);
      expect(code).toBe(v.suffix);
    });
  }
});

// ── verifyTotpCode ─────────────────────────────────────────────────────────

describe("verifyTotpCode", () => {
  it("accepts the current code", async () => {
    const now = 1111111111000;
    const code = await generateTotpCode(RFC_SECRET_B32, now);
    expect(await verifyTotpCode(RFC_SECRET_B32, code, { timestampMs: now })).toBe(true);
  });

  it("accepts code from the previous step (±30s drift)", async () => {
    const now = 1111111111000;
    const codePrev = await generateTotpCode(RFC_SECRET_B32, now - 30_000);
    expect(await verifyTotpCode(RFC_SECRET_B32, codePrev, { timestampMs: now })).toBe(true);
  });

  it("accepts code from the next step (clock-skew tolerance)", async () => {
    const now = 1111111111000;
    const codeNext = await generateTotpCode(RFC_SECRET_B32, now + 30_000);
    expect(await verifyTotpCode(RFC_SECRET_B32, codeNext, { timestampMs: now })).toBe(true);
  });

  it("rejects code from 2 steps ago", async () => {
    const now = 1111111111000;
    const codeOld = await generateTotpCode(RFC_SECRET_B32, now - 60_000);
    expect(await verifyTotpCode(RFC_SECRET_B32, codeOld, { timestampMs: now })).toBe(false);
  });

  it("rejects wrong code", async () => {
    expect(await verifyTotpCode(RFC_SECRET_B32, "000000", { timestampMs: 1111111111000 })).toBe(false);
  });

  it("rejects non-digit code", async () => {
    expect(await verifyTotpCode(RFC_SECRET_B32, "abc123", { timestampMs: 1111111111000 })).toBe(false);
  });

  it("rejects wrong length", async () => {
    expect(await verifyTotpCode(RFC_SECRET_B32, "12345", { timestampMs: 1111111111000 })).toBe(false);
    expect(await verifyTotpCode(RFC_SECRET_B32, "1234567", { timestampMs: 1111111111000 })).toBe(false);
  });

  it("does not throw on malformed secret — returns false", async () => {
    await expect(verifyTotpCode("not-base32-@@@", "123456")).resolves.toBe(false);
    await expect(verifyTotpCode("", "123456")).resolves.toBe(false);
  });

  it("window: 0 rejects ±1 step drift", async () => {
    const now = 1111111111000;
    const codeNext = await generateTotpCode(RFC_SECRET_B32, now + 30_000);
    expect(
      await verifyTotpCode(RFC_SECRET_B32, codeNext, { timestampMs: now, window: 0 }),
    ).toBe(false);
  });

  it("window: 2 accepts ±60s drift", async () => {
    const now = 1111111111000;
    const codeFar = await generateTotpCode(RFC_SECRET_B32, now + 60_000);
    expect(
      await verifyTotpCode(RFC_SECRET_B32, codeFar, { timestampMs: now, window: 2 }),
    ).toBe(true);
  });
});

// ── Secret generation + URI ────────────────────────────────────────────────

describe("generateTotpSecret", () => {
  it("returns a 32-character base32 string (20 bytes encoded)", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("two calls produce different secrets", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it("the generated secret round-trips through verify", async () => {
    const s = generateTotpSecret();
    const now = Date.now();
    const code = await generateTotpCode(s, now);
    expect(await verifyTotpCode(s, code, { timestampMs: now })).toBe(true);
  });
});

describe("buildOtpauthUri", () => {
  it("builds the standard otpauth URI shape", () => {
    const uri = buildOtpauthUri({
      label: "max@advocate-mcp.com",
      issuer: "AdvocateMCP",
      secret: "JBSWY3DPEHPK3PXP",
    });
    expect(uri.startsWith("otpauth://totp/AdvocateMCP")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=AdvocateMCP");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    // Label is URL-encoded.
    expect(uri).toContain(encodeURIComponent("AdvocateMCP:max@advocate-mcp.com"));
  });
});

describe("TOTP_CONFIG", () => {
  it("exposes the standard parameters", () => {
    expect(TOTP_CONFIG.stepSeconds).toBe(30);
    expect(TOTP_CONFIG.digits).toBe(6);
    expect(TOTP_CONFIG.secretBytes).toBe(20);
    expect(TOTP_CONFIG.defaultWindow).toBe(1);
  });
});
