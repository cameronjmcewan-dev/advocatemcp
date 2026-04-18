import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";
import { verifyToken, type TokenError } from "../lib/tracked-url.js";

export const decodeRouter = Router();

/**
 * Resolve the signing key from env. Mirrors the pattern used in the click
 * pipeline: TOKEN_SIGNING_KEY is required in production. A missing key in
 * non-production environments falls back to a well-known insecure key so
 * local smoke tests work without extra env setup.
 */
function getSigningKey(): string {
  const k = process.env.TOKEN_SIGNING_KEY;
  if (k) return k;
  if (process.env.NODE_ENV === "production") {
    throw new Error("TOKEN_SIGNING_KEY must be set in production");
  }
  return "dev-insecure-key";
}

/**
 * GET /r/:token/decode — read-only intent lookup for customer-site scripts.
 *
 * Verifies the HMAC-signed attribution token and returns the minimum fields a
 * landing page needs to personalize: `{ intent, ref, slug }`. No PII, no
 * `dest`, no `query_id`, no `aid` — the client script only needs to know
 * which AI referred the visitor and what intent they expressed.
 *
 * `intent` is joined from the `queries` row referenced by `token.query_id`.
 * If the row is missing or has a NULL intent (unclassified query), the
 * response returns `intent: null`. Old tokens from before the intent
 * classifier shipped will get `null` and that's expected.
 *
 * CORS: open to any origin since the endpoint exposes zero sensitive data
 * and is specifically designed to be called cross-origin from a customer's
 * own domain. Response is cached briefly so a page reload doesn't slam the
 * endpoint and so a token held across an hour of open tabs stays cheap.
 */
decodeRouter.get("/r/:token/decode", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "private, max-age=60");

  const { token } = req.params;
  let payload;
  try {
    payload = verifyToken(token, getSigningKey());
  } catch (err) {
    const reason = typeof err === "string" ? (err as TokenError) : "malformed";
    res.status(400).json({ error: "invalid_token", reason });
    return;
  }

  const db = getDb();
  const row = db
    .prepare("SELECT intent FROM queries WHERE id = ?")
    .get(payload.query_id) as { intent: string | null } | undefined;

  res.json({
    intent: row?.intent ?? null,
    ref:    payload.ref,
    slug:   payload.slug,
  });
});

// Preflight — browsers will OPTIONS this before the cross-origin GET even
// though the request has no preflight-triggering headers today. Handling
// OPTIONS explicitly keeps us safe if a future version adds a custom header.
decodeRouter.options("/r/:token/decode", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
  res.status(204).end();
});
