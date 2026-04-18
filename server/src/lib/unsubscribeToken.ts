import { createHmac, timingSafeEqual } from "node:crypto";
import { getSigningKey } from "./continuationToken.js";

/**
 * HMAC domain separator for digest-unsubscribe tokens. Shares the
 * `TOKEN_SIGNING_KEY` with attribution + continuation tokens, but the
 * prefix ensures a token minted for one purpose cannot verify for another.
 *
 * Do NOT change. Rotating this breaks all emails in flight.
 */
export const UNSUBSCRIBE_HMAC_PREFIX = "digest-unsub:v1:";

/**
 * Unsubscribe tokens don't expire. A customer following a link from a
 * six-month-old email should still be able to opt out. We deliberately
 * omit the `ts` claim so rotating the signing key is the only way to
 * invalidate old tokens — and we'd only rotate that key under credential
 * compromise, which is the one time "every old email's unsub link breaks"
 * is an acceptable outcome.
 */
export interface UnsubscribePayload {
  slug:  string;
  scope: "digest";
}

export function mintUnsubscribeToken(slug: string): string {
  const payload: UnsubscribePayload = { slug, scope: "digest" };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", getSigningKey())
    .update(UNSUBSCRIBE_HMAC_PREFIX + encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

export type UnsubscribeError = "malformed" | "bad_signature" | "bad_scope";

export function verifyUnsubscribeToken(token: string): UnsubscribePayload {
  const dot = token.lastIndexOf(".");
  if (dot < 1 || dot === token.length - 1) throw "malformed" satisfies UnsubscribeError;
  const encoded = token.slice(0, dot);
  const sig     = token.slice(dot + 1);

  const expected = createHmac("sha256", getSigningKey())
    .update(UNSUBSCRIBE_HMAC_PREFIX + encoded)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw "bad_signature" satisfies UnsubscribeError;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw "malformed" satisfies UnsubscribeError;
  }
  if (!parsed || typeof parsed !== "object")                      throw "malformed" satisfies UnsubscribeError;
  const p = parsed as Partial<UnsubscribePayload>;
  if (typeof p.slug !== "string" || !p.slug)                      throw "malformed" satisfies UnsubscribeError;
  if (p.scope !== "digest")                                       throw "bad_scope" satisfies UnsubscribeError;
  return { slug: p.slug, scope: "digest" };
}
