/* v2 Bot Traffic page — deeper view into /api/client/metrics than the
 * Overview's summary card. Shares the same metrics payload so no extra
 * endpoint is needed. */
(function () {
  'use strict';

  // Bot-family grouping + brand-color palette — same logic as the
  // Overview donut on /app. Multiple variants from one vendor (GPTBot,
  // GPTBot/1.0, ChatGPT, ChatGPT-User, OAI-SearchBot) collapse onto one
  // OpenAI row instead of fragmenting the list with confusing duplicates.
  // Apr 29 2026.
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

  const DEMO = {
    business_name: 'Preview Business',
    total_queries: 847,
    queries_by_crawler: {
      Perplexity: 312, ChatGPT: 284, Claude: 171, Gemini: 80, Copilot: 32, 'Meta AI': 12, Cursor: 6,
    },
    recent_queries: [
      { timestamp: Date.now() - 5  * 60 * 1000, crawler_agent: 'Perplexity', query_text: 'best florist in south austin' },
      { timestamp: Date.now() - 18 * 60 * 1000, crawler_agent: 'ChatGPT',    query_text: 'same day delivery flowers austin' },
      { timestamp: Date.now() - 44 * 60 * 1000, crawler_agent: 'Claude',     query_text: 'florist open sunday with online ordering' },
      { timestamp: Date.now() - 62 * 60 * 1000, crawler_agent: 'Gemini',     query_text: 'sympathy arrangements austin' },
      { timestamp: Date.now() - 90 * 60 * 1000, crawler_agent: 'ChatGPT',    query_text: 'wedding florist small ceremony' },
      { timestamp: Date.now() - 4  * 3600 * 1000, crawler_agent: 'Perplexity', query_text: 'austin florist takes corporate orders' },
    ],
  };

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    // Honor the topbar's date-range selector. AdvocateChrome.getRange()
    // resolves URL → localStorage → '30d' default and is available the
    // moment chrome.js is parsed (which is BEFORE this fetchReal runs).
    // We previously called window.AMCP_DATE_RANGE.get() but that global
    // is created inside chrome.mount() which doesn't run until AFTER
    // shell.js's parallel fetchReal() — race that always lost.
    const range = (window.AdvocateChrome && window.AdvocateChrome.getRange) ? window.AdvocateChrome.getRange() : '30d';
    const r = await af(`/api/client/metrics?range=${encodeURIComponent(range)}`);
    return (r.ok ? await r.json() : {}) || {};
  }

  // Derive a human label from the API's echoed `date_range.days`. The
  // backend returns the actual window it used (7, 30, 90, 365), so the
  // label always tracks the data even if the user just switched ranges
  // and the response is mid-flight.
  function rangeLabel(m) {
    const days = (m && m.date_range && m.date_range.days) || 30;
    return `Last ${days} days`;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtCount(v) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toLocaleString();
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
    if (isNaN(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60)    return Math.round(s) + 's ago';
    if (s < 3600)  return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function dailySeries(metrics, days) {
    // Default to the API's echoed window when the caller doesn't pass one.
    // 30 is the backend default; 14 was the previous hardcoded value that
    // silently dropped 16 days of data from the chart.
    days = days || (metrics && metrics.date_range && metrics.date_range.days) || 30;
    const now = new Date();
    const buckets = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
      buckets.push({ day: d, count: 0, label: d.toLocaleDateString(undefined, { weekday: 'short' })[0] });
    }
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

  function render(metrics) {
    const m = metrics || {};
    const by = m.queries_by_crawler || {};
    // Raw entries (per User-Agent) — only used to compute the
    // total + the headline `topCrawler` KPI's underlying max. The
    // user-facing breakdown collapses everything onto AI families.
    const rawEntries = Object.entries(by).sort((a, b) => b[1] - a[1]);
    const totalMentions = rawEntries.reduce((s, [, n]) => s + n, 0);
    const recent = (m.recent_queries || []).slice(0, 20);
    const lastSeen = recent[0] ? timeAgo(recent[0].timestamp) : '—';

    // Family-grouped breakdown (same treatment as Overview donut).
    const byFamily = Object.create(null);
    for (const [name, n] of rawEntries) {
      const fam = botFamily(name);
      byFamily[fam] = (byFamily[fam] || 0) + (n || 0);
    }
    const familyEntries = Object.entries(byFamily).sort((a, b) => b[1] - a[1]);
    const topCrawler      = familyEntries[0] ? familyEntries[0][0] : '—';
    const uniqueCrawlers  = familyEntries.length;

    const days = (m.date_range && m.date_range.days) || 30;
    const series = dailySeries(m, days);
    // The daily bar chart stays as the primary visualization on this
    // page — chartMax + bars feed both the legacy CSS bars and the
    // ECharts upgrade applied in afterMount.
    const chartMax = Math.max(1, ...series.map(s => s.count));
    const bars = series.map(s => {
      const pct = Math.max(4, (s.count / chartMax) * 100);
      return `<div class="bar" data-v="${s.count} visits" style="height:${pct}%"></div>`;
    }).join('');
    const labels = series.map(s => `<span>${s.label}</span>`).join('');

    // By AI family — color each bar with the vendor's flagship hue so
    // the list reads at a glance instead of being a wall of identical
    // maroon. Hue map matches the Overview donut.
    const crawlerBars = familyEntries.length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">No crawler traffic yet.</div>`
      : familyEntries.map(([name, n]) => {
          const pct = totalMentions ? Math.round((n / totalMentions) * 100) : 0;
          const color = BOT_FAMILY_COLOR[name] || BOT_FAMILY_COLOR.Other;
          return `<div class="bot-row">
            <span class="name" style="display:inline-flex;align-items:center;gap:8px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color}"></span>${esc(name)}</span>
            <div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="n">${fmtCount(n)} <span style="color:var(--muted);font-size:11px;margin-left:4px">${pct}%</span></span>
          </div>`;
        }).join('');

    const recentRows = recent.length === 0
      ? `<tr><td colspan="3" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No bot visits in the ${rangeLabel(m).toLowerCase()}.</td></tr>`
      : recent.map(q => `<tr>
          <td class="t">${esc(timeAgo(q.timestamp))}</td>
          <td><span class="bot-tag">${esc(q.crawler_agent || 'unknown')}</span></td>
          <td><span class="q">${esc(q.query_text || '')}</span></td>
        </tr>`).join('');

    return `
      <div class="kpis">
        <div class="kpi"><div class="head"><div class="k">Total visits</div></div><div class="v tabular">${fmtCount(totalMentions)}</div><div class="d">${rangeLabel(m)}</div></div>
        <div class="kpi"><div class="head"><div class="k">AI vendors</div></div><div class="v tabular">${fmtCount(uniqueCrawlers)}</div><div class="d">Companies seen</div></div>
        <div class="kpi"><div class="head"><div class="k">Most active</div></div><div class="v tabular" style="font-size:28px">${esc(topCrawler)}</div><div class="d">Top vendor</div></div>
        <div class="kpi"><div class="head"><div class="k">Last visit</div></div><div class="v tabular" style="font-size:28px">${esc(lastSeen)}</div><div class="d">Most recent hit</div></div>
      </div>

      <div class="row">
        <div class="card-dash" data-bots-traffic-card>
          <div class="card-head"><div><h3>Daily bot traffic</h3><div class="sub">${days}-day rolling view</div></div></div>
          <div class="chart">${bars}</div>
          <div class="chart-labels">${labels}</div>
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>By AI vendor</h3><div class="sub">Share of visits, ${rangeLabel(m).toLowerCase()}</div></div></div>
          ${crawlerBars}
        </div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>Recent bot visits</h3><div class="sub">Every AI crawler hit, oldest → newest</div></div>
            <a href="/Mentions.html" class="btn btn-ghost btn-sm">See as mentions →</a>
          </div>
          <table class="tbl">
            <thead><tr><th>When</th><th>AI tool</th><th>They were asked</th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ── ECharts area-line upgrade for the daily bot traffic card ───────────
  // Same pattern as the Overview's AI bot traffic card — replace the
  // legacy CSS-bars rendering with a smooth area-line chart once
  // ECharts has finished loading from CDN. Falls through silently if
  // ECharts never loads (legacy bars stay rendered).
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
    });
  }

  function afterMount(metrics) {
    pollEcharts(() => {
      bootMaroonTheme();
      upgradeDailyBotTrafficChart(metrics);
    });
  }
  function upgradeDailyBotTrafficChart(metrics) {
    const card = document.querySelector('.card-dash[data-bots-traffic-card]');
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

  window.AMCP_BOTS = { demo: () => DEMO, fetch: fetchReal, render, afterMount };

  // Re-fetch + re-render when the topbar's date-range selector changes.
  // Mirrors the amcp:location-changed pattern in overview.js — the shell
  // owns the fetch+render pipeline; we just nudge it to refresh.
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
