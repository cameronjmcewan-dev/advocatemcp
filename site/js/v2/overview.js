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
    const [metrics, radar, activity, onboarding] = await Promise.all([
      af('/api/client/metrics').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/radar').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/activity-detail').then(r => r.ok ? r.json() : null).catch(() => null),
      // Onboarding snapshot drives the inline Get Started panel. 404
      // means the business row hasn't been created yet (fresh signup
      // mid-Stripe-webhook); treat as "no snapshot, hide panel".
      af('/api/client/onboarding').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return {
      metrics:    metrics  || {},
      radar:      radar    || { summary: {}, basket: { queries: [] }, authority_report: {} },
      activity:   activity || { reservations: [], handoffs: [], agent_requests: [], totals: {} },
      onboarding: onboarding || null,
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
  /* Compact result rendering for the Overview score card. Lower
   * info density than the BusinessProfile version — just the big
   * number, per-engine bars, and the top 2 improvements with
   * deep-links so the customer sees "fix this → re-run". */
  function renderOverviewScore(data) {
    if (!data) return '';
    const score = (data.score != null ? data.score : 0).toFixed(1);
    const cite = data.cite_rate != null ? data.cite_rate : 0;
    const variants = data.per_variant || [];
    const improvements = (data.improvements || []).slice(0, 2);

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

    return `
      <div class="ov-score-summary">
        <div class="ov-score-big">
          <div class="ov-score-num">${score}<span class="ov-score-max">/10</span></div>
          <div class="ov-score-meta">${cite}% cite rate</div>
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
      </style>
    `;
  }

  /* AI citation score card on the Overview. The customer-facing
   * scoring tool lives on /BusinessProfile.html (full UI with
   * improvements list); this card is the at-a-glance summary +
   * one-click "Run a fresh check" surface that lives on the page
   * the customer hits on every login. By default it shows a
   * "no score yet" prompt so we don't burn API budget on every
   * page load — customer chooses when to run a check. */
  function renderScoreOverviewCard() {
    return `
      <div class="row single">
        <div class="card-dash" id="score-overview-card">
          <div class="card-head">
            <div>
              <h3>AI citation score</h3>
              <div class="sub">How likely AI search engines (Perplexity, ChatGPT, Claude, Google) are to cite your business when someone asks about you. Run a check to see the number + what to improve.</div>
            </div>
            <div>
              <button id="btn-run-overview-score" type="button" class="btn btn-primary btn-sm">Run AI score check →</button>
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
    // AI citation score on the Overview. Same endpoint as
    // BusinessProfile's scoring card but rendered as a compact
    // "score + top 2 improvements" summary here. Click → run →
    // ~30-45s → inline render. No persistence in v0; each click
    // costs ~$0.04 so customer chooses when to refresh.
    const scoreBtn = document.getElementById('btn-run-overview-score');
    const scoreResultEl = document.getElementById('score-overview-result');
    if (scoreBtn && scoreResultEl) {
      scoreBtn.addEventListener('click', async () => {
        const af = window.AMCP && window.AMCP.authedFetch;
        if (!af) { scoreResultEl.innerHTML = '<p style="color:var(--red)">Not signed in.</p>'; return; }
        scoreBtn.disabled = true;
        const started = Date.now();
        scoreResultEl.innerHTML = '<div class="ov-score-loading"><span class="ov-score-spinner"></span><span class="ov-score-loading-text">Scoring how 4 AI engines would cite you right now… ~30-45s</span></div>';
        const ticker = setInterval(() => {
          const elapsed = Math.round((Date.now() - started) / 1000);
          const span = scoreResultEl.querySelector('.ov-score-loading-text');
          if (span) span.textContent = `Running… ${elapsed}s elapsed`;
        }, 2000);
        try {
          const res = await af('/api/client/profile-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          clearInterval(ticker);
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            scoreResultEl.innerHTML = `<p style="color:var(--red);font-size:13.5px">Score check failed: ${esc(body.error || ('HTTP ' + res.status))}</p>`;
            return;
          }
          scoreResultEl.innerHTML = renderOverviewScore(body);
        } catch (err) {
          clearInterval(ticker);
          scoreResultEl.innerHTML = `<p style="color:var(--red);font-size:13.5px">Network error: ${esc(String((err && err.message) || err))}</p>`;
        } finally {
          scoreBtn.disabled = false;
        }
      });
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
  }

  window.AMCP_OVERVIEW = {
    demo:   () => DEMO,
    fetch:  fetchReal,
    render,
    afterMount,
  };
})();
