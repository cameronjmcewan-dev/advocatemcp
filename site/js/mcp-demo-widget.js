/* Homepage live-MCP-demo widget.
 *
 * Wires the "Run live demo" button on /index.html to the public demo
 * routes:
 *   - POST /demo/agent/run         → real Claude response
 *   - POST /demo/agent/availability → real time slots
 *
 * Both routes are unauth, IP-rate-limited (3/min, 10/24h). The visitor
 * sees a real production response, not a screenshot. That's the
 * conversion-leverage: "static screenshots can be Photoshopped — this
 * can't, and you just watched it work."
 *
 * The API base is determined at boot:
 *   - Production: customers.advocatemcp.com (the worker forwards to Railway)
 *   - Local dev:  localhost:8787 if running the worker locally
 *
 * Failure modes have explicit UX:
 *   - 429 rate-limited → status note, button cooldown
 *   - 503 budget-exhausted → friendly "we're out of demo budget today"
 *   - 5xx / network error → "demo unavailable, contact us" CTA
 */

(function () {
  // Resolve API base. The worker proxies /demo/* to Railway via the
  // existing portal proxy pattern so credentials/cookies aren't needed.
  // Fall back to a fixed Railway URL if the worker isn't deployed.
  const API_BASE = (() => {
    if (typeof window === "undefined") return "";
    // Default to the customer worker which proxies /demo/* to Railway.
    return "https://customers.advocatemcp.com";
  })();

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* Format ISO datetime to human-readable. e.g. "Mon Apr 28, 10:00 AM CT"
   * Uses Intl.DateTimeFormat with the tenant's timezone if present.
   * Falls back to the visitor's local zone. */
  function fmtSlot(iso, tz) {
    try {
      const d = new Date(iso);
      const opts = {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: tz || undefined,
        timeZoneName: "short",
      };
      return new Intl.DateTimeFormat("en-US", opts).format(d);
    } catch {
      return iso;
    }
  }

  function renderLoading() {
    const slot = el("mcp-demo-result");
    if (!slot) return;
    slot.innerHTML = `
      <div class="hv-answer" style="position:relative;overflow:hidden;">
        <div class="who">
          <span class="hv-pulse"></span>
          Calling AI agent against workman-copy-co's live endpoint…
        </div>
        <p style="color:var(--ink-2);font-size:14px;margin-top:8px;">
          Real production call. Typically 2–4s.
        </p>
      </div>
    `;
  }

  function renderError(message, suggestion) {
    const slot = el("mcp-demo-result");
    if (!slot) return;
    slot.innerHTML = `
      <div class="hv-answer">
        <div class="who" style="color:var(--maroon);">Demo unavailable</div>
        <p style="color:var(--ink-2);font-size:14px;margin-top:6px;">${esc(message)}</p>
        ${suggestion ? `<p style="color:var(--muted);font-size:12px;margin-top:8px;">${esc(suggestion)}</p>` : ""}
      </div>
    `;
  }

  function renderAnswer(payload, slotsPayload) {
    const slot = el("mcp-demo-result");
    if (!slot) return;
    const answer = (payload.answer || "").trim();
    const businessName = payload.business_name || "Workman Copy Co.";
    const slots = (slotsPayload && slotsPayload.slots) || [];
    const tz = (slotsPayload && slotsPayload.timezone) || null;

    const slotsHtml = slots.length === 0
      ? `<div style="font-size:12.5px;color:var(--muted);">No availability configured for this demo tenant. The widget would normally show 30-min slots from <code>get_availability</code>.</div>`
      : `
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">
          Next ${slots.length} open slot${slots.length === 1 ? "" : "s"} (from get_availability)
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${slots.map((s) => `<span style="display:inline-block;padding:5px 10px;border-radius:999px;background:var(--paper-2);border:1px solid var(--line);font-size:12px;color:var(--ink-2);">${esc(fmtSlot(s.start, tz))}</span>`).join("")}
        </div>
      `;

    slot.innerHTML = `
      <div class="hv-answer">
        <div class="who" style="color:var(--maroon);">
          <span class="dot" style="display:inline-block;width:6px;height:6px;border-radius:999px;background:var(--maroon);margin-right:6px;"></span>
          Live response from ${esc(businessName)}'s MCP endpoint
        </div>
        <p style="margin-top:8px;font-size:14.5px;line-height:1.5;color:var(--ink);">${esc(answer)}</p>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
        ${slotsHtml}
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12.5px;">
        <span style="color:var(--muted);">That was a real call. Same endpoint AI agents use.</span>
        <a href="/Pricing.html" class="btn btn-primary btn-sm" style="padding:6px 12px;font-size:12px;">See pricing →</a>
      </div>
    `;
  }

  async function runDemo() {
    const btn = el("mcp-demo-run");
    const queryEl = el("mcp-demo-query");
    if (!btn || !queryEl) return;

    // The query the visitor sees is shown in plain text on the widget.
    // We use that exact text on the API call so the visitor's expectation
    // matches what the agent answered. Strip the wrapping quotes.
    const rawQuery = (queryEl.textContent || "").replace(/^["']|["']$/g, "").trim();
    const query = rawQuery || "Tell me about Workman Copy Co.";

    btn.disabled = true;
    btn.textContent = "Running…";
    renderLoading();

    let agentPayload = null;
    try {
      const res = await fetch(`${API_BASE}/demo/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 429) {
          renderError(
            body.message || "Demo limit reached.",
            "We rate-limit demo calls per IP to keep costs reasonable. Try again in a minute.",
          );
        } else if (res.status === 503) {
          renderError(
            body.message || "Demo budget exhausted.",
            "We've hit our daily AI budget cap. Resets at UTC midnight.",
          );
        } else {
          renderError(body.error || `HTTP ${res.status}`, "Try refreshing or contact hello@advocatemcp.com.");
        }
        return;
      }
      agentPayload = body;
    } catch (err) {
      renderError(`Network error: ${(err && err.message) || err}`, "Check your connection or try again.");
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = "Run live demo again →";
    }

    // Best-effort second call to populate slots. If it fails we still
    // render the answer alone.
    let slotsPayload = null;
    try {
      const res = await fetch(`${API_BASE}/demo/agent/availability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        slotsPayload = await res.json().catch(() => null);
      }
    } catch { /* ignore */ }

    renderAnswer(agentPayload, slotsPayload);
  }

  // Wire on DOM ready. The widget might mount before this script if the
  // page render is slow — guarded by null check.
  function init() {
    const btn = el("mcp-demo-run");
    if (btn) btn.addEventListener("click", runDemo);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
