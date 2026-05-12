import type { Request, Response, NextFunction } from "express";
import { getDb, type BusinessRow } from "../db.js";
import {
  hashApiKey,
  verifyApiKeyHash,
  apiKeyPrefix,
} from "../lib/apiKeyHash.js";

// ── Business lifecycle gate (SOC 2 CC6.2/CC6.3) ─────────────────────────────
//
// Statuses that BLOCK authenticated access. Mirrors the vocabulary in
// server/src/db/migrations/038_businesses_status.sql and the worker-side
// migration 0026. Rows pre-dating the migration have business_status='active'
// by default and pass through unaffected.
const BLOCKED_STATUSES: ReadonlySet<string> = new Set(["cancelled", "suspended"]);

function isBlockedStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && BLOCKED_STATUSES.has(status);
}

// ── API key lookup (SOC 2 CC6.1) ────────────────────────────────────────────
//
// resolveBusinessByApiKey implements the dual-read strategy described in
// server/src/db/migrations/039_businesses_api_key_hash.sql:
//
//   1. Prefix lookup → constant-time verify against api_key_hash.
//   2. If the prefix doesn't match any row (or hash doesn't verify), fall
//      back to the legacy plaintext column lookup.
//   3. On legacy-match success, opportunistically backfill the hash + prefix
//      columns so the next request hits the fast path.
//
// The fast path is index-bounded (idx_businesses_api_key_prefix) followed by
// one PBKDF2 verify against a single row. The slow path is one SELECT on the
// plaintext column. Both paths are constant-time with respect to whether a
// match exists (no early return reveals which column matched).
//
// Returns the matched BusinessRow on success and null on failure. The caller
// is responsible for any status / authorization checks beyond key match.

interface ResolveResult {
  row: BusinessRow;
  matched_via: "hash" | "plaintext_legacy";
}

function resolveBusinessByApiKey(rawKey: string): ResolveResult | null {
  if (typeof rawKey !== "string" || rawKey.length === 0) return null;
  const db = getDb();
  const prefix = apiKeyPrefix(rawKey);

  // Fast path: prefix lookup → constant-time verify. Multiple rows could
  // theoretically share the same 8-char prefix (UUID v4 hex has ~32 bits of
  // entropy in the first 8 chars, so collisions are unlikely but not
  // impossible). Iterate all matches and timing-safe-verify each.
  const candidates = db
    .prepare("SELECT * FROM businesses WHERE api_key_prefix = ?")
    .all(prefix) as BusinessRow[];
  for (const row of candidates) {
    if (verifyApiKeyHash(rawKey, row.api_key_hash ?? null)) {
      return { row, matched_via: "hash" };
    }
  }

  // Legacy fallback: plaintext column. Rows pre-dating migration 039 have
  // api_key_hash IS NULL and won't show up via the prefix path. WHERE
  // api_key_hash IS NULL filters out rows that already migrated, so we
  // don't accept the same key via two paths during the transition.
  const legacy = db
    .prepare("SELECT * FROM businesses WHERE api_key = ? AND api_key_hash IS NULL LIMIT 1")
    .get(rawKey) as BusinessRow | undefined;
  if (!legacy) return null;

  // Opportunistic backfill — best effort. Failure leaves the row in legacy
  // mode; next request will retry.
  try {
    const { hash, prefix: newPrefix } = hashApiKey(rawKey);
    db.prepare(
      "UPDATE businesses SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?",
    ).run(hash, newPrefix, legacy.id);
  } catch (err) {
    console.warn(`[auth] backfill_api_key_hash_failed id=${legacy.id}`, err);
  }
  return { row: legacy, matched_via: "plaintext_legacy" };
}

// ── requireApiKey ───────────────────────────────────────────────────────────
// Accepts EITHER:
//   X-API-Key: <SERVER_API_KEY>           (Worker / server-to-server calls)
//   Authorization: Bearer <business_key>  (business owners / direct API calls)
//
// SERVER_API_KEY = process.env.API_KEY (set via Railway env var + wrangler secret)
// business_key  = any valid api_key in the businesses table

function extractKey(req: Request): string | null {
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey) return xKey;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = extractKey(req);
  if (!key) {
    console.warn(`[auth] missing api_key — ${req.method} ${req.path} from ${req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress}`);
    res.status(401).json({ error: "Invalid or missing api_key" });
    return;
  }

  // 1. Server-level key (used by Cloudflare Worker, CI, admin tools).
  // Bypass business_status check — admin operations may need to act on
  // cancelled tenants (read history, run final exports, finalise billing).
  const serverKey = process.env.API_KEY;
  if (serverKey && key === serverKey) { next(); return; }

  // 2. Any valid business api_key in the DB — but only if not blocked.
  // Uses the SOC 2 CC6.1 dual-read path (hash fast path + plaintext legacy).
  const match = resolveBusinessByApiKey(key);
  if (match) {
    if (isBlockedStatus(match.row.business_status)) {
      console.warn(`[auth] blocked status=${match.row.business_status} for key=${key.slice(0, 8)}… — ${req.method} ${req.path}`);
      res.status(401).json({
        error: "subscription_inactive",
        message: "This API key is associated with an inactive subscription.",
      });
      return;
    }
    next();
    return;
  }

  console.warn(`[auth] invalid api_key ${key.slice(0, 8)}… — ${req.method} ${req.path}`);
  res.status(401).json({ error: "Invalid or missing api_key" });
}

// Augment Express request so downstream handlers can access the resolved business
declare global {
  namespace Express {
    interface Request {
      business?: BusinessRow;
    }
  }
}

/**
 * Validates that the `Authorization: Bearer <api_key>` header belongs to
 * the business identified by `:slug` in the route params.
 * Attaches the business row to `req.business` on success.
 */
export function requireSlugApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  const { slug } = req.params;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Missing Authorization header",
      hint: "Use: Authorization: Bearer <your_api_key>",
    });
    return;
  }

  const apiKey = authHeader.slice(7).trim();

  // SOC 2 CC6.1: resolve via the dual-read hash path, then require the
  // matched row's slug equals the URL slug. (Order matters — checking
  // hash first and slug second avoids leaking, via timing, whether the
  // slug exists when the key is wrong.)
  const match = resolveBusinessByApiKey(apiKey);
  if (!match || match.row.slug !== slug) {
    res.status(401).json({ error: "Invalid API key for this business" });
    return;
  }

  // SOC 2 CC6.2/CC6.3: block authenticated access for inactive subscriptions.
  if (isBlockedStatus(match.row.business_status)) {
    console.warn(`[auth] blocked status=${match.row.business_status} slug=${slug} — ${req.method} ${req.path}`);
    res.status(401).json({
      error: "subscription_inactive",
      message: "This subscription is inactive.",
    });
    return;
  }

  req.business = match.row;
  next();
}

/**
 * Strict server-only gate. Accepts ONLY the server admin key
 * (X-API-Key: <API_KEY>). Does NOT accept tenant Bearer keys.
 *
 * Used to lock down cost-sensitive endpoints (profile-score,
 * format-judge) so they can ONLY be reached via the Worker proxy
 * (which holds the secret). Direct Railway access with a leaked
 * tenant api_key is rejected — even though that tenant could call
 * cheap reads, they can't trigger paid Claude runs without going
 * through the Worker.
 *
 * Why this matters: tenant api_keys are visible in the dashboard
 * and could be screenshared, screenshot, or exfiltrated. A leaked
 * tenant key should not let an attacker spam expensive endpoints
 * by hitting Railway's public URL directly. The Worker is the
 * front door; SERVER_API_KEY is its key.
 *
 * The customer's path is unchanged: their session → Worker proxy
 * → Worker injects X-API-Key: SERVER_API_KEY → Railway accepts.
 * Direct curl-with-leaked-Bearer-token paths now get 401.
 */
export function requireServerKeyOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const xKey = req.headers["x-api-key"];
  const serverKey = process.env.API_KEY;
  if (!serverKey) {
    // If SERVER_API_KEY isn't configured, fail closed. We'd rather
    // 503 than accept everything.
    res.status(503).json({ error: "server_misconfigured", message: "API_KEY not configured" });
    return;
  }
  if (typeof xKey === "string" && xKey === serverKey) {
    next();
    return;
  }
  console.warn(`[auth] requireServerKeyOnly rejected ${req.method} ${req.path} from ${req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress}`);
  res.status(401).json({
    error: "server_key_required",
    message: "This endpoint can only be reached via the Worker proxy.",
  });
}

/**
 * Accept EITHER the server admin key (X-API-Key: <API_KEY>) OR a slug-bound
 * business key (Authorization: Bearer <business_api_key> matching :slug).
 *
 * Use for per-tenant read endpoints where admin tools and tenant portals
 * both need access but business keys must be scoped to their own slug.
 */
export function requireSlugOrAdminKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // 1. Server admin key fast-path
  const xKey = req.headers["x-api-key"];
  const serverKey = process.env.API_KEY;
  if (typeof xKey === "string" && serverKey && xKey === serverKey) {
    next();
    return;
  }

  // 2. Slug-bound business key
  const authHeader = req.headers.authorization;
  const { slug } = req.params;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Invalid or missing api_key" });
    return;
  }
  const apiKey = authHeader.slice(7).trim();
  const match = resolveBusinessByApiKey(apiKey);
  if (!match || match.row.slug !== slug) {
    res.status(401).json({ error: "Invalid api_key for this business" });
    return;
  }
  if (isBlockedStatus(match.row.business_status)) {
    console.warn(`[auth] blocked status=${match.row.business_status} slug=${slug} — ${req.method} ${req.path}`);
    res.status(401).json({
      error: "subscription_inactive",
      message: "This subscription is inactive.",
    });
    return;
  }
  next();
}
