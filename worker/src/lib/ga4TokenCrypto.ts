/**
 * Backward-compatibility shim. The actual implementation moved to
 * lib/tokenCrypto.ts during Phase 3 PR 1 of the Traffic Impact data-
 * depth roadmap. New callers should import from lib/tokenCrypto.ts
 * directly.
 *
 * The signing key env var GA4_TOKEN_ENCRYPTION_KEY is unchanged —
 * it's the secret name that ties this to GA4 specifically; the
 * crypto library itself is generic.
 */

export { encryptToken, decryptToken } from "./tokenCrypto";
