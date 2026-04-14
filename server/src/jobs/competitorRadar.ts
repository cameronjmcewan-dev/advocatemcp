/**
 * Competitor Radar cron handler + pure helpers.
 *
 * This file is the single entry point for P3 polling. The cron-scheduled
 * `pollAll()` will be added in a later task. For now it exports two pure
 * helpers used by seeding and the fan-out loop.
 */

export interface ProfileForSeeding {
  category: string;
  location: string;
  services: string[];
}

/**
 * Produce up to 6 deterministic auto-seed queries from a tenant profile.
 * Field-missing-safe: returns [] if category or location is blank.
 */
export function generateAutoQueries(p: ProfileForSeeding): string[] {
  const cat = p.category.trim();
  const loc = p.location.trim();
  if (!cat || !loc) return [];

  const city = loc.split(",")[0]!.trim();
  const base = [
    `best ${cat} in ${loc}`,
    `top ${cat} in ${city}`,
    `${cat} near me in ${loc}`,
  ];
  const services = (p.services ?? []).slice(0, 3).map((s) => s.trim()).filter(Boolean);
  for (const svc of services) base.push(`${svc} ${cat} ${loc}`);
  return base;
}

/**
 * Fan a stored query into up to 3 phrasing variants. Skips a variant if the
 * query already contains the variant's distinguishing affix (case-insensitive).
 */
export function phrasingVariants(query: string): string[] {
  const lower = query.toLowerCase();
  const out: string[] = [query];
  if (!lower.includes("reviews")) out.push(`${query} reviews`);
  if (!lower.includes("top rated")) out.push(`top rated ${query}`);
  return out;
}
