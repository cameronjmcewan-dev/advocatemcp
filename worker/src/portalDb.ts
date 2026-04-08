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
  created_at: string;
  updated_at: string;
}

export interface Business {
  id: string;
  slug: string;
  business_name: string;
  api_key: string;
  created_at: string;
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
      id:            row.user_id as string,
      email:         row.email as string,
      password_hash: row.password_hash as string,
      salt:          row.salt as string,
      full_name:     row.full_name as string | null,
      role:          row.role as string,
      created_at:    row.u_created_at as string,
      updated_at:    row.u_updated_at as string,
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
