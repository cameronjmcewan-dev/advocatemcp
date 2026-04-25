/*!
 * AdvocateMCP context script, Session 5 (AI Handoff).
 *
 * Drop-in `<script src="https://advocatemcp.com/advocate-context.js">` tag
 * for customer landing pages. When a visitor arrives via an AI-referred
 * click, the URL carries a signed attribution token as `?amcp_t=...`. This
 * script decodes that token against the AdvocateMCP API and exposes the
 * visitor's intent, referring crawler, and business slug as:
 *
 *   window.advocateContext = { intent, ref, slug }   // or null if no token
 *
 * A `advocate:context` CustomEvent fires on the same data so listeners
 * can react without polling. The token is stripped from the URL via
 * history.replaceState after the decode resolves so it does not linger in
 * browser history or leak via document.referrer on subsequent navigation.
 *
 * Zero dependencies. Zero tracking. The script never throws, a failed
 * decode quietly leaves window.advocateContext = null and the customer's
 * page renders its default experience.
 *
 * Configuration (all optional):
 *
 *   <script
 *     src="https://advocatemcp.com/advocate-context.js"
 *     data-api-base="https://api.advocatemcp.com"
 *     data-param-name="amcp_t"
 *     data-strip-url="true"
 *   ></script>
 */
(function () {
  "use strict";

  var DEFAULT_API_BASE  = "https://api.advocatemcp.com";
  var DEFAULT_PARAM     = "amcp_t";

  // Feature detection, don't run on very old browsers.
  if (typeof window === "undefined" || typeof fetch !== "function" || !window.URL) {
    return;
  }

  var scriptEl =
    (document.currentScript) ||
    (function () {
      var scripts = document.getElementsByTagName("script");
      for (var i = scripts.length - 1; i >= 0; i--) {
        var s = scripts[i];
        if (s && /advocate-context\.js/.test(s.src || "")) return s;
      }
      return null;
    })();

  function attr(name, fallback) {
    if (!scriptEl) return fallback;
    var v = scriptEl.getAttribute(name);
    return (v === null || v === "") ? fallback : v;
  }

  var apiBase   = attr("data-api-base", DEFAULT_API_BASE).replace(/\/+$/, "");
  var paramName = attr("data-param-name", DEFAULT_PARAM);
  var stripUrl  = attr("data-strip-url", "true") !== "false";

  // Default context: visitors with no token get null so landing pages can
  // distinguish "came from AI" from "unknown traffic".
  window.advocateContext = null;

  function publish(ctx) {
    window.advocateContext = ctx;
    try {
      window.dispatchEvent(new CustomEvent("advocate:context", { detail: ctx }));
    } catch (_) {
      // Very old IE lacks CustomEvent; silently skip.
    }
  }

  function readTokenFromUrl() {
    try {
      var u = new URL(window.location.href);
      return u.searchParams.get(paramName);
    } catch (_) {
      return null;
    }
  }

  function stripTokenFromUrl() {
    if (!stripUrl || !window.history || !window.history.replaceState) return;
    try {
      var u = new URL(window.location.href);
      if (!u.searchParams.has(paramName)) return;
      u.searchParams.delete(paramName);
      var qs = u.searchParams.toString();
      var clean = u.pathname + (qs ? "?" + qs : "") + (u.hash || "");
      window.history.replaceState(window.history.state, "", clean);
    } catch (_) {
      // Never block the happy path on a history-API failure.
    }
  }

  function isValidContext(obj) {
    return (
      obj &&
      typeof obj === "object" &&
      (obj.intent === null || typeof obj.intent === "string") &&
      typeof obj.ref === "string" &&
      typeof obj.slug === "string"
    );
  }

  var token = readTokenFromUrl();
  if (!token) return;

  var url = apiBase + "/r/" + encodeURIComponent(token) + "/decode";

  fetch(url, { method: "GET", credentials: "omit", mode: "cors" })
    .then(function (res) {
      if (!res.ok) return null;
      return res.json().catch(function () { return null; });
    })
    .then(function (data) {
      if (!isValidContext(data)) {
        // Keep the URL dirty if decode failed, the token might be valid
        // for a retry from a different script version, and stripping it
        // silently would make debugging harder.
        return;
      }
      publish({ intent: data.intent, ref: data.ref, slug: data.slug });
      stripTokenFromUrl();
    })
    .catch(function () {
      // Network hiccup, CORS miss, whatever, the customer's page renders
      // its default experience. No error surfaced to the user or console.
    });
})();
