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

export const adminExperimentsRouter = Router();

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
