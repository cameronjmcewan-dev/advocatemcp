import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";
import crypto from "crypto";
// AMC-004: /register is a worker-only endpoint (called from worker on
// Stripe checkout success and from the admin/onboarding flow). It must
// NOT be reachable with any tenant Bearer — a leaked tenant key should
// never be able to register a new business. requireServerKeyOnly enforces
// X-API-Key: <SERVER_API_KEY>.
import { requireServerKeyOnly } from "../middleware/auth.js";
import { OnboardingPayloadSchema } from "../schemas/business.js";
import { getApiBaseUrl } from "../lib/baseUrl.js";
import { generateLeadingFaqs } from "../agent/faqGenerator.js";
import type { BusinessRow } from "../db.js";
import { hashApiKey } from "../lib/apiKeyHash.js";

export const registerRouter = Router();

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);
}

/**
 * POST /register — onboard a new business.
 *
 * Validates the request body against OnboardingPayloadSchema (zod), auto-generates
 * a slug + API key, and persists the flat profile columns plus the 9-step wizard
 * JSON blobs. Returns slug, API key, and public endpoint URLs.
 */
registerRouter.post("/register", requireServerKeyOnly, (req: Request, res: Response) => {
  const parsed = OnboardingPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "validation_error",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const p = parsed.data;

  const db = getDb();
  // Prefer the caller-supplied slug (e.g. the worker's mint from wizard
  // input + KV uniqueness check) so worker-side and server-side slugs stay
  // in lockstep. Fall back to slugify(name) when omitted, preserving the
  // legacy /register contract for CLI / manual onboard scripts. The schema
  // already enforces the character class on p.slug, so we trust it directly.
  const baseSlug = p.slug ?? slugify(p.name);
  const apiKey = crypto.randomUUID();
  const j = (v: unknown): string | null =>
    v === undefined ? null : JSON.stringify(v);

  // Pick + INSERT is retried on UNIQUE-slug violations to close the race
  // where two concurrent /register calls (same business name, different
  // Node processes on the same DB) both pass the "is the slug free" check
  // and race each other to INSERT. The winner commits, the loser hits
  // SQLITE_CONSTRAINT_UNIQUE, bumps the suffix, and retries. Bounded at
  // MAX_SLUG_ATTEMPTS so a pathological contention storm returns 503 rather
  // than looping forever. Within a single Node process better-sqlite3's
  // synchronous API serializes the handler — this is the multi-process case.
  const MAX_SLUG_ATTEMPTS = 10;
  const insertStmt = db.prepare(
    `INSERT INTO businesses
       (slug, name, description, services, pricing, location, phone, website,
        referral_url, tone, api_key,
        category, star_rating, review_count, years_in_business, top_services,
        availability, differentiator, service_radius_miles, certifications,
        pricing_tier, service_area_keywords,
        hours_json, services_json_v2, pricing_json_v2, credentials_json,
        ratings_json, differentiators_text, customer_quotes_json,
        guarantee_text, case_stories_json, lead_routing_json,
        plan, email,
        beta_started_at, beta_ends_at, beta_coupon_id, beta_cohort,
        avg_booking_value_cents, revenue_currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const slugFreeStmt = db.prepare("SELECT id FROM businesses WHERE slug = ?");

  let insertedSlug: string | null = null;
  let suffix = 0;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    // Advance suffix until the slug is free at this instant. The pick is
    // inside the retry loop so every attempt picks fresh.
    let candidate = suffix === 0 ? baseSlug : `${baseSlug}-${suffix}`;
    while (slugFreeStmt.get(candidate)) {
      suffix++;
      candidate = `${baseSlug}-${suffix}`;
    }

    try {
      insertStmt.run(
        candidate,
        p.name,
        p.description,
        JSON.stringify(p.services),
        p.pricing ?? null,
        p.location,
        p.phone ?? null,
        p.website ?? null,
        p.referral_url ?? p.website ?? null,
        p.tone,
        apiKey,
        p.category,
        p.star_rating,
        p.review_count,
        p.years_in_business ?? null,
        p.top_services ?? null,
        p.availability ?? null,
        p.differentiator ?? null,
        p.service_radius_miles ?? null,
        p.certifications ?? null,
        p.pricing_tier ?? null,
        p.service_area_keywords ?? null,
        j(p.hours_json),
        j(p.services_json_v2),
        j(p.pricing_json_v2),
        j(p.credentials_json),
        j(p.ratings_json),
        p.differentiators_text ?? null,
        j(p.customer_quotes_json),
        p.guarantee_text ?? null,
        j(p.case_stories_json),
        j(p.lead_routing_json),
        // Session 4: 'pro' tenants are picked up by the competitor-radar cron;
        // 'base' is the default at the column level too — we pass the literal
        // here only so an explicit forwarding from the wizard takes effect.
        p.plan ?? "base",
        p.email ?? null,
        // Beta cohort fields. Worker stripe webhook detects the beta
        // promo code at checkout, then forwards these to /register so
        // server-side digest + ending-email crons can pick the right copy.
        p.beta_started_at ?? null,
        p.beta_ends_at ?? null,
        p.beta_coupon_id ?? null,
        p.beta_cohort ?? null,
        // Revenue attribution (Pro feature, Apr 27 2026). avg_booking_value
        // arrives from the wizard step 4 (pricing); customers can also
        // edit it later from Settings. revenue_webhook_secret is generated
        // server-side on first opt-in via the settings endpoint, never on
        // signup, so it stays null here. revenue_currency falls back to
        // the column-level default 'USD' when omitted.
        p.avg_booking_value_cents ?? null,
        p.revenue_currency ?? "USD",
      );
      insertedSlug = candidate;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      // Only retry on slug-unique collision; everything else is a genuine
      // failure that deserves a 500.
      if (/UNIQUE/i.test(msg) && /\.slug\b/i.test(msg)) {
        suffix++;
        continue;
      }
      console.error("[register] Error:", err);
      res.status(500).json({
        error: "registration_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
      return;
    }
  }

  if (insertedSlug === null) {
    console.error(`[register] slug_contention_exhausted baseSlug=${baseSlug} attempts=${MAX_SLUG_ATTEMPTS}`);
    res.status(503).json({
      error: "slug_contention",
      message: "could not allocate unique slug; retry",
    });
    return;
  }

  // SOC 2 CC6.1: populate api_key_hash + api_key_prefix alongside the
  // plaintext api_key column. The plaintext column is retained during the
  // dual-read transition (see migration 039 header for the strategy);
  // populating the hash on every new row means we never widen the set of
  // legacy plaintext-only rows.
  try {
    const { hash, prefix } = hashApiKey(apiKey);
    db.prepare(
      "UPDATE businesses SET api_key_hash = ?, api_key_prefix = ? WHERE slug = ?",
    ).run(hash, prefix, insertedSlug);
  } catch (err) {
    // Hashing failure should not abort registration. The auth middleware's
    // legacy fallback path will still validate the plaintext column. Log
    // loudly so the operator sees the hash backfill never landed.
    console.error(`[register] api_key_hash_backfill_failed slug=${insertedSlug}`, err);
  }

  // Fire-and-forget FAQ generation (Phase 1 grey-hat optimization, Apr 28
  // 2026). The /register response returns immediately with the slug +
  // api_key — generation runs after, takes ~3-5s, lands in `faqs_json`
  // when complete. Gated on FEATURE_FAQS_V2; if disabled or the call
  // throws, the row stays NULL and the daily cron picks it up later.
  // No await — onboarding latency is fixed, generation is best-effort.
  const flag = (process.env.FEATURE_FAQS_V2 ?? "").toLowerCase();
  if ((flag === "true" || flag === "1") && process.env.ANTHROPIC_API_KEY) {
    const newRow = db.prepare("SELECT * FROM businesses WHERE slug = ?").get(insertedSlug) as BusinessRow | undefined;
    if (newRow) {
      void (async () => {
        try {
          const out = await generateLeadingFaqs(newRow);
          if (out.faqs.length >= 3) {
            db.prepare(
              "UPDATE businesses SET faqs_json = ?, faqs_generated_at = ?, faqs_source = 'claude' WHERE id = ?",
            ).run(JSON.stringify(out.faqs), Date.now(), newRow.id);
            console.log(`[register-faqs] ${newRow.slug}: ${out.faqs.length} FAQs (rejected ${out.rejected}; ${out.cost_cents.toFixed(2)}¢)`);
          } else {
            console.warn(`[register-faqs] ${newRow.slug}: only ${out.faqs.length} valid FAQs; leaving NULL for cron retry.`);
          }
        } catch (err) {
          console.error(`[register-faqs] ${newRow.slug}: error`, err);
        }
      })();
    }
  }

  const base = getApiBaseUrl();
  res.status(201).json({
    slug: insertedSlug,
    api_key: apiKey,
    agent_endpoint: `${base}/agents/${insertedSlug}/query`,
    profile_endpoint: `${base}/agents/${insertedSlug}/profile`,
    mcp_endpoint: `${base}/mcp`,
    wellknown_url: `https://<your-domain>/.well-known/ai-agent.json`,
  });
});
