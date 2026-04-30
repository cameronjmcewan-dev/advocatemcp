/* v2 Overview module — populates the main content of /app.html.
 *
 * Every card in Max's Dashboard.html mockup is either wired to a real
 * /api/client/* field or explicitly remapped (per the migration plan at
 * ~/.claude/plans/for-a-is-there-unified-emerson.md):
 *
 *   Mentions       ← metrics.total_queries
 *   Click-throughs ← metrics.referral_clicks_last_30_days
 *   Earned $       → REMAPPED to Reservations (count of held+confirmed)
 *   Win rate       → REMAPPED to Citation rate (radar.summary.citation_rate)
 *   Earned column  → REMAPPED to Intent (queries.intent)
 *   Revenue card   → REMAPPED to "AI-attributed bookings" (reservations funnel; renamed from "Agent transactions" Apr 25 2026 to make the customer value immediately legible)
 *
 * Exposes three functions on window.AMCP_OVERVIEW:
 *   demo()    → returns a realistic dataset for the preview URL, where
 *               real auth cookies can't cross domains.
 *   fetch()   → makes the /api/client/{metrics,radar,activity-detail}
 *               calls and returns a normalized { metrics, radar, activity }
 *               object. Callers must have a valid session.
 *   render()  → returns the mainContent HTML string for
 *               AdvocateChrome.mount({ mainContent }).
 */
(function () {
  'use strict';

  /* ────────────────────────────────────────────────────────────────────
   * Demo data — used on the preview URL and when a real fetch returns
   * an empty tenant so the layout has something to show.
   * ──────────────────────────────────────────────────────────────────── */
  const DEMO = {
    metrics: {
      business_name: 'Preview Business',
      total_queries: 847,
      referral_clicks: 189,
      referral_clicks_last_30_days: 189,
      queries_by_crawler: {
        Perplexity: 312, ChatGPT: 284, Claude: 171, Gemini: 80, Copilot: 32,
      },
      recent_queries: [
        { timestamp: '2026-04-22T14:02:00Z', crawler_agent: 'Perplexity', query_text: 'best florist in south austin',            intent: 'brand_direct', referral_clicked: 1 },
        { timestamp: '2026-04-22T13:48:00Z', crawler_agent: 'ChatGPT',    query_text: 'same day delivery flowers austin',        intent: 'affordable',   referral_clicked: 1 },
        { timestamp: '2026-04-22T13:21:00Z', crawler_agent: 'Claude',     query_text: 'florist open sunday with online ordering',intent: 'brand_direct', referral_clicked: 0 },
        { timestamp: '2026-04-22T12:58:00Z', crawler_agent: 'Gemini',     query_text: 'sympathy arrangements austin',            intent: 'brand_direct', referral_clicked: 0 },
        { timestamp: '2026-04-22T11:44:00Z', crawler_agent: 'ChatGPT',    query_text: 'wedding florist small ceremony',          intent: 'comparison',   referral_clicked: 1 },
        { timestamp: '2026-04-22T10:33:00Z', crawler_agent: 'Perplexity', query_text: 'austin florist takes corporate orders',   intent: 'comparison',   referral_clicked: 1 },
      ],
    },
    radar: {
      summary: {
        citation_rate: 0.64,
        polls_this_week: 48,
        wins_this_week: 31,
        by_bot: [],
      },
      basket: { queries: [] },
      authority_report: { top_missing_keyword: 'wedding florist' },
    },
    activity: {
      reservations: [
        { id: 'r_abc', status: 'confirmed', created_at: '2026-04-22T14:05:00Z', service: 'Same-day bouquet' },
        { id: 'r_def', status: 'confirmed', created_at: '2026-04-22T11:40:00Z', service: 'Corporate order' },
        { id: 'r_ghi', status: 'held',      created_at: '2026-04-22T09:12:00Z', service: 'Wedding consult' },
      ],
      handoffs: [
        { id: 'h_jkl', delivered_via: 'sms',   created_at: '2026-04-22T14:08:00Z' },
        { id: 'h_mno', delivered_via: 'email', created_at: '2026-04-22T10:45:00Z' },
      ],
      agent_requests: [
        { tool_called: 'query_business_agent', created_at: '2026-04-22T14:04:00Z', agent_id: 'claude-desktop/1.0' },
        { tool_called: 'reserve_slot',         created_at: '2026-04-22T14:02:00Z', agent_id: 'claude-desktop/1.0' },
        { tool_called: 'get_quote',            created_at: '2026-04-22T13:55:00Z', agent_id: 'cursor/0.42' },
      ],
      totals: {},
    },
  };

  /* ────────────────────────────────────────────────────────────────────
   * Real fetch.
   * ──────────────────────────────────────────────────────────────────── */
  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    if (!af) throw new Error('AMCP.authedFetch not available — did dashboard-auth.js load?');
    // Per-location filter (Apr 27 2026 Section 2). Reads the topbar
    // selector's current value; appended to the revenue-summary fetch
    // so filtering re-scopes the dashboard's headline number. Other
    // analytics endpoints will gain location_id support as the data
    // model migration lands; for now the bookings-derived KPIs scope
    // via the revenue summary's event_count.
    const locId = (window.AMCP_LOCATION && window.AMCP_LOCATION.get && window.AMCP_LOCATION.get()) || null;
    const locQuery = locId ? '?location_id=' + encodeURIComponent(locId) : '';
    // Date range filter (Apr 29 2026 — replaces the static 30d default).
    // Reads ?range=7d|30d|90d|365d from the URL set by the topbar picker.
    // The worker forwards this to the server's /analytics/:slug endpoint
    // which already supports it (PR #145). Old workers ignore the param
    // and return their default 30-day window — graceful degradation.
    const rng = new URL(location.href).searchParams.get('range') || '30d';
    const rangeQ = '?range=' + encodeURIComponent(rng);
    const join = (qs) => qs ? (locQuery ? locQuery + '&' + qs.slice(1) : qs) : locQuery;
    const [metrics, radar, activity, onboarding, revenue] = await Promise.all([
      af('/api/client/metrics' + rangeQ).then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/radar' + rangeQ).then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/activity-detail' + rangeQ).then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/onboarding').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/revenue-summary' + join(rangeQ)).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return {
      metrics:    metrics  || {},
      radar:      radar    || { summary: {}, basket: { queries: [] }, authority_report: {} },
      activity:   activity || { reservations: [], handoffs: [], agent_requests: [], totals: {} },
      onboarding: onboarding || null,
      revenue:    revenue  || null,
    };
  }

  // Re-fetch when the topbar location selector changes. Listening on
  // window because dashboard-chrome.js dispatches the event globally
  // so every page module can reactively rescope.
  if (typeof window !== 'undefined') {
    window.addEventListener('amcp:location-changed', () => {
      // Rebuild via AMCP_SHELL.boot() flow. The shell provides a single
      // fetchReal+render pipeline; trigger it via reload of the section.
      if (window.AMCP_SHELL && typeof window.AMCP_SHELL.refresh === 'function') {
        window.AMCP_SHELL.refresh();
      } else {
        // Fallback: full page reload. Less elegant but always works.
        window.location.reload();
      }
    });
  }

  /* ────────────────────────────────────────────────────────────────────
   * Helpers.
   * ──────────────────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtPct(v) {
    if (v == null || isNaN(v)) return '—';
    return Math.round(v * 100) + '%';
  }
  function fmtCount(v) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toLocaleString();
  }
  /**
   * Format integer cents as a localized currency string. Always uses 0
   * fraction digits because the dashboard cards are scan-not-spreadsheet —
   * "$4,250" reads cleaner than "$4,250.00". The currency arg is ISO-4217;
   * Intl.NumberFormat handles the symbol placement automatically.
   *
   * Returns '—' when cents is null/undefined so callers don't have to
   * branch — useful for the unconfigured-revenue case where we still
   * want to render the KPI shell but suppress the dollar value.
   */
  function fmtMoneyCents(cents, currency) {
    if (cents == null || isNaN(cents)) return '—';
    const dollars = Number(cents) / 100;
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'USD',
        maximumFractionDigits: 0,
      }).format(dollars);
    } catch {
      // Bad currency code → fall back to USD-style formatting so we
      // never crash the dashboard over a malformed config value.
      return '$' + Math.round(dollars).toLocaleString();
    }
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60)    return Math.round(s) + 's ago';
    if (s < 3600)  return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function intentLabel(i) {
    if (!i) return '—';
    const map = {
      brand_direct: 'Brand',
      comparison:   'Comparison',
      affordable:   'Price-led',
      emergency:    'Emergency',
      research:     'Research',
    };
    return map[i] || i;
  }

  /* ────────────────────────────────────────────────────────────────────
   * Derived values.
   * ──────────────────────────────────────────────────────────────────── */
  function reservationCount(activity) {
    const arr = (activity && activity.reservations) || [];
    return arr.filter(r => r.status === 'held' || r.status === 'confirmed').length;
  }
  function handoffCount(activity) {
    const arr = (activity && activity.handoffs) || [];
    return arr.filter(h => h.delivered_via).length;
  }
  function agentCallCount(activity) {
    const arr = (activity && activity.agent_requests) || [];
    return arr.length;
  }
  function citationRate(radar) {
    const r = radar && radar.summary && radar.summary.citation_rate;
    return typeof r === 'number' ? r : null;
  }

  /* Derive a 14-point daily series from recent_queries[] timestamps. The
     metrics endpoint doesn't return a pre-bucketed daily chart today, so
     we roll our own from the timestamps we have. Returns an array of
     { day, count } oldest-first. */
  function derivedDailySeries(metrics) {
    const days = 14;
    const now = new Date();
    const buckets = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      buckets.push({ day: d, count: 0, label: d.toLocaleDateString(undefined, { weekday: 'short' })[0] });
    }
    const queries = (metrics && metrics.recent_queries) || [];
    queries.forEach(q => {
      const t = new Date(q.timestamp).getTime();
      if (isNaN(t)) return;
      for (let i = 0; i < buckets.length; i++) {
        const next = i < buckets.length - 1 ? buckets[i + 1].day.getTime() : Infinity;
        if (t >= buckets[i].day.getTime() && t < next) { buckets[i].count++; break; }
      }
    });
    return buckets;
  }

  /* ────────────────────────────────────────────────────────────────────
   * Per-card renderers — each returns an HTML string fragment.
   * ──────────────────────────────────────────────────────────────────── */
  function renderKPIs({ metrics, radar, activity, revenue }) {
    const mentions     = fmtCount(metrics && metrics.total_queries);
    const clicks       = fmtCount(metrics && metrics.referral_clicks_last_30_days);
    const reservations = fmtCount(reservationCount(activity));
    const citation     = fmtPct(citationRate(radar));

    // Revenue card has three render states (Apr 27 2026):
    //
    //   verified    → "$X,XXX from N AI-attributed bookings"  (green pill)
    //   estimated   → "~$X,XXX from N AI-attributed bookings"  (amber pill)
    //   unconfigured → "N AI-attributed bookings" + CTA (no dollars)
    //
    // The unconfigured state intentionally never displays a dollar value —
    // founder directive: never show unverified currency on the dashboard.
    // Source defaults to 'unconfigured' when /api/client/revenue-summary
    // 404s on legacy workers (fall-through-graceful).
    const revSource    = (revenue && revenue.source) || 'unconfigured';
    const revAmount    = revenue && revenue.amount_cents;
    const revCurrency  = (revenue && revenue.currency) || 'USD';
    const revCount     = (revenue && revenue.event_count != null) ? revenue.event_count : reservationCount(activity);

    let kpiHeadline, kpiSub, kpiPill, kpiPlain;
    if (revSource === 'verified') {
      kpiHeadline = fmtMoneyCents(revAmount, revCurrency);
      kpiSub      = `from ${fmtCount(revCount)} AI-attributed bookings · this month`;
      kpiPill     = '<span class="rev-pill rev-pill-verified" title="Confirmed via your booking-system webhook.">✓ Verified</span>';
      kpiPlain    = 'Real dollars from AI-driven bookings, confirmed by your booking system.';
    } else if (revSource === 'estimated') {
      const aov = revenue && revenue.aov_cents;
      kpiHeadline = '~' + fmtMoneyCents(revAmount, revCurrency);
      kpiSub      = `from ${fmtCount(revCount)} AI-attributed bookings · this month`;
      kpiPill     = `<span class="rev-pill rev-pill-estimated" title="Estimated using your average ticket of ${fmtMoneyCents(aov, revCurrency)}. Configure a revenue webhook in Settings for verified numbers.">Estimated</span>`;
      kpiPlain    = 'Estimated using your average ticket × AI-attributed bookings.';
    } else {
      // Unconfigured — booking count, no dollars, with CTA.
      kpiHeadline = fmtCount(revCount);
      kpiSub      = 'AI-attributed bookings · this month';
      kpiPill     = '';
      kpiPlain    = 'Add an average ticket in Settings to see estimated revenue.';
    }

    // KPI ordering choice (Apr 25 2026): "AI-attributed bookings" comes
    // first because it's the single most retention-critical number. A
    // tenant who sees "0 bookings" for 60 days churns; a tenant who sees
    // "3 bookings" renews. Mentions/Click-throughs/Citation rate are all
    // upstream signals — bookings are the outcome.
    return `
      <div class="kpis" data-tour="kpis">
        <div class="kpi">
          <div class="head"><div class="k">AI-attributed revenue ${kpiPill} <span class="info" title="${revSource === 'verified' ? 'Confirmed via your booking-system webhook.' : revSource === 'estimated' ? 'Estimated based on your average ticket value.' : 'Bookings AI agents made on your behalf via MCP.'}">i</span></div></div>
          <div class="v tabular">${kpiHeadline}</div>
          <div class="d">${kpiSub}</div>
          <div class="plain">${kpiPlain}</div>
        </div>
        <div class="kpi">
          <div class="head"><div class="k">Mentions <span class="info" title="Total AI queries that referenced your business.">i</span></div></div>
          <div class="v tabular">${mentions}</div>
          <div class="d">Last 30 days</div>
          <div class="plain">Times AI answered a question by mentioning you.</div>
        </div>
        <div class="kpi">
          <div class="head"><div class="k">Click-throughs <span class="info" title="People who tapped from an AI answer to your site.">i</span></div></div>
          <div class="v tabular">${clicks}</div>
          <div class="d">Last 30 days</div>
          <div class="plain">Visitors who came from an AI citation.</div>
        </div>
        <div class="kpi">
          <div class="head"><div class="k">Citation rate <span class="info" title="% of tracked competitor queries AI named you in.">i</span></div></div>
          <div class="v tabular">${citation}</div>
          <div class="d">Rolling weekly</div>
          <div class="plain">Out of every 100 category searches, how often you appeared.</div>
        </div>
      </div>
    `;
  }

  function renderBotChart({ metrics }) {
    const series = derivedDailySeries(metrics);
    const max = Math.max(1, ...series.map(s => s.count));
    const bars = series.map(s => {
      const pct = Math.max(4, (s.count / max) * 100);
      return `<div class="bar" data-v="${s.count} mentions" style="height:${pct}%"></div>`;
    }).join('');
    const labels = series.map(s => `<span>${s.label || ''}</span>`).join('');
    return `
      <div class="card-dash" data-tour="bot-traffic">
        <div class="card-head">
          <div>
            <h3>AI bot traffic</h3>
            <div class="sub">Daily mentions across every AI tool</div>
          </div>
        </div>
        <div class="chart">${bars}</div>
        <div class="chart-labels">${labels}</div>
      </div>
    `;
  }

  function renderBotBreakdown({ metrics }) {
    const by = (metrics && metrics.queries_by_crawler) || {};
    const rows = Object.entries(by)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const total = rows.reduce((s, [, n]) => s + n, 0) || 1;
    const html = rows.length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">No crawler traffic yet.</div>`
      : rows.map(([name, n]) => {
          const pct = Math.round((n / total) * 100);
          return `<div class="bot-row">
            <span class="name">${esc(name)}</span>
            <div class="track"><div class="fill" style="width:${pct}%"></div></div>
            <span class="n">${fmtCount(n)}</span>
          </div>`;
        }).join('');
    return `
      <div class="card-dash">
        <div class="card-head"><div><h3>Which AI tool?</h3><div class="sub">Breakdown by crawler, last 30 days</div></div></div>
        ${html}
      </div>
    `;
  }

  function renderMentionsTable({ metrics }) {
    const recent = (metrics && metrics.recent_queries) || [];
    const rowsHtml = recent.length === 0
      ? `<tr><td colspan="4" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No mentions yet. AI crawlers will populate this table as they visit.</td></tr>`
      : recent.slice(0, 6).map(q => {
          const clicked = q.referral_clicked
            ? `<span class="st clicked">→ Clicked</span>`
            : `<span class="st cited">✓ Named</span>`;
          return `<tr>
            <td class="t">${esc(timeAgo(q.timestamp))}</td>
            <td><span class="bot-tag">${esc(q.crawler_agent || 'unknown')}</span></td>
            <td><span class="q">${esc(q.query_text || '')}</span></td>
            <td>${clicked} <span style="color:var(--muted);margin-left:8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em">${esc(intentLabel(q.intent))}</span></td>
          </tr>`;
        }).join('');
    return `
      <div class="card-dash">
        <div class="card-head">
          <div><h3>Recent AI mentions</h3><div class="sub">Every citation and what the visitor did next</div></div>
          <a href="/Mentions.html" class="btn btn-ghost btn-sm">View all →</a>
        </div>
        <table class="tbl">
          <thead><tr><th>When</th><th>AI tool</th><th>They were asked</th><th>What happened</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  function renderRadarCard({ radar }) {
    const rate = citationRate(radar);
    const pct = rate == null ? '—' : fmtPct(rate);
    const tip = (radar && radar.authority_report && radar.authority_report.top_missing_keyword) || null;
    const tipHtml = tip
      ? `<div class="radar-tip"><strong>Tip:</strong> Add "<em>${esc(tip)}</em>" to your services — it came up most in queries where a competitor won.</div>`
      : '';
    return `
      <div class="card-dash" data-tour="radar">
        <div class="card-head">
          <div><h3>Competitor Radar</h3><div class="sub">Share of AI mentions this week</div></div>
          <span class="chip maroon">PRO</span>
        </div>
        <div class="radar-you">${pct}</div>
        <div class="sub" style="color:var(--muted);font-size:13px;margin-top:4px;">AI picked you ${pct} of the time in tracked category searches.</div>
        ${tipHtml}
      </div>
    `;
  }

  function renderAgentTransactions({ activity }) {
    const agentCalls = agentCallCount(activity);
    const reservations = reservationCount(activity);
    const handoffs = handoffCount(activity);
    const confirmed = ((activity && activity.reservations) || []).filter(r => r.status === 'confirmed').length;
    const confirmPct = reservations ? Math.round((confirmed / reservations) * 100) : 0;
    return `
      <div class="card-dash">
        <div class="card-head">
          <div><h3>AI-attributed bookings</h3><div class="sub">When an AI agent reaches your business via MCP and books on a real customer's behalf — the closest thing to "AI sent me revenue" you can measure today.</div></div>
          <a href="/A2APipeline.html" class="btn btn-ghost btn-sm">View full →</a>
        </div>
        <div class="rev-main">
          <div class="big tabular">${fmtCount(agentCalls)}</div>
          <div class="sm">agent tool calls · ${fmtCount(reservations)} reservations · ${fmtCount(handoffs)} handoffs</div>
        </div>
        <div class="bot-dots">
          <div class="bot-dot"><div class="l">Confirmed rate</div><div class="v">${confirmPct}%</div></div>
          <div class="bot-dot"><div class="l">Confirmed</div><div class="v">${fmtCount(confirmed)}</div></div>
          <div class="bot-dot"><div class="l">Handoffs delivered</div><div class="v">${fmtCount(handoffs)}</div></div>
        </div>
      </div>
    `;
  }

  function renderActivityFeed({ activity }) {
    const events = [];
    (activity && activity.reservations || []).forEach(r => events.push({ t: r.created_at, kind: 'reservation', label: `Reservation ${esc(r.status || 'new')}`, detail: r.service || '' }));
    (activity && activity.handoffs     || []).forEach(h => events.push({ t: h.created_at, kind: 'handoff',     label: `Handoff via ${esc(h.delivered_via || 'unknown')}`, detail: '' }));
    (activity && activity.agent_requests || []).forEach(a => events.push({ t: a.created_at, kind: 'agent',    label: `Agent call · ${esc(a.tool_called || 'tool')}`, detail: esc(a.agent_id || '') }));
    events.sort((x, y) => new Date(y.t) - new Date(x.t));
    const shown = events.slice(0, 8);
    const html = shown.length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">Quiet so far. Activity appears as crawlers and agents arrive.</div>`
      : shown.map(e => {
          const dot = e.kind === 'reservation' ? 'var(--maroon)'
                    : e.kind === 'handoff'     ? 'var(--sage)'
                    : 'var(--amber)';
          return `<div class="feed-item">
            <span class="dot" style="background:${dot}"></span>
            <div><strong>${e.label}</strong>${e.detail ? ` — ${e.detail}` : ''}<div class="t">${timeAgo(e.t)}</div></div>
          </div>`;
        }).join('');
    return `
      <div class="card-dash">
        <div class="card-head">
          <div><h3>Activity feed</h3><div class="sub">Last 8 events across bots, agents, and reservations</div></div>
          <span class="chip sage dot-chip"><span class="dot"></span>Live</span>
        </div>
        ${html}
      </div>
    `;
  }

  /* ────────────────────────────────────────────────────────────────────
   * Public render: the whole main content for /app.html.
   * ──────────────────────────────────────────────────────────────────── */
  /* Compact result rendering for the Overview score card. Lower
   * info density than the BusinessProfile version — just the big
   * number, per-engine bars, and the top 2 improvements with
   * deep-links so the customer sees "fix this → re-run". */
  /* SVG sparkline for the score_history array. ~120px wide × 28px
   * tall, fits inline next to the big score. Renders nothing if
   * fewer than 2 data points (need at least two to draw a line). */
  function renderSparkline(history) {
    if (!Array.isArray(history) || history.length < 2) return '';
    const w = 120, h = 28;
    const pts = history.slice(-30);
    const minScore = Math.min(...pts.map((p) => p.score));
    const maxScore = Math.max(...pts.map((p) => p.score));
    const range = Math.max(0.5, maxScore - minScore);
    const step = pts.length > 1 ? (w - 4) / (pts.length - 1) : 0;
    const path = pts.map((p, i) => {
      const x = 2 + i * step;
      const y = h - 2 - ((p.score - minScore) / range) * (h - 4);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    const last = pts[pts.length - 1];
    const lastX = 2 + (pts.length - 1) * step;
    const lastY = h - 2 - ((last.score - minScore) / range) * (h - 4);
    return `
      <svg class="ov-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
        <path d="${path}" fill="none" stroke="var(--maroon)" stroke-width="1.5" />
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="var(--maroon)" />
      </svg>
    `;
  }

  function renderOverviewScore(data) {
    if (!data) return '';
    const score = (data.score != null ? data.score : 0).toFixed(1);
    const cite = data.cite_rate != null ? data.cite_rate : 0;
    const variants = data.per_variant || [];
    const improvements = (data.improvements || []).slice(0, 2);
    const history = data.history || [];
    const isStale = data.is_stale === true;
    const lastRun = data.run_at ? new Date(data.run_at) : null;

    const labelMap = {
      perplexity_html: 'Perplexity',
      openai_html:     'ChatGPT',
      claude_html:     'Claude',
      google_html:     'Google AI Overview',
    };
    const variantBars = variants.map((v) => {
      const label = labelMap[v.variant_id] || v.variant_id;
      const pct = Math.round((v.score / 10) * 100);
      return `
        <div class="ov-engine-row">
          <span class="ov-engine-name">${esc(label)}</span>
          <div class="ov-engine-bar"><div class="ov-engine-fill" style="width:${pct}%"></div></div>
          <span class="ov-engine-num">${v.score.toFixed(1)}</span>
        </div>
      `;
    }).join('');

    const improvementsHtml = improvements.length === 0
      ? `<p style="color:var(--muted);font-size:13.5px;margin:6px 0 0">Great score. Re-run periodically to keep tracking.</p>`
      : improvements.map((i) => `
          <div class="ov-tip">
            <strong>+${i.expected_lift.toFixed(1)}</strong>
            <span>${esc(i.reason)}</span>
            <a href="${esc(i.href)}">Open →</a>
          </div>
        `).join('');

    const staleLabel = isStale
      ? `<div class="ov-stale">Profile changed since last check — score may be out of date</div>`
      : '';

    return `
      ${staleLabel}
      <div class="ov-score-summary">
        <div class="ov-score-big">
          <div class="ov-score-num">${score}<span class="ov-score-max">/10</span></div>
          <div class="ov-score-meta">${cite}% cite rate ${lastRun ? '· ' + timeAgo(lastRun.toISOString()) : ''}</div>
          ${renderSparkline(history)}
        </div>
        <div class="ov-engine-list">${variantBars}</div>
      </div>
      ${improvementsHtml ? `<div class="ov-tips"><strong class="ov-tips-h">Top opportunities</strong>${improvementsHtml}</div>` : ''}
      <style>
        .ov-score-loading { display:flex; align-items:center; gap:10px; padding:14px; color:var(--muted); font-size:13.5px; }
        .ov-score-spinner { width:14px; height:14px; border-radius:999px; border:2px solid var(--line); border-top-color:var(--maroon); animation:ov-spin 1s linear infinite; }
        @keyframes ov-spin { to { transform: rotate(360deg); } }
        .ov-score-summary { display:grid; grid-template-columns:160px 1fr; gap:24px; align-items:center; padding:6px 0 14px; }
        @media (max-width:720px) { .ov-score-summary { grid-template-columns:1fr; } }
        .ov-score-big { padding:14px 16px; background:var(--paper-2); border-radius:12px; text-align:center; }
        .ov-score-num { font-family:var(--serif); font-size:48px; line-height:1; color:var(--maroon); font-weight:400; }
        .ov-score-max { font-size:22px; color:var(--muted); }
        .ov-score-meta { font-size:12.5px; color:var(--muted); margin-top:4px; }
        .ov-engine-list { display:flex; flex-direction:column; gap:8px; }
        .ov-engine-row { display:grid; grid-template-columns:140px 1fr 36px; gap:10px; align-items:center; font-size:13px; }
        .ov-engine-name { color:var(--ink-2); }
        .ov-engine-bar { height:6px; background:var(--line); border-radius:999px; overflow:hidden; }
        .ov-engine-fill { height:100%; background:var(--maroon); }
        .ov-engine-num { font-variant-numeric:tabular-nums; color:var(--ink); text-align:right; }
        .ov-tips { padding-top:12px; border-top:1px solid var(--line); }
        .ov-tips-h { font-size:11.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); display:block; margin-bottom:8px; }
        .ov-tip { display:grid; grid-template-columns:36px 1fr auto; gap:10px; align-items:center; padding:8px 0; font-size:13px; line-height:1.45; color:var(--ink-2); }
        .ov-tip strong { font-family:var(--serif); font-size:18px; color:var(--sage); text-align:center; }
        .ov-tip a { color:var(--maroon); font-weight:500; font-size:12.5px; white-space:nowrap; }
        .ov-spark { display:block; margin: 8px auto 0; opacity: 0.85; }
        .ov-stale {
          background: var(--paper-2); border: 1px solid var(--line);
          border-left: 3px solid var(--maroon);
          padding: 8px 12px; border-radius: 6px;
          font-size: 12.5px; color: var(--ink-2); margin-bottom: 14px;
        }
      </style>
    `;
  }

  /* Citation rating card on the Overview. The customer-facing
   * scoring tool lives on /BusinessProfile.html (full UI with
   * improvements list + the explainer panel); this card is the
   * at-a-glance summary + one-click "Run a fresh check" surface
   * that lives on the page the customer hits on every login.
   *
   * Naming: see profile.js renderScoreCard() for the rationale —
   * this is a calibrated proxy, not a count of real citations.
   * Real citation tracking lives on Competitor Radar. */
  function renderScoreOverviewCard() {
    return `
      <div class="row single">
        <div class="card-dash" id="score-overview-card">
          <div class="card-head">
            <div>
              <h3 style="display:inline-flex;align-items:center;gap:8px">Citation rating
                <a href="/BusinessProfile.html"
                   title="Learn how this is calculated on Business Profile"
                   style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;background:var(--paper-2);color:var(--ink-2);border:1px solid var(--line);font-size:11px;font-weight:600;text-decoration:none;line-height:1">?</a>
              </h3>
              <div class="sub">A predicted score for how citation-ready your profile is when AI search engines build their answers. Calibrated against the per-engine rendering each bot receives. Real citations from live polls live on <a href="/CompetitorRadar.html" style="color:var(--maroon)">Competitor Radar</a>.</div>
            </div>
            <div>
              <button id="btn-run-overview-score" type="button" class="btn btn-primary btn-sm">Run citation check →</button>
            </div>
          </div>
          <div id="score-overview-result" style="margin-top:14px"></div>
        </div>
      </div>
    `;
  }

  function render(data) {
    const d = data || {};
    const name = (d.metrics && d.metrics.business_name) || 'your business';
    return `
      <div id="gs-panel-mount"></div>

      <div class="plain-banner" id="plain-banner">
        <strong>In plain English:</strong>
        Here's what AI is saying about ${esc(name)} and what visitors did next.
        <span class="x" onclick="this.parentElement.style.display='none'">✕</span>
      </div>

      ${renderScoreOverviewCard()}

      ${renderKPIs(d)}

      ${
        // Liability-safe disclaimer rendered ONLY when the AI-attributed
        // revenue card is in the 'estimated' state. Verified state shows
        // verified actuals — no disclaimer needed. Unconfigured state
        // shows no dollar values at all. The string "estimated" must
        // appear here exactly so a customer who screenshots the
        // dashboard for their accountant sees the label preserved.
        (d.revenue && d.revenue.source === 'estimated')
          ? `<div class="rev-disclaimer">Estimated revenue is computed from your supplied average ticket × AI-attributed booking count. Actuals may differ. Configure a verified-revenue webhook in Settings for confirmed numbers.</div>`
          : ''
      }

      <div class="row" data-tour="bot-traffic">
        ${renderBotChart(d)}
        ${renderBotBreakdown(d)}
      </div>

      <div class="row" data-tour="mentions-table">
        ${renderMentionsTable(d)}
        ${renderRadarCard(d)}
      </div>

      <div class="row" data-tour="revenue">
        ${renderAgentTransactions(d)}
        ${renderActivityFeed(d)}
      </div>

      <div class="page-foot">
        <span>© 2026 Advocate · last synced ${new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</span>
        <span>Need help? <a href="#" id="footer-help" style="color:var(--maroon);">Replay the tutorial</a></span>
      </div>
    `;
  }

  // Mount the inline Get Started panel after render(). The panel
  // hides itself when the tenant has onboarded_at set, when the user
  // is an admin viewing ?as=<slug>, or when the snapshot is null
  // (admin impersonation server-side returns an empty state). Click
  // through any step → the panel re-renders from the new snapshot.
  function afterMount(data) {
    const mount = document.getElementById('gs-panel-mount');
    if (mount && window.AMCP_GET_STARTED && typeof window.AMCP_GET_STARTED.render === 'function') {
      const snap = (data && data.onboarding) || null;
      window.AMCP_GET_STARTED.render(mount, snap);
    }
    // First-login welcome modal. Tour bridge gates internally on
    // AMCP_ONBOARDING.isFirstLogin() and on user role, so calling
    // unconditionally here is safe.
    if (window.AMCP_TOUR && typeof window.AMCP_TOUR.maybeAutoStart === 'function') {
      window.AMCP_TOUR.maybeAutoStart();
    }
    // AI citation score: load cached value instantly via GET (no API
    // spend), then if cache is stale or missing, expose a "Run check"
    // button. The cached score IS the legit score of the info served
    // because mutations invalidate the hash → next view triggers
    // fresh run.
    const scoreBtn       = document.getElementById('btn-run-overview-score');
    const scoreResultEl  = document.getElementById('score-overview-result');
    if (scoreBtn && scoreResultEl) {
      const af = window.AMCP && window.AMCP.authedFetch;

      async function loadCached() {
        if (!af) return;
        try {
          const res = await af('/api/client/profile-score', { method: 'GET' });
          const body = await res.json().catch(() => ({}));
          if (res.ok && body.has_score) {
            scoreResultEl.innerHTML = renderOverviewScore(body);
          } else {
            scoreResultEl.innerHTML = '';
          }
          // Update button label based on state.
          if (body.has_score && body.is_stale) {
            scoreBtn.textContent = 'Profile changed — re-run check →';
          } else if (body.has_score) {
            scoreBtn.textContent = 'Re-run check →';
          } else {
            scoreBtn.textContent = 'Run citation check →';
          }
        } catch { /* silent — show "Run check" button */ }
      }

      async function runScore() {
        if (!af) { scoreResultEl.innerHTML = '<p style="color:var(--red)">Not signed in.</p>'; return; }
        scoreBtn.disabled = true;
        const started = Date.now();
        scoreResultEl.innerHTML = '<div class="ov-score-loading"><span class="ov-score-spinner"></span><span class="ov-score-loading-text">Scoring how citation-ready each AI engine\'s rendered output looks… ~30-45s</span></div>';
        const ticker = setInterval(() => {
          const elapsed = Math.round((Date.now() - started) / 1000);
          const span = scoreResultEl.querySelector('.ov-score-loading-text');
          if (span) span.textContent = `Running… ${elapsed}s elapsed`;
        }, 2000);
        try {
          // The overview button is always a user click (no autosave
          // path on this surface). Force a fresh run so the score
          // reflects the current profile rather than the cached row,
          // which may itself be a stale 0/0 from a partially-run
          // earlier attempt.
          const res = await af('/api/client/profile-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: true }),
          });
          clearInterval(ticker);
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            scoreResultEl.innerHTML = `<p style="color:var(--red);font-size:13.5px">Score check failed: ${esc(body.error || ('HTTP ' + res.status))}</p>`;
            return;
          }
          scoreResultEl.innerHTML = renderOverviewScore(body);
          scoreBtn.textContent = 'Re-run check →';
        } catch (err) {
          clearInterval(ticker);
          scoreResultEl.innerHTML = `<p style="color:var(--red);font-size:13.5px">Network error: ${esc(String((err && err.message) || err))}</p>`;
        } finally {
          scoreBtn.disabled = false;
        }
      }

      scoreBtn.addEventListener('click', runScore);
      loadCached();
    }

    // Footer "Replay the tutorial" link.
    const replay = document.getElementById('footer-help');
    if (replay) {
      replay.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.AMCP_TOUR && typeof window.AMCP_TOUR.start === 'function') {
          window.AMCP_TOUR.start();
        } else if (window.AMCP_ONBOARDING && typeof window.AMCP_ONBOARDING.openWelcome === 'function') {
          window.AMCP_ONBOARDING.openWelcome();
        }
      });
    }

    // ── In-place chart upgrades (Apr 29 2026) ──────────────────────────────
    // Replace the legacy CSS bar chart + horizontal bars with ECharts
    // canvases. The renderXxxChart functions still emit their original
    // mount points; here we hide those + paint richer charts inside
    // `.echart-host` siblings injected by the new render code.
    upgradeChartsToECharts(data);

    // Wire the existing topbar `.date-range` button to a real dropdown.
    initRangePicker();
  }

  // ── ECharts upgrades on existing chart sections ────────────────────────
  function pollEcharts(cb, attempts) {
    attempts = attempts || 0;
    if (window.echarts) { cb(); return; }
    if (attempts > 50) return;
    setTimeout(() => pollEcharts(cb, attempts + 1), 100);
  }
  function readMaroonTokens() {
    const root = getComputedStyle(document.documentElement);
    return {
      maroon: (root.getPropertyValue('--maroon') || '#7d2550').trim(),
      tint:   (root.getPropertyValue('--maroon-tint') || '#c87b9b').trim(),
      ink:    (root.getPropertyValue('--ink') || '#141210').trim(),
      muted:  (root.getPropertyValue('--muted') || '#766f63').trim(),
      line:   (root.getPropertyValue('--line') || '#d4ccbf').trim(),
    };
  }
  function bootMaroonTheme() {
    if (!window.echarts) return;
    const t = readMaroonTokens();
    window.echarts.registerTheme('advocate-maroon', {
      color: [t.maroon, t.tint, '#3a8c7c', '#d29922', '#5a7eaa', '#e07a5f', '#9b59b6', '#34d399'],
      backgroundColor: 'transparent',
      textStyle: { color: t.ink, fontFamily: 'inherit' },
      title:    { textStyle: { color: t.ink } },
      legend:   { textStyle: { color: t.muted } },
      tooltip:  { backgroundColor: 'rgba(20,18,16,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 } },
      categoryAxis: { axisLine:{ lineStyle:{ color: t.line } }, axisTick:{ lineStyle:{ color: t.line } }, axisLabel:{ color: t.muted }, splitLine:{ lineStyle:{ color: t.line } } },
      valueAxis:    { axisLine:{ lineStyle:{ color: t.line } }, axisTick:{ lineStyle:{ color: t.line } }, axisLabel:{ color: t.muted }, splitLine:{ lineStyle:{ color: t.line } } },
    });
  }
  function upgradeChartsToECharts(data) {
    pollEcharts(() => {
      bootMaroonTheme();
      upgradeBotTrafficChart(data);
      upgradeWhichToolDonut(data);
    });
  }

  /** Replace the legacy CSS-bars `.chart` inside the AI bot traffic card
   *  with an ECharts area-line chart. Same data source as the legacy
   *  rendering: derivedDailySeries(metrics). */
  function upgradeBotTrafficChart(data) {
    // The legacy renderBotChart writes a `.card-dash[data-tour="bot-traffic"]`
    // wrapper. Inside it find the `.chart` (CSS bars) + `.chart-labels`
    // and replace with a single ECharts mount.
    const wrap = document.querySelector('.card-dash[data-tour="bot-traffic"]');
    if (!wrap) return;
    const oldChart  = wrap.querySelector('.chart');
    const oldLabels = wrap.querySelector('.chart-labels');
    if (!oldChart) return;
    if (oldLabels) oldLabels.remove();
    const host = document.createElement('div');
    host.style.cssText = 'width:100%;height:280px;margin-top:8px';
    oldChart.replaceWith(host);

    const series = derivedDailySeries(data && data.metrics);
    const inst = window.echarts.init(host, 'advocate-maroon');
    inst.setOption({
      grid: { left: 36, right: 16, top: 16, bottom: 32 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: series.map((s) => s.day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })),
        boundaryGap: false,
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: [{
        type: 'line',
        data: series.map((s) => s.count),
        smooth: true,
        showSymbol: false,
        areaStyle: { opacity: 0.18 },
        lineStyle: { width: 2 },
      }],
    });
    window.addEventListener('resize', () => { try { inst.resize(); } catch (_) {} });
  }

  /** Map each raw crawler User-Agent label (ClaudeBot, GPTBot, ChatGPT,
   *  GPTBot/1.0, ChatGPT-User, OAI-SearchBot, Perplexity-User, Google-
   *  Extended, etc.) to its parent AI company. Multiple variants from
   *  the same vendor (e.g. GPTBot + GPTBot/1.0 + ChatGPT-User + OAI-
   *  SearchBot) collapse onto one slice so the donut isn't a confetti
   *  of near-identical maroon shades. Apr 29 2026. */
  function botFamily(name) {
    const s = String(name || '').toLowerCase();
    if (s.includes('claude') || s.includes('anthropic')) return 'Anthropic';
    if (s.includes('gpt') || s.includes('chatgpt') || s.includes('oai')) return 'OpenAI';
    if (s.includes('perplexity'))  return 'Perplexity';
    if (s.includes('google'))      return 'Google';
    if (s.includes('bing') || s.includes('microsoft')) return 'Microsoft';
    if (s.includes('meta') || s.includes('facebook'))  return 'Meta';
    if (s.includes('apple'))       return 'Apple';
    if (s.includes('cohere'))      return 'Cohere';
    if (s.includes('mistral'))     return 'Mistral';
    if (s.includes('xai') || s.includes('grok')) return 'xAI';
    if (s.includes('mcp'))         return 'MCP clients';
    return 'Other';
  }

  /** Brand-tinted, high-contrast palette per AI family. Uses each
   *  vendor's flagship color where one exists (Anthropic = our maroon,
   *  OpenAI's signature green, Google red, etc.) so the donut reads
   *  semantically + the colors don't blur together. */
  const BOT_FAMILY_COLOR = {
    'Anthropic':   '#7d2550',
    'OpenAI':      '#10a37f',
    'Google':      '#ea4335',
    'Perplexity':  '#5a9bd4',
    'Microsoft':   '#0078d4',
    'Meta':        '#1877f2',
    'Apple':       '#9b9b9b',
    'Cohere':      '#d29922',
    'Mistral':     '#fa520f',
    'xAI':         '#1a1a1a',
    'MCP clients': '#9b59b6',
    'Other':       '#766f63',
  };

  /** Replace the horizontal bar list inside "Which AI tool?" with a
   *  family-grouped donut chart. */
  function upgradeWhichToolDonut(data) {
    const heads = document.querySelectorAll('.card-dash .card-head h3');
    let wrap = null;
    heads.forEach((h) => { if (h.textContent.trim() === 'Which AI tool?') wrap = h.closest('.card-dash'); });
    if (!wrap) return;
    const head = wrap.querySelector('.card-head');
    Array.from(wrap.children).forEach((c) => { if (c !== head) c.remove(); });
    const host = document.createElement('div');
    // Taller mount so the legend along the bottom gets its own row
    // without crowding the donut. 320px ≈ donut + 60px legend strip.
    host.style.cssText = 'width:100%;height:320px;margin-top:8px';
    wrap.appendChild(host);

    const by = (data && data.metrics && data.metrics.queries_by_crawler) || {};
    // Group raw crawler names by AI family + sum counts. Drops the
    // confetti effect of GPTBot + GPTBot/1.0 + ChatGPT + ChatGPT-User
    // + OAI-SearchBot all rendering as separate near-identical slices.
    const byFamily = Object.create(null);
    for (const [name, count] of Object.entries(by)) {
      const fam = botFamily(name);
      byFamily[fam] = (byFamily[fam] || 0) + (count || 0);
    }
    let entries = Object.entries(byFamily)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({
        name,
        value,
        itemStyle: { color: BOT_FAMILY_COLOR[name] || BOT_FAMILY_COLOR.Other },
      }));
    if (!entries.length) {
      entries = [{ name: 'No traffic yet', value: 1, itemStyle: { color: BOT_FAMILY_COLOR.Other } }];
    }

    const inst = window.echarts.init(host, 'advocate-maroon');
    inst.setOption({
      tooltip: {
        trigger: 'item',
        formatter: (p) => {
          const total = entries.reduce((s, e) => s + e.value, 0) || 1;
          const pct = ((p.value / total) * 100).toFixed(1);
          return `<b>${p.name}</b><br>${p.value.toLocaleString()} mentions · ${pct}%`;
        },
      },
      // Legend along the bottom (out of the donut's space + scrollable
      // when more vendors arrive). Centered horizontally so it reads
      // symmetrically against the card chrome.
      legend: {
        type: 'scroll',
        orient: 'horizontal',
        bottom: 0,
        left: 'center',
        textStyle: { color: 'var(--muted)' },
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 14,
      },
      series: [{
        type: 'pie',
        radius: ['58%', '78%'],
        center: ['50%', '42%'],   // donut centered above the legend
        label: { show: false },
        labelLine: { show: false },
        avoidLabelOverlap: true,
        data: entries,
      }],
    });
    window.addEventListener('resize', () => { try { inst.resize(); } catch (_) {} });
  }

  // ── Date range picker on the topbar (Apr 29 2026) ──────────────────────
  // The chrome's `.date-range` button is the same element across every v2
  // page. Wire it once here so the Overview can filter by 7d/30d/90d/365d.
  // The selection sets ?range= on the URL; reload triggers a fresh fetch
  // with the new range. (Applying without reload requires plumbing the
  // range into fetchReal; for v1 a reload is simplest + universally
  // correct across legacy + ECharts paths.)
  function initRangePicker() {
    const btn = document.querySelector('.date-range');
    if (!btn || btn.dataset.rangeWired) return;
    btn.dataset.rangeWired = '1';

    const u = new URL(location.href);
    const cur = u.searchParams.get('range') || '30d';
    const labels = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '365d': 'Last year' };
    btn.textContent = (labels[cur] || labels['30d']) + ' ⌄';
    btn.style.cursor = 'pointer';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.amcp-range-menu').forEach((m) => m.remove());
      const menu = document.createElement('div');
      menu.className = 'amcp-range-menu';
      menu.style.cssText = 'position:absolute;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:4px;box-shadow:0 4px 14px rgba(0,0,0,.10);z-index:1000;min-width:160px;font-family:inherit';
      ['7d','30d','90d','365d'].forEach((opt) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = labels[opt];
        item.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 11px;background:none;border:none;color:var(--ink);font-family:inherit;font-size:13px;cursor:pointer;border-radius:5px';
        item.addEventListener('mouseenter', () => { item.style.background = 'var(--paper-2)'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
        item.addEventListener('click', () => {
          const u2 = new URL(location.href);
          u2.searchParams.set('range', opt);
          window.location.href = u2.toString();
        });
        menu.appendChild(item);
      });
      const r = btn.getBoundingClientRect();
      menu.style.top = (r.bottom + window.scrollY + 6) + 'px';
      menu.style.left = (r.left + window.scrollX) + 'px';
      document.body.appendChild(menu);
      const closer = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closer); } };
      setTimeout(() => document.addEventListener('click', closer), 0);
    });
  }

  window.AMCP_OVERVIEW = {
    demo:   () => DEMO,
    fetch:  fetchReal,
    render,
    afterMount,
  };
})();

