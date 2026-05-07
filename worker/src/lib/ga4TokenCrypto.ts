/**
 * AES-256-GCM wrapper for storing GA4 OAuth refresh tokens in D1.
 *
 * Encrypts with a per-Worker secret key (GA4_TOKEN_ENCRYPTION_KEY, 64-char
 * hex = 32 bytes = AES-256). Each encryption uses a fresh random 12-byte
 * IV; the IV and 16-byte auth tag are bundled with the ciphertext into a
 * single base64 string for compact DB storage.
 *
 * Output format (base64-decoded): [12B IV][N bytes ciphertext + 16B tag]
 *
 * Decryption verifies the auth tag — tampered ciphertext or wrong key
 * throws. Never returns silently-corrupted plaintext.
 */

// ── Constants ─────────────────────────────────────────────────────────────────
// AES-256-GCM parameters. Changing any of these would break decryption of
// existing ciphertexts — we'd need a key-rotation migration path.
const KEY_LENGTH_BYTES   = 32;                              // AES-256
const KEY_HEX_LENGTH     = KEY_LENGTH_BYTES * 2;            // 64 hex chars
const IV_LENGTH_BYTES    = 12;                              // GCM standard 96-bit IV
const TAG_LENGTH_BYTES   = 16;                              // GCM 128-bit auth tag
const MIN_CIPHERTEXT_BYTES = IV_LENGTH_BYTES + TAG_LENGTH_BYTES; // empty plaintext minimum

const HEX_CHARS_RE = /^[0-9a-fA-F]+$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== KEY_HEX_LENGTH) {
    throw new Error("ga4TokenCrypto: invalid hex key length");
  }
  // Reject non-hex characters explicitly. Without this, parseInt silently
  // returns NaN on bad chars and coerces to 0 — yielding a corrupted key
  // that "works" (encrypts + decrypts) but with the wrong bytes.
  if (!HEX_CHARS_RE.test(hex)) {
    throw new Error("ga4TokenCrypto: invalid hex key characters");
  }
  const bytes = new Uint8Array(KEY_LENGTH_BYTES);
  for (let i = 0; i < KEY_LENGTH_BYTES; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Convert bytes to binary string, then btoa
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new Error("ga4TokenCrypto: invalid base64 ciphertext");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKey(
  hexKey: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const keyBytes = hexToBytes(hexKey);
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function encryptToken(
  plaintext: string,
  hexKey: string,
): Promise<string> {
  const key = await importKey(hexKey, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const plaintextBytes = new TextEncoder().encode(plaintext);

  const ciphertextWithTag = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintextBytes,
  );

  // Concatenate: [IV][ciphertext + tag]
  const combined = new Uint8Array(IV_LENGTH_BYTES + ciphertextWithTag.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertextWithTag), IV_LENGTH_BYTES);

  return bytesToBase64(combined);
}

export async function decryptToken(
  ciphertextB64: string,
  hexKey: string,
): Promise<string> {
  const combined = base64ToBytes(ciphertextB64);

  // Minimum is [IV][tag] for empty plaintext; anything shorter is corrupt.
  if (combined.length < MIN_CIPHERTEXT_BYTES) {
    throw new Error("ga4TokenCrypto: ciphertext too short");
  }

  const iv = combined.slice(0, IV_LENGTH_BYTES);
  const ciphertextWithTag = combined.slice(IV_LENGTH_BYTES);

  const key = await importKey(hexKey, "decrypt");

  // crypto.subtle.decrypt throws DOMException on tag mismatch or wrong key
  const plaintextBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertextWithTag,
  );

  return new TextDecoder().decode(plaintextBytes);
}
