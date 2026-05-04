// D1 query helpers for the client portal auth layer.
// Separate from the existing server/src/db.ts (SQLite/Railway) to avoid confusion.

import { newId, hashToken, generateSessionToken } from "./auth";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  full_name: string | null;
  role: string;
  email_verified: number;  // 0 or 1 — set during activation, gates dashboard
  created_at: string;
  updated_at: string;
}

export interface Business {
  id: string;
  slug: string;
  business_name: string;
  api_key: string;
  created_at: string;
  domain?: string;
  plan?: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  // Phase F Part 1: activation token minted by the Stripe webhook.
  // All three fields are optional on the TS type because existing
  // callers of SELECT * from before the 0005 migration do not expect
  // them. Nullable on D1 where the column allows it.
  activation_token?: string | null;
  activation_status?: string;
  activation_issued_at?: string | null;
  // Round 4: dashboard onboarding state (migration 0007). All three
  // optional for the same reason as the Phase F fields — legacy rows
  // had no such columns. Readers should treat null/undefined as "not
  // yet onboarded."
  first_dashboard_at?: string | null;
  onboarded_at?: string | null;
  onboarding_state?: string | null;
}

export interface Session {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
}

const SESSION_TTL_MS       = 30 * 24 * 60 * 60 * 1000; // 30 days
const RATE_WINDOW_SECONDS  = 15 * 60;                    // 15 minutes
const MAX_ATTEMPTS         = 5;

// ── Users ──────────────────────────────────────────────────────────────────

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  return db
    .prepare("SELECT * FROM users WHERE email = ? LIMIT 1")
    .bind(email.toLowerCase().trim())
    .first<User>() ?? null;
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  return db
    .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
    .bind(id)
    .first<User>() ?? null;
}

export async function createUser(
  db: D1Database,
  email: string,
  passwordHash: string,
  salt: string,
  fullName?: string,
  role = "client"
): Promise<User> {
  const id  = newId();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, salt, full_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, email.toLowerCase().trim(), passwordHash, salt, fullName ?? null, role, now, now)
    .run();
  const user = await getUserById(db, id);
  if (!user) throw new Error("createUser: insert did not return a row");
  return user;
}

// ── Sessions ───────────────────────────────────────────────────────────────

export async function createSession(
  db: D1Database,
  userId: string
): Promise<{ session: Session; token: string }> {
  const token      = generateSessionToken();
  const tokenHash  = await hashToken(token);
  const id         = newId();
  const now        = new Date().toISOString();
  const expiresAt  = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, userId, tokenHash, expiresAt, now, now)
    .run();

  const session = await db
    .prepare("SELECT * FROM sessions WHERE id = ? LIMIT 1")
    .bind(id)
    .first<Session>();
  if (!session) throw new Error("createSession: insert did not return a row");
  return { session, token };
}

export interface SessionWithUser extends Session {
  user: User;
}

export async function getSessionByToken(
  db: D1Database,
  token: string
): Promise<SessionWithUser | null> {
  const tokenHash = await hashToken(token);
  const now       = new Date().toISOString();

  const row = await db
    .prepare(
      `SELECT
         s.id, s.user_id, s.token_hash, s.expires_at, s.created_at, s.last_seen_at,
         u.email, u.full_name, u.role,
         u.password_hash, u.salt,
         u.email_verified,
         u.created_at  AS u_created_at,
         u.updated_at  AS u_updated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?
       LIMIT 1`
    )
    .bind(tokenHash, now)
    .first<Record<string, unknown>>();

  if (!row) return null;

  // Fire-and-forget: update last_seen_at
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
    .bind(now, tokenHash)
    .run();

  return {
    id:           row.id as string,
    user_id:      row.user_id as string,
    token_hash:   row.token_hash as string,
    expires_at:   row.expires_at as string,
    created_at:   row.created_at as string,
    last_seen_at: row.last_seen_at as string,
    user: {
      id:             row.user_id as string,
      email:          row.email as string,
      password_hash:  row.password_hash as string,
      salt:           row.salt as string,
      full_name:      row.full_name as string | null,
      role:           row.role as string,
      email_verified: row.email_verified as number,
      created_at:     row.u_created_at as string,
      updated_at:     row.u_updated_at as string,
    },
  };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  const tokenHash = await hashToken(token);
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

// ── Businesses ─────────────────────────────────────────────────────────────

export async function getAllBusinesses(db: D1Database): Promise<Business[]> {
  const result = await db
    .prepare("SELECT * FROM businesses ORDER BY business_name")
    .all<Business>();
  return result.results;
}

/**
 * Active businesses only — filters out pending onboarding rows.
 *
 * A row is "pending" when api_key = 'pending' (set by registerBusinessInD1
 * before the Stripe webhook fires). These rows are onboarding-in-progress
 * and must never appear in customer-facing lists (business switcher,
 * aggregate counts) — they skew totals and surface half-setup tenants.
 *
 * getAllBusinesses() is kept for admin debug views where seeing everything
 * matters; use this helper for the dashboard and every /api/client/*
 * proxy that serves user-facing data.
 */
export async function getActiveBusinesses(db: D1Database): Promise<Business[]> {
  const result = await db
    .prepare("SELECT * FROM businesses WHERE api_key != 'pending' ORDER BY business_name")
    .all<Business>();
  return result.results;
}

export async function getUserBusinesses(db: D1Database, userId: string): Promise<Business[]> {
  const result = await db
    .prepare(
      `SELECT b.*
       FROM businesses b
       JOIN user_business_access uba ON uba.business_id = b.id
       WHERE uba.user_id = ?
       ORDER BY b.business_name`
    )
    .bind(userId)
    .all<Business>();
  return result.results;
}

/**
 * Per-business role lookup for the team-accounts feature.
 *
 * Returns the user's role on a specific business, or null if the user
 * has no access to that business. Use this in any handler that needs
 * to gate a write operation on the role (e.g., only owners can invite
 * team members, only owner/editor can change profile, etc.).
 *
 * Migration 0011 added the role column to user_business_access; legacy
 * rows default to 'owner' so this returns the correct role for tenants
 * that pre-date team accounts.
 */
export type BusinessRole = "owner" | "editor" | "viewer";

export async function getUserRoleOnBusiness(
  db: D1Database,
  userId: string,
  businessId: string,
): Promise<BusinessRole | null> {
  const row = await db
    .prepare(
      `SELECT role FROM user_business_access
        WHERE user_id = ? AND business_id = ? LIMIT 1`,
    )
    .bind(userId, businessId)
    .first<{ role: string }>();
  if (!row) return null;
  if (row.role === "owner" || row.role === "editor" || row.role === "viewer") return row.role;
  // Legacy rows or unexpected values fall back to owner — pre-migration
  // tenants always had a single user who paid, so 'owner' is the safe
  // assumption when the column data is dirty.
  return "owner";
}

/**
 * List every team member on a business + their role.
 * Used by the Settings Team card and the role-management endpoints.
 */
export interface TeamMember {
  user_id:        string;
  email:          string;
  full_name:      string | null;
  role:           BusinessRole;
  pending_invite: boolean;
  created_at:     string;
}

export async function listTeamMembers(
  db: D1Database,
  businessId: string,
): Promise<TeamMember[]> {
  const result = await db
    .prepare(
      `SELECT u.id          AS user_id,
              u.email       AS email,
              u.full_name   AS full_name,
              uba.role      AS role,
              u.pending_invite AS pending_invite,
              uba.created_at AS created_at
         FROM users u
         JOIN user_business_access uba ON uba.user_id = u.id
        WHERE uba.business_id = ?
        ORDER BY (uba.role = 'owner') DESC, uba.created_at ASC`,
    )
    .bind(businessId)
    .all<{
      user_id: string;
      email: string;
      full_name: string | null;
      role: string;
      pending_invite: number;
      created_at: string;
    }>();
  return result.results.map((r) => ({
    user_id:        r.user_id,
    email:          r.email,
    full_name:      r.full_name,
    role:           (r.role === "editor" || r.role === "viewer") ? r.role : "owner",
    pending_invite: r.pending_invite === 1,
    created_at:     r.created_at,
  }));
}

export async function getBusinessBySlug(db: D1Database, slug: string): Promise<Business | null> {
  return db
    .prepare("SELECT * FROM businesses WHERE slug = ? LIMIT 1")
    .bind(slug)
    .first<Business>() ?? null;
}

export async function createBusiness(
  db: D1Database,
  slug: string,
  businessName: string,
  apiKey: string
): Promise<Business> {
  const id  = newId();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO businesses (id, slug, business_name, api_key, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, slug, businessName, apiKey, now)
    .run();
  const biz = await db
    .prepare("SELECT * FROM businesses WHERE id = ? LIMIT 1")
    .bind(id)
    .first<Business>();
  if (!biz) throw new Error("createBusiness: insert did not return a row");
  return biz;
}

export async function updateBusinessApiKey(
  db: D1Database,
  slug: string,
  newApiKey: string
): Promise<void> {
  await db
    .prepare("UPDATE businesses SET api_key = ? WHERE slug = ?")
    .bind(newApiKey, slug)
    .run();
}

// ── Round 4: onboarding state helpers ────────────────────────────────────

/**
 * Shape of the JSON blob stored in businesses.onboarding_state. Kept
 * flexible on purpose — checklist keys will churn over time (v2 adds
 * "invite a teammate"), and we'd rather stay schema-stable than add a
 * column per step.
 *
 * Unknown keys are preserved on round-trip. Readers should treat a
 * missing key the same as "not completed."
 */
export interface OnboardingState {
  welcome?: {
    current_slide?: number;
    completed_at?: string | null;
  };
  checklist?: Record<string, { completed_at: string }>;
  tour?: {
    completed_at?: string | null;
  };
  [extra: string]: unknown;
}

export interface OnboardingSnapshot {
  first_dashboard_at: string | null;
  onboarded_at:       string | null;
  state:              OnboardingState;
}

function parseStateBlob(raw: string | null | undefined): OnboardingState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as OnboardingState;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Return the onboarding snapshot for a single slug. Returns null if the
 * business row itself doesn't exist so the caller can 404 cleanly.
 */
export async function getOnboardingState(
  db: D1Database,
  slug: string,
): Promise<OnboardingSnapshot | null> {
  const row = await db
    .prepare(
      "SELECT first_dashboard_at, onboarded_at, onboarding_state FROM businesses WHERE slug = ? LIMIT 1",
    )
    .bind(slug)
    .first<{
      first_dashboard_at: string | null;
      onboarded_at:       string | null;
      onboarding_state:   string | null;
    }>();
  if (!row) return null;
  return {
    first_dashboard_at: row.first_dashboard_at ?? null,
    onboarded_at:       row.onboarded_at ?? null,
    state:              parseStateBlob(row.onboarding_state),
  };
}

/**
 * Atomically stamp first_dashboard_at the first time a non-admin session
 * loads the metrics endpoint for a business. Idempotent — only writes
 * when the column is currently NULL. Returns true if the column was
 * just set (useful for "should we fire the welcome overlay?" callers),
 * false if it already had a value or the slug doesn't exist.
 */
export async function touchFirstDashboardIfNull(
  db: D1Database,
  slug: string,
  atIso: string,
): Promise<boolean> {
  const info = await db
    .prepare(
      "UPDATE businesses SET first_dashboard_at = ? WHERE slug = ? AND first_dashboard_at IS NULL",
    )
    .bind(atIso, slug)
    .run();
  const changes = (info as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return changes > 0;
}

/**
 * Mark a single onboarding step complete. The step key is a dotted
 * path ("welcome.completed", "checklist.dns_configured",
 * "tour.completed") that selects where the value lands in the state
 * blob. `value`, if provided, is stored under the step key; otherwise
 * we stamp { completed_at: <nowIso> } as a default.
 *
 * Also sets businesses.onboarded_at when the caller asserts the final
 * step — callers pass `allCompleted: true` when their own state merge
 * indicates the whole flow is done. We keep that determination on the
 * caller because the list of required checklist keys is hosted-vs-
 * custom-domain specific.
 *
 * Returns the full snapshot post-write so the endpoint can return it
 * in one round-trip.
 */
export async function markOnboardingStep(
  db: D1Database,
  slug: string,
  stepKey: string,
  value: unknown,
  nowIso: string,
  allCompleted: boolean,
): Promise<OnboardingSnapshot | null> {
  const current = await getOnboardingState(db, slug);
  if (!current) return null;

  const next = mergeStep(current.state, stepKey, value ?? { completed_at: nowIso });
  const onboardedAt = allCompleted && !current.onboarded_at ? nowIso : current.onboarded_at;

  await db
    .prepare(
      "UPDATE businesses SET onboarding_state = ?, onboarded_at = ? WHERE slug = ?",
    )
    .bind(JSON.stringify(next), onboardedAt, slug)
    .run();

  return {
    first_dashboard_at: current.first_dashboard_at,
    onboarded_at:       onboardedAt,
    state:              next,
  };
}

function mergeStep(
  base: OnboardingState,
  dottedKey: string,
  value: unknown,
): OnboardingState {
  const parts = dottedKey.split(".").filter(Boolean);
  if (parts.length === 0) return base;
  const out: OnboardingState = { ...base };
  let cursor: Record<string, unknown> = out as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const existing = cursor[key];
    const nested: Record<string, unknown> =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor[key] = nested;
    cursor = nested;
  }
  cursor[parts[parts.length - 1]!] = value;
  return out;
}

// ── Phase F Part 1: activation token helpers ─────────────────────────────

export interface ActivationRecord {
  token: string | null;
  status: string;
  issued_at: string | null;
}

/**
 * Atomically write an activation token for a business, but ONLY if no
 * token has been issued yet. The idempotency guarantee comes from the
 * `activation_token IS NULL` guard in the WHERE clause — a second
 * call after a token has already been stored results in meta.changes
 * = 0 and leaves the existing token untouched.
 *
 * Callers must SELECT first to decide whether to even mint a token (the
 * mint is HMAC-SHA256 and cheap but not free, and we want to avoid
 * signing a token that will be thrown away on every Stripe retry). The
 * SELECT-then-UPDATE pattern would be racy; the atomic WHERE IS NULL
 * here closes that race so the common-case short-circuit in
 * provisionActivationToken can be a pure optimization on top.
 *
 * Returns true when the UPDATE actually landed (this call minted), or
 * false when the row was already populated (no-op — another call got
 * here first). Also returns false if the slug row does not exist; the
 * webhook code path guarantees the row was created at checkout time so
 * this should not happen in production, but the helper is defensive.
 */
export async function setActivationTokenIfMissing(
  db: D1Database,
  slug: string,
  token: string,
  issuedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE businesses
         SET activation_token = ?, activation_status = ?, activation_issued_at = ?
         WHERE slug = ? AND activation_token IS NULL`,
    )
    .bind(token, "pending_send", issuedAt, slug)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * Unconditionally overwrite a slug's activation token + reset status
 * + stamp a fresh issued_at. Used by the admin "resend activation"
 * endpoint so a re-send always goes out with a fresh 7-day TTL window
 * instead of re-mailing the original (potentially expired) token.
 *
 * Returns true when the row exists and was updated; false when the
 * slug doesn't exist (caller surfaces this as 404).
 */
export async function setActivationToken(
  db: D1Database,
  slug: string,
  token: string,
  issuedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE businesses
         SET activation_token = ?, activation_status = ?, activation_issued_at = ?
         WHERE slug = ?`,
    )
    .bind(token, "pending_send", issuedAt, slug)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * Read the activation token record for a business. Returns null when
 * the businesses row itself does not exist (used by the admin retrieval
 * endpoint to distinguish 404 from "200 with token=null"). Returns a
 * record with `token: null` when the row exists but no token has been
 * minted yet.
 */
export async function getActivationRecord(
  db: D1Database,
  slug: string,
): Promise<ActivationRecord | null> {
  const row = await db
    .prepare(
      `SELECT activation_token, activation_status, activation_issued_at
         FROM businesses
         WHERE slug = ?
         LIMIT 1`,
    )
    .bind(slug)
    .first<{
      activation_token: string | null;
      activation_status: string | null;
      activation_issued_at: string | null;
    }>();
  if (!row) return null;
  return {
    token:     row.activation_token,
    status:    row.activation_status ?? "none",
    issued_at: row.activation_issued_at,
  };
}

/**
 * Update the activation_status for a business. Unconditional — callers
 * are responsible for deciding when a status transition is appropriate.
 * Used by the Stripe webhook to flip pending_send → sent after a
 * successful Resend API call, and by the admin resend endpoint.
 */
export async function updateActivationStatus(
  db: D1Database,
  slug: string,
  status: string,
): Promise<void> {
  await db
    .prepare("UPDATE businesses SET activation_status = ? WHERE slug = ?")
    .bind(status, slug)
    .run();
}

export async function updateUserPassword(
  db: D1Database,
  userId: string,
  passwordHash: string,
  salt: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE users SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?")
    .bind(passwordHash, salt, now, userId)
    .run();
}

export async function grantAccess(
  db: D1Database,
  userId: string,
  businessId: string
): Promise<void> {
  const id  = newId();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO user_business_access (id, user_id, business_id, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(id, userId, businessId, now)
    .run();
}

// ── Rate limiting ──────────────────────────────────────────────────────────

export async function checkRateLimit(db: D1Database, identifier: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - RATE_WINDOW_SECONDS * 1000).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM login_attempts WHERE identifier = ? AND attempted_at > ?`
    )
    .bind(identifier, windowStart)
    .first<{ cnt: number }>();
  return (row?.cnt ?? 0) < MAX_ATTEMPTS;
}

export async function recordLoginAttempt(db: D1Database, identifier: string): Promise<void> {
  const id  = newId();
  const now = new Date().toISOString();
  await db
    .prepare(`INSERT INTO login_attempts (id, identifier, attempted_at) VALUES (?, ?, ?)`)
    .bind(id, identifier, now)
    .run();
  // Prune old attempts to keep the table small (fire-and-forget)
  const cutoff = new Date(Date.now() - RATE_WINDOW_SECONDS * 2000).toISOString();
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < ?").bind(cutoff).run();
}

// ── Dashboards (Phase B of dashboard redesign, Apr 29 2026) ─────────────────

export interface Dashboard {
  id:           number;
  user_id:      string;
  business_id:  string;
  name:         string;
  layout_json:  string;
  filters_json: string;
  is_default:   number;          // 0 | 1 (SQLite has no native bool)
  created_at:   number;
  updated_at:   number;
}

/** Layout entry shape — matches DEFAULT_DASHBOARD_LAYOUT in cards.ts. */
export interface DashboardLayoutEntry {
  card_id: string;
  size:    "sm" | "md" | "lg" | "xl";
}

export interface DashboardFilters {
  date_range?:    string | { start: string; end: string } | null;
  intent_filter?: string[] | null;
  bot_filter?:    string[] | null;
}

/** Default 8-card seed used when auto-seeding a new user's first dashboard.
 *  Mirrored from worker/src/routes/dashboard/cards.ts so the seed doesn't
 *  cross the route-vs-db boundary. Update both in lockstep. */
export const DEFAULT_DASHBOARD_LAYOUT_SEED: DashboardLayoutEntry[] = [
  { card_id: "visibilityScore",    size: "sm" },
  { card_id: "clickRate",          size: "sm" },
  { card_id: "queriesOverTime",    size: "lg" },
  { card_id: "botMix",             size: "md" },
  { card_id: "intentDistribution", size: "md" },
  { card_id: "activityHeatmap",    size: "lg" },
  { card_id: "topQueries",         size: "md" },
  { card_id: "agentReputation",    size: "md" },
];

/** List a user's dashboards for a given business. */
export async function getDashboards(
  db: D1Database, userId: string, businessId: string,
): Promise<Dashboard[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, business_id, name, layout_json, filters_json,
              is_default, created_at, updated_at
         FROM dashboards
         WHERE user_id = ? AND business_id = ?
         ORDER BY is_default DESC, created_at ASC`,
    )
    .bind(userId, businessId)
    .all<Dashboard>();
  return result.results ?? [];
}

/** Fetch one dashboard, scoped to the caller's user + business. Returns
 *  null when not found OR when ownership doesn't match. */
export async function getDashboard(
  db: D1Database, id: number, userId: string, businessId: string,
): Promise<Dashboard | null> {
  return db
    .prepare(
      `SELECT id, user_id, business_id, name, layout_json, filters_json,
              is_default, created_at, updated_at
         FROM dashboards
         WHERE id = ? AND user_id = ? AND business_id = ?`,
    )
    .bind(id, userId, businessId)
    .first<Dashboard>();
}

/** Resolve the user's default dashboard for a business, auto-seeding when
 *  none exist. The seeded row uses DEFAULT_DASHBOARD_LAYOUT_SEED. */
export async function getOrSeedDefaultDashboard(
  db: D1Database, userId: string, businessId: string,
): Promise<Dashboard> {
  const existing = await db
    .prepare(
      `SELECT id, user_id, business_id, name, layout_json, filters_json,
              is_default, created_at, updated_at
         FROM dashboards
         WHERE user_id = ? AND business_id = ? AND is_default = 1
         LIMIT 1`,
    )
    .bind(userId, businessId)
    .first<Dashboard>();
  if (existing) return existing;

  // Seed.
  const now = Date.now();
  const layout = JSON.stringify(DEFAULT_DASHBOARD_LAYOUT_SEED);
  await db
    .prepare(
      `INSERT INTO dashboards
         (user_id, business_id, name, layout_json, filters_json,
          is_default, created_at, updated_at)
       VALUES (?, ?, 'Default', ?, '{}', 1, ?, ?)`,
    )
    .bind(userId, businessId, layout, now, now)
    .run();
  // Re-read so we get the auto-generated id.
  const seeded = await db
    .prepare(
      `SELECT id, user_id, business_id, name, layout_json, filters_json,
              is_default, created_at, updated_at
         FROM dashboards
         WHERE user_id = ? AND business_id = ? AND is_default = 1
         LIMIT 1`,
    )
    .bind(userId, businessId)
    .first<Dashboard>();
  if (!seeded) throw new Error("seedDefaultDashboard: insert succeeded but row not found");
  return seeded;
}

/** Create a fresh dashboard. When `copyFromId` is provided, the new row's
 *  layout_json + filters_json are cloned from that dashboard (which must
 *  belong to the same user + business). Otherwise the seed layout is
 *  used. Throws on duplicate name. */
export async function createDashboard(
  db: D1Database,
  userId: string,
  businessId: string,
  name: string,
  copyFromId: number | null,
): Promise<Dashboard> {
  let layout = JSON.stringify(DEFAULT_DASHBOARD_LAYOUT_SEED);
  let filters = "{}";
  if (copyFromId !== null) {
    const src = await getDashboard(db, copyFromId, userId, businessId);
    if (src) { layout = src.layout_json; filters = src.filters_json; }
  }
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO dashboards
         (user_id, business_id, name, layout_json, filters_json,
          is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(userId, businessId, name, layout, filters, now, now)
    .run();
  // D1 doesn't expose lastInsertRowid uniformly. Re-read by name.
  const row = await db
    .prepare(
      `SELECT id, user_id, business_id, name, layout_json, filters_json,
              is_default, created_at, updated_at
         FROM dashboards
         WHERE user_id = ? AND business_id = ? AND name = ?`,
    )
    .bind(userId, businessId, name)
    .first<Dashboard>();
  if (!row) throw new Error(`createDashboard: row missing after insert (name="${name}")`);
  void result;
  return row;
}

/** Update name + layout + filters. Each is independently optional —
 *  caller passes only what changed. */
export async function updateDashboard(
  db: D1Database,
  id: number,
  userId: string,
  businessId: string,
  patch: { name?: string; layout_json?: string; filters_json?: string },
): Promise<Dashboard | null> {
  const sets: string[] = [];
  const binds: (string | number)[] = [];
  if (patch.name !== undefined)         { sets.push("name = ?");         binds.push(patch.name); }
  if (patch.layout_json !== undefined)  { sets.push("layout_json = ?");  binds.push(patch.layout_json); }
  if (patch.filters_json !== undefined) { sets.push("filters_json = ?"); binds.push(patch.filters_json); }
  if (sets.length === 0) return getDashboard(db, id, userId, businessId);
  sets.push("updated_at = ?");
  binds.push(Date.now());
  binds.push(id, userId, businessId);
  await db
    .prepare(
      `UPDATE dashboards SET ${sets.join(", ")}
         WHERE id = ? AND user_id = ? AND business_id = ?`,
    )
    .bind(...binds)
    .run();
  return getDashboard(db, id, userId, businessId);
}

/** Promote `id` to the default dashboard, demoting any other current
 *  default for the same (user, business). Atomic via two-step UPDATE in
 *  D1's prepared-statement batch — D1 doesn't support multi-statement
 *  transactions in a single .run(), so we rely on the partial unique
 *  index for race safety. The two updates are sequenced: demote the old
 *  default first (so the index slot is free), then promote the target. */
export async function promoteDashboardToDefault(
  db: D1Database, id: number, userId: string, businessId: string,
): Promise<Dashboard | null> {
  await db
    .prepare(
      `UPDATE dashboards SET is_default = 0, updated_at = ?
         WHERE user_id = ? AND business_id = ? AND is_default = 1 AND id <> ?`,
    )
    .bind(Date.now(), userId, businessId, id)
    .run();
  await db
    .prepare(
      `UPDATE dashboards SET is_default = 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND business_id = ?`,
    )
    .bind(Date.now(), id, userId, businessId)
    .run();
  return getDashboard(db, id, userId, businessId);
}

/** Delete a dashboard. Refuses when the row is currently is_default=1;
 *  the caller must promote a different dashboard first. Returns true on
 *  success, false when the row didn't exist OR was the default. */
export async function deleteDashboard(
  db: D1Database, id: number, userId: string, businessId: string,
): Promise<{ ok: boolean; reason?: "not_found" | "is_default" }> {
  const row = await getDashboard(db, id, userId, businessId);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.is_default === 1) return { ok: false, reason: "is_default" };
  await db
    .prepare(`DELETE FROM dashboards WHERE id = ? AND user_id = ? AND business_id = ?`)
    .bind(id, userId, businessId)
    .run();
  return { ok: true };
}
