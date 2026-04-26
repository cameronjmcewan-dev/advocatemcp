/**
 * Namecheap DNS client — programmatic record management for tenants
 * whose domain is registered + DNS-hosted at Namecheap.
 *
 * Auth model: Namecheap's API requires three pieces:
 *   1. ApiUser (Namecheap username — the account that owns the domain)
 *   2. ApiKey  (production key created at namecheap.com/profile/manage/apikey)
 *   3. ClientIp (whitelisted source IP — Namecheap requires the IP making
 *      the API call to be on the account's whitelist)
 *
 * The IP whitelist is the friction. We can't fix that — it's a fundamental
 * constraint of Namecheap's API. The customer-facing flow is:
 *
 *   1. Customer logs in at namecheap.com
 *   2. Profile → Tools → Namecheap API Access → Enable
 *   3. Add 0.0.0.0/0 OR a specific IP (we tell them ours) to the
 *      whitelist
 *   4. Generate the API key
 *   5. Paste username + key into our activate page → we make the call
 *
 * V1 we ask the customer to whitelist 0.0.0.0/0 *for the duration of
 * setup* and to lock it back down after. That's the simplest path
 * because Cloudflare Workers don't have a fixed egress IP — anycast
 * means each call could come from a different edge node.
 *
 * API style: XML-over-HTTP. POST to https://api.namecheap.com/xml.response
 * with all params as querystring. Response is XML; we parse with a
 * small regex-based parser since CF Workers don't ship a DOM parser.
 *
 * Apex story: Namecheap supports an "ALIAS Record" on FreeDNS / BasicDNS
 * (their default DNS service). This works at the apex — same UX as
 * ANAME elsewhere. We use it for apex routing.
 *
 * Same security model as the other clients: credentials never persist,
 * held in memory during the request only.
 */

const NC_API_BASE = "https://api.namecheap.com/xml.response";
const FETCH_TIMEOUT_MS = 8000;

interface NcAuth {
  /** Namecheap username (ApiUser AND UserName params share this). */
  username: string;
  /** Production API key from namecheap.com/profile/manage/apikey. */
  apikey: string;
}

interface ValidateResult {
  ok: boolean;
  reason?: string;
  domain?: string;
}

interface RecordSpec {
  /** Namecheap supports A, AAAA, ALIAS, CNAME, MX, MXE, NS, TXT, URL, URL301, FRAME. */
  type: "CNAME" | "TXT" | "ALIAS";
  /** Hostname relative to the apex: "@", "www", "_cf-custom-hostname", etc. */
  host: string;
  /** Record value. For CNAME/ALIAS, the target hostname. For TXT, the literal value. */
  address: string;
  /** TTL in seconds. Namecheap accepts 60-60000. */
  ttl?: number;
}

interface RecordResult {
  ok: boolean;
  reason?: string;
  already_exists?: boolean;
}

/** Helper: GET to Namecheap's xml.response endpoint with the
 *  required common params. Returns the raw XML body and a quick
 *  success-status flag we extract from the top-level Response. */
async function ncFetch(
  auth: NcAuth,
  command: string,
  extraParams: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; xml: string }> {
  const params = new URLSearchParams({
    ApiUser:  auth.username.trim(),
    ApiKey:   auth.apikey.trim(),
    UserName: auth.username.trim(),
    // ClientIp here is what Namecheap matches against the whitelist.
    // We pass a placeholder; the actual call origin is whatever CF
    // gives us. Customer must whitelist 0.0.0.0/0 for Workers.
    ClientIp: "0.0.0.0",
    Command:  command,
    ...extraParams,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${NC_API_BASE}?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/xml,text/xml" },
      signal: ctrl.signal,
    });
    const xml = await res.text();
    return { ok: res.ok, status: res.status, xml };
  } catch {
    return { ok: false, status: 0, xml: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse Namecheap's `<ApiResponse Status="OK"|"ERROR">`. Returns
 *  the status + first error number (if any) for branching. */
function parseApiStatus(xml: string): { status: "OK" | "ERROR" | "UNKNOWN"; errorNumber?: string; errorText?: string } {
  const statusMatch = xml.match(/<ApiResponse[^>]*Status=["']([^"']+)["']/i);
  const status = statusMatch?.[1]?.toUpperCase();
  if (status === "OK") return { status: "OK" };
  // Errors are inside <Errors><Error Number="N">message</Error></Errors>
  const errMatch = xml.match(/<Error\s+Number=["'](\d+)["'][^>]*>([\s\S]*?)<\/Error>/i);
  if (errMatch) {
    return {
      status: status === "ERROR" ? "ERROR" : "UNKNOWN",
      errorNumber: errMatch[1],
      errorText: errMatch[2]?.trim(),
    };
  }
  return { status: status === "ERROR" ? "ERROR" : "UNKNOWN" };
}

/** Format guards: Namecheap usernames are 1-32 alphanumeric+hyphen,
 *  API keys are 32-char hex-like. We validate loosely to avoid
 *  rejecting legit edge cases while catching paste mistakes. */
function looksLikeUsername(s: string): boolean {
  return typeof s === "string" && s.length >= 1 && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s);
}
function looksLikeApiKey(s: string): boolean {
  return typeof s === "string" && s.length >= 16 && s.length <= 200 && /^[A-Za-z0-9]+$/.test(s);
}

/** Validate that the credential pair (a) is real, (b) the customer's
 *  domain is in this account's domain list. Calls
 *  domains.getList and looks for the customer's domain. */
export async function validateNamecheapCredential(
  auth: NcAuth,
  customerDomain: string,
): Promise<ValidateResult> {
  const username = auth.username.trim();
  const apikey = auth.apikey.trim();
  if (!looksLikeUsername(username) || !looksLikeApiKey(apikey)) {
    return { ok: false, reason: "credential_format_invalid" };
  }
  const apex = customerDomain.replace(/^www\./i, "").toLowerCase();

  const r = await ncFetch({ username, apikey }, "namecheap.domains.getList", {
    PageSize: "100",
    Page:     "1",
  });
  if (!r.ok && r.status === 0) return { ok: false, reason: "credential_verify_failed" };

  const status = parseApiStatus(r.xml);
  if (status.status !== "OK") {
    // Common Namecheap errors:
    //   1011102 — API Key invalid
    //   1011147 — IP not whitelisted
    //   1010104 — ApiUser invalid
    if (status.errorNumber === "1011147") {
      return { ok: false, reason: "ip_not_whitelisted" };
    }
    if (status.errorNumber === "1011102" || status.errorNumber === "1010104") {
      return { ok: false, reason: "credential_invalid_or_revoked" };
    }
    return { ok: false, reason: "credential_verify_failed" };
  }

  // Look for the customer's apex in the domain list.
  const escapedApex = apex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const domainRe = new RegExp(`<Domain[^>]*Name=["']${escapedApex}["']`, "i");
  if (!domainRe.test(r.xml)) {
    return { ok: false, reason: "domain_not_found_for_credential" };
  }

  return { ok: true, domain: apex };
}

/** Read the existing host records for a domain. Used so the apply
 *  step is idempotent — Namecheap's setHosts wipes-and-replaces, so
 *  we have to merge our records into the existing set rather than
 *  blindly overwriting. */
async function getExistingHosts(
  auth: NcAuth,
  apex: string,
): Promise<Array<{ name: string; type: string; address: string; ttl?: string }>> {
  const [sld, ...rest] = apex.split(".");
  const tld = rest.join(".");
  const r = await ncFetch(auth, "namecheap.domains.dns.getHosts", { SLD: sld!, TLD: tld });
  if (!r.ok || parseApiStatus(r.xml).status !== "OK") return [];

  const hosts: Array<{ name: string; type: string; address: string; ttl?: string }> = [];
  // Namecheap returns <host Name="..." Type="..." Address="..." TTL="..." />
  const hostRe = /<host\s+([^>]+)\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = hostRe.exec(r.xml))) {
    const attrs = m[1] ?? "";
    const name = /Name=["']([^"']+)["']/i.exec(attrs)?.[1];
    const type = /Type=["']([^"']+)["']/i.exec(attrs)?.[1];
    const address = /Address=["']([^"']*)["']/i.exec(attrs)?.[1];
    const ttl = /TTL=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (name !== undefined && type && address !== undefined) {
      hosts.push({ name, type, address, ttl });
    }
  }
  return hosts;
}

/**
 * Apply the full set of records the tenant needs. Namecheap's
 * setHosts is replace-the-set, so this:
 *   1. Reads existing records via getHosts
 *   2. For each desired record:
 *      - if a (type, name) already exists with same address → keep
 *      - if exists with different address → preserve original AND log
 *        a conflict (don't overwrite the customer's data)
 *      - if missing → add
 *   3. Writes the merged set back via setHosts
 *
 * Returns per-record outcomes (added / already_exists / conflict).
 */
export async function applyNamecheapRecords(
  auth: NcAuth,
  customerDomain: string,
  specs: RecordSpec[],
): Promise<{ overall_ok: boolean; results: Array<RecordResult & { spec: RecordSpec }> }> {
  const apex = customerDomain.replace(/^www\./i, "").toLowerCase();
  const [sld, ...rest] = apex.split(".");
  const tld = rest.join(".");

  const existing = await getExistingHosts(auth, apex);
  // Build a working set of records we'll PUT back. Start with existing.
  type Working = { name: string; type: string; address: string; ttl: string };
  const working: Working[] = existing.map((e) => ({
    name: e.name,
    type: e.type,
    address: e.address,
    ttl: e.ttl ?? "1800",
  }));

  const results: Array<RecordResult & { spec: RecordSpec }> = [];
  for (const spec of specs) {
    const idx = working.findIndex((w) => w.name === spec.host && w.type === spec.type);
    if (idx >= 0) {
      if (working[idx]!.address === spec.address) {
        results.push({ ok: true, already_exists: true, spec });
        continue;
      }
      // Conflict — don't overwrite.
      results.push({
        ok: false,
        reason: `record_conflict_${spec.type.toLowerCase()}_${spec.host === "@" ? "apex" : spec.host}`,
        spec,
      });
      continue;
    }
    working.push({
      name: spec.host,
      type: spec.type,
      address: spec.address,
      ttl: String(spec.ttl ?? 1800),
    });
    results.push({ ok: true, spec });
  }

  // If any conflicts, don't mutate at all — let the customer resolve.
  const hasConflicts = results.some((r) => !r.ok);
  if (hasConflicts) {
    return { overall_ok: false, results };
  }

  // Build setHosts params: HostName1=..&RecordType1=..&Address1=..&TTL1=..
  const setParams: Record<string, string> = {
    SLD: sld!,
    TLD: tld,
  };
  working.forEach((w, i) => {
    const n = i + 1;
    setParams[`HostName${n}`] = w.name;
    setParams[`RecordType${n}`] = w.type;
    setParams[`Address${n}`] = w.address;
    setParams[`TTL${n}`] = w.ttl;
  });

  const r = await ncFetch(auth, "namecheap.domains.dns.setHosts", setParams);
  if (!r.ok || parseApiStatus(r.xml).status !== "OK") {
    const status = parseApiStatus(r.xml);
    if (status.errorNumber === "1011147") {
      return {
        overall_ok: false,
        results: results.map((rr) => rr.ok ? { ...rr, ok: false, reason: "ip_not_whitelisted" } : rr),
      };
    }
    return {
      overall_ok: false,
      results: results.map((rr) => rr.ok ? { ...rr, ok: false, reason: "set_hosts_failed" } : rr),
    };
  }

  return { overall_ok: true, results };
}
