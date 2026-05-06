/* v2 Click-throughs page — uses /api/client/clicks for the raw click
 * events and /api/client/metrics for the rollup counts. */
(function () {

  // Same bot-family + brand-color logic as the Overview / Bot traffic
  // pages — group GPTBot / GPTBot-1.0 / ChatGPT / ChatGPT-User / OAI-
  // SearchBot onto one OpenAI slice instead of fragmenting the donut.
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
  'use strict';

  const DEMO = {
    metrics: {
      total_queries: 847,
      referral_clicks: 189,
      referral_clicks_last_30_days: 189,
    },
    clicks: [
      { id: 1, ref: 'PerplexityBot',  user_agent: 'PerplexityBot/1.0', timestamp: new Date(Date.now() -  8 * 60000).toISOString() },
      { id: 2, ref: 'ChatGPT-User',   user_agent: 'ChatGPT-User/1.1',  timestamp: new Date(Date.now() - 19 * 60000).toISOString() },
      { id: 3, ref: 'ClaudeBot',      user_agent: 'ClaudeBot/1.0',     timestamp: new Date(Date.now() - 34 * 60000).toISOString() },
      { id: 4, ref: 'Google-Extended', user_agent: 'Google-Extended',  timestamp: new Date(Date.now() - 56 * 60000).toISOString() },
      { id: 5, ref: 'PerplexityBot',  user_agent: 'PerplexityBot/1.0', timestamp: new Date(Date.now() - 2 * 3600 * 1000).toISOString() },
      { id: 6, ref: 'ChatGPT-User',   user_agent: 'ChatGPT-User/1.1',  timestamp: new Date(Date.now() - 3 * 3600 * 1000).toISOString() },
    ],
  };

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    // Honor the topbar's date-range selector. wireDateRange in
    // dashboard-chrome.js sets window.AMCP_DATE_RANGE; fall back to 30d.
    const range = (window.AMCP_DATE_RANGE && window.AMCP_DATE_RANGE.get && window.AMCP_DATE_RANGE.get()) || '30d';
    const rangeQ = `?range=${encodeURIComponent(range)}`;
    const [m, c] = await Promise.all([
      af(`/api/client/metrics${rangeQ}`).then(r => r.ok ? r.json() : null).catch(() => null),
      af(`/api/client/clicks${rangeQ}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return {
      metrics: m || {},
      clicks:  (c && Array.isArray(c.clicks)) ? c.clicks : (Array.isArray(c) ? c : []),
    };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtCount(v) { return v == null || isNaN(v) ? '—' : Number(v).toLocaleString(); }
  function fmtPct(v)   { return v == null || isNaN(v) ? '—' : Math.round(v * 100) + '%'; }
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

  function refBucketName(ref, ua) {
    const src = (ref || '') + ' ' + (ua || '');
    if (/perplex/i.test(src))  return 'Perplexity';
    if (/chatgpt|openai|gpt/i.test(src))  return 'ChatGPT';
    if (/claude|anthropic/i.test(src))    return 'Claude';
    if (/gemini|google-extended|googlebot/i.test(src)) return 'Gemini / Google';
    if (/meta/i.test(src))     return 'Meta AI';
    if (/copilot|bing/i.test(src)) return 'Copilot';
    return ref || 'Other';
  }

  function render(data) {
    const d = data || {};
    const m = d.metrics || {};
    const clicks = d.clicks || [];

    const total    = m.referral_clicks || clicks.length;
    const month    = m.referral_clicks_last_30_days != null ? m.referral_clicks_last_30_days : clicks.length;
    const queries  = m.total_queries || null;
    const ctr      = (queries && total) ? (total / queries) : null;

    // Break clicks down by AI vendor (family-grouped). Mirrors the
    // Overview / Bot traffic donut treatment so the dashboard speaks
    // one visual language across pages.
    const byFamily = Object.create(null);
    clicks.forEach(c => {
      const raw = refBucketName(c.ref, c.user_agent);
      const fam = botFamily(raw);
      byFamily[fam] = (byFamily[fam] || 0) + 1;
    });
    const srcEntries = Object.entries(byFamily).sort((a, b) => b[1] - a[1]);
    const srcTotal = srcEntries.reduce((s, [, n]) => s + n, 0);
    const srcDonutMount = srcEntries.length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">No clicks yet.</div>`
      : `<div data-clicks-source-donut style="width:100%;height:280px;margin-top:8px"></div>`;

    const rows = clicks.length === 0
      ? `<tr><td colspan="3" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No click-throughs yet. AI-cited visitors will appear here.</td></tr>`
      : clicks.slice(0, 25).map(c => `<tr>
          <td class="t">${esc(timeAgo(c.timestamp))}</td>
          <td><span class="bot-tag">${esc(refBucketName(c.ref, c.user_agent))}</span></td>
          <td style="font-family:var(--mono);font-size:12.5px;color:var(--muted)">${esc(c.user_agent || c.ref || '')}</td>
        </tr>`).join('');

    return `
      <div class="plain-banner">
        <strong>In plain English:</strong>
        Every tracked link AI handed to a user — and whether they actually clicked it. Higher is better.
      </div>

      <div class="kpis">
        <div class="kpi"><div class="head"><div class="k">Total click-throughs</div></div><div class="v tabular">${fmtCount(total)}</div><div class="d">All time</div></div>
        <div class="kpi"><div class="head"><div class="k">This period</div></div><div class="v tabular">${fmtCount(month)}</div><div class="d">${(m.date_range && m.date_range.days) ? `Last ${m.date_range.days} days` : 'Last 30 days'}</div></div>
        <div class="kpi"><div class="head"><div class="k">Click-through rate</div></div><div class="v tabular">${fmtPct(ctr)}</div><div class="d">Clicks ÷ mentions</div></div>
        <div class="kpi"><div class="head"><div class="k">Top source</div></div><div class="v tabular" style="font-size:28px">${esc(srcEntries[0] ? srcEntries[0][0] : '—')}</div><div class="d">Most clicks</div></div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>By AI vendor</h3><div class="sub">Which assistants sent the most visitors</div></div></div>
          ${srcDonutMount}
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>How we count</h3><div class="sub">What makes a click "tracked"</div></div></div>
          <p style="font-size:13.5px;line-height:1.65;color:var(--ink-2)">Every link Advocate hands to an AI crawler is an HMAC-signed <code style="background:var(--paper-2);padding:1px 4px;border-radius:3px;font-size:12px">/track?t=…</code> redirect. When the user actually clicks it, the Worker decodes the token, logs the click to D1, then 302s to your real page.</p>
          <p style="font-size:13.5px;line-height:1.65;color:var(--ink-2);margin-top:8px">Bot UAs are excluded from the click count — if a crawler follows its own link we skip it, so this number is human engagement only.</p>
        </div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>Recent click-throughs</h3><div class="sub">Last ${fmtCount(Math.min(25, clicks.length))} tracked clicks</div></div>
            <a href="/Mentions.html" class="btn btn-ghost btn-sm">See source mentions →</a>
          </div>
          <table class="tbl">
            <thead><tr><th>When</th><th>Source</th><th>User agent</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ── ECharts donut for "By AI vendor" — same shape as the bot traffic
//    donut, family-grouped, brand-colored, legend below. ──────────────
function pollEcharts(cb, attempts) {
  attempts = attempts || 0;
  if (window.echarts) { cb(); return; }
  if (attempts > 50) return;
  setTimeout(() => pollEcharts(cb, attempts + 1), 100);
}
function bootMaroonTheme() {
  if (!window.echarts) return;
  const root = getComputedStyle(document.documentElement);
  window.echarts.registerTheme('advocate-maroon', {
    backgroundColor: 'transparent',
    textStyle: { color: (root.getPropertyValue('--ink') || '#141210').trim(), fontFamily: 'inherit' },
    tooltip: { backgroundColor: 'rgba(20,18,16,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 } },
  });
}
function afterMount(data) {
  pollEcharts(() => {
    bootMaroonTheme();
    const host = document.querySelector('[data-clicks-source-donut]');
    if (!host) return;
    const d = data || {};
    const clicks = d.clicks || [];
    const byFamily = Object.create(null);
    clicks.forEach(c => {
      const fam = botFamily(refBucketName(c.ref, c.user_agent));
      byFamily[fam] = (byFamily[fam] || 0) + 1;
    });
    const entries = Object.entries(byFamily)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({
        name,
        value,
        itemStyle: { color: BOT_FAMILY_COLOR[name] || BOT_FAMILY_COLOR.Other },
      }));
    if (!entries.length) return;
    const total = entries.reduce((s, e) => s + e.value, 0) || 1;
    const inst = window.echarts.init(host, 'advocate-maroon');
    inst.setOption({
      tooltip: {
        trigger: 'item',
        formatter: (p) => `<b>${p.name}</b><br>${p.value.toLocaleString()} clicks · ${((p.value/total)*100).toFixed(1)}%`,
      },
      legend: { type: 'scroll', orient: 'horizontal', bottom: 0, left: 'center', itemWidth: 10, itemHeight: 10, itemGap: 14, textStyle: { color: 'var(--muted)' } },
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

window.AMCP_CLICKS = { demo: () => DEMO, fetch: fetchReal, render, afterMount };

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
