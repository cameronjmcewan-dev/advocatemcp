/* v2 Mentions page — single canonical view of every AI-presence event.
 *
 * Merged from the previous Bot Traffic + Mentions pages (May 6 2026).
 * Same /api/client/metrics payload, one page covering both lenses:
 *   - "Who's mentioning me?" (vendor breakdown, daily traffic chart)
 *   - "What are they asking?" (intent breakdown, recent table with intent + click)
 *
 * Every "bot visit" is also a "mention" — they were always the same row
 * in the queries log; the dual-page presentation confused customers and
 * the headline numbers disagreed (windowed vs. all-time). This page
 * consolidates the surface and standardizes on the windowed total
 * driven by the topbar date-range selector. */
(function () {
  'use strict';

  // ── Color palettes ────────────────────────────────────────────────

  // Intent → brand-meaningful colors. Covers both legacy `intent` keys
  // (price_led, brand_direct, best_top, specific_service, general,
  // affordable) AND the canonical INTENT_V2 keys (brand, pricing, hours,
  // location, emergency, comparison, service, reviews, contact, research,
  // other) since both flow through queries_by_intent depending on which
  // column has data. Apr 29 2026.
  const INTENT_COLOR = {
    brand:            '#7d2550',  pricing:          '#d29922',
    hours:            '#3a8c7c',  location:         '#5a7eaa',
    emergency:        '#ea4335',  comparison:       '#5a9bd4',
    service:          '#10a37f',  reviews:          '#fa520f',
    contact:          '#9b59b6',  research:         '#c87b9b',
    other:            '#766f63',
    // Legacy intent column values (still appear in older rows)
    brand_direct:     '#7d2550',  price_led:        '#d29922',
    'price-led':      '#d29922',  affordable:       '#d29922',
    booking:          '#10a37f',  best_top:         '#5a9bd4',
    specific_service: '#10a37f',  general:          '#9b9b9b',
    unknown:          '#766f63',
  };
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

  // Bot-family grouping + brand-color palette. Multiple variants from
  // one vendor (GPTBot, GPTBot/1.0, ChatGPT, ChatGPT-User, OAI-SearchBot)
  // collapse onto one OpenAI row instead of fragmenting the breakdown.
  // Ported from bots.js. Apr 29 2026.
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

  // ── Demo data (preview mode) ──────────────────────────────────────

  const DEMO = {
    business_name: 'Preview Business',
    total_queries: 847,
    date_range: { start: null, end: null, days: 30 },
    queries_by_crawler: {
      Perplexity: 312, ChatGPT: 284, Claude: 171, Gemini: 80, Copilot: 32, 'Meta AI': 12, Cursor: 6,
    },
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

  // ── Fetch ─────────────────────────────────────────────────────────

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    // AdvocateChrome.getRange() resolves URL → localStorage → '30d' and
    // is available before this function runs (window.AMCP_DATE_RANGE is
    // not — it's created inside chrome.mount() which runs after fetch).
    const range = (window.AdvocateChrome && window.AdvocateChrome.getRange) ? window.AdvocateChrome.getRange() : '30d';
    const r = await af(`/api/client/metrics?range=${encodeURIComponent(range)}`);
    return (r.ok ? await r.json() : {}) || {};
  }

  // ── Formatting helpers ────────────────────────────────────────────

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
  // Derive the human label from the API's echoed `date_range.days` so
  // the label always tracks the data even mid-flight.
  function rangeLabel(m) {
    const days = (m && m.date_range && m.date_range.days) || 30;
    return `Last ${days} days`;
  }

  // ── Daily bucket builder ──────────────────────────────────────────
  //
  // Build a daily series oldest-first. Prefer the server-bucketed
  // queries_last_30_days array (authoritative across ALL queries in the
  // window); fall back to bucketing from the limited recent_queries[]
  // (max 50, lossy on > 50-visit windows).
  //
  // Critical: a day with zero queries MUST still appear as {count: 0}.
  // Server-side GROUP BY DATE(...) skips empty days. Mirrors
  // overview.js's derivedDailySeries pattern. Landed in PR #167.
  function dailySeries(metrics, days) {
    days = days || (metrics && metrics.date_range && metrics.date_range.days) || 30;
    const now = new Date();
    const buckets = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
      buckets.push({ day: d, count: 0, label: d.toLocaleDateString(undefined, { weekday: 'short' })[0] });
    }

    // Preferred path: server-bucketed counts. Match by ISO date string
    // (YYYY-MM-DD) so timezone offsets don't shift days at the boundary.
    const serverDaily = (metrics && metrics.queries_last_30_days) || null;
    if (Array.isArray(serverDaily) && serverDaily.length > 0) {
      const byDate = Object.create(null);
      for (const row of serverDaily) {
        if (row && typeof row.date === 'string' && typeof row.count === 'number') {
          byDate[row.date] = (byDate[row.date] || 0) + row.count;
        }
      }
      for (const b of buckets) {
        const y = b.day.getFullYear();
        const m = String(b.day.getMonth() + 1).padStart(2, '0');
        const d = String(b.day.getDate()).padStart(2, '0');
        const key = `${y}-${m}-${d}`;
        if (byDate[key]) b.count = byDate[key];
      }
      return buckets;
    }

    // Fallback path: bucket from recent_queries[]. Lossy when > ~50.
    (metrics.recent_queries || []).forEach(q => {
      const t = typeof q.timestamp === 'number' ? q.timestamp : new Date(q.timestamp).getTime();
      if (isNaN(t)) return;
      for (let i = 0; i < buckets.length; i++) {
        const nxt = i < buckets.length - 1 ? buckets[i + 1].day.getTime() : Infinity;
        if (t >= buckets[i].day.getTime() && t < nxt) { buckets[i].count++; break; }
      }
    });
    return buckets;
  }

  // ── Render ────────────────────────────────────────────────────────

  function render(metrics) {
    const m = metrics || {};
    const recent = m.recent_queries || [];

    // Windowed total — sum of queries_by_crawler in the selected range.
    // Replaces the previous all-time m.total_queries reading; consistent
    // with the date-range dropdown.
    const total     = Object.values(m.queries_by_crawler || {}).reduce((s, n) => s + (n || 0), 0);
    const clicked   = recent.filter(q => q.referral_clicked).length;
    const clickRate = recent.length ? clicked / recent.length : null;
    const lastSeen  = recent[0] ? timeAgo(recent[0].timestamp) : '—';

    // Vendor (family-grouped). Same treatment as Overview's bot donut.
    const byCrawler = m.queries_by_crawler || {};
    const byFamily = Object.create(null);
    for (const [name, n] of Object.entries(byCrawler)) {
      const fam = botFamily(name);
      byFamily[fam] = (byFamily[fam] || 0) + (n || 0);
    }
    const familyEntries = Object.entries(byFamily).sort((a, b) => b[1] - a[1]);
    const topAiTool = familyEntries[0] ? familyEntries[0][0] : '—';

    // Intent breakdown (donut painted in afterMount).
    const byIntent = m.queries_by_intent || {};
    const intentEntries = Object.entries(byIntent).sort((a, b) => b[1] - a[1]);

    // Daily chart series. Bar/line height feeds both the legacy CSS bars
    // and the ECharts area-line upgrade applied in afterMount.
    const days = (m.date_range && m.date_range.days) || 30;
    const series = dailySeries(m, days);
    const chartMax = Math.max(1, ...series.map(s => s.count));
    const bars = series.map(s => {
      const pct = Math.max(4, (s.count / chartMax) * 100);
      return `<div class="bar" data-v="${s.count} mentions" style="height:${pct}%"></div>`;
    }).join('');
    const labels = series.map(s => `<span>${s.label}</span>`).join('');

    // Vendor breakdown bars (right column, top row).
    const crawlerBars = familyEntries.length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">No mentions yet.</div>`
      : familyEntries.map(([name, n]) => {
          const pct = total ? Math.round((n / total) * 100) : 0;
          const color = BOT_FAMILY_COLOR[name] || BOT_FAMILY_COLOR.Other;
          return `<div class="bot-row">
            <span class="name" style="display:inline-flex;align-items:center;gap:8px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color}"></span>${esc(name)}</span>
            <div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="n">${fmtCount(n)} <span style="color:var(--muted);font-size:11px;margin-left:4px">${pct}%</span></span>
          </div>`;
        }).join('');

    // Intent donut mount point (right column, second row).
    const intentDonut = intentEntries.length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">No intent data yet.</div>`
      : `<div data-mentions-intent-donut style="width:100%;height:280px;margin-top:8px"></div>`;

    // Recent mentions table.
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
        Every time an AI assistant brought up your business, we log it here — who mentioned you, what the person was asking, and whether they then clicked through.
      </div>

      <div class="kpis">
        <div class="kpi"><div class="head"><div class="k">Total mentions</div></div><div class="v tabular">${fmtCount(total)}</div><div class="d">${rangeLabel(m)}</div></div>
        <div class="kpi"><div class="head"><div class="k">Click-through rate</div></div><div class="v tabular">${fmtPct(clickRate)}</div><div class="d">Of visible mentions</div></div>
        <div class="kpi"><div class="head"><div class="k">Top AI tool</div></div><div class="v tabular" style="font-size:28px">${esc(topAiTool)}</div><div class="d">Most active</div></div>
        <div class="kpi"><div class="head"><div class="k">Last mention</div></div><div class="v tabular" style="font-size:28px">${esc(lastSeen)}</div><div class="d">Most recent hit</div></div>
      </div>

      <div class="row">
        <div class="card-dash" data-mentions-traffic-card>
          <div class="card-head"><div><h3>Daily mentions</h3><div class="sub">${days}-day rolling view</div></div></div>
          <div class="chart">${bars}</div>
          <div class="chart-labels">${labels}</div>
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>By AI tool</h3><div class="sub">Share of mentions, ${rangeLabel(m).toLowerCase()}. Counts how often AI search engines (Claude, ChatGPT, Perplexity, etc.) fetched your page &mdash; not human clicks. For visits driven by users who clicked through from an AI answer, see <a href="/TrafficImpact.html" style="color:var(--maroon)">Traffic Impact</a>'s AI-vs-Human chart (one stage downstream).</div></div></div>
          ${crawlerBars}
        </div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>Why people are asking</h3><div class="sub">Breakdown by what the person was looking for</div></div></div>
          ${intentDonut}
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>About these question types</h3><div class="sub">How we sort each question into a group</div></div></div>
          <p style="font-size:13.5px;line-height:1.6;color:var(--ink-2);">Every question that comes through Advocate gets sorted into one of these groups before we answer:</p>
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
            <a href="/TrafficImpact.html" class="btn btn-ghost btn-sm">See traffic impact →</a>
          </div>
          <table class="tbl">
            <thead><tr><th>When</th><th>AI tool</th><th>They were asked</th><th>What happened · intent</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ── ECharts theme + polling ───────────────────────────────────────

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
      color: [t.maroon, t.tint, '#3a8c7c', '#d29922', '#5a7eaa', '#e07a5f'],
      backgroundColor: 'transparent',
      textStyle: { color: t.ink, fontFamily: 'inherit' },
      tooltip: { backgroundColor: 'rgba(20,18,16,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 } },
      categoryAxis: { axisLine:{ lineStyle:{ color: t.line } }, axisTick:{ lineStyle:{ color: t.line } }, axisLabel:{ color: t.muted }, splitLine:{ lineStyle:{ color: t.line } } },
      valueAxis:    { axisLine:{ lineStyle:{ color: t.line } }, axisTick:{ lineStyle:{ color: t.line } }, axisLabel:{ color: t.muted }, splitLine:{ lineStyle:{ color: t.line } } },
      legend: { textStyle: { color: t.muted } },
    });
  }

  // ── ECharts upgrades ──────────────────────────────────────────────

  function upgradeDailyMentionsChart(metrics) {
    const card = document.querySelector('.card-dash[data-mentions-traffic-card]');
    if (!card) return;
    const oldChart  = card.querySelector('.chart');
    const oldLabels = card.querySelector('.chart-labels');
    if (!oldChart) return;
    if (oldLabels) oldLabels.remove();
    const host = document.createElement('div');
    host.style.cssText = 'width:100%;height:280px;margin-top:8px';
    oldChart.replaceWith(host);

    const days = (metrics && metrics.date_range && metrics.date_range.days) || 30;
    const series = dailySeries(metrics || {}, days);
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

  function upgradeIntentDonut(metrics) {
    const host = document.querySelector('[data-mentions-intent-donut]');
    if (!host) return;
    const m = metrics || {};
    const byIntent = m.queries_by_intent || {};
    const entries = Object.entries(byIntent)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v], idx) => ({
        name: intentLabel(k),
        value: v,
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
  }

  function afterMount(metrics) {
    pollEcharts(() => {
      bootMaroonTheme();
      upgradeDailyMentionsChart(metrics);
      upgradeIntentDonut(metrics);
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
