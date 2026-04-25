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
});
export type OnboardingPayload = z.infer<typeof OnboardingPayloadSchema>;
