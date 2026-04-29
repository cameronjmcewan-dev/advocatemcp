/* v2 Mentions page — every citation, sortable, with Intent column (no
 * Earned since we don't track dollar attribution yet). */
(function () {

  // Intent → brand-meaningful colors. Same hue logic as the bot-family
  // donut on /app: high-contrast, semantically loaded so the donut reads
  // at a glance instead of being a wall of similar maroon. Apr 29 2026.
  const INTENT_COLOR = {
    brand_direct:  '#7d2550',  // maroon — most valuable: they asked for you
    comparison:    '#5a9bd4',  // blue — cool, deliberative
    price_led:     '#d29922',  // amber — money-related
    emergency:     '#ea4335',  // red — urgent
    research:      '#9b59b6',  // purple — exploratory
    booking:       '#10a37f',  // green — conversion intent
    location:      '#3a8c7c',  // teal — geo-bound
    unknown:       '#766f63',  // muted brown
  };
  function intentColor(key) {
    return INTENT_COLOR[String(key || 'unknown').toLowerCase()] || INTENT_COLOR.unknown;
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
    const r = await af('/api/client/metrics');
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
        .map(([k, v]) => ({
          name: intentLabel(k),
          value: v,
          itemStyle: { color: intentColor(k) },
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
})();
