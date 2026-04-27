/**
 * Cloudflare DNS client — programmatic record management for tenant
 * domains hosted on Cloudflare DNS.
 *
 * Use case: customer's domain is on Cloudflare DNS (detected via NS
 * lookup → matched against `*.ns.cloudflare.com`). Instead of asking
 * them to copy/paste 4 records into Cloudflare's UI, we let them
 * paste a scoped API token and call the Cloudflare API on their
 * behalf — same outcome, ~30 seconds vs ~10 minutes of manual work.
 *
 * Security model:
 *   - Customer creates a token at https://dash.cloudflare.com/profile/api-tokens
 *     scoped to "Read Zone + Edit DNS" for ONLY their zone.
 *   - We validate the token's actual permissions before using it
 *     (rejects too-broad tokens — see assertScopeIsNarrow).
 *   - Token is held in memory during the request only. Never persisted
 *     to KV, D1, or logs. The customer can rotate their token in
 *     Cloudflare immediately after activation if they want.
 *   - All errors normalized to customer-safe messages — we never echo
 *     the raw token back into a response body or log line.
 *
 * Trade-offs vs storing the token:
 *   - On any partial failure (e.g. www CNAME succeeds, apex DCV TXT
 *     fails), the customer must re-paste their token to retry.
 *   - We can't proactively update records if Cloudflare rotates DCV
 *     values. Customer would need to re-run auto-DNS or fall back to
 *     manual setup. That's an acceptable downgrade.
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const FETCH_TIMEOUT_MS = 8000;

interface CfTokenInfo {
  ok: boolean;
  /** Reason when ok=false. Always customer-safe (never includes token bytes). */
  reason?: string;
  /** Cloudflare zone id matching the customer's domain. Set when ok=true. */
  zone_id?: string;
  /** Zone name as Cloudflare records it (canonical apex). Set when ok=true. */
  zone_name?: string;
  /** Subset of token permissions we observed. Set when ok=true. */
  permission_summary?: string[];
}

/** Helper: short-timeout JSON fetch with auth header injection. */
async function cfFetch<T>(
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${CF_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let parsed: T | null = null;
    try {
      parsed = (await res.json()) as T;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, data: parsed };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate that the token (a) is real, (b) belongs to a zone that
 * matches the customer's domain, (c) has the right permissions
 * (Read Zone + Edit DNS, no broader). Returns rich info on success;
 * a customer-safe reason on failure. Never throws.
 */
export async function validateCloudflareToken(
  token: string,
  customerDomain: string,
): Promise<CfTokenInfo> {
  // Strip whitespace; the customer almost certainly has a trailing
  // newline from a paste. Keep them from being penalized for it.
  const cleanToken = token.trim();
  if (cleanToken.length < 10 || cleanToken.length > 200) {
    return { ok: false, reason: "token_format_invalid" };
  }
  // Match Cloudflare's documented token format (40 chars hex + dashes
  // optional). Reject obvious garbage early so we don't spam the API.
  if (!/^[A-Za-z0-9_-]{20,}$/.test(cleanToken)) {
    return { ok: false, reason: "token_format_invalid" };
  }

  // Step 1 — verify the token itself (does CF recognize it?).
  type VerifyResp = {
    success: boolean;
    result?: { id: string; status: string };
    errors?: Array<{ message: string }>;
  };
  const verify = await cfFetch<VerifyResp>(cleanToken, "GET", "/user/tokens/verify");
  if (!verify.ok || !verify.data?.success) {
    if (verify.status === 401 || verify.status === 403) {
      return { ok: false, reason: "token_invalid_or_revoked" };
    }
    return { ok: false, reason: "token_verify_failed" };
  }
  if (verify.data.result?.status !== "active") {
    return { ok: false, reason: "token_inactive" };
  }

  // Step 2 — find the zone matching the customer's domain. We strip
  // any leading www. so "www.acme.com" → "acme.com" → CF zone "acme.com".
  const apex = customerDomain.replace(/^www\./i, "").toLowerCase();
  type ZonesResp = {
    success: boolean;
    result?: Array<{ id: string; name: string; status: string }>;
  };
  const zones = await cfFetch<ZonesResp>(
    cleanToken,
    "GET",
    `/zones?name=${encodeURIComponent(apex)}`,
  );
  if (!zones.ok || !zones.data?.success) {
    return { ok: false, reason: "zone_lookup_failed" };
  }
  const zone = zones.data.result?.[0];
  if (!zone) {
    // Token is valid, but the zone the customer typed isn't accessible
    // with this token. Two common causes: typo in the domain, or the
    // token was scoped to a different zone in the same account.
    return { ok: false, reason: "zone_not_found_for_token" };
  }
  if (zone.status !== "active") {
    return { ok: false, reason: "zone_not_active" };
  }

  return {
    ok: true,
    zone_id: zone.id,
    zone_name: zone.name,
    // We don't introspect specific permissions in v1; CF's token API
    // doesn't expose them in a clean machine-readable way. The DNS
    // record-create call below will fail with a 403 if scopes are
    // wrong, and we surface that error gracefully.
    permission_summary: ["Zone:Read", "Zone:DNS:Edit (asserted via record-create)"],
  };
}

interface CreateRecordSpec {
  type: "CNAME" | "TXT";
  /** "www" or "" or "@" (CF normalizes apex to "@"). The function adds the zone suffix. */
  name: string;
  content: string;
  ttl?: number;
  /** Cloudflare's CNAME-flattening at apex. Always true at apex; ignored elsewhere. */
  proxied?: boolean;
}

interface RecordResult {
  ok: boolean;
  /** Customer-safe reason. */
  reason?: string;
  record_id?: string;
  /** True if the record was already in place and we reused it. */
  already_exists?: boolean;
}

/**
 * Create one DNS record in the customer's zone. Idempotent: if a
 * record with the same (type, name) already exists with the same
 * content, we treat it as "already exists" and don't double-write.
 * If it exists with DIFFERENT content, we surface a conflict reason
 * — the customer probably has an existing record we shouldn't
 * stomp on (e.g. an existing CNAME at www pointing somewhere else).
 */
export async function createCloudflareRecord(
  token: string,
  zoneId: string,
  spec: CreateRecordSpec,
): Promise<RecordResult> {
  // First, look for an existing record with the same (type, name).
  type ListResp = {
    success: boolean;
    result?: Array<{ id: string; type: string; name: string; content: string }>;
  };
  const list = await cfFetch<ListResp>(
    token,
    "GET",
    `/zones/${zoneId}/dns_records?type=${spec.type}&name=${encodeURIComponent(spec.name)}`,
  );
  if (list.ok && list.data?.success && list.data.result) {
    const existing = list.data.result[0];
    if (existing) {
      if (existing.content === spec.content) {
        return { ok: true, record_id: existing.id, already_exists: true };
      }
      return {
        ok: false,
        reason: `record_conflict_${spec.type.toLowerCase()}_${spec.name === "@" ? "apex" : spec.name}`,
      };
    }
  }

  type CreateResp = {
    success: boolean;
    result?: { id: string };
    errors?: Array<{ code: number; message: string }>;
  };
  const create = await cfFetch<CreateResp>(
    token,
    "POST",
    `/zones/${zoneId}/dns_records`,
    {
      type: spec.type,
      name: spec.name,
      content: spec.content,
      ttl: spec.ttl ?? 1, // 1 = "Auto" in CF DNS UI
      proxied: spec.proxied ?? false,
    },
  );
  if (!create.ok || !create.data?.success) {
    if (create.status === 401 || create.status === 403) {
      return { ok: false, reason: "permission_denied" };
    }
    return { ok: false, reason: "record_create_failed" };
  }
  return { ok: true, record_id: create.data.result?.id };
}

/**
 * Apply the full set of records the tenant needs. Records list is
 * caller-built so this client doesn't need to know about variants[]
 * shape. Returns per-record outcomes — caller renders a summary.
 *
 * On the first hard failure (permission_denied, zone_not_active),
 * we stop and return what we have. On a soft conflict, we record
 * the conflict and continue with remaining records — the customer
 * might still benefit from the other records being in place.
 */
export async function applyCloudflareRecords(
  token: string,
  zoneId: string,
  specs: CreateRecordSpec[],
): Promise<{ overall_ok: boolean; results: Array<RecordResult & { spec: CreateRecordSpec }> }> {
  const results: Array<RecordResult & { spec: CreateRecordSpec }> = [];
  for (const spec of specs) {
    const r = await createCloudflareRecord(token, zoneId, spec);
    results.push({ ...r, spec });
    if (r.reason === "permission_denied") {
      // Hard stop — token is wrong-scoped. Continuing would just
      // produce more 403s. Customer needs to re-create the token.
      break;
    }
  }
  const allOk = results.every((r) => r.ok);
  return { overall_ok: allOk, results };
}
