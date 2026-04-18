import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import { runAudit } from "../audit.js";
import { canonicalDomain } from "../../lib/domainMatch.js";

export const adminAuditBatchRouter = Router();

const BATCH_MAX = 5;
const CONCURRENCY = 3;

/**
 * POST /admin/audits/batch
 *
 * Run audits on a list of prospects in one operator request — the
 * acquisition outreach accelerator. Cameron drops a list of {domain,
 * category, location?} for businesses he wants to pitch, gets back
 * audit results + share URLs ready to drop into outreach emails.
 *
 * Bypasses the per-IP rate limit (this is an authenticated operator
 * call, not an anonymous public one) but still respects:
 *   - The provider availability check (no audits without OpenAI/Perplexity key)
 *   - The 24h cache (same domain+category+location returns prior result)
 *   - The daily global budget cap (so a runaway batch can't drain the API)
 *
 * Bounded concurrency (3) so a 5-prospect batch finishes in ~7-15s
 * instead of 35s. Each individual audit's queries already run in
 * parallel within the audit, so we cap outer concurrency to avoid
 * hammering the upstream provider.
 *
 * Bearer auth is enforced by `routes/admin/index.ts` one level up.
 *
 * Request body:
 *   {
 *     "prospects": [
 *       { "domain": "acme.com", "category": "plumber", "location": "Boise, ID" },
 *       { "domain": "other.com", "category": "law firm", "location": "Austin, TX" },
 *       ...
 *     ]
 *   }
 *
 * Max 5 prospects per request. Cameron submits multiple batches if
 * he has more.
 *
 * Response:
 *   {
 *     batch_size: N,
 *     succeeded:  M,
 *     results: [
 *       { input: {...}, ok: true,  cached: bool, audit: {...}, share_url: "..." },
 *       { input: {...}, ok: false, error: "...", meta: {...} },
 *       ...
 *     ]
 *   }
 */

interface ProspectInput {
  domain:    string;
  category:  string;
  location?: string | null;
}

interface ParsedProspect {
  raw:      ProspectInput;
  domain:   string;
  category: string;
  location: string | null;
  error?:   string;
}

function parseProspect(p: unknown): ParsedProspect {
  const raw = (p && typeof p === "object" ? p : {}) as ProspectInput;
  const domain = canonicalDomain(typeof raw.domain === "string" ? raw.domain.trim() : "");
  const category = typeof raw.category === "string" ? raw.category.trim() : "";
  const rawLoc = typeof raw.location === "string" ? raw.location.trim() : "";
  const location = rawLoc ? rawLoc.slice(0, 120) : null;

  if (!domain)            return { raw, domain: "", category, location, error: "invalid_domain" };
  if (domain.length > 253) return { raw, domain, category, location, error: "domain_too_long" };
  if (!category)          return { raw, domain, category: "", location, error: "invalid_category" };
  if (category.length > 80) return { raw, domain, category, location, error: "category_too_long" };
  return { raw, domain, category, location };
}

/**
 * Run an array of async tasks with bounded concurrency. Returns results
 * in input order. No external dependency; audit batches at our scale
 * don't need a fully-featured pool.
 */
async function pMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

adminAuditBatchRouter.post("/audits/batch", async (req: Request, res: Response) => {
  const body = req.body;
  if (!body || typeof body !== "object" || !Array.isArray(body.prospects)) {
    res.status(400).json({ error: "missing_prospects_array" });
    return;
  }
  if (body.prospects.length === 0) {
    res.status(400).json({ error: "empty_prospects_array" });
    return;
  }
  if (body.prospects.length > BATCH_MAX) {
    res.status(400).json({ error: "batch_too_large", limit: BATCH_MAX });
    return;
  }

  const parsed: ParsedProspect[] = (body.prospects as unknown[]).map(parseProspect);

  // Hash a synthetic admin-batch IP so audit rows from this path don't
  // pollute the per-IP rate limit on real public traffic. The hash itself
  // is stored on the row so /admin/audits filtering can group these.
  const adminBatchId = crypto.randomBytes(4).toString("hex");
  const adminIpHash  = crypto.createHash("sha256").update(`admin-batch:${adminBatchId}`).digest("hex");

  const results = await pMap(parsed, CONCURRENCY, async (p) => {
    if (p.error) {
      return {
        input: p.raw,
        ok:    false as const,
        error: p.error,
      };
    }
    const r = await runAudit({
      domain:          p.domain,
      category:        p.category,
      location:        p.location,
      ipHash:          adminIpHash,
      skipIpRateLimit: true,
    });
    if (!r.ok) {
      return { input: p.raw, ok: false as const, error: r.error, meta: r.meta };
    }
    return {
      input:     p.raw,
      ok:        true as const,
      cached:    r.cached,
      audit:     r.audit,
      share_url: `https://advocatemcp.com/r/${r.audit.id}`,
    };
  });

  const succeeded = results.filter((r) => r.ok).length;
  res.json({
    batch_size: parsed.length,
    succeeded,
    results,
  });
});
