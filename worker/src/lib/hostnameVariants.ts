/**
 * Hostname variant derivation for tenant onboarding.
 *
 * Background: a tenant signs up with one hostname (typed in the wizard
 * or pulled from Stripe metadata). Pre-Apr-26-2026, we registered just
 * that hostname as a Cloudflare for SaaS custom hostname + Worker
 * Route. AI bots crawling a different variant of the same site (apex
 * when only www was registered, or vice versa) hit the customer's
 * underlying origin directly with no Advocate intercept — silently
 * losing roughly half of every tenant's bot traffic.
 *
 * Fix: derive every variant we should claim from the customer's input
 * and register each one. For typical cases:
 *
 *   acme.com         → ["acme.com", "www.acme.com"]
 *   www.acme.com     → ["acme.com", "www.acme.com"]
 *   acme.co.uk       → ["acme.co.uk", "www.acme.co.uk"]
 *   www.acme.co.uk   → ["acme.co.uk", "www.acme.co.uk"]
 *   shop.acme.com    → ["shop.acme.com"]                   // custom subdomain, owner's choice
 *   x.hosted.advocatemcp.com → ["x.hosted.advocatemcp.com"]  // our own domain, no apex/www to add
 *
 * PSL note: a fully-correct apex split for "acme.co.uk" needs the
 * Public Suffix List (Mozilla maintains a ~200KB file of effective
 * TLDs). Bundling it into a Cloudflare Worker is overkill for the v1
 * cut. We use a small allowlist of common multi-label SLDs (co, com,
 * net, org, gov, edu, ac) to handle the ~95% of cases that matter
 * (UK, AU, JP, etc.). If a tenant has a hostname under an exotic
 * suffix we don't recognise, we register only what they typed and
 * print a warning — that's safer than guessing and registering the
 * wrong apex on someone else's behalf.
 */

/**
 * Common 2-label TLD suffixes ("co.uk", "com.au", etc.) where the
 * effective TLD is the last TWO labels and the apex is the third.
 * Order: ranked by frequency in our expected customer base. Anything
 * outside this list falls through to the conservative "register only
 * what you typed" path.
 */
const KNOWN_2LABEL_SLDS = new Set([
  // Generic 2-label SLDs that show up across many ccTLDs.
  "co", "com", "net", "org", "gov", "edu", "ac", "or",
  // Specific allowances for "<TLD>.<ccTLD>" combos that don't fit the
  // generic pattern but we still want to handle.
]);

/**
 * Extract the bare hostname from a user-provided string. Accepts:
 *   - "acme.com"
 *   - "www.acme.com"
 *   - "https://www.acme.com"
 *   - "https://www.acme.com/path?q=x"
 *   - "WWW.ACME.COM"   (lowercased on the way out)
 *
 * Returns null for clearly-invalid input (empty string, IP literal,
 * localhost, no dot at all). Doesn't validate against the public
 * suffix list — that's a downstream concern.
 */
export function normalizeHostname(input: string | null | undefined): string | null {
  // Tolerant of nullable / non-string input — backfill iterates over
  // historical KV records and some pre-Apr-26-2026 tenant blobs may
  // not have `domain` set. Safer to short-circuit here than to crash
  // the whole batch on one bad record.
  if (input == null) return null;
  if (typeof input !== "string") return null;
  let host = input.trim().toLowerCase();
  if (!host) return null;

  // Strip protocol if present.
  host = host.replace(/^https?:\/\//, "");

  // Strip path / query / hash.
  host = host.split("/")[0] ?? "";
  host = host.split("?")[0] ?? "";
  host = host.split("#")[0] ?? "";

  // Strip port.
  host = host.split(":")[0] ?? "";

  if (!host) return null;
  if (host === "localhost") return null;
  // IPv4 literal — reject; we only register hostname tenants.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;
  // Must have at least one dot.
  if (!host.includes(".")) return null;
  // Disallow leading/trailing dots and double dots.
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return null;
  // Lazy hostname-character check — let the Cloudflare API give the
  // authoritative reject if our regex misses something exotic.
  if (!/^[a-z0-9.-]+$/.test(host)) return null;

  return host;
}

/**
 * Produce the full set of hostnames we should claim for a tenant
 * given their typed-in input. Always returns the normalized input as
 * one of the elements (or [] if the input was invalid). Variants are
 * deduplicated and sorted alphabetically so callers can compare
 * outputs across runs.
 */
export function deriveHostnameVariants(input: string | null | undefined): string[] {
  const host = normalizeHostname(input);
  if (!host) return [];

  // Hosted-tenant subdomains live under our own zone — apex is
  // advocatemcp.com (ours) and www would point to a different
  // tenant's marketing page. Don't auto-derive variants here.
  if (host.endsWith(".hosted.advocatemcp.com")) {
    return [host];
  }

  const labels = host.split(".");

  // Two labels = apex like "acme.com": claim both apex and www.
  if (labels.length === 2) {
    return sortUnique([host, `www.${host}`]);
  }

  // www. + 2 labels = "www.acme.com": derive apex by stripping www.
  if (labels[0] === "www" && labels.length === 3) {
    const apex = labels.slice(1).join(".");
    return sortUnique([apex, host]);
  }

  // 3 labels with a known 2-label SLD = apex like "acme.co.uk":
  // claim both apex and www.
  if (labels.length === 3 && KNOWN_2LABEL_SLDS.has(labels[1] ?? "")) {
    return sortUnique([host, `www.${host}`]);
  }

  // www. + 3 labels with a known 2-label SLD = "www.acme.co.uk":
  // derive apex by stripping www.
  if (
    labels[0] === "www" &&
    labels.length === 4 &&
    KNOWN_2LABEL_SLDS.has(labels[2] ?? "")
  ) {
    const apex = labels.slice(1).join(".");
    return sortUnique([apex, host]);
  }

  // Anything else (custom subdomain like "shop.acme.com" or unknown
  // multi-label TLD) — register only what the customer typed. Safer
  // than guessing.
  return [host];
}

/**
 * Categorize a hostname as apex (no www, top-level for the tenant)
 * vs. www-subdomain. Used by the DNS-instruction renderer to decide
 * whether to emit "CNAME" or "ANAME/A" guidance for that variant.
 */
export function classifyVariant(host: string): "apex" | "www" | "other" {
  const labels = host.split(".");
  if (labels[0] === "www") return "www";
  if (labels.length === 2) return "apex";
  if (labels.length === 3 && KNOWN_2LABEL_SLDS.has(labels[1] ?? "")) return "apex";
  return "other";
}

function sortUnique(arr: string[]): string[] {
  return Array.from(new Set(arr)).sort();
}
