/* window.AMCP — shared auth module for advocatemcp.com dashboard pages
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
     * Throws the raw error response body on failure — callers inspect
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
        // network error — fall through to clear state
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
     * path is relative to API_BASE (e.g. '/api/client/metrics'). */
    async authedFetch(path, opts) {
      const options = opts || {};
      const headers = Object.assign(
        {},
        options.headers || {},
        AMCP.token ? { Authorization: `Bearer ${AMCP.token}` } : {}
      );
      return fetch(`${API_BASE}${path}`, Object.assign({}, options, {
        credentials: 'include',
        headers,
      }));
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
