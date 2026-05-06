import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../../db.js";

export const tenantsRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /admin/tenants/:slug/email
 *
 * Admin-only tenant contact-email backfill. Accepts `{ email }` in the
 * body, validates shape, and updates `businesses.email` for the slug.
 * Primary use case is legacy tenants registered before migration 016
 * added the column (e.g. legacy tenants) — the P5 digest job skips tenants with no
 * email on file, so this endpoint is the quickest way to unblock them.
 *
 * Idempotent: setting the same email twice returns `{ changes: 0 }` but
 * still 200. Setting a new value returns `{ changes: 1 }`.
 *
 * Bearer auth is enforced by `routes/admin/index.ts` one level up.
 */
tenantsRouter.post("/tenants/:slug/email", (req: Request, res: Response) => {
  const { slug } = req.params;
  const raw = req.body?.email;
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }

  const db = getDb();
  const existing = db
    .prepare("SELECT email FROM businesses WHERE slug=?")
    .get(slug) as { email: string | null } | undefined;
  if (!existing) {
    res.status(404).json({ error: "tenant_not_found", slug });
    return;
  }

  // Honest idempotency: SQLite's UPDATE always reports changes=1 when WHERE
  // matches a row regardless of value change. Compare first so `changes=0`
  // on a true no-op tells the caller "nothing actually changed".
  let changes = 0;
  if (existing.email !== email) {
    changes = db.prepare("UPDATE businesses SET email=? WHERE slug=?").run(email, slug).changes;
  }
  res.json({ ok: true, slug, email, changes });
});
