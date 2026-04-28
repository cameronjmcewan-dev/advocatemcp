/**
 * Admin endpoint to trigger FAQ generation on-demand for a specific slug.
 *
 * Phase 1 grey-hat verification + operator tool. Without this we'd be stuck
 * waiting for the daily 03:00 UTC cron to populate `faqs_json`. Same admin
 * trigger pattern as `digest/run-now` (server/src/routes/admin/digest.ts).
 *
 * Bearer auth (ADMIN_API_KEY) is enforced by routes/admin/index.ts one
 * level up; this router does not re-check.
 *
 * Apr 28 2026.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../../db.js";
import type { BusinessRow } from "../../db.js";
import { generateLeadingFaqs } from "../../agent/faqGenerator.js";

export const adminFaqsRouter = Router();

/**
 * POST /admin/businesses/:slug/regenerate-faqs
 *
 * Forces FAQ generation for the named slug regardless of current
 * `faqs_json` state. Useful for:
 *   - Verifying Phase 1 deploy without waiting for cron
 *   - Refreshing FAQs after a profile edit
 *   - Manual recovery for tenants the cron skipped
 *
 * Returns the generated FAQs + cost so operators can spot drift in
 * generation cost over time. Synchronous — the call blocks until the
 * generator returns (typically 3-5s) so curl callers see the result
 * immediately. NOT cached; every call re-generates.
 */
adminFaqsRouter.post("/businesses/:slug/regenerate-faqs", async (req: Request, res: Response) => {
  const { slug } = req.params;
  const db = getDb();

  const business = db
    .prepare("SELECT * FROM businesses WHERE slug = ? LIMIT 1")
    .get(slug) as BusinessRow | undefined;
  if (!business) {
    res.status(404).json({ error: "business_not_found", slug });
    return;
  }

  // Refuse to run when the feature flag is off — keeps an operator from
  // accidentally generating FAQs against a tenant whose plan doesn't
  // expect them, and matches the cron's gate.
  const flag = (process.env.FEATURE_FAQS_V2 ?? "").toLowerCase();
  if (flag !== "true" && flag !== "1") {
    res.status(409).json({ error: "feature_disabled", flag: "FEATURE_FAQS_V2" });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(409).json({ error: "anthropic_key_missing" });
    return;
  }

  try {
    const out = await generateLeadingFaqs(business);
    if (out.faqs.length < 3) {
      res.status(422).json({
        error:    "insufficient_faqs",
        message:  "Generator produced <3 valid entries; profile may be too sparse.",
        rejected: out.rejected,
        faqs:     out.faqs,
      });
      return;
    }
    db.prepare(
      "UPDATE businesses SET faqs_json = ?, faqs_generated_at = ?, faqs_source = 'claude' WHERE id = ?",
    ).run(JSON.stringify(out.faqs), Date.now(), business.id);
    res.json({
      slug,
      generated:        out.faqs.length,
      rejected:         out.rejected,
      cost_cents:       out.cost_cents,
      tokens_in:        out.tokens_in,
      tokens_out:       out.tokens_out,
      model:            out.model,
      faqs:             out.faqs,
    });
  } catch (err) {
    res.status(500).json({
      error:   "faq_generation_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
