/**
 * AI Insights — Pro/Enterprise tenant-tailored Claude recommendations.
 *
 * Renders below the existing "Top opportunities to improve" block on
 * BusinessProfile.html and on the Overview score card. Two surfaces,
 * two layouts:
 *
 *   compact: false (BusinessProfile) — renders 6-10 cards, the full
 *     Claude output. Action labels + URLs link straight to the
 *     relevant profile field.
 *
 *   compact: true  (Overview)        — renders the top 3-4 cards plus
 *     a "View all on Business Profile →" link.
 *
 * Plan-aware: Pro/Enterprise tenants AND admin role get the unlocked
 * panel. Base/Free see a maroon-tinted upsell card with a mailto CTA
 * to max@advocate-mcp.com (mirrors the radar.js renderLocked
 * convention; no Stripe self-serve upgrade flow exists yet).
 *
 * Data flow:
 *   bindPanel()      → loadCached() → GET /api/client/ai-recommendations
 *                                      ├─ has_recommendations:false → render Generate button
 *                                      ├─ is_stale:true              → auto-trigger run()
 *                                      └─ has_recommendations:true   → renderResults()
 *   button click → run({force:true}) → POST /api/client/ai-recommendations
 *
 * Apr 30 2026.
 */

(function () {
  "use strict";

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isUnlocked() {
    var d = window.AMCP_DATA || {};
    if (d.user_role === 'admin') return true;
    return d.plan === 'pro' || d.plan === 'enterprise';
  }

  function relativeTime(iso) {
    if (!iso) return 'just now';
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return 'recently';
    var s = Math.floor(ms / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  /* Locked-state upsell. Mirrors radar.js renderLocked but condensed
   * for inline placement inside an existing card. mailto CTA matches
   * the rest of the dashboard's no-self-serve-upgrade convention. */
  function renderLocked(opts) {
    var compact = !!(opts && opts.compact);
    var subject = encodeURIComponent('Upgrade to Pro');
    var bizName = (window.AMCP_DATA && window.AMCP_DATA.business_name) || 'my business';
    var body = encodeURIComponent(
      "Hi Max,\n\nI'd like to upgrade " + bizName + " to the Pro tier so we can " +
      "access AI Insights and the rest of the Pro dashboard. Please send next steps.\n\n" +
      "Thanks,\n",
    );
    var benefitsList = [
      'Tenant-tailored recommendations from Claude',
      'References your actual bot traffic + competitor citations',
      'Auto-refreshes weekly as your data shifts',
    ];
    var benefits = benefitsList.map(function (b) {
      return '<li style="margin:6px 0;color:var(--ink);font-size:13.5px">'
           +   '<span style="color:var(--maroon);margin-right:6px">●</span>'
           +   esc(b)
           + '</li>';
    }).join('');
    return ''
      + '<div class="ai-insights-card locked' + (compact ? ' compact' : '') + '">'
      +   '<div class="ai-insights-head">'
      +     '<h3 class="ai-insights-h">AI Insights</h3>'
      +     '<span class="ai-insights-chip">Pro feature</span>'
      +   '</div>'
      +   '<p class="ai-insights-lede">'
      +     'AI-generated recommendations tailored to your profile, score breakdown, '
      +     'recent bot traffic, and competitor radar. Refreshed weekly.'
      +   '</p>'
      +   (compact ? '' : '<ul class="ai-insights-benefits">' + benefits + '</ul>')
      +   '<a class="ai-insights-cta" href="mailto:max@advocate-mcp.com?subject=' + subject + '&body=' + body + '">'
      +     'Upgrade to Pro →'
      +   '</a>'
      + '</div>';
  }

  /* Empty state — unlocked tenant with no cache yet. */
  function renderEmpty(opts) {
    var compact = !!(opts && opts.compact);
    return ''
      + '<div class="ai-insights-card unlocked' + (compact ? ' compact' : '') + '">'
      +   '<div class="ai-insights-head">'
      +     '<h3 class="ai-insights-h">AI Insights</h3>'
      +   '</div>'
      +   '<p class="ai-insights-lede">'
      +     'We analyze your profile, score breakdown, recent bot traffic, and competitor '
      +     'radar to produce 6-10 specific actions. Takes about 30 seconds.'
      +   '</p>'
      +   '<button type="button" class="ai-insights-btn" data-ai-action="generate">'
      +     'Generate AI recommendations →'
      +   '</button>'
      + '</div>';
  }

  /* Loading state — spinner + ticker. Reuses the existing score-spinner
   * CSS from profile.js's style block (set up there once, used here too). */
  function renderLoading(opts) {
    var compact = !!(opts && opts.compact);
    return ''
      + '<div class="ai-insights-card unlocked loading' + (compact ? ' compact' : '') + '">'
      +   '<div class="ai-insights-head">'
      +     '<h3 class="ai-insights-h">AI Insights</h3>'
      +   '</div>'
      +   '<div class="ai-insights-loading">'
      +     '<div class="score-spinner"></div>'
      +     '<span class="ai-insights-loading-text">Analyzing your data… ~30-45s</span>'
      +   '</div>'
      + '</div>';
  }

  function priorityClass(p) {
    if (p === 'high') return 'high';
    if (p === 'med')  return 'med';
    return 'low';
  }

  function renderRecCard(rec) {
    var actionLink = rec.action_url
      ? '<a class="ai-rec-action" href="' + esc(rec.action_url) + '">' + esc(rec.action_label || 'Open →') + '</a>'
      : '';
    var deltaChip = rec.expected_score_delta != null
      ? '<span class="ai-rec-delta">+' + Number(rec.expected_score_delta).toFixed(1) + '</span>'
      : '';
    return ''
      + '<div class="ai-rec-card">'
      +   '<div class="ai-rec-meta">'
      +     '<span class="ai-priority-pill ' + priorityClass(rec.priority) + '">' + esc(rec.priority) + '</span>'
      +     deltaChip
      +   '</div>'
      +   '<div class="ai-rec-body-wrap">'
      +     '<div class="ai-rec-title">' + esc(rec.title) + '</div>'
      +     '<div class="ai-rec-body">' + esc(rec.body) + '</div>'
      +     (actionLink ? '<div class="ai-rec-action-row">' + actionLink + '</div>' : '')
      +   '</div>'
      + '</div>';
  }

  /* Results state — render the cached recommendations. */
  function renderResults(data, opts) {
    var compact = !!(opts && opts.compact);
    var recs = (data && data.recommendations) || [];
    var capped = compact ? recs.slice(0, 4) : recs.slice(0, 10);
    var generated = data && data.generated_at;
    var moreLink = compact && recs.length > capped.length
      ? '<a class="ai-insights-more" href="/BusinessProfile.html' + (window.location.search || '') + '">View all ' + recs.length + ' on Business Profile →</a>'
      : '';
    var staleChip = data && data.is_stale
      ? '<span class="ai-insights-stale">Stale — re-running</span>'
      : '';
    return ''
      + '<div class="ai-insights-card unlocked results' + (compact ? ' compact' : '') + '">'
      +   '<div class="ai-insights-head">'
      +     '<h3 class="ai-insights-h">AI Insights</h3>'
      +     staleChip
      +   '</div>'
      +   '<div class="ai-insights-list">'
      +     capped.map(renderRecCard).join('')
      +   '</div>'
      +   moreLink
      +   '<div class="ai-insights-foot">'
      +     'Generated ' + relativeTime(generated) + '. '
      +     '<button type="button" class="ai-insights-link-btn" data-ai-action="regenerate">Re-generate →</button>'
      +   '</div>'
      + '</div>';
  }

  /* Public renderPanel — returns HTML for whichever state we're in.
   * State is read from a module-level cache (lastFetchedData) populated
   * by loadCached on bind. Initial render is "empty" until loadCached
   * resolves. */
  var lastFetchedData = null;
  var inFlight = false;

  function renderPanel(opts) {
    if (!isUnlocked()) return renderLocked(opts);
    if (inFlight)      return renderLoading(opts);
    if (!lastFetchedData || !lastFetchedData.has_recommendations) {
      return renderEmpty(opts);
    }
    return renderResults(lastFetchedData, opts);
  }

  /* Cache-only fetch on mount. If the response is is_stale=true AND we
   * have data, render existing recs with a stale chip + auto-trigger a
   * fresh run in the background. */
  async function loadCached(rootEl, opts) {
    var af = window.AMCP && window.AMCP.authedFetch;
    if (!af) return;
    try {
      var res = await af('/api/client/ai-recommendations');
      if (res.status === 402) {
        // Plan changed under us (e.g. admin downgrades the impersonated
        // tenant mid-session). Force re-render as locked.
        lastFetchedData = null;
        rootEl.innerHTML = renderLocked(opts);
        bindPanel(rootEl, opts);
        return;
      }
      if (!res.ok) return;
      var body = await res.json().catch(function () { return null; });
      if (!body) return;
      lastFetchedData = body;
      rootEl.innerHTML = renderPanel(opts);
      bindHandlers(rootEl, opts);
      // Auto-regenerate in the background when stale.
      if (body.is_stale && body.has_recommendations) {
        run(rootEl, opts, { background: true });
      }
    } catch (_) { /* network blip — leave whatever we rendered */ }
  }

  /* Force a fresh run. opts.background=true means we're refreshing
   * stale data on page load — keep the existing list visible during
   * the call instead of swapping to the spinner. */
  async function run(rootEl, opts, runOpts) {
    var af = window.AMCP && window.AMCP.authedFetch;
    if (!af) return;
    var background = !!(runOpts && runOpts.background);
    inFlight = true;
    if (!background) {
      rootEl.innerHTML = renderLoading(opts);
    }
    var started = Date.now();
    var ticker = setInterval(function () {
      var span = rootEl.querySelector('.ai-insights-loading-text');
      if (span) {
        var elapsed = Math.round((Date.now() - started) / 1000);
        span.textContent = 'Analyzing your data… ' + elapsed + 's elapsed';
      }
    }, 2000);
    try {
      var res = await af('/api/client/ai-recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      clearInterval(ticker);
      inFlight = false;
      if (res.status === 402) {
        lastFetchedData = null;
        rootEl.innerHTML = renderLocked(opts);
        bindPanel(rootEl, opts);
        return;
      }
      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        rootEl.innerHTML = ''
          + '<div class="ai-insights-card unlocked error">'
          +   '<h3 class="ai-insights-h">AI Insights</h3>'
          +   '<p class="ai-insights-lede" style="color:var(--red)">'
          +     esc(err.error || ('HTTP ' + res.status))
          +     ' — please retry in a minute.'
          +   '</p>'
          +   '<button type="button" class="ai-insights-btn" data-ai-action="generate">Try again →</button>'
          + '</div>';
        bindHandlers(rootEl, opts);
        return;
      }
      var body = await res.json().catch(function () { return null; });
      if (body) {
        lastFetchedData = body;
        rootEl.innerHTML = renderResults(body, opts);
        bindHandlers(rootEl, opts);
      }
    } catch (e) {
      clearInterval(ticker);
      inFlight = false;
      rootEl.innerHTML = ''
        + '<div class="ai-insights-card unlocked error">'
        +   '<h3 class="ai-insights-h">AI Insights</h3>'
        +   '<p class="ai-insights-lede" style="color:var(--red)">Network error — please retry.</p>'
        +   '<button type="button" class="ai-insights-btn" data-ai-action="generate">Try again →</button>'
        + '</div>';
      bindHandlers(rootEl, opts);
    }
  }

  function bindHandlers(rootEl, opts) {
    rootEl.querySelectorAll('[data-ai-action="generate"], [data-ai-action="regenerate"]').forEach(function (btn) {
      btn.addEventListener('click', function () { run(rootEl, opts, { background: false }); });
    });
  }

  function bindPanel(rootEl, opts) {
    if (!rootEl) return;
    if (!isUnlocked()) {
      // Locked panel has no state to bind beyond the static mailto link.
      return;
    }
    bindHandlers(rootEl, opts);
    loadCached(rootEl, opts);
  }

  async function refresh() {
    var slot = document.getElementById('ai-insights-slot') || document.getElementById('ai-insights-slot-overview');
    if (!slot) return;
    var compact = slot.id === 'ai-insights-slot-overview';
    await run(slot, { compact: compact }, { background: false });
  }

  /* Inject CSS once per page load. Lives here (not the host page's
   * style block) so adding the panel to a new surface needs zero
   * stylesheet edits. */
  var STYLES_INJECTED = false;
  function ensureStyles() {
    if (STYLES_INJECTED) return;
    STYLES_INJECTED = true;
    var css = ''
      + '.ai-insights-card { margin-top:18px; padding:18px 18px 16px; border:1px solid var(--line); border-radius:10px; background:var(--paper); }'
      + '.ai-insights-card.compact { padding:14px 16px 12px; }'
      + '.ai-insights-card.locked { background:var(--maroon-wash); border-color:var(--maroon-tint); }'
      + '.ai-insights-card.error  { border-color:rgba(176,30,60,0.35); }'
      + '.ai-insights-head { display:flex; align-items:center; gap:10px; margin-bottom:8px; }'
      + '.ai-insights-h { font-family:var(--serif), Georgia, serif; font-size:18px; font-weight:400; margin:0; color:var(--ink); }'
      + '.ai-insights-card.compact .ai-insights-h { font-size:16px; }'
      + '.ai-insights-chip { background:var(--maroon); color:#fff; font-size:10.5px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; padding:2px 8px; border-radius:999px; }'
      + '.ai-insights-stale { background:var(--amber-tint); color:var(--amber); font-size:10.5px; font-weight:600; padding:2px 8px; border-radius:999px; }'
      + '.ai-insights-lede { font-size:13.5px; line-height:1.55; color:var(--muted); margin:0 0 14px; }'
      + '.ai-insights-benefits { list-style:none; padding:0; margin:0 0 14px; }'
      + '.ai-insights-cta { display:inline-block; padding:9px 16px; background:var(--maroon); color:#fff; border-radius:6px; font-size:13.5px; font-weight:500; text-decoration:none; }'
      + '.ai-insights-cta:hover { background:var(--maroon); opacity:0.9; }'
      + '.ai-insights-btn { display:inline-block; padding:9px 16px; background:var(--maroon); color:#fff; border:0; border-radius:6px; font-size:13.5px; font-weight:500; cursor:pointer; font-family:inherit; }'
      + '.ai-insights-btn:hover { opacity:0.9; }'
      + '.ai-insights-link-btn { background:none; border:0; padding:0; color:var(--maroon); font-size:13px; cursor:pointer; font-family:inherit; }'
      + '.ai-insights-link-btn:hover { text-decoration:underline; }'
      + '.ai-insights-loading { display:flex; align-items:center; gap:10px; padding:14px 0; color:var(--muted); font-size:13.5px; }'
      + '.ai-insights-list { display:flex; flex-direction:column; gap:0; }'
      + '.ai-rec-card { display:grid; grid-template-columns:90px 1fr; gap:14px; padding:12px 0; border-bottom:1px solid var(--line); }'
      + '.ai-rec-card:last-child { border-bottom:0; }'
      + '.ai-rec-meta { display:flex; flex-direction:column; gap:6px; align-items:flex-start; }'
      + '.ai-priority-pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; }'
      + '.ai-priority-pill.high { background:rgba(176,30,60,0.12); color:var(--maroon); }'
      + '.ai-priority-pill.med  { background:var(--amber-tint); color:var(--amber); }'
      + '.ai-priority-pill.low  { background:var(--bg2, #f5f1ea); color:var(--muted); }'
      + '.ai-rec-delta { font-family:var(--serif), Georgia, serif; font-style:italic; font-size:18px; color:var(--maroon); }'
      + '.ai-rec-title { font-size:14.5px; font-weight:600; color:var(--ink); margin-bottom:4px; line-height:1.35; }'
      + '.ai-rec-body  { font-size:13px; line-height:1.55; color:var(--muted); }'
      + '.ai-rec-action-row { margin-top:6px; }'
      + '.ai-rec-action { font-size:13px; color:var(--maroon); text-decoration:none; }'
      + '.ai-rec-action:hover { text-decoration:underline; }'
      + '.ai-insights-foot { margin-top:14px; padding-top:10px; border-top:1px solid var(--line); font-size:12px; color:var(--muted); }'
      + '.ai-insights-more { display:inline-block; margin-top:10px; font-size:13px; color:var(--maroon); text-decoration:none; }'
      + '.ai-insights-more:hover { text-decoration:underline; }';
    var style = document.createElement('style');
    style.setAttribute('data-amcp-ai-insights', '1');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Inject styles once now, even before any panel mounts, so they're
  // available the moment renderPanel() output is in DOM.
  ensureStyles();

  window.AMCP_AI_INSIGHTS = {
    renderPanel: renderPanel,
    bindPanel:   bindPanel,
    refresh:     refresh,
  };
}());
