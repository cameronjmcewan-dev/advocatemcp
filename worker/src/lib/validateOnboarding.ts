// Runtime validator mirroring server/src/schemas/business.ts OnboardingPayloadSchema.
// Zero external dependencies — keeps the Worker bundle small.
// If the zod schema changes, update this file in lockstep.

type OkResult<T> = { ok: true; value: T };
type ErrResult = { ok: false; errors: string[] };
export type Result<T> = OkResult<T> | ErrResult;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

function isStr(v: unknown): v is string { return typeof v === "string"; }
function isNum(v: unknown): v is number { return typeof v === "number" && !Number.isNaN(v); }
function isBool(v: unknown): v is boolean { return typeof v === "boolean"; }
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkDay(v: unknown, errs: string[], path: string): void {
  if (v === null) return;
  if (!isObj(v)) { errs.push(`${path}: must be object or null`); return; }
  if (!isStr(v.open) || !TIME_RE.test(v.open)) errs.push(`${path}.open: HH:MM required`);
  if (!isStr(v.close) || !TIME_RE.test(v.close)) errs.push(`${path}.close: HH:MM required`);
}

function checkHours(h: unknown, errs: string[]): void {
  if (!isObj(h)) { errs.push("hours_json: must be object"); return; }
  for (const d of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const) {
    checkDay(h[d], errs, `hours_json.${d}`);
  }
  if (h.emergency_24_7 !== undefined && !isBool(h.emergency_24_7)) {
    errs.push("hours_json.emergency_24_7: boolean required");
  }
}

function checkCredentials(c: unknown, errs: string[]): void {
  if (!isObj(c)) { errs.push("credentials_json: must be object"); return; }
  if (c.licenses !== undefined) {
    if (!Array.isArray(c.licenses)) {
      errs.push("credentials_json.licenses: array required");
    } else {
      c.licenses.forEach((lic, i) => {
        if (!isObj(lic) || !isStr(lic.name) || !isStr(lic.number)) {
          errs.push(`credentials_json.licenses[${i}]: {name, number} required`);
        }
      });
    }
  }
  if (c.insured !== undefined && !isBool(c.insured)) {
    errs.push("credentials_json.insured: boolean required");
  }
  if (c.bonded !== undefined && !isBool(c.bonded)) {
    errs.push("credentials_json.bonded: boolean required");
  }
  if (c.certifications !== undefined && !Array.isArray(c.certifications)) {
    errs.push("credentials_json.certifications: array required");
  }
}

function checkPricingV2(p: unknown, errs: string[]): void {
  if (!isObj(p)) { errs.push("pricing_json_v2: must be object"); return; }
  if (p.ranges !== undefined) {
    if (!Array.isArray(p.ranges)) {
      errs.push("pricing_json_v2.ranges: array required");
    } else {
      p.ranges.forEach((r, i) => {
        const path = `pricing_json_v2.ranges[${i}]`;
        if (!isObj(r) || !isStr(r.service)) { errs.push(`${path}.service required`); return; }
        if (!isNum(r.min) || !isNum(r.max)) { errs.push(`${path}.min/max: numbers required`); return; }
        if (r.min > r.max) errs.push(`${path}: min must be <= max`);
        if (!isStr(r.unit) || !["job", "hour", "visit", "sqft"].includes(r.unit)) {
          errs.push(`${path}.unit: must be job|hour|visit|sqft`);
        }
      });
    }
  }
}

function checkLeadRouting(l: unknown, errs: string[]): void {
  if (!isObj(l)) { errs.push("lead_routing_json: must be object"); return; }
  if (!isStr(l.preferred_channel) || !["phone", "email", "form", "text"].includes(l.preferred_channel)) {
    errs.push("lead_routing_json.preferred_channel: phone|email|form|text");
  }
  if (l.email !== undefined && (!isStr(l.email) || !EMAIL_RE.test(l.email))) {
    errs.push("lead_routing_json.email: invalid email");
  }
  if (l.form_url !== undefined && (!isStr(l.form_url) || !URL_RE.test(l.form_url))) {
    errs.push("lead_routing_json.form_url: invalid url");
  }
}

/**
 * Validate an onboarding wizard payload. Shape mirrors
 * OnboardingPayloadSchema in `server/src/schemas/business.ts`. When that
 * schema changes, update this function in lockstep.
 */
export function validateOnboardingPayload(raw: unknown): Result<Record<string, unknown>> {
  const errs: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["body must be object"] };

  // Required top-level fields
  if (!isStr(raw.name) || raw.name.length === 0) errs.push("name: required string");
  if (!isStr(raw.description) || raw.description.length === 0) errs.push("description: required string");
  if (!isStr(raw.category) || raw.category.length === 0) errs.push("category: required string");
  if (!isStr(raw.location) || raw.location.length === 0) errs.push("location: required string");
  if (!Array.isArray(raw.services) || raw.services.length === 0 || !raw.services.every(isStr)) {
    errs.push("services: non-empty string[]");
  }
  if (!isNum(raw.star_rating) || raw.star_rating < 0 || raw.star_rating > 5) {
    errs.push("star_rating: number 0–5");
  }
  if (!isNum(raw.review_count) || raw.review_count < 0 || !Number.isInteger(raw.review_count)) {
    errs.push("review_count: non-negative integer");
  }

  // Optional nested blobs
  if (raw.hours_json !== undefined) checkHours(raw.hours_json, errs);
  if (raw.credentials_json !== undefined) checkCredentials(raw.credentials_json, errs);
  if (raw.pricing_json_v2 !== undefined) checkPricingV2(raw.pricing_json_v2, errs);
  if (raw.lead_routing_json !== undefined) checkLeadRouting(raw.lead_routing_json, errs);

  if (raw.pricing_tier !== undefined && isStr(raw.pricing_tier) &&
      !["budget", "mid-range", "premium"].includes(raw.pricing_tier)) {
    errs.push("pricing_tier: budget|mid-range|premium");
  }

  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true, value: raw };
}
