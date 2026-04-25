/* Admin endpoint for triggering format-judge experiments.
 *
 * The experiment harness lives at server/src/experiments/formatJudge/.
 * It needs ANTHROPIC_API_KEY (the production agent's key works fine
 * for judge calls — same Anthropic account, different model usage).
 *
 * POST /admin/experiments/format-judge
 *   body: { profile_slugs?, queries?, variant_ids?, judges? }
 *   auth: bearer ADMIN_API_KEY
 *   returns: { cfg, summary, trials, report_md }
 *
 * Cost: roughly $0.50–$1 per default-config run (1 profile × 5 queries
 * × 6 variants × 1 Sonnet judge = 30 trials). Pricing scales linearly
 * with profiles × queries × variants × judges.
 *
 * Idempotency: every call is a fresh run; results are not persisted
 * server-side. Caller writes the response to disk if they want it
 * archived.
 */

import { Router, type Request, type Response } from "express";
import { runExperiment } from "../../experiments/formatJudge/runner.js";
import { getDb } from "../../db.js";
import type { BusinessRow } from "../../db.js";

export const adminExperimentsRouter = Router();

/* GET /admin/profile-scores
 * Bulk read of every tenant's cached profile-score (no API spend).
 * Powers a fleet-wide admin view: which tenants score high, which
 * have stale scores, who hasn't run yet. */
adminExperimentsRouter.get(
  "/admin/profile-scores",
  (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT slug, name, last_score_json, score_history_json
           FROM businesses
          ORDER BY name ASC`
      )
      .all() as Array<Pick<BusinessRow, "slug" | "name" | "last_score_json" | "score_history_json">>;
    const out = rows.map((r) => {
      let blob: { score?: number; cite_rate?: number; run_at?: string; profile_hash?: string } | null = null;
      try { blob = r.last_score_json ? JSON.parse(r.last_score_json) : null; } catch { blob = null; }
      let history: Array<{ score: number; run_at: string }> = [];
      try {
        const h = r.score_history_json ? JSON.parse(r.score_history_json) : [];
        if (Array.isArray(h)) history = h;
      } catch { history = []; }
      return {
        slug:      r.slug,
        name:      r.name,
        has_score: !!blob,
        score:     blob?.score ?? null,
        cite_rate: blob?.cite_rate ?? null,
        run_at:    blob?.run_at ?? null,
        history,
      };
    });
    res.json({ tenants: out, count: out.length });
  },
);

adminExperimentsRouter.post(
  "/experiments/format-judge",
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      profile_slugs?: unknown;
      queries?: unknown;
      variant_ids?: unknown;
      judges?: unknown;
      profile_patches?: unknown;
    };

    function asStringArray(v: unknown): string[] | undefined {
      if (!Array.isArray(v)) return undefined;
      const out = v.filter((x): x is string => typeof x === "string");
      return out.length > 0 ? out : undefined;
    }

    function asProfilePatches(v: unknown): Record<string, Record<string, unknown>> | undefined {
      if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
      const out: Record<string, Record<string, unknown>> = {};
      for (const [slug, patch] of Object.entries(v as Record<string, unknown>)) {
        if (patch && typeof patch === "object" && !Array.isArray(patch)) {
          out[slug] = patch as Record<string, unknown>;
        }
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }

    try {
      const result = await runExperiment({
        profileSlugs:   asStringArray(body.profile_slugs),
        queries:        asStringArray(body.queries),
        variantIds:     asStringArray(body.variant_ids),
        judges:         asStringArray(body.judges),
        profilePatches: asProfilePatches(body.profile_patches),
      });
      res.json(result);
    } catch (err) {
      console.error("[format-judge] error:", err);
      res.status(500).json({
        error: "Experiment failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);
