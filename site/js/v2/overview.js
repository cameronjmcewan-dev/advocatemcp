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
 *   Revenue card   → REMAPPED to "Agent transactions" (reservations funnel)
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
    const [metrics, radar, activity] = await Promise.all([
      af('/api/client/metrics').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/radar').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/activity-detail').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return {
      metrics:  metrics  || {},
      radar:    radar    || { summary: {}, basket: { queries: [] }, authority_report: {} },
      activity: activity || { reservations: [], handoffs: [], agent_requests: [], totals: {} },
    };
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
  function renderKPIs({ metrics, radar, activity }) {
    const mentions     = fmtCount(metrics && metrics.total_queries);
    const clicks       = fmtCount(metrics && metrics.referral_clicks_last_30_days);
    const reservations = fmtCount(reservationCount(activity));
    const citation     = fmtPct(citationRate(radar));

    return `
      <div class="kpis" data-tour="kpis">
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
          <div class="head"><div class="k">Reservations <span class="info" title="A2A reserve_slot holds + confirmations.">i</span></div></div>
          <div class="v tabular">${reservations}</div>
          <div class="d">Held or confirmed</div>
          <div class="plain">Bookings agents made on your behalf.</div>
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
          <div><h3>Agent transactions</h3><div class="sub">The A2A funnel — calls to confirmed work</div></div>
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
  function render(data) {
    const d = data || {};
    const name = (d.metrics && d.metrics.business_name) || 'your business';
    return `
      <div class="plain-banner" id="plain-banner">
        <strong>In plain English:</strong>
        Here's what AI is saying about ${esc(name)} and what visitors did next.
        <span class="x" onclick="this.parentElement.style.display='none'">✕</span>
      </div>

      ${renderKPIs(d)}

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

  window.AMCP_OVERVIEW = {
    demo:   () => DEMO,
    fetch:  fetchReal,
    render,
  };
})();
