/* v2 Bot Traffic page — deeper view into /api/client/metrics than the
 * Overview's summary card. Shares the same metrics payload so no extra
 * endpoint is needed. */
(function () {
  'use strict';

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
    const r = await af('/api/client/metrics');
    return (r.ok ? await r.json() : {}) || {};
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
    days = days || 14;
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
    const crawlerEntries = Object.entries(by).sort((a, b) => b[1] - a[1]);
    const totalMentions = crawlerEntries.reduce((s, [, n]) => s + n, 0);
    const topCrawler = crawlerEntries[0] ? crawlerEntries[0][0] : '—';
    const uniqueCrawlers = crawlerEntries.length;
    const recent = (m.recent_queries || []).slice(0, 20);
    const lastSeen = recent[0] ? timeAgo(recent[0].timestamp) : '—';

    const series = dailySeries(m);
    const chartMax = Math.max(1, ...series.map(s => s.count));
    const bars = series.map(s => {
      const pct = Math.max(4, (s.count / chartMax) * 100);
      return `<div class="bar" data-v="${s.count} visits" style="height:${pct}%"></div>`;
    }).join('');
    const labels = series.map(s => `<span>${s.label}</span>`).join('');

    const crawlerBars = crawlerEntries.length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">No crawler traffic yet.</div>`
      : crawlerEntries.map(([name, n]) => {
          const pct = totalMentions ? Math.round((n / totalMentions) * 100) : 0;
          return `<div class="bot-row">
            <span class="name">${esc(name)}</span>
            <div class="track"><div class="fill" style="width:${pct}%"></div></div>
            <span class="n">${fmtCount(n)}</span>
          </div>`;
        }).join('');

    const recentRows = recent.length === 0
      ? `<tr><td colspan="3" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No bot visits in the last 30 days.</td></tr>`
      : recent.map(q => `<tr>
          <td class="t">${esc(timeAgo(q.timestamp))}</td>
          <td><span class="bot-tag">${esc(q.crawler_agent || 'unknown')}</span></td>
          <td><span class="q">${esc(q.query_text || '')}</span></td>
        </tr>`).join('');

    return `
      <div class="kpis">
        <div class="kpi"><div class="head"><div class="k">Total visits</div></div><div class="v tabular">${fmtCount(totalMentions)}</div><div class="d">Last 30 days</div></div>
        <div class="kpi"><div class="head"><div class="k">Unique crawlers</div></div><div class="v tabular">${fmtCount(uniqueCrawlers)}</div><div class="d">AI tools seen</div></div>
        <div class="kpi"><div class="head"><div class="k">Most active</div></div><div class="v tabular" style="font-size:28px">${esc(topCrawler)}</div><div class="d">Top source</div></div>
        <div class="kpi"><div class="head"><div class="k">Last visit</div></div><div class="v tabular" style="font-size:28px">${esc(lastSeen)}</div><div class="d">Most recent hit</div></div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>Daily bot traffic</h3><div class="sub">14-day rolling view</div></div></div>
          <div class="chart">${bars}</div>
          <div class="chart-labels">${labels}</div>
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>By AI tool</h3><div class="sub">Share of visits, last 30 days</div></div></div>
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

  window.AMCP_BOTS = { demo: () => DEMO, fetch: fetchReal, render };
})();
