/**
 * Bot-HTML cache invalidation — server → worker callback.
 *
 * The worker (worker/src/index.ts) edge-caches rendered bot HTML
 * keyed by `(slug × cache_version × botType × pathname)`. The
 * `cache_version` segment lives in BUSINESS_MAP KV under
 * `version:<slug>` and the worker exposes
 * POST /admin/cache/bump-version?slug=<slug> to mint a fresh
 * monotonic version string.
 *
 * Server callers invoke this helper after any mutation that affects
 * what AI crawlers see — profile edits, location changes, future
 * structured-data additions. Result: the next bot crawl after the
 * mutation pays a full cold render and captures the new JSON-LD +
 * prose. Without this, edits could take up to the worker's 600s TTL
 * to reach the wire.
 *
 * Best-effort: a worker outage or 2s timeout never fails the
 * mutation. The cache will age out via TTL anyway; we just lose the
 * "instant" guarantee for that single edit. Errors are logged with
 * structured context so ops can spot patterns.
 *
 * Apr 30 2026.
 */

const TIMEOUT_MS = 2000;

export async function invalidateBotCache(slug: string): Promise<void> {
  const workerBase = process.env.WORKER_BASE_URL ?? "https://customers.advocatemcp.com";
  const apiKey     = process.env.API_KEY;

  if (!apiKey) {
    // Without SERVER_API_KEY we can't authenticate to the worker.
    // The worker correctly rejects unauthed bumps; surfacing a
    // structured warning instead of failing silently lets ops spot
    // a misconfigured deploy.
    console.warn(JSON.stringify({
      bot_cache_invalidation: true,
      event: "skipped_no_server_key",
      slug,
    }));
    return;
  }

  const url = `${workerBase}/admin/cache/bump-version?slug=${encodeURIComponent(slug)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-Key":     apiKey,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ reason: "profile_patch" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(JSON.stringify({
        bot_cache_invalidation: true,
        event: "bump_failed",
        slug,
        status: res.status,
        body_preview: body.slice(0, 200),
      }));
      return;
    }
    // Success path — log at info level for ops visibility.
    const data = await res.json().catch(() => ({})) as { new_version?: string };
    console.log(JSON.stringify({
      bot_cache_invalidation: true,
      event: "bump_success",
      slug,
      new_version: data.new_version ?? "?",
    }));
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    console.warn(JSON.stringify({
      bot_cache_invalidation: true,
      event: isTimeout ? "bump_timeout" : "bump_error",
      slug,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}
