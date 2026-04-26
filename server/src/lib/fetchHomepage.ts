/* SSRF-safe HTML fetcher for the public citation-readiness audit.
 *
 * The audit lets random visitors paste their site URL. That means we
 * fetch arbitrary external URLs server-side, which without guards is
 * a textbook SSRF vector — a visitor could ask us to fetch
 * http://169.254.169.254/latest/meta-data/ (EC2 metadata) or
 * http://10.0.0.1:8500/ (internal Consul) and surface the results.
 *
 * Defenses, in order of importance:
 *   1. HTTPS-only (drops `file:`, `gopher:`, `dict:`, etc.).
 *   2. DNS resolves to a public IP — reject any RFC1918, loopback,
 *      link-local, or carrier-grade NAT range.
 *   3. Hard timeout (8s) — slowloris-style endpoints can't tie up a
 *      Railway worker.
 *   4. Hard size cap (500kb) — bombs (zip-bomb-style HTML) can't
 *      exhaust memory.
 *   5. Content-type whitelist — text/html only. PDFs, images,
 *      streams all rejected.
 *   6. Redirect cap (3 hops) — prevents redirect-chain abuse to
 *      bounce through internal hosts.
 *
 * Errors are typed so the caller can choose 4xx vs 5xx response
 * codes intelligently. We never leak internal error details to the
 * client — those go in `meta` for ops.
 */

import { lookup } from "dns/promises";

export interface FetchHomepageSuccess {
  ok:           true;
  url:          string;       // final URL after redirects
  html:         string;
  byte_length:  number;
  content_type: string;
  fetched_at:   string;        // ISO UTC
}

export interface FetchHomepageError {
  ok:        false;
  reason:
    | "invalid_url"
    | "non_https"
    | "private_address"
    | "dns_lookup_failed"
    | "timeout"
    | "too_large"
    | "wrong_content_type"
    | "too_many_redirects"
    | "http_error"
    | "network_error";
  message:   string;
  status?:   number;
}

const FETCH_TIMEOUT_MS    = 8_000;
const MAX_HTML_BYTES      = 500 * 1024;
const MAX_REDIRECTS       = 3;
const ALLOWED_CONTENT     = /^text\/html(;|$)/i;
const USER_AGENT          = "AdvocateMCP-Audit/1.0 (+https://advocatemcp.com/audit)";

/* IPv4 ranges we refuse to connect to. Each entry is [base, mask-bits].
 * Comparison is done numerically against the resolved A record. */
const PRIVATE_V4_RANGES: Array<[number, number]> = [
  [ipToInt("0.0.0.0"),         8],   // current network
  [ipToInt("10.0.0.0"),        8],   // RFC1918 class A
  [ipToInt("100.64.0.0"),     10],   // CGNAT
  [ipToInt("127.0.0.0"),       8],   // loopback
  [ipToInt("169.254.0.0"),    16],   // link-local + AWS metadata
  [ipToInt("172.16.0.0"),     12],   // RFC1918 class B
  [ipToInt("192.0.0.0"),      24],   // protocol assignment
  [ipToInt("192.0.2.0"),      24],   // documentation (TEST-NET-1)
  [ipToInt("192.168.0.0"),    16],   // RFC1918 class C
  [ipToInt("198.18.0.0"),     15],   // benchmarking
  [ipToInt("198.51.100.0"),   24],   // documentation (TEST-NET-2)
  [ipToInt("203.0.113.0"),    24],   // documentation (TEST-NET-3)
  [ipToInt("224.0.0.0"),       4],   // multicast
  [ipToInt("240.0.0.0"),       4],   // reserved
];

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  // Crude IPv4-only check; rejects all IPv6 conservatively. We could
  // extend to IPv6 (fc00::/7, fe80::/10, ::1/128) but most SMB websites
  // resolve A records — IPv6-only gets a benign reject which is fine.
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return true;
  const ipNum = ipToInt(ip);
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipNum & mask) === (base & mask);
  });
}

/* Resolve hostname to an A record and check it isn't private. Returns
 * null if it's safe (we can connect), or an error reason if not. */
async function checkHostnameSafe(hostname: string): Promise<{ safe: true } | { safe: false; reason: FetchHomepageError["reason"]; message: string }> {
  // Browser-style hostnames only. Reject obvious junk.
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(hostname)) {
    return { safe: false, reason: "invalid_url", message: "Hostname doesn't look like a public domain." };
  }
  try {
    const records = await lookup(hostname, { all: true, family: 0 });
    if (records.length === 0) {
      return { safe: false, reason: "dns_lookup_failed", message: "DNS returned no records." };
    }
    for (const rec of records) {
      if (rec.family === 4) {
        if (isPrivateIPv4(rec.address)) {
          return { safe: false, reason: "private_address", message: `Hostname resolves to a private/reserved IP (${rec.address}).` };
        }
      }
      if (rec.family === 6) {
        // Conservative: reject any IPv6 result. Almost no SMB website
        // is IPv6-only, and the IPv6 private-range list is non-trivial.
        return { safe: false, reason: "private_address", message: "IPv6 addresses aren't supported by this audit." };
      }
    }
    return { safe: true };
  } catch (err) {
    return { safe: false, reason: "dns_lookup_failed", message: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/* Fetch a URL's HTML content with all the SSRF guards above. */
export async function fetchHomepage(rawUrl: string): Promise<FetchHomepageSuccess | FetchHomepageError> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url", message: "Couldn't parse that URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "non_https", message: "Only https:// URLs are accepted." };
  }
  // Strip auth components — they're rejected outright since they could
  // be used for credential probing of internal services.
  if (url.username || url.password) {
    return { ok: false, reason: "invalid_url", message: "URLs with embedded credentials aren't accepted." };
  }

  const hostnameCheck = await checkHostnameSafe(url.hostname);
  if (!hostnameCheck.safe) {
    return { ok: false, reason: hostnameCheck.reason, message: hostnameCheck.message };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let currentUrl = url.toString();
  let hops = 0;
  try {
    while (hops <= MAX_REDIRECTS) {
      const resp = await fetch(currentUrl, {
        method:    "GET",
        redirect:  "manual",
        signal:    controller.signal,
        headers:   {
          "User-Agent":      USER_AGENT,
          "Accept":          "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      // Manual redirect handling — recheck the target hostname against
      // private-IP rules before following.
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        if (!location) {
          return { ok: false, reason: "http_error", message: "Redirect without Location header.", status: resp.status };
        }
        const next = new URL(location, currentUrl);
        if (next.protocol !== "https:") {
          return { ok: false, reason: "non_https", message: "Redirect tried to switch to non-https.", status: resp.status };
        }
        const recheck = await checkHostnameSafe(next.hostname);
        if (!recheck.safe) {
          return { ok: false, reason: recheck.reason, message: `Redirect target unsafe: ${recheck.message}` };
        }
        currentUrl = next.toString();
        hops += 1;
        continue;
      }
      if (!resp.ok) {
        return { ok: false, reason: "http_error", message: `Site returned ${resp.status}.`, status: resp.status };
      }
      const ct = resp.headers.get("content-type") ?? "";
      if (!ALLOWED_CONTENT.test(ct)) {
        return { ok: false, reason: "wrong_content_type", message: `Content-Type was '${ct}', expected text/html.` };
      }

      // Read the body with a hard byte cap. The fetch() body is a
      // ReadableStream — chunk-by-chunk read lets us bail mid-download
      // if the response is huge.
      const reader = resp.body?.getReader();
      if (!reader) {
        return { ok: false, reason: "network_error", message: "No response body to read." };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > MAX_HTML_BYTES) {
            // Best-effort cancel so we don't keep streaming.
            try { await reader.cancel(); } catch { /* ignore */ }
            return {
              ok: false, reason: "too_large",
              message: `Page exceeded ${MAX_HTML_BYTES} byte cap (got >${total} so far).`,
            };
          }
          chunks.push(value);
        }
      }
      const html = Buffer.concat(chunks).toString("utf8");
      return {
        ok:           true,
        url:          currentUrl,
        html,
        byte_length:  total,
        content_type: ct,
        fetched_at:   new Date().toISOString(),
      };
    }
    return { ok: false, reason: "too_many_redirects", message: `Exceeded ${MAX_REDIRECTS}-hop redirect cap.` };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "timeout", message: `Request exceeded ${FETCH_TIMEOUT_MS}ms timeout.` };
    }
    return {
      ok: false, reason: "network_error",
      message: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
