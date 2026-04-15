import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

export const REQUEST_ID_HEADER = "x-advocate-request-id";

/** Crockford base32 alphabet — ULID spec. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Encode an unsigned integer into `length` Crockford base32 chars (big-endian).
 * Used for both the 48-bit timestamp prefix (10 chars) and the 80-bit random
 * suffix (16 chars). Total: 26 chars = 130 bits of encoded entropy, of which
 * 48 are time and 80 are random — matches ulid spec exactly.
 */
function encodeBase32(value: bigint, length: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

/** Generate a ULID — 10 char time + 16 char random, 26 char total. */
export function generateUlid(): string {
  const time = BigInt(Date.now());
  const rand = crypto.randomBytes(10);
  let randVal = 0n;
  for (const b of rand) randVal = (randVal << 8n) | BigInt(b);
  return encodeBase32(time, 10) + encodeBase32(randVal, 16);
}

/**
 * Express middleware: populates `res.locals.requestId` and echoes
 * `x-advocate-request-id` on the response. Accepts a well-formed inbound
 * header if present, otherwise mints a fresh ULID.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const inbound = req.header(REQUEST_ID_HEADER);
  const id = inbound && ULID_REGEX.test(inbound) ? inbound : generateUlid();
  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}
