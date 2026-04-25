/* window.AMCP, shared auth module for advocatemcp.com dashboard pages
 *
 * Auth state lives in JS memory only. Tokens never touch localStorage or
 * sessionStorage. The amcp_refresh cookie (HttpOnly, SameSite=Strict,
 * Path=/api/auth/refresh) is the durable credential. On every page load
 * call AMCP.requireAuth() which silently re-issues an access token from
 * the cookie via POST /api/auth/refresh before any data fetch runs. */
(function () {
  'use strict';

  const API_BASE = 'https://customers.advocatemcp.com';

  const AMCP = {
    token: /** @type {string|null} */ (null),
    API_BASE,

    /* ── login ──────────────────────────────────────────────────────────
     * POST /api/auth/login
     * Sets AMCP.token on success.
     * Throws the raw error response body on failure, callers inspect
     * err.error_code for: invalid_credentials | rate_limited |
     * platform_error | invalid_body */
    async login(email, password) {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw data;
      AMCP.token = data.access_token;
      return data; // { access_token, expires_in, user }
    },

    /* ── logout ─────────────────────────────────────────────────────────
     * POST /api/auth/logout
     * Best-effort server-side session clear. Always clears local token
     * and redirects to login.html regardless of network outcome. */
    async logout() {
      try {
        await fetch(`${API_BASE}/api/auth/logout`, {
          method: 'POST',
          credentials: 'include',
          headers: AMCP.token ? { Authorization: `Bearer ${AMCP.token}` } : {},
        });
      } catch (_) {
        // network error, fall through to clear state
      }
      AMCP.token = null;
      window.location.href = '/login.html';
    },

    /* ── refresh ────────────────────────────────────────────────────────
     * POST /api/auth/refresh
     * Silently re-authenticates using the amcp_refresh cookie.
     * advocatemcp.com and customers.advocatemcp.com share eTLD+1
     * advocatemcp.com, so SameSite=Strict cookies are sent on same-site
     * cross-origin fetches with credentials:'include'.
     * Returns true when a new access token was obtained, false otherwise. */
    async refresh() {
      try {
        const res = await fetch(`${API_BASE}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) return false;
        const data = await res.json();
        AMCP.token = data.access_token;
        return true;
      } catch (_) {
        return false;
      }
    },

    /* ── authedFetch ────────────────────────────────────────────────────
     * Authenticated wrapper around fetch. Injects Authorization header
     * and always includes credentials for cookie transport.
     * path is relative to API_BASE (e.g. '/api/client/metrics').
     *
     * Impersonation: when an admin viewing ?as=<slug> calls a per-tenant
     * endpoint (/api/client/*), inject `slug=<slug>` into the query
     * string so the worker resolves to the impersonated tenant instead
     * of falling back to businesses[0]. /api/client/all-metrics is
     * admin-scoped and never needs slug scoping; everything else does.
     * Skipped if the caller already set ?slug= explicitly. */
    async authedFetch(path, opts) {
      const options = opts || {};
      const headers = Object.assign(
        {},
        options.headers || {},
        AMCP.token ? { Authorization: `Bearer ${AMCP.token}` } : {}
      );

      let resolvedPath = path;
      if (typeof path === 'string' && path.startsWith('/api/client/') && !path.startsWith('/api/client/all-metrics')) {
        try {
          const asSlug = new URL(window.location.href).searchParams.get('as');
          if (asSlug) {
            const [base, query] = path.split('?');
            const params = new URLSearchParams(query || '');
            if (!params.has('slug')) {
              params.set('slug', asSlug);
              resolvedPath = base + '?' + params.toString();
            }
          }
        } catch { /* URL parse failure → fall back to original path */ }
      }

      return fetch(`${API_BASE}${resolvedPath}`, Object.assign({}, options, {
        credentials: 'include',
        headers,
      }));
    },

    /* ── cachedFetch ────────────────────────────────────────────────────
     * Session-scoped memoisation for idempotent GETs. Key is the path +
     * query string. Default TTL is 60s, tuned for the admin console
     * workflow where the same /api/client/all-metrics is consumed by
     * Mission Control, Tenants, and Queries pages inside the same
     * 5–10-second user session. Returns a Response-shaped object so
     * callers that expect `.ok` + `.status` + `.json()` keep working.
     *
     * Cache only survives while the tab is open (sessionStorage). It is
     * keyed against the current access token hash-prefix so two signed-in
     * accounts in different tabs don't cross-contaminate. Missing
     * sessionStorage (private mode, some embedded browsers) falls
     * through to the network every call without throwing. */
    async cachedFetch(path, ttlMs) {
      const ttl = typeof ttlMs === 'number' ? ttlMs : 60_000;
      let storageKey = null;
      try {
        const who = AMCP.token ? AMCP.token.slice(0, 16) : 'anon';
        // Include ?as=<slug> in the cache key so impersonating tenant A
        // then tenant B doesn't return A's cached response for B.
        const asSlug = new URL(window.location.href).searchParams.get('as') || '';
        storageKey = 'amcp.cache.' + who + '.' + asSlug + '.' + path;
        const cached = sessionStorage.getItem(storageKey);
        if (cached) {
          const { t, body, status } = JSON.parse(cached);
          if (Date.now() - t < ttl) {
            return {
              ok:     status >= 200 && status < 300,
              status: status,
              async json() { return JSON.parse(body); },
            };
          }
        }
      } catch { /* sessionStorage blocked, fall through */ }

      const res = await AMCP.authedFetch(path);
      // Only cache 2xx responses; errors must always re-fetch.
      if (storageKey && res.ok) {
        try {
          const body = await res.clone().text();
          sessionStorage.setItem(storageKey, JSON.stringify({
            t:      Date.now(),
            body:   body,
            status: res.status,
          }));
        } catch { /* quota exceeded or serialisation failed, ignore */ }
      }
      return res;
    },

    /* ── requireAuth ────────────────────────────────────────────────────
     * Call at the top of every protected page before rendering data.
     * Attempts a silent refresh if no in-memory token is present.
     * Redirects to login.html if auth cannot be established.
     * Returns true when the caller may proceed. */
    async requireAuth() {
      if (AMCP.token) return true;
      const ok = await AMCP.refresh();
      if (!ok) {
        window.location.href = '/login.html';
        return false;
      }
      return true;
    },
  };

  window.AMCP = AMCP;
})();
