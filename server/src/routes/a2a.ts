import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { verifyContinuationToken } from "../lib/continuationToken.js";
import { getDb } from "../db.js";

export const a2aRouter = Router();

function signingKey(): string {
  const k = process.env.TOKEN_SIGNING_KEY;
  if (k) return k;
  if (process.env.NODE_ENV === "production") {
    throw new Error("TOKEN_SIGNING_KEY must be set in production");
  }
  return "dev-insecure-key";
}

const confirmBody = z.object({ confirmation_token: z.string().min(1) });

a2aRouter.post("/a2a/confirm", (req: Request, res: Response) => {
  const parsed = confirmBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
  }
  let payload;
  try {
    payload = verifyContinuationToken(parsed.data.confirmation_token, signingKey());
  } catch (err) {
    const code = err === "expired" || err === "malformed" ? 400 : 401;
    return res.status(code).json({ error: String(err) });
  }
  if (payload.scope !== "confirm") {
    return res.status(401).json({ error: "wrong_scope" });
  }
  const row = getDb().prepare(`SELECT id, status FROM reservations WHERE id = ?`).get(payload.ticket) as { id: string; status: string } | undefined;
  if (!row) return res.status(404).json({ error: "reservation_not_found" });
  if (row.status !== "held") return res.status(409).json({ error: "not_confirmable", current_status: row.status });
  getDb().prepare(`UPDATE reservations SET status='confirmed' WHERE id = ?`).run(row.id);
  return res.status(200).json({ reservation_id: row.id, status: "confirmed" });
});

a2aRouter.post("/a2a/continue/:token", (req: Request, res: Response) => {
  let payload;
  try {
    payload = verifyContinuationToken(req.params.token ?? "", signingKey());
  } catch (err) {
    const code = err === "expired" || err === "malformed" ? 400 : 401;
    return res.status(code).json({ error: String(err) });
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
