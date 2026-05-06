/* v2 Mentions page — every citation, sortable, with Intent column (no
 * Earned since we don't track dollar attribution yet). */
(function () {

  // Intent → brand-meaningful colors. Covers BOTH the legacy `intent`
  // keys (price_led, brand_direct, best_top, specific_service, general,
  // affordable) AND the canonical INTENT_V2 keys (brand, pricing, hours,
  // location, emergency, comparison, service, reviews, contact, research,
  // other) since both flow through queries_by_intent depending on which
  // column has data.
  //
  // High-contrast hues chosen so distinct slices read at a glance even
  // on dark backgrounds. Anything not in this map falls through to a
  // categorical fallback palette by slot index — every intent gets a
  // unique color regardless of whether we predeclared it.
  // Apr 29 2026.
  const INTENT_COLOR = {
    // Canonical INTENT_V2
    brand:            '#7d2550',  // maroon — they asked for you by name
    pricing:          '#d29922',  // amber — money-related
    hours:            '#3a8c7c',  // teal — temporal
    location:         '#5a7eaa',  // slate-blue — geo-bound
    emergency:        '#ea4335',  // red — urgent
    comparison:       '#5a9bd4',  // bright blue — deliberative
    service:          '#10a37f',  // green — direct purchase intent
    reviews:          '#fa520f',  // orange — reputation-shaped
    contact:          '#9b59b6',  // purple — direct-action
    research:         '#c87b9b',  // dusty rose — exploratory
    other:            '#766f63',  // muted brown — uncategorized
    // Legacy `intent` column values (still appear in older rows)
    brand_direct:     '#7d2550',
    price_led:        '#d29922',
    'price-led':      '#d29922',
    affordable:       '#d29922',
    booking:          '#10a37f',
    best_top:         '#5a9bd4',
    specific_service: '#10a37f',
    general:          '#9b9b9b',  // grey — not specific
    unknown:          '#766f63',
  };
  // Fallback palette — used when a never-before-seen intent shows up.
  // Picks by stable index so the same intent always gets the same
  // color across renders.
  const INTENT_FALLBACK = [
    '#7d2550', '#10a37f', '#5a9bd4', '#d29922', '#ea4335',
    '#9b59b6', '#3a8c7c', '#fa520f', '#0078d4', '#c87b9b',
    '#1877f2', '#fbb03b', '#e07a5f', '#5b8e7d', '#a85aa3',
  ];
  function intentColor(key, idx) {
    const k = String(key || 'unknown').toLowerCase();
    if (INTENT_COLOR[k]) return INTENT_COLOR[k];
    return INTENT_FALLBACK[(idx || 0) % INTENT_FALLBACK.length];
  }
  'use strict';

  const DEMO = {
    business_name: 'Preview Business',
    total_queries: 847,
    queries_by_intent: {
      brand_direct: 412, comparison: 228, affordable: 141, emergency: 42, research: 24,
    },
    recent_queries: [
      { timestamp: Date.now() - 4  * 60 * 1000, crawler_agent: 'Perplexity', query_text: 'best florist in south austin',             intent: 'brand_direct', referral_clicked: 1 },
      { timestamp: Date.now() - 17 * 60 * 1000, crawler_agent: 'ChatGPT',    query_text: 'same day delivery flowers austin',         intent: 'affordable',   referral_clicked: 1 },
      { timestamp: Date.now() - 42 * 60 * 1000, crawler_agent: 'Claude',     query_text: 'florist open sunday with online ordering', intent: 'brand_direct', referral_clicked: 0 },
      { timestamp: Date.now() - 61 * 60 * 1000, crawler_agent: 'Gemini',     query_text: 'sympathy arrangements austin',             intent: 'brand_direct', referral_clicked: 0 },
      { timestamp: Date.now() - 88 * 60 * 1000, crawler_agent: 'ChatGPT',    query_text: 'wedding florist small ceremony',           intent: 'comparison',   referral_clicked: 1 },
      { timestamp: Date.now() - 3  * 3600 * 1000, crawler_agent: 'Perplexity', query_text: 'austin florist takes corporate orders',   intent: 'comparison',   referral_clicked: 1 },
      { timestamp: Date.now() - 5  * 3600 * 1000, crawler_agent: 'Claude',     query_text: 'affordable wedding bouquets austin',      intent: 'affordable',   referral_clicked: 0 },
      { timestamp: Date.now() - 7  * 3600 * 1000, crawler_agent: 'ChatGPT',    query_text: 'emergency florist late night austin',     intent: 'emergency',    referral_clicked: 0 },
    ],
  };

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    // Honor the topbar's date-range selector (set by wireDateRange in
    // dashboard-chrome.js). Falls back to the backend's default (30d).
    const range = (window.AMCP_DATE_RANGE && window.AMCP_DATE_RANGE.get && window.AMCP_DATE_RANGE.get()) || '30d';
    const r = await af(`/api/client/metrics?range=${encodeURIComponent(range)}`);
    return (r.ok ? await r.json() : {}) || {};
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtCount(v) { return v == null || isNaN(v) ? '—' : Number(v).toLocaleString(); }
  function fmtPct(v) { return v == null || isNaN(v) ? '—' : Math.round(v * 100) + '%'; }
  function timeAgo(iso) {
    if (!iso) return '';
    const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
    if (isNaN(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return Math.round(s) + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function intentLabel(i) {
    const map = { brand_direct: 'Brand', comparison: 'Comparison', affordable: 'Price-led', emergency: 'Emergency', research: 'Research' };
    return i ? (map[i] || i) : '—';
  }

  function render(metrics) {
    const m = metrics || {};
    const recent = m.recent_queries || [];
    const total  = m.total_queries || recent.length;
    const clicked = recent.filter(q => q.referral_clicked).length;
    const clickRate = recent.length ? clicked / recent.length : null;
    const brandCount = (m.queries_by_intent && m.queries_by_intent.brand_direct) || recent.filter(q => q.intent === 'brand_direct').length;

    // Top intents
    const byIntent = m.queries_by_intent || {};
    const intentEntries = Object.entries(byIntent).sort((a, b) => b[1] - a[1]);
    const intentTotal = intentEntries.reduce((s, [, n]) => s + n, 0);
    // Mount point for an ECharts donut. afterMount paints the chart
    // once ECharts has loaded; if it never does, the empty container
    // stays — the legacy bar list isn't kept since the donut is
    // strictly nicer.
    const intentBars = intentEntries.length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">No intent data yet.</div>`
      : `<div data-mentions-intent-donut style="width:100%;height:280px;margin-top:8px"></div>`;

    const rowsHtml = recent.length === 0
      ? `<tr><td colspan="4" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No mentions yet.</td></tr>`
      : recent.map(q => {
          const clickedCell = q.referral_clicked
            ? `<span class="st clicked">→ Clicked</span>`
            : `<span class="st cited">✓ Named</span>`;
          return `<tr>
            <td class="t">${esc(timeAgo(q.timestamp))}</td>
            <td><span class="bot-tag">${esc(q.crawler_agent || 'unknown')}</span></td>
            <td><span class="q">${esc(q.query_text || '')}</span></td>
            <td>${clickedCell} <span style="color:var(--muted);margin-left:8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em">${esc(intentLabel(q.intent))}</span></td>
          </tr>`;
        }).join('');

    return `
      <div class="plain-banner">
        <strong>In plain English:</strong>
        Every time an AI assistant brought up your business, we log it here with what the person was asking and whether they then clicked through.
      </div>

      <div class="kpis">
        <div class="kpi"><div class="head"><div class="k">Total mentions</div></div><div class="v tabular">${fmtCount(total)}</div><div class="d">All time</div></div>
        <div class="kpi"><div class="head"><div class="k">Recent click-through</div></div><div class="v tabular">${fmtPct(clickRate)}</div><div class="d">Of visible mentions</div></div>
        <div class="kpi"><div class="head"><div class="k">Brand queries</div></div><div class="v tabular">${fmtCount(brandCount)}</div><div class="d">Asked for you by name</div></div>
        <div class="kpi"><div class="head"><div class="k">Top intent</div></div><div class="v tabular" style="font-size:26px">${esc(intentLabel(intentEntries[0] ? intentEntries[0][0] : null))}</div><div class="d">Most common ask</div></div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>Why people are asking</h3><div class="sub">Breakdown by detected intent</div></div></div>
          ${intentBars}
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>About intent</h3><div class="sub">How we categorize each query</div></div></div>
          <p style="font-size:13.5px;line-height:1.6;color:var(--ink-2);">Advocate's agent classifies every query before answering:</p>
          <ul style="font-size:13.5px;line-height:1.75;color:var(--ink-2);padding-left:18px;margin-top:8px;">
            <li><strong>Brand</strong> — named your business directly</li>
            <li><strong>Comparison</strong> — weighing you vs. a competitor</li>
            <li><strong>Price-led</strong> — searching on cost or affordability</li>
            <li><strong>Emergency</strong> — time-sensitive, urgent</li>
            <li><strong>Research</strong> — gathering info, not ready to book</li>
          </ul>
        </div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>All recent mentions</h3><div class="sub">Last 20, oldest → newest</div></div>
            <a href="/ClickThroughs.html" class="btn btn-ghost btn-sm">See clicks →</a>
          </div>
          <table class="tbl">
            <thead><tr><th>When</th><th>AI tool</th><th>They were asked</th><th>What happened · intent</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ── ECharts donut for "Why people are asking" ──────────────────────────
  function pollEcharts(cb, attempts) {
    attempts = attempts || 0;
    if (window.echarts) { cb(); return; }
    if (attempts > 50) return;
    setTimeout(() => pollEcharts(cb, attempts + 1), 100);
  }
  function bootMaroonTheme() {
    if (!window.echarts) return;
    const root = getComputedStyle(document.documentElement);
    const ink   = (root.getPropertyValue('--ink') || '#141210').trim();
    const muted = (root.getPropertyValue('--muted') || '#766f63').trim();
    window.echarts.registerTheme('advocate-maroon', {
      backgroundColor: 'transparent',
      textStyle: { color: ink, fontFamily: 'inherit' },
      tooltip: { backgroundColor: 'rgba(20,18,16,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 } },
      legend: { textStyle: { color: muted } },
    });
  }
  function afterMount(metrics) {
    pollEcharts(() => {
      bootMaroonTheme();
      const host = document.querySelector('[data-mentions-intent-donut]');
      if (!host) return;
      const m = metrics || {};
      const byIntent = m.queries_by_intent || {};
      const entries = Object.entries(byIntent)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v], idx) => ({
          name: intentLabel(k),
          value: v,
          // Pass the rank so unmapped intents pick a stable color
          // from the fallback palette by index.
          itemStyle: { color: intentColor(k, idx) },
        }));
      if (!entries.length) return;
      const total = entries.reduce((s, e) => s + e.value, 0) || 1;
      const inst = window.echarts.init(host, 'advocate-maroon');
      inst.setOption({
        tooltip: {
          trigger: 'item',
          formatter: (p) => `<b>${p.name}</b><br>${p.value.toLocaleString()} mentions · ${((p.value/total)*100).toFixed(1)}%`,
        },
        legend: { type: 'scroll', orient: 'horizontal', bottom: 0, left: 'center', itemWidth: 10, itemHeight: 10, itemGap: 14 },
        series: [{
          type: 'pie',
          radius: ['58%', '78%'],
          center: ['50%', '42%'],
          label: { show: false },
          labelLine: { show: false },
          avoidLabelOverlap: true,
          data: entries,
        }],
      });
      window.addEventListener('resize', () => { try { inst.resize(); } catch (_) {} });
    });
  }

  window.AMCP_MENTIONS = { demo: () => DEMO, fetch: fetchReal, render, afterMount };

  // Re-fetch + re-render when the topbar's date-range selector changes.
  if (typeof window !== 'undefined') {
    window.addEventListener('amcp:date-range-changed', () => {
      if (window.AMCP_SHELL && typeof window.AMCP_SHELL.refresh === 'function') {
        window.AMCP_SHELL.refresh();
      } else {
        window.location.reload();
      }
    });
  }
})();
