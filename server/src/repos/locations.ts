/**
 * Locations repository — multi-location support per tenant.
 *
 * One tenant has one or more locations. The agent reads all locations
 * from the system prompt and disambiguates by city/zip when a query
 * mentions a place. Plan-tier caps:
 *
 *   base       → 1 location (the primary, auto-created on register)
 *   pro        → 3 locations
 *   enterprise → unbounded
 *
 * Caps are enforced in addLocation() via a read-then-write that sees
 * the current plan + count. There's no transaction wrapping that pair
 * because better-sqlite3 is synchronous within a single Node process —
 * a concurrent multi-process INSERT race is theoretically possible
 * across Railway replicas, but the worst case is one extra row past
 * the cap, recoverable by deletion. We accept the tradeoff for simpler
 * code; if cap-overflow becomes a real problem later, wrap in BEGIN /
 * COMMIT IMMEDIATE.
 *
 * The `is_primary` invariant — exactly one row per business has
 * is_primary=1 — is enforced by a partial unique index in migration 030.
 * Promoting a non-primary to primary requires demoting the existing
 * primary first inside a transaction (setPrimary() handles this).
 */

import type Database from "better-sqlite3";
import crypto from "crypto";

export type Plan = "base" | "pro" | "enterprise";

export interface LocationRow {
  id:             string;
  business_slug:  string;
  name:           string;
  address_line1:  string | null;
  address_line2:  string | null;
  city:           string;
  state:          string;
  postal_code:    string | null;
  country:        string;
  phone:          string | null;
  hours_json:     string | null;          // raw JSON string from DB
  is_primary:     0 | 1;
  created_at:     string;
}

export interface LocationInput {
  name:           string;
  address_line1?: string | null;
  address_line2?: string | null;
  city:           string;
  state:          string;
  postal_code?:   string | null;
  country?:       string;
  phone?:         string | null;
  hours_json?:    Record<string, unknown> | null;
}

const CAP_BY_PLAN: Record<Plan, number> = {
  base:       1,
  pro:        3,
  enterprise: Number.POSITIVE_INFINITY,
};

function locationId(): string {
  return "loc_" + crypto.randomBytes(10).toString("hex");
}

/** Read every location for a tenant, primary first, then by created_at. */
export function listLocations(db: Database.Database, slug: string): LocationRow[] {
  return db
    .prepare(
      `SELECT * FROM locations
        WHERE business_slug = ?
        ORDER BY is_primary DESC, created_at ASC`,
    )
    .all(slug) as LocationRow[];
}

/**
 * Insert a non-primary location. Reads the tenant's plan + current
 * location count, rejects with code 'plan_limit' when at cap.
 *
 * Returns either an inserted-row response or a structured cap-rejection
 * the route can render as 402 with an upgrade CTA. Throws only for
 * underlying DB errors (constraint violations, schema drift).
 */
export type AddLocationResult =
  | { ok: true; row: LocationRow }
  | { ok: false; code: "plan_limit"; cap: number; current_count: number; plan: Plan }
  | { ok: false; code: "validation"; field: string };

export function addLocation(
  db:    Database.Database,
  slug:  string,
  input: LocationInput,
): AddLocationResult {
  if (!input.name || input.name.trim().length === 0) {
    return { ok: false, code: "validation", field: "name" };
  }
  if (!input.city || input.city.trim().length === 0) {
    return { ok: false, code: "validation", field: "city" };
  }
  if (!input.state || input.state.trim().length === 0) {
    return { ok: false, code: "validation", field: "state" };
  }

  // Read tenant plan + current location count.
  const tenant = db
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .get(slug) as { plan: string | null } | undefined;
  if (!tenant) {
    return { ok: false, code: "validation", field: "business_slug" };
  }
  const plan: Plan = (tenant.plan === "pro" || tenant.plan === "enterprise")
    ? tenant.plan
    : "base";
  const cap = CAP_BY_PLAN[plan];

  const countRow = db
    .prepare("SELECT COUNT(*) AS n FROM locations WHERE business_slug = ?")
    .get(slug) as { n: number };

  if (countRow.n >= cap) {
    return { ok: false, code: "plan_limit", cap, current_count: countRow.n, plan };
  }

  // Insert. is_primary=0 always — the primary is set by the migration
  // backfill or via setPrimary() explicitly. New additions are never
  // automatically promoted.
  const id = locationId();
  db
    .prepare(
      `INSERT INTO locations
         (id, business_slug, name, address_line1, address_line2, city, state,
          postal_code, country, phone, hours_json, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      slug,
      input.name.trim(),
      input.address_line1 ?? null,
      input.address_line2 ?? null,
      input.city.trim(),
      input.state.trim(),
      input.postal_code ?? null,
      input.country ?? "US",
      input.phone ?? null,
      input.hours_json ? JSON.stringify(input.hours_json) : null,
    );

  const row = db
    .prepare("SELECT * FROM locations WHERE id = ? AND business_slug = ?")
    .get(id, slug) as LocationRow;
  return { ok: true, row };
}

/**
 * Update a location's mutable fields. is_primary cannot be flipped here
 * — use setPrimary() so the partial unique index doesn't reject. The
 * tenant slug is verified against the row's owner before any UPDATE
 * lands, preventing cross-tenant edits via a forged location id.
 */
export type UpdateLocationResult =
  | { ok: true; row: LocationRow }
  | { ok: false; code: "not_found" | "validation"; field?: string };

export function updateLocation(
  db:    Database.Database,
  slug:  string,
  id:    string,
  input: Partial<LocationInput>,
): UpdateLocationResult {
  const existing = db
    .prepare("SELECT * FROM locations WHERE id = ? AND business_slug = ?")
    .get(id, slug) as LocationRow | undefined;
  if (!existing) return { ok: false, code: "not_found" };

  // Build the SET clause dynamically from supplied fields. Keep the
  // unsupplied fields at their existing value (no NULL-overwrite).
  const next = {
    name:          input.name          !== undefined ? input.name.trim()      : existing.name,
    address_line1: input.address_line1 !== undefined ? input.address_line1    : existing.address_line1,
    address_line2: input.address_line2 !== undefined ? input.address_line2    : existing.address_line2,
    city:          input.city          !== undefined ? input.city.trim()      : existing.city,
    state:         input.state         !== undefined ? input.state.trim()     : existing.state,
    postal_code:   input.postal_code   !== undefined ? input.postal_code      : existing.postal_code,
    country:       input.country       !== undefined ? (input.country ?? "US") : existing.country,
    phone:         input.phone         !== undefined ? input.phone            : existing.phone,
    hours_json:    input.hours_json    !== undefined
      ? (input.hours_json ? JSON.stringify(input.hours_json) : null)
      : existing.hours_json,
  };

  if (!next.name)  return { ok: false, code: "validation", field: "name" };
  if (!next.city)  return { ok: false, code: "validation", field: "city" };
  if (!next.state) return { ok: false, code: "validation", field: "state" };

  db
    .prepare(
      `UPDATE locations
          SET name = ?, address_line1 = ?, address_line2 = ?,
              city = ?, state = ?, postal_code = ?, country = ?,
              phone = ?, hours_json = ?
        WHERE id = ? AND business_slug = ?`,
    )
    .run(
      next.name,
      next.address_line1,
      next.address_line2,
      next.city,
      next.state,
      next.postal_code,
      next.country,
      next.phone,
      next.hours_json,
      id,
      slug,
    );

  const row = db
    .prepare("SELECT * FROM locations WHERE id = ? AND business_slug = ?")
    .get(id, slug) as LocationRow;
  return { ok: true, row };
}

/**
 * Remove a location. Refuses to delete the primary — the customer must
 * promote a different location to primary first. This prevents the
 * "tenant exists with zero locations" state which the AI agent's
 * Locations: prompt block isn't designed to handle.
 */
export type RemoveLocationResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "primary_locked" };

export function removeLocation(
  db:   Database.Database,
  slug: string,
  id:   string,
): RemoveLocationResult {
  const row = db
    .prepare("SELECT is_primary FROM locations WHERE id = ? AND business_slug = ?")
    .get(id, slug) as { is_primary: 0 | 1 } | undefined;
  if (!row) return { ok: false, code: "not_found" };
  if (row.is_primary === 1) return { ok: false, code: "primary_locked" };

  db
    .prepare("DELETE FROM locations WHERE id = ? AND business_slug = ?")
    .run(id, slug);
  return { ok: true };
}

/**
 * Promote a non-primary location to primary, demoting the existing
 * primary in the same transaction so the partial unique index never
 * sees two primaries simultaneously.
 */
export function setPrimary(
  db:   Database.Database,
  slug: string,
  id:   string,
): { ok: true } | { ok: false; code: "not_found" } {
  const target = db
    .prepare("SELECT id FROM locations WHERE id = ? AND business_slug = ?")
    .get(id, slug) as { id: string } | undefined;
  if (!target) return { ok: false, code: "not_found" };

  const tx = db.transaction(() => {
    db.prepare("UPDATE locations SET is_primary = 0 WHERE business_slug = ? AND is_primary = 1").run(slug);
    // Defensive: filter the promote UPDATE by BOTH id AND slug. The
    // earlier SELECT already verified id belongs to slug, but adding
    // the slug filter here means even a future refactor that drops
    // the SELECT can't accidentally cross-tenant a promote. Apr 27
    // 2026 audit.
    db.prepare("UPDATE locations SET is_primary = 1 WHERE id = ? AND business_slug = ?").run(id, slug);
  });
  tx();
  return { ok: true };
}

/** Plan caps exposed for the UI to render the "X of Y locations" line
 * without re-implementing the lookup. */
export function getLocationCap(plan: Plan): number {
  return CAP_BY_PLAN[plan];
}
