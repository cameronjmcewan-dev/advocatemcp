import { z } from "zod";

// HH:MM 24h
const TimeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM 24h");

const DaySchema = z
  .object({ open: TimeStr, close: TimeStr })
  .nullable();

export const HoursSchema = z.object({
  mon: DaySchema,
  tue: DaySchema,
  wed: DaySchema,
  thu: DaySchema,
  fri: DaySchema,
  sat: DaySchema,
  sun: DaySchema,
  emergency_24_7: z.boolean().default(false),
});
export type Hours = z.infer<typeof HoursSchema>;

export const ServicesV2Schema = z.object({
  inclusions: z.array(z.string().min(1)).default([]),
  exclusions: z.array(z.string().min(1)).default([]),
  specialties: z.array(z.string().min(1)).default([]),
  not_offered: z.array(z.string().min(1)).default([]),
});

export const PricingRangeSchema = z
  .object({
    service: z.string().min(1),
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
    unit: z.enum(["job", "hour", "visit", "sqft"]),
  })
  .refine((v) => v.min <= v.max, { message: "min must be <= max" });

export const PricingV2Schema = z.object({
  ranges: z.array(PricingRangeSchema).default([]),
  call_for_quote: z.boolean().default(false),
  free_estimates: z.boolean().default(false),
});

export const CredentialsSchema = z.object({
  licenses: z
    .array(z.object({ name: z.string().min(1), number: z.string().min(1) }))
    .default([]),
  insured: z.boolean().default(false),
  bonded: z.boolean().default(false),
  certifications: z.array(z.string().min(1)).default([]),
});

export const SourceRatingSchema = z.object({
  rating: z.number().min(0).max(5),
  count: z.number().int().nonnegative(),
  // Optional URL to the platform's review page (e.g.
  // https://www.google.com/maps/place/.../@.../reviews ,
  // https://www.yelp.com/biz/...). When present, the per-bot HTML
  // renderer emits Review.url + subjectOf links into JSON-LD so AI
  // search judges treat the platform as a third-party verification
  // source rather than as self-reported. iter7 of the format-judge
  // harness flagged "no third-party verification" as the universal
  // -1 to -2 deduction across all variants — this field unlocks the
  // path to 9-10.
  url: z.string().url().optional(),
  // Verification metadata stamped by POST /agents/:slug/profile/verify-rating
  // when the source has a public read API (currently Google only).
  // Renderer reads `verified_at` to add a "verified <date>" hint into
  // JSON-LD, distinguishing live-pulled ratings from self-reported ones.
  // place_id is opaque to us — we just round-trip it so a future
  // re-verify can skip URL re-parsing.
  place_id: z.string().min(1).max(200).optional(),
  verified_at: z.string().datetime().optional(),
});

export const RatingsSchema = z.object({
  google: SourceRatingSchema.optional(),
  yelp: SourceRatingSchema.optional(),
  facebook: SourceRatingSchema.optional(),
  bbb: SourceRatingSchema.optional(),
});

export const CustomerQuoteSchema = z.object({
  quote: z.string().min(1).max(500),
  author: z.string().min(1).max(120),
  source: z.enum(["google", "yelp", "facebook", "bbb", "direct"]).default("direct"),
});

export const CaseStorySchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(600),
});

export const LeadRoutingSchema = z.object({
  preferred_channel: z.enum(["phone", "email", "form", "text"]),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  form_url: z.string().url().optional(),
});

export const OnboardingPayloadSchema = z.object({
  // Optional caller-supplied slug. When the worker registers a tenant on
  // Railway, the worker has already minted the canonical slug (from wizard
  // input + KV uniqueness check) — passing it through here lets Railway
  // store the same slug instead of slugify(name)-ing the display name and
  // diverging. Without this, the worker stores Railway's api_key under its
  // own slug while Railway has the tenant under slugify(name) — so every
  // /agents/:slug/query call from the bot-interception path 404s.
  // Same character constraints as server's slugify() output: lowercase
  // alphanumeric + single-hyphen separators, 2-60 chars. If omitted (or
  // invalid for any reason) the server falls back to slugify(name) for
  // back-compat with existing /register callers (CLI, manual scripts).
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(2).max(60).optional(),
  // Step 1 — identity
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  category: z.string().min(1).max(80),
  location: z.string().min(1).max(200),
  phone: z.string().optional(),
  website: z.string().url().optional(),
  referral_url: z.string().url().optional(),
  tone: z.enum(["friendly", "professional", "luxury"]).default("friendly"),

  // Step 2 — services (flat + structured)
  services: z.array(z.string().min(1)).min(1),
  services_json_v2: ServicesV2Schema.optional(),

  // Step 3 — hours
  hours_json: HoursSchema.optional(),
  availability: z.string().optional(),
  service_radius_miles: z.number().int().positive().optional(),
  service_area_keywords: z.string().optional(),

  // Step 4 — pricing
  pricing: z.string().optional(),
  pricing_tier: z.enum(["budget", "mid-range", "premium"]).optional(),
  pricing_json_v2: PricingV2Schema.optional(),

  // Step 5 — credentials & trust
  credentials_json: CredentialsSchema.optional(),
  certifications: z.string().optional(),
  years_in_business: z.number().int().nonnegative().optional(),

  // Step 6 — ratings (dual source)
  star_rating: z.number().min(0).max(5),
  review_count: z.number().int().nonnegative(),
  ratings_json: RatingsSchema.optional(),

  // Step 7 — differentiators & proof
  differentiator: z.string().optional(),
  differentiators_text: z.string().max(1500).optional(),
  customer_quotes_json: z.array(CustomerQuoteSchema).optional(),
  guarantee_text: z.string().max(500).optional(),
  case_stories_json: z.array(CaseStorySchema).optional(),
  top_services: z.string().optional(),

  // Step 8 — lead routing
  lead_routing_json: LeadRoutingSchema.optional(),

  // Digest recipient (P5 weekly radar digest). Optional: legacy tenants
  // registered before migration 016 will have NULL; the digest job skips
  // tenants with no email on file rather than crashing.
  email: z.string().email().optional(),

  // Plan tier (Session 4: gates competitor-radar to 'pro' tenants).
  // Optional on the wire — server defaults to 'base' if omitted so legacy
  // callers (CLI, manual onboard scripts) continue to work without change.
  plan: z.enum(["base", "pro"]).optional(),

  // Revenue attribution (Pro feature, Apr 27 2026).
  //
  // avg_booking_value_cents — customer-supplied "average ticket" used to
  //   compute estimated AI-attributed revenue when the customer hasn't
  //   wired up a verified-revenue webhook. Stored as integer cents to
  //   avoid float rounding when multiplied by booking counts. Optional;
  //   when absent the dashboard shows booking counts only, no dollars.
  // revenue_currency — ISO-4217 string for display formatting. Defaults
  //   to USD at the column level; the wire field is optional so almost
  //   no caller has to set it.
  // revenue_webhook_secret is intentionally NOT exposed via the wizard
  //   payload — it is server-generated and only readable via the
  //   authenticated settings endpoint. Customers see/rotate it from
  //   the dashboard, never set it on signup.
  avg_booking_value_cents: z.number().int().nonnegative().max(10_000_000).optional(),
  revenue_currency:        z.string().regex(/^[A-Z]{3}$/, "must be ISO-4217 (3 uppercase letters)").optional(),

  // Beta cohort fields, mirrored from worker D1. Set by the Stripe
  // webhook when checkout used a Stripe promo code on the
  // BETA_COUPON_IDS allowlist. weeklyDigest + betaEndingEmail jobs
  // read these to pick the right copy. ISO timestamps; cohort is a
  // free-text label like "beta_2026_04".
  beta_started_at: z.string().datetime().optional(),
  beta_ends_at:    z.string().datetime().optional(),
  beta_coupon_id:  z.string().max(120).optional(),
  beta_cohort:     z.string().max(60).optional(),
});
export type OnboardingPayload = z.infer<typeof OnboardingPayloadSchema>;
