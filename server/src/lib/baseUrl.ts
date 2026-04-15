/**
 * Resolve the public API base URL.
 *
 * In production, throws if `API_BASE_URL` is unset — silently falling back to
 * a fixed string (`api.advocatemcp.com` does not currently resolve in DNS)
 * would publish a manifest with non-resolving transports[] and attribution
 * URLs and break every downstream agent that follows them.
 *
 * In dev/test, falls back to `http://localhost:3000` so a fresh clone runs
 * without any env config required.
 *
 * Mirrors the pattern of `getSigningKey()` in `continuationToken.ts`:
 * single source of truth, fail-loud in prod.
 */
export function getApiBaseUrl(): string {
  const v = process.env.API_BASE_URL;
  if (v) return v;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "API_BASE_URL must be set in production — refusing to publish a " +
        "manifest with a fallback URL that doesn't resolve."
    );
  }
  return "http://localhost:3000";
}
