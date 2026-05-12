/**
 * RFC 6238 TOTP — Time-based One-Time Password.
 *
 * Pure Web Crypto implementation (HMAC-SHA1). No npm deps. All inputs
 * defaulted to the values every popular authenticator app (Google Auth,
 * Authy, 1Password, Bitwarden) interprets without extra parameters:
 *
 *   - 30-second step window
 *   - 6-digit codes
 *   - SHA-1 HMAC
 *   - Unix epoch as T0
 *
 * Functions exported:
 *   - generateTotpSecret(): fresh 20-byte secret, returned base32-encoded
 *   - generateTotpCode(secret, [timestampMs]): the current 6-digit code
 *   - verifyTotpCode(secret, code, [opts]): constant-time verify with ±1
 *       step drift tolerance (default — covers clock skew up to 30s in
 *       either direction).
 *   - buildOtpauthUri({label, issuer, secret}): the otpauth:// URI you'd
 *       encode as a QR code for an authenticator app.
 *
 * Design notes:
 *   - The shared secret is 20 bytes (160 bits) — the maximum RFC 4226
 *     specifies for HMAC-SHA1 keys and the upper end of what Google
 *     Authenticator displays. Anything shorter weakens the protocol.
 *   - Verification is constant-time on the per-step comparison via
 *     crypto.subtle (returns numbers; we compare with bitwise XOR + OR
 *     accumulator so timing only depends on number-comparison cost, not
 *     digit position). Window iteration is in fixed order so an attacker
 *     cannot probe drift to leak the current step.
 */

const STEP_SECONDS  = 30;
const DIGITS        = 6;
const SECRET_BYTES  = 20;
const DEFAULT_WINDOW = 1; // accept current ±1 step (±30s)

// ── Base32 (RFC 4648, no padding) ───────────────────────────────────────────
//
// Authenticator apps want secrets as uppercase A-Z + 2-7 with no padding.
// We hand-roll the encoder/decoder to avoid a dependency and to control
// exact behaviour around mixed case / surrounding whitespace.

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function decodeBase32(encoded: string): Uint8Array {
  const cleaned = encoded.replace(/[\s=]/g, "").toUpperCase();
  const bytes = new Uint8Array(Math.floor((cleaned.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const v = B32_ALPHABET.indexOf(ch);
    if (v === -1) throw new Error(`decodeBase32: invalid character ${JSON.stringify(ch)}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[idx++] = (value >>> bits) & 0xff;
    }
  }
  return bytes.subarray(0, idx);
}

// ── HOTP / TOTP core ────────────────────────────────────────────────────────

async function hmacSha1(keyBytes: Uint8Array, counterBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, counterBytes);
  return new Uint8Array(sig);
}

function counterBytesFor(step: number): Uint8Array {
  // 8-byte big-endian counter — JS bitwise ops are 32-bit, so split the
  // 64-bit step into high32/low32. Step values that overflow 53 bits are
  // unreachable for any meaningful timestamp this century, but we still
  // handle them correctly via Math.floor of divisions.
  const buf = new Uint8Array(8);
  let hi = Math.floor(step / 0x1_0000_0000);
  let lo = step >>> 0;
  for (let i = 7; i >= 0; i--) {
    if (i >= 4) {
      buf[i] = lo & 0xff;
      lo = lo >>> 8;
    } else {
      buf[i] = hi & 0xff;
      hi = hi >>> 8;
    }
  }
  return buf;
}

function truncate(hash: Uint8Array, digits: number): string {
  // RFC 4226 §5.3 dynamic truncation.
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset]     & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) <<  8) |
     (hash[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(binary % mod).padStart(digits, "0");
}

/**
 * Generate a 6-digit TOTP code for a given secret + timestamp.
 * Default timestamp is `Date.now()`; callers can override for testing
 * (RFC 6238 test vectors) or for drift verification.
 */
export async function generateTotpCode(
  secretBase32: string,
  timestampMs: number = Date.now(),
): Promise<string> {
  const keyBytes = decodeBase32(secretBase32);
  const step = Math.floor(timestampMs / 1000 / STEP_SECONDS);
  const hash = await hmacSha1(keyBytes, counterBytesFor(step));
  return truncate(hash, DIGITS);
}

export interface VerifyTotpOptions {
  /** Steps of drift accepted in either direction. Default 1 (±30s). */
  window?: number;
  /** Override the reference timestamp. Default Date.now(). */
  timestampMs?: number;
}

/**
 * Verify a candidate TOTP code against a stored secret. Accepts ±`window`
 * steps of drift (default ±1 = ±30s).
 *
 * Returns true on match, false otherwise. Never throws — bad secret / bad
 * input returns false. Constant-time on the per-step compare so timing
 * does not reveal which step matched.
 */
export async function verifyTotpCode(
  secretBase32: string,
  candidate: string,
  opts: VerifyTotpOptions = {},
): Promise<boolean> {
  if (typeof candidate !== "string") return false;
  if (candidate.length !== DIGITS) return false;
  if (!/^\d+$/.test(candidate)) return false;

  let keyBytes: Uint8Array;
  try {
    keyBytes = decodeBase32(secretBase32);
  } catch {
    return false;
  }
  if (keyBytes.length === 0) return false;

  const window = Math.max(0, opts.window ?? DEFAULT_WINDOW);
  const ts = opts.timestampMs ?? Date.now();
  const currentStep = Math.floor(ts / 1000 / STEP_SECONDS);

  // Iterate the full window in fixed order; accumulate match bit in `ok`
  // so timing reflects window size, not which step matched.
  let ok = 0;
  for (let delta = -window; delta <= window; delta++) {
    const hash = await hmacSha1(keyBytes, counterBytesFor(currentStep + delta));
    const code = truncate(hash, DIGITS);
    ok |= constantTimeEqualStrings(code, candidate);
  }
  return ok === 1;
}

function constantTimeEqualStrings(a: string, b: string): 1 | 0 {
  if (a.length !== b.length) return 0;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0 ? 1 : 0;
}

// ── Secret generation + otpauth URI ─────────────────────────────────────────

/**
 * Generate a fresh base32-encoded TOTP secret (160-bit / 20 bytes).
 * Uses crypto.getRandomValues — cryptographically random.
 */
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return encodeBase32(bytes);
}

export interface OtpauthUriOptions {
  /** Account name shown in the authenticator app (typically the user's email). */
  label: string;
  /** Issuer shown in the authenticator app (typically the product name). */
  issuer: string;
  /** Base32-encoded secret from generateTotpSecret(). */
  secret: string;
}

/**
 * Build an otpauth://totp/... URI suitable for QR-encoding. RFC standard
 * format; understood by every authenticator app on the market.
 */
export function buildOtpauthUri({ label, issuer, secret }: OtpauthUriOptions): string {
  const safeIssuer = encodeURIComponent(issuer);
  const safeLabel = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  }).toString();
  return `otpauth://totp/${safeLabel}?${params.replace(`issuer=${safeIssuer}`, `issuer=${safeIssuer}`)}`;
}

export const TOTP_CONFIG = Object.freeze({
  stepSeconds: STEP_SECONDS,
  digits: DIGITS,
  secretBytes: SECRET_BYTES,
  defaultWindow: DEFAULT_WINDOW,
});
