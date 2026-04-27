/**
 * AWS Route 53 DNS client. Most technical SMBs that aren't on
 * Cloudflare end up here — agencies, marketing firms with custom
 * AWS infra, anyone whose domain was set up by a developer.
 *
 * Auth model: AWS access key + secret key. The customer creates an
 * IAM user with Route53 permissions, generates the access key pair,
 * pastes both into our activate page. Same in-memory-only security
 * model as the other DNS clients — credentials never persist.
 *
 * The hard part: AWS APIs require Signature V4 request signing. We
 * implement it from scratch (small Worker, no AWS SDK dependency)
 * using the SubtleCrypto APIs. SigV4 is well-specified and fits in
 * ~80 lines of code.
 *
 * Apex story: Route 53 has native ALIAS records. ALIAS at apex
 * pointing to a CloudFront/ELB/etc target works. But we route
 * to `customers.advocatemcp.com` (a non-AWS host), which Route53
 * ALIAS does NOT support — ALIAS targets must be AWS resources.
 *
 * So Route53 customers go through the same apex story as everyone
 * who can't use ALIAS: either CNAME-flattening if their TLD allows
 * it (rare), or static A records, or domain forwarding via a
 * separate mechanism. Our V1 ships:
 *   - www CNAME via Route53 (works fine)
 *   - DCV TXT records via Route53 (works fine)
 *   - apex via static A records pointing at our anycast IPs
 *     (104.21.44.57, 172.67.195.220) — set programmatically via
 *     the same API call.
 *
 * If anycast IPs ever rotate the customer would need to re-run the
 * apply step — same fragility note we surface in the manual guide
 * for static A records.
 */

const R53_ENDPOINT = "https://route53.amazonaws.com";
const R53_REGION = "us-east-1"; // Route53 is global but Sigv4 expects us-east-1
const R53_SERVICE = "route53";
const FETCH_TIMEOUT_MS = 8000;

/** Static apex IPs we point Route53 customers' apex A records at. */
const APEX_A_IPS = ["104.21.44.57", "172.67.195.220"];

interface R53Auth {
  accessKeyId: string;
  secretAccessKey: string;
}

interface ValidateResult {
  ok: boolean;
  reason?: string;
  hosted_zone_id?: string;
  zone_name?: string;
}

interface RecordSpec {
  type: "CNAME" | "TXT" | "A";
  /** FQDN, ending in dot — Route53 expects "www.acme.com." not "www" */
  name: string;
  /** For CNAME: target hostname. For TXT: the value (we wrap in quotes). For A: IPv4. */
  values: string[];
  ttl?: number;
}

interface RecordResult {
  ok: boolean;
  reason?: string;
  already_exists?: boolean;
}

// ── SigV4 helpers ────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(hash);
}

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const keyBytes = typeof key === "string" ? enc.encode(key) : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
}

/* AWS SigV4 signing key derivation. */
async function deriveSigningKey(
  secret: string,
  date: string, // YYYYMMDD
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac("AWS4" + secret, date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Sign an AWS request with SigV4. Mutates nothing — returns a new
 *  headers map ready to send. */
async function signSigV4(
  auth: R53Auth,
  method: "GET" | "POST" | "DELETE",
  path: string,
  query: string,
  body: string,
): Promise<SignedRequest> {
  const now = new Date();
  const isoStamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");  // 20240101T000000Z
  const dateStamp = isoStamp.slice(0, 8);                            // 20240101

  const host = "route53.amazonaws.com";
  const payloadHash = await sha256(body);

  // Canonical request
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${isoStamp}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${R53_REGION}/${R53_SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    isoStamp,
    credentialScope,
    await sha256(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey(auth.secretAccessKey, dateStamp, R53_REGION, R53_SERVICE);
  const signatureBytes = await hmac(signingKey, stringToSign);
  const signature = toHex(signatureBytes);

  const authorization =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${auth.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const url = `${R53_ENDPOINT}${path}${query ? `?${query}` : ""}`;
  return {
    url,
    method,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": isoStamp,
      Host: host,
      "Content-Type": "application/xml",
    },
    body,
  };
}

async function r53Fetch(req: SignedRequest): Promise<{ ok: boolean; status: number; xml: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" ? undefined : req.body,
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

// ── Format guards ───────────────────────────────────────────────────────────

function looksLikeAccessKey(s: string): boolean {
  // AWS access keys are typically 20 chars, prefixed "AKIA" or "ASIA".
  return typeof s === "string" && s.length >= 16 && s.length <= 128 && /^[A-Za-z0-9/+=_-]+$/.test(s);
}

function looksLikeSecret(s: string): boolean {
  // AWS secrets are typically 40 chars base64-ish.
  return typeof s === "string" && s.length >= 20 && s.length <= 200 && /^[A-Za-z0-9/+=_-]+$/.test(s);
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Validate the IAM credentials by listing hosted zones and looking
 *  for the customer's apex. */
export async function validateRoute53Credential(
  auth: R53Auth,
  customerDomain: string,
): Promise<ValidateResult> {
  const akid = auth.accessKeyId.trim();
  const secret = auth.secretAccessKey.trim();
  if (!looksLikeAccessKey(akid) || !looksLikeSecret(secret)) {
    return { ok: false, reason: "credential_format_invalid" };
  }

  const apex = customerDomain.replace(/^www\./i, "").toLowerCase();

  const req = await signSigV4(
    { accessKeyId: akid, secretAccessKey: secret },
    "GET",
    "/2013-04-01/hostedzone",
    `dnsname=${encodeURIComponent(apex)}`,
    "",
  );
  const r = await r53Fetch(req);
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "credential_invalid_or_revoked" };
    return { ok: false, reason: "credential_verify_failed" };
  }

  // Look for the customer's zone in the response. Route53 returns it
  // with a trailing dot in the Name field.
  const escapedApex = apex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const zoneRe = new RegExp(`<Id>(/hostedzone/[^<]+)</Id>\\s*<Name>${escapedApex}\\.</Name>`, "i");
  const m = zoneRe.exec(r.xml);
  if (!m) {
    return { ok: false, reason: "domain_not_found_for_credential" };
  }
  // Id format is "/hostedzone/Z1234ABCD" — strip the prefix.
  const fullId = m[1] ?? "";
  const hostedZoneId = fullId.replace(/^\/hostedzone\//, "");

  return { ok: true, hosted_zone_id: hostedZoneId, zone_name: apex };
}

function buildChangeBatchXml(specs: Array<{ spec: RecordSpec; action: "UPSERT" }>): string {
  const changes = specs.map(({ spec, action }) => {
    const resourceRecords = spec.values
      .map((v) => `<ResourceRecord><Value>${spec.type === "TXT" ? `&quot;${v}&quot;` : v}</Value></ResourceRecord>`)
      .join("");
    return `<Change>
      <Action>${action}</Action>
      <ResourceRecordSet>
        <Name>${spec.name}</Name>
        <Type>${spec.type}</Type>
        <TTL>${spec.ttl ?? 300}</TTL>
        <ResourceRecords>${resourceRecords}</ResourceRecords>
      </ResourceRecordSet>
    </Change>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Changes>${changes}</Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`;
}

/**
 * Apply the records via a single ChangeResourceRecordSets call.
 * Route53 supports atomic batching (all changes succeed or all fail)
 * and UPSERT semantics — if a record exists with same content, no-op;
 * if exists with different content, replace. So Route53's apply is
 * naturally idempotent without a pre-list step.
 */
export async function applyRoute53Records(
  auth: R53Auth,
  hostedZoneId: string,
  specs: RecordSpec[],
): Promise<{ overall_ok: boolean; results: Array<RecordResult & { spec: RecordSpec }>; }> {
  const akid = auth.accessKeyId.trim();
  const secret = auth.secretAccessKey.trim();

  const body = buildChangeBatchXml(specs.map((s) => ({ spec: s, action: "UPSERT" })));
  const req = await signSigV4(
    { accessKeyId: akid, secretAccessKey: secret },
    "POST",
    `/2013-04-01/hostedzone/${hostedZoneId}/rrset`,
    "",
    body,
  );
  const r = await r53Fetch(req);
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      return {
        overall_ok: false,
        results: specs.map((spec) => ({ ok: false, reason: "permission_denied", spec })),
      };
    }
    // Surface Route53's specific error message via XML error parsing.
    const errMatch = /<Code>([^<]+)<\/Code>/i.exec(r.xml);
    const errCode = errMatch?.[1] ?? "rrset_change_failed";
    return {
      overall_ok: false,
      results: specs.map((spec) => ({
        ok: false,
        reason: errCode === "InvalidChangeBatch" ? "record_conflict" : "rrset_change_failed",
        spec,
      })),
    };
  }

  return {
    overall_ok: true,
    results: specs.map((spec) => ({ ok: true, spec })),
  };
}

export const ROUTE53_APEX_A_IPS = APEX_A_IPS;
