/**
 * IONOS DNS client. Used by some EU customers (1&1 / IONOS is the
 * dominant German registrar). Their public DNS API is straightforward:
 * single API key authentication via X-API-Key header, JSON over HTTPS.
 *
 * Auth: customer creates an API key at
 * https://developer.hosting.ionos.com/keys. The key is delivered as
 * "PublicPrefix.Secret" — they paste the full thing.
 *
 * Apex story: IONOS DNS doesn't natively support ANAME/ALIAS at apex.
 * Their API supports CNAME records but the spec forbids CNAME at apex
 * (RFC 1034). We route apex via static A records pointing at our
 * anycast IPs — same pattern as Route53.
 *
 * Same security model: credentials never persist.
 */

const IONOS_API_BASE = "https://api.hosting.ionos.com/dns/v1";
const FETCH_TIMEOUT_MS = 8000;
const APEX_A_IPS = ["104.21.44.57", "172.67.195.220"];

interface IonosAuth {
  /** Full API key — "PublicPrefix.Secret" format pasted by customer. */
  apiKey: string;
}

interface ValidateResult {
  ok: boolean;
  reason?: string;
  zone_id?: string;
  zone_name?: string;
}

interface RecordSpec {
  type: "CNAME" | "TXT" | "A";
  /** FQDN — IONOS expects fully-qualified names. */
  name: string;
  /** Single value per record. CNAME target / TXT data / A IP. */
  content: string;
  ttl?: number;
  /** Always false for our records. IONOS uses this for staging. */
  disabled?: boolean;
}

interface RecordResult {
  ok: boolean;
  reason?: string;
  already_exists?: boolean;
}

async function ionosFetch<T>(
  auth: IonosAuth,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${IONOS_API_BASE}${path}`, {
      method,
      headers: {
        "X-API-Key": auth.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let parsed: T | null = null;
    try {
      const text = await res.text();
      parsed = text ? (JSON.parse(text) as T) : null;
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

function looksLikeApiKey(s: string): boolean {
  // IONOS keys are dot-separated PublicPrefix.Secret, alphanumeric, ~80 chars total.
  return typeof s === "string" && s.length >= 20 && s.length <= 300 && /^[A-Za-z0-9._-]+$/.test(s) && s.includes(".");
}

/** Validate the API key by listing zones and finding the customer's apex. */
export async function validateIonosCredential(
  auth: IonosAuth,
  customerDomain: string,
): Promise<ValidateResult> {
  const cleanKey = auth.apiKey.trim();
  if (!looksLikeApiKey(cleanKey)) {
    return { ok: false, reason: "credential_format_invalid" };
  }
  const apex = customerDomain.replace(/^www\./i, "").toLowerCase();

  type ZonesResp = Array<{ id: string; name: string; type?: string }>;
  const r = await ionosFetch<ZonesResp>({ apiKey: cleanKey }, "GET", "/zones");
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "credential_invalid_or_revoked" };
    return { ok: false, reason: "credential_verify_failed" };
  }
  if (!Array.isArray(r.data)) return { ok: false, reason: "credential_verify_failed" };

  const zone = r.data.find((z) => z.name?.toLowerCase() === apex);
  if (!zone) return { ok: false, reason: "domain_not_found_for_credential" };

  return { ok: true, zone_id: zone.id, zone_name: zone.name };
}

/**
 * Apply records via PATCH /zones/{zoneId}/records — IONOS supports
 * batch upsert. Their API merges existing records by (type, name, content)
 * triple, so submitting an already-present record is a no-op.
 *
 * Behavior on conflict (different content at same type+name):
 * IONOS REPLACES, which we don't want. We GET first, detect, and
 * surface conflicts to the customer rather than silently overwrite.
 */
export async function applyIonosRecords(
  auth: IonosAuth,
  zoneId: string,
  specs: RecordSpec[],
): Promise<{ overall_ok: boolean; results: Array<RecordResult & { spec: RecordSpec }> }> {
  const cleanKey = auth.apiKey.trim();
  const credentials = { apiKey: cleanKey };

  // Get existing records to detect conflicts.
  type ZoneResp = { id: string; name: string; records: Array<{ type: string; name: string; content: string; id: string }> };
  const list = await ionosFetch<ZoneResp>(credentials, "GET", `/zones/${zoneId}`);
  const existing = list.ok && list.data?.records ? list.data.records : [];

  const results: Array<RecordResult & { spec: RecordSpec }> = [];
  const toCreate: RecordSpec[] = [];

  for (const spec of specs) {
    const match = existing.find((e) =>
      e.type === spec.type && e.name.toLowerCase() === spec.name.toLowerCase()
    );
    if (match) {
      if (match.content === spec.content || match.content === `"${spec.content}"`) {
        results.push({ ok: true, already_exists: true, spec });
        continue;
      }
      // Conflict — different content at same type+name.
      results.push({
        ok: false,
        reason: `record_conflict_${spec.type.toLowerCase()}_${spec.name.replace(/\.+$/, "").split(".")[0]}`,
        spec,
      });
      continue;
    }
    toCreate.push(spec);
    results.push({ ok: true, spec });
  }

  // Skip the write if any conflicts — let the customer resolve.
  if (results.some((r) => !r.ok)) {
    return { overall_ok: false, results };
  }

  if (toCreate.length === 0) {
    return { overall_ok: true, results };
  }

  // PATCH the zone with new records.
  const patchBody = toCreate.map((s) => ({
    name: s.name,
    type: s.type,
    content: s.content,
    ttl: s.ttl ?? 3600,
    disabled: false,
  }));

  const patch = await ionosFetch(credentials, "PATCH", `/zones/${zoneId}`, patchBody);
  if (!patch.ok) {
    if (patch.status === 401 || patch.status === 403) {
      return {
        overall_ok: false,
        results: results.map((r) => r.ok ? { ...r, ok: false, reason: "permission_denied" } : r),
      };
    }
    return {
      overall_ok: false,
      results: results.map((r) => r.ok && !r.already_exists ? { ...r, ok: false, reason: "record_create_failed" } : r),
    };
  }

  return { overall_ok: true, results };
}

export const IONOS_APEX_A_IPS = APEX_A_IPS;
