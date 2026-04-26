/**
 * DNS provider detection via NS records.
 *
 * Why this exists: the biggest single source of customer support load
 * for any product that requires custom-domain DNS records is "where
 * do I add this in [GoDaddy / Squarespace / Wix / Namecheap]?"
 * Generic instructions don't cut it because each registrar's UI is
 * different. Detecting the provider from a domain's NS records lets
 * us render provider-specific copy with exact menu paths and
 * screenshots — eliminating the "I don't know where to click" bounce.
 *
 * How: query Cloudflare's public DoH endpoint
 * (`https://cloudflare-dns.com/dns-query`) for the NS records of the
 * customer's apex, and pattern-match the returned hostnames against
 * a small allowlist of common SMB providers. Anything we don't
 * recognize falls through to "other" and the activate page shows
 * generic copy.
 *
 * Trade-offs:
 *   - Lookup is best-effort. We wrap the fetch in a 1500ms timeout;
 *     on timeout, slow DoH, network blip, or unknown NS pattern, we
 *     return "other" and the activate page falls back to generic
 *     guidance. Activation never blocks waiting for this.
 *   - We do NOT bundle the Public Suffix List. The detector operates
 *     on whatever apex the caller passes in — same heuristic as
 *     hostnameVariants.ts.
 *   - We pick the first matched provider in pattern order. If a
 *     domain is delegated to multiple NS sets (rare), we surface the
 *     first match. Detection is a UX hint, not authoritative.
 */

export type ProviderId =
  | "godaddy"
  | "squarespace"
  | "namecheap"
  | "cloudflare"
  | "google-domains"
  | "wix"
  | "route53"
  | "shopify"
  | "ionos"
  | "hostgator"
  | "bluehost"
  | "other";

interface ProviderPattern {
  /** Substring to match against the NS hostname (case-insensitive). */
  needle: RegExp;
  provider: ProviderId;
}

/* Patterns ordered roughly by SMB market share. First match wins. */
const PROVIDER_PATTERNS: ProviderPattern[] = [
  // GoDaddy: ns##.domaincontrol.com (managed DNS) + secureserver.net (older)
  { needle: /domaincontrol\.com$/i, provider: "godaddy" },
  { needle: /secureserver\.net$/i, provider: "godaddy" },
  // Squarespace
  { needle: /squarespacedns\.com$/i, provider: "squarespace" },
  // Namecheap
  { needle: /registrar-servers\.com$/i, provider: "namecheap" },
  { needle: /namecheaphosting\.com$/i, provider: "namecheap" },
  // Cloudflare DNS (free + paid plans)
  { needle: /\.ns\.cloudflare\.com$/i, provider: "cloudflare" },
  // Google Domains (deprecated 2023, still resolving for some users
  // mid-migration to Squarespace)
  { needle: /domains\.google\.?$/i, provider: "google-domains" },
  { needle: /googledomains\.com$/i, provider: "google-domains" },
  // Wix
  { needle: /wixdns\.net$/i, provider: "wix" },
  // AWS Route 53
  { needle: /awsdns-/i, provider: "route53" },
  // Shopify (rare but happens)
  { needle: /shopify\.com$/i, provider: "shopify" },
  // IONOS (1&1)
  { needle: /ui-dns\.(?:com|de|org|biz)$/i, provider: "ionos" },
  // HostGator + Bluehost (both run by EIG / Newfold, share NS)
  { needle: /hostgator\.com$/i, provider: "hostgator" },
  { needle: /bluehost\.com$/i, provider: "bluehost" },
];

interface DohAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 1500;

/**
 * Look up NS records for `domain` and classify the customer's DNS
 * provider. Returns "other" on timeout, on no NS answer, or on no
 * pattern match. Never throws.
 */
export async function detectDnsProvider(domain: string): Promise<{
  provider: ProviderId;
  nameservers: string[];
}> {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return { provider: "other", nameservers: [] };

  const url = `${DOH_URL}?name=${encodeURIComponent(trimmed)}&type=NS`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return { provider: "other", nameservers: [] };
    const body = (await res.json()) as DohResponse;
    const nameservers = Array.isArray(body.Answer)
      ? body.Answer
          .filter((a) => a.type === 2 /* NS */)
          .map((a) => a.data.replace(/\.$/, "").toLowerCase())
      : [];
    if (nameservers.length === 0) {
      return { provider: "other", nameservers: [] };
    }

    for (const pattern of PROVIDER_PATTERNS) {
      if (nameservers.some((ns) => pattern.needle.test(ns))) {
        return { provider: pattern.provider, nameservers };
      }
    }
    return { provider: "other", nameservers };
  } catch {
    return { provider: "other", nameservers: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return a display name for a provider id. Used by the activate-page
 * UI when we want to say "We detected your DNS is on GoDaddy."
 */
export function providerDisplayName(p: ProviderId): string {
  switch (p) {
    case "godaddy":         return "GoDaddy";
    case "squarespace":     return "Squarespace";
    case "namecheap":       return "Namecheap";
    case "cloudflare":      return "Cloudflare";
    case "google-domains":  return "Google Domains";
    case "wix":             return "Wix";
    case "route53":         return "AWS Route 53";
    case "shopify":         return "Shopify";
    case "ionos":           return "IONOS";
    case "hostgator":       return "HostGator";
    case "bluehost":        return "Bluehost";
    default:                return "your DNS provider";
  }
}
