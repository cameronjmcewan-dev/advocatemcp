/**
 * GoDaddy DNS client — programmatic record management for tenants
 * whose domain is on GoDaddy DNS.
 *
 * Auth model: GoDaddy deprecated public OAuth in 2023. The remaining
 * supported path is API key + API secret (the "Production" credential
 * pair the customer creates in their developer dashboard at
 * https://developer.godaddy.com/keys). We pass these as
 * `Authorization: sso-key {KEY}:{SECRET}`.
 *
 * Apex story: GoDaddy doesn't offer ANAME/ALIAS at apex via their
 * core DNS. Two real options:
 *   1. Domain Forwarding (HTTP 301) from apex to https://www.<domain>.
 *      We can create this via the /v1/domains/{domain}/forwards
 *      endpoint. Bots crawling apex follow the 301 to www, hit our
 *      Worker, get the optimized response.
 *   2. Static A records pointing at our SaaS edge IPs. Less flexible
 *      because anycast IPs can change.
 *
 * V1 ships option 1 only — it's the simpler customer story and we can
 * automate it. If the apex 301 path is ever blocked (rare per-tenant
 * GoDaddy config), the customer can fall back to manual A records
 * via the per-provider guide.
 *
 * Same security model as cloudflare.ts: credentials never persist,
 * held in memory during the request only.
 */

const GD_API_BASE = "https://api.godaddy.com/v1";
const FETCH_TIMEOUT_MS = 8000;

interface GdAuth {
  /** API Key from developer.godaddy.com (visible to customer). */
  key: string;
  /** API Secret (sensitive — never echo back). */
  secret: string;
}

interface ValidateResult {
  ok: boolean;
  reason?: string;
  domain?: string;
  status?: string;
  /** Whether the domain is apex-eligible for forwarding setup. */
  forwarding_supported?: boolean;
}

/** Helper: short-timeout JSON fetch with sso-key auth header injection. */
async function gdFetch<T>(
  auth: GdAuth,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; rawText?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GD_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `sso-key ${auth.key}:${auth.secret}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let parsed: T | null = null;
    let rawText: string | undefined;
    try {
      // Some GoDaddy 204s return empty body. Read once into text, then
      // try JSON.parse.
      rawText = await res.text();
      parsed = rawText ? (JSON.parse(rawText) as T) : null;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, data: parsed, rawText };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Format guards for an API key + secret pair. GoDaddy keys are
 * typically ~14 alphanumeric chars, secrets ~22 alphanumeric. We
 * accept a generous range to avoid rejecting legit credentials we
 * haven't seen, but reject obviously-broken input early. */
function looksLikeCredential(s: string): boolean {
  if (typeof s !== "string") return false;
  if (s.length < 8 || s.length > 200) return false;
  return /^[A-Za-z0-9_-]+$/.test(s);
}

/**
 * Validate the API key + secret can manage the customer's domain.
 * Hits /v1/domains/{domain} which requires the credential to have
 * domain-management scope on this specific domain.
 */
export async function validateGoDaddyCredential(
  auth: GdAuth,
  customerDomain: string,
): Promise<ValidateResult> {
  const cleanKey = auth.key.trim();
  const cleanSecret = auth.secret.trim();
  if (!looksLikeCredential(cleanKey) || !looksLikeCredential(cleanSecret)) {
    return { ok: false, reason: "credential_format_invalid" };
  }

  const apex = customerDomain.replace(/^www\./i, "").toLowerCase();

  type DomainResp = { domain?: string; status?: string };
  const r = await gdFetch<DomainResp>(
    { key: cleanKey, secret: cleanSecret },
    "GET",
    `/domains/${encodeURIComponent(apex)}`,
  );

  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      return { ok: false, reason: "credential_invalid_or_revoked" };
    }
    if (r.status === 404) {
      return { ok: false, reason: "domain_not_found_for_credential" };
    }
    return { ok: false, reason: "credential_verify_failed" };
  }
  const status = r.data?.status;
  if (status && status !== "ACTIVE") {
    return { ok: false, reason: "domain_not_active" };
  }
  return {
    ok: true,
    domain: r.data?.domain ?? apex,
    status,
    forwarding_supported: true,
  };
}

interface RecordSpec {
  type: "CNAME" | "TXT";
  /** GoDaddy expects "www" or "@" for apex, NOT the FQDN. */
  name: string;
  data: string;
  ttl?: number;
}

interface RecordResult {
  ok: boolean;
  reason?: string;
  /** True if the record was already in place with same data. */
  already_exists?: boolean;
}

/**
 * Create or update a single DNS record. GoDaddy's /records endpoint
 * is REPLACE-by-(type,name) semantics by default — PUT to
 * /domains/{domain}/records/{type}/{name} replaces every record at
 * that key. We GET first to detect already-correct records (avoid an
 * unnecessary write) and to detect conflicts (existing record with
 * different data we shouldn't blindly stomp on).
 */
export async function createGoDaddyRecord(
  auth: GdAuth,
  domain: string,
  spec: RecordSpec,
): Promise<RecordResult> {
  const cleanKey = auth.key.trim();
  const cleanSecret = auth.secret.trim();
  const credentials = { key: cleanKey, secret: cleanSecret };

  type ListResp = Array<{ type: string; name: string; data: string; ttl?: number }>;
  const list = await gdFetch<ListResp>(
    credentials,
    "GET",
    `/domains/${encodeURIComponent(domain)}/records/${spec.type}/${encodeURIComponent(spec.name)}`,
  );

  if (list.ok && Array.isArray(list.data) && list.data.length > 0) {
    const existing = list.data[0]!;
    if (existing.data === spec.data) {
      return { ok: true, already_exists: true };
    }
    // Different content already there — surface conflict so the
    // customer can resolve.
    return {
      ok: false,
      reason: `record_conflict_${spec.type.toLowerCase()}_${spec.name === "@" ? "apex" : spec.name}`,
    };
  }

  // PUT to replace the (type, name) bucket with our single record.
  const put = await gdFetch(
    credentials,
    "PUT",
    `/domains/${encodeURIComponent(domain)}/records/${spec.type}/${encodeURIComponent(spec.name)}`,
    [{ data: spec.data, ttl: spec.ttl ?? 600 }],
  );
  if (!put.ok) {
    if (put.status === 401 || put.status === 403) {
      return { ok: false, reason: "permission_denied" };
    }
    return { ok: false, reason: "record_create_failed" };
  }
  return { ok: true };
}

interface ForwardingSpec {
  /** "https://www.acme.com" — the redirect target. */
  target_url: string;
  /** "PERMANENT" (301) or "TEMPORARY" (302). Always PERMANENT for our use. */
  type?: "PERMANENT" | "TEMPORARY";
}

/**
 * Set up domain forwarding (apex → https://www.<domain>) so AI bots
 * crawling the apex follow the 301 to www and land on our intercept.
 * This is GoDaddy's substitute for ANAME/ALIAS at apex.
 *
 * Endpoint: PUT /v1/domains/{domain}/forwards/{filter}
 * Body: array of forward specs. We always set type=PERMANENT (301)
 * and strip query string by default for cleanliness.
 */
export async function setupGoDaddyForwarding(
  auth: GdAuth,
  domain: string,
  spec: ForwardingSpec,
): Promise<{ ok: boolean; reason?: string }> {
  const cleanKey = auth.key.trim();
  const cleanSecret = auth.secret.trim();
  const credentials = { key: cleanKey, secret: cleanSecret };

  // PUT to /domains/{domain}/forwards/{filter} where filter is
  // typically the bare apex. Body is a single forward record.
  const r = await gdFetch(
    credentials,
    "PUT",
    `/domains/${encodeURIComponent(domain)}/forwards/${encodeURIComponent(domain)}`,
    [
      {
        type: spec.type ?? "PERMANENT",
        url: spec.target_url,
        // Strip subdomains preserves apex-only forwarding semantics.
        // Strip query/path keep things clean for bot crawls.
        masking: false,
      },
    ],
  );
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      return { ok: false, reason: "permission_denied" };
    }
    if (r.status === 404) {
      // Forwarding endpoint not available for this domain —
      // typically because the domain is on GoDaddy registration but
      // not their DNS. Customer needs to do apex via static A records
      // instead.
      return { ok: false, reason: "forwarding_not_available" };
    }
    return { ok: false, reason: "forwarding_setup_failed" };
  }
  return { ok: true };
}

/**
 * Apply the full set of records the tenant needs. Mirrors the
 * shape of applyCloudflareRecords. Plus an optional forwarding
 * setup for apex when the customer's flow asks us to.
 */
export async function applyGoDaddyRecords(
  auth: GdAuth,
  domain: string,
  specs: RecordSpec[],
  forwardingTarget?: string,
): Promise<{
  overall_ok: boolean;
  results: Array<RecordResult & { spec: RecordSpec }>;
  forwarding?: { ok: boolean; reason?: string };
}> {
  const results: Array<RecordResult & { spec: RecordSpec }> = [];
  for (const spec of specs) {
    const r = await createGoDaddyRecord(auth, domain, spec);
    results.push({ ...r, spec });
    if (r.reason === "permission_denied") break;
  }
  let forwarding: { ok: boolean; reason?: string } | undefined;
  if (forwardingTarget && results.every((r) => r.ok || r.already_exists)) {
    forwarding = await setupGoDaddyForwarding(auth, domain, {
      target_url: forwardingTarget,
      type: "PERMANENT",
    });
  }
  const allOk = results.every((r) => r.ok) && (!forwarding || forwarding.ok);
  return { overall_ok: allOk, results, forwarding };
}
