/**
 * Canonicalize a URL-or-domain string to a lowercase bare domain.
 * Returns "" on unparseable input so callers can safely compare.
 */
export function canonicalDomain(urlOrDomain: string): string {
  if (!urlOrDomain || typeof urlOrDomain !== "string") return "";
  const trimmed = urlOrDomain.trim();
  if (!trimmed) return "";

  // Try as URL first. If no scheme, retry with https:// prefix.
  let host = "";
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    host = u.hostname;
  } catch {
    return "";
  }

  // Reject obvious garbage (URL constructor accepts "not" as a scheme-less host otherwise).
  if (!host.includes(".")) return "";

  host = host.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

/**
 * Strict-match: citation url canonical domain === tenant website canonical domain.
 * v1 does NOT match subdomains to roots or owned-presence profiles (Yelp, BBB, etc.).
 */
export function isCitationOfTenant(
  citationUrl: string,
  tenantWebsite: string | null | undefined,
): boolean {
  const c = canonicalDomain(citationUrl);
  const t = canonicalDomain(tenantWebsite ?? "");
  return c !== "" && t !== "" && c === t;
}
