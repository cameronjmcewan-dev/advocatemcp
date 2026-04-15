import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC input prefix — the DOMAIN SEPARATOR between attribution tokens and
 * continuation tokens. Attribution tokens sign the base64url payload string
 * directly. Continuation tokens prepend this literal ASCII string before
 * hashing, so on the same signing key the HMACs can never collide and an
 * attribution token cannot be replayed as a continuation token or vice versa.
 *
 * Do NOT change this string. Changing it invalidates all previously minted
 * continuation tokens. It is intentionally not configurable for this reason.
 */
export const CONTINUATION_HMAC_PREFIX = "a2a-continuation:v1:";

const EXPIRY_SECONDS = 3600;

export interface ContinuationPayload {
  ticket: string;
  business_slug: string;
  agent_id?: string;
  scope: "confirm" | "continue";
  ts: number;
}

export type ContinuationError = "malformed" | "bad_signature" | "expired";

export function mintContinuationToken(
  claim: Omit<ContinuationPayload, "ts">,
  signingKey: string,
  opts?: { overrideTs?: number }
): string {
  const payload: ContinuationPayload = {
    ...claim,
    ts: opts?.overrideTs ?? Math.floor(Date.now() / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", signingKey)
    .update(CONTINUATION_HMAC_PREFIX + encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyContinuationToken(token: string, signingKey: string): ContinuationPayload {
  const dot = token.lastIndexOf(".");
  if (dot < 1 || dot === token.length - 1) throw "malformed" satisfies ContinuationError;

  const encoded = token.slice(0, dot);
  const givenSig = token.slice(dot + 1);
  const expectedSig = createHmac("sha256", signingKey)
    .update(CONTINUATION_HMAC_PREFIX + encoded)
    .digest("base64url");

  // Compare lengths before timingSafeEqual — timingSafeEqual throws if lengths differ.
  // Length mismatch still returns bad_signature rather than propagating a thrown error.
  const a = Buffer.from(givenSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw "bad_signature" satisfies ContinuationError;

  let payload: ContinuationPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ContinuationPayload;
  } catch {
    throw "malformed" satisfies ContinuationError;
  }
  if (
    typeof payload.ticket !== "string" ||
    typeof payload.business_slug !== "string" ||
    typeof payload.ts !== "number" ||
    (payload.scope !== "confirm" && payload.scope !== "continue") ||
    (payload.agent_id !== undefined && typeof payload.agent_id !== "string")
  ) {
    throw "malformed" satisfies ContinuationError;
  }

  // Expiry check is AFTER signature verify — do not leak whether a bad-signature
  // token was also expired.
  const now = Math.floor(Date.now() / 1000);
  if (now - payload.ts > EXPIRY_SECONDS) throw "expired" satisfies ContinuationError;
  return payload;
}
