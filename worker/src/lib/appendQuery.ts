/**
 * Append a single query parameter to a URL, preserving any existing query
 * string, fragment, and path. If the key is already present, the existing
 * value is replaced (not duplicated) — callers who need multi-value params
 * must handle that explicitly.
 *
 * Used by Session 5's /track redirect to forward `amcp_t=<token>` on the
 * customer-facing redirect so the landing-page script can read it.
 *
 * Returns the original URL unchanged if it is not parseable — the caller's
 * redirect proceeds without the added param rather than throwing.
 */
export function appendQuery(urlStr: string, key: string, value: string): string {
  if (!urlStr) return urlStr;
  try {
    const u = new URL(urlStr);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    return urlStr;
  }
}
