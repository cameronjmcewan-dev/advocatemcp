import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { verifyContinuationToken, getSigningKey } from "../lib/continuationToken.js";
import { getDb } from "../db.js";

export const a2aRouter = Router();

/**
 * Map a thrown token-verification error to (HTTP code, reason string).
 * `verifyContinuationToken` throws string literals ("malformed" | "bad_signature" | "expired").
 * If an Error (or anything else) ever surfaces, collapse to 401/internal_error rather than
 * leaking stack bits.
 *   - malformed         → 400 (syntactically invalid input)
 *   - bad_signature     → 401 (authentication failed)
 *   - expired           → 401 (credential no longer authenticates)
 */
function mapTokenError(err: unknown): { code: number; reason: string } {
  if (typeof err !== "string") return { code: 401, reason: "internal_error" };
  if (err === "malformed") return { code: 400, reason: err };
  if (err === "bad_signature" || err === "expired") return { code: 401, reason: err };
  return { code: 401, reason: "internal_error" };
}

const confirmBody = z.object({ confirmation_token: z.string().min(1) });

a2aRouter.post("/a2a/confirm", (req: Request, res: Response) => {
  const parsed = confirmBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
  }
  let payload;
  try {
    payload = verifyContinuationToken(parsed.data.confirmation_token, getSigningKey());
  } catch (err) {
    const { code, reason } = mapTokenError(err);
    return res.status(code).json({ error: reason });
  }
  if (payload.scope !== "confirm") {
    return res.status(401).json({ error: "wrong_scope" });
  }

  // Atomic transition: flip to 'confirmed' only if still 'held' AND the token's
  // business_slug matches the row. This collapses the check-then-update race to
  // zero and prevents a cross-tenant confirm if a token somehow references
  // another tenant's reservation id.
  const upd = getDb()
    .prepare(`UPDATE reservations SET status='confirmed' WHERE id = ? AND business_slug = ? AND status='held'`)
    .run(payload.ticket, payload.business_slug);

  if (upd.changes === 1) {
    return res.status(200).json({ reservation_id: payload.ticket, status: "confirmed" });
  }

  // 0 rows changed: either the reservation doesn't exist, belongs to another
  // tenant, or is not in 'held'. Disambiguate for the caller.
  const row = getDb()
    .prepare(`SELECT status, business_slug FROM reservations WHERE id = ?`)
    .get(payload.ticket) as { status: string; business_slug: string } | undefined;
  if (!row) return res.status(404).json({ error: "reservation_not_found" });
  if (row.business_slug !== payload.business_slug) {
    return res.status(404).json({ error: "reservation_not_found" });
  }
  return res.status(409).json({ error: "not_confirmable", current_status: row.status });
});

a2aRouter.post("/a2a/continue/:token", (req: Request, res: Response) => {
  let payload;
  try {
    payload = verifyContinuationToken(req.params.token ?? "", getSigningKey());
  } catch (err) {
    const { code, reason } = mapTokenError(err);
    return res.status(code).json({ error: reason });
  }
  if (payload.scope !== "continue") {
    return res.status(401).json({ error: "wrong_scope" });
  }
  return res.status(200).json({
    ticket: payload.ticket,
    business_slug: payload.business_slug,
    agent_id: payload.agent_id ?? null,
    ts: payload.ts,
  });
});
