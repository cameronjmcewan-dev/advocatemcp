/**
 * Signed team-invite token — Apr 27 2026 Enterprise honesty pass.
 *
 * Mints a one-shot magic-link token that an invitee clicks to accept
 * a team invitation, set their password, and join a tenant. Mirrors
 * activation-token.ts byte-for-byte except for the payload shape:
 *
 *   payload: { user_id, business_slug, role, iat, exp }
 *
 * One-shot enforcement is in the database (users.invite_consumed_at)
 * rather than in the token itself — token verifies any number of
 * times, but the accept handler refuses to process when invite_consumed_at
 * is non-null.
 *
 * Signing key: INVITE_SIGNING_KEY env var (separate from ACTIVATION_SIGNING_KEY
 * so a leaked activation key can't be used to forge invites and vice versa).
 */

export interface InviteTokenPayload {
  user_id:        string;
  business_slug:  string;
  role:           "owner" | "editor" | "viewer";
  iat:            number;
  exp:            number;
}

export type InviteTokenError = "malformed" | "bad_signature" | "expired";

export const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 3600;     // 7 days

const enc = new TextEncoder();

function bytesToBase64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  const binary = atob(padded + "=".repeat(pad));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function signInviteToken(
  payload: { user_id: string; business_slug: string; role: "owner" | "editor" | "viewer" },
  signingKey: string,
  ttlSeconds: number = DEFAULT_INVITE_TTL_SECONDS,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const fullPayload: InviteTokenPayload = {
    user_id:       payload.user_id,
    business_slug: payload.business_slug,
    role:          payload.role,
    iat,
    exp,
  };
  const jsonBytes = enc.encode(JSON.stringify(fullPayload));
  const encodedPayload = bytesToBase64url(jsonBytes);

  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(encodedPayload));
  const encodedSig = bytesToBase64url(new Uint8Array(sigBuf));

  return `${encodedPayload}.${encodedSig}`;
}

export async function verifyInviteToken(
  token: string,
  signingKey: string,
): Promise<InviteTokenPayload> {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 1 || dotIdx === token.length - 1) throw "malformed" satisfies InviteTokenError;
  const encodedPayload = token.slice(0, dotIdx);
  const encodedSig     = token.slice(dotIdx + 1);

  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  const expectedSigBuf = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(encodedPayload));

  let actualSigBytes: Uint8Array;
  try { actualSigBytes = base64urlToBytes(encodedSig); }
  catch { throw "malformed" satisfies InviteTokenError; }
  const expectedSigBytes = new Uint8Array(expectedSigBuf);

  if (actualSigBytes.length !== expectedSigBytes.length) throw "bad_signature" satisfies InviteTokenError;
  let mismatch = 0;
  for (let i = 0; i < expectedSigBytes.length; i++) {
    mismatch |= actualSigBytes[i]! ^ expectedSigBytes[i]!;
  }
  if (mismatch !== 0) throw "bad_signature" satisfies InviteTokenError;

  let payload: InviteTokenPayload;
  try {
    const jsonStr = new TextDecoder().decode(base64urlToBytes(encodedPayload));
    payload = JSON.parse(jsonStr) as InviteTokenPayload;
  } catch { throw "malformed" satisfies InviteTokenError; }

  if (payload.exp < Math.floor(Date.now() / 1000)) throw "expired" satisfies InviteTokenError;
  if (payload.role !== "owner" && payload.role !== "editor" && payload.role !== "viewer") {
    throw "malformed" satisfies InviteTokenError;
  }
  return payload;
}
