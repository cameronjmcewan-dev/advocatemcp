/* v2 Activity Feed — unified timeline of reservations, handoffs, MCP
 * agent calls, and bot hits. Sources:
 *   /api/client/activity-detail.{reservations,handoffs,agent_requests}
 *   /api/client/metrics.recent_queries   (bot hits)
 *
 * Renders one chronological stream grouped by day, with colored dots
 * distinguishing event types. No revenue / dollar fields surface because
 * we don't track attribution yet. */
(function () {
  'use strict';

  const DEMO = {
    metrics: {
      business_name: 'Preview Business',
      recent_queries: [
        { timestamp: Date.now() -  4 * 60 * 1000, crawler_agent: 'Perplexity', query_text: 'best florist in south austin' },
        { timestamp: Date.now() - 17 * 60 * 1000, crawler_agent: 'ChatGPT',    query_text: 'same day delivery flowers austin' },
        { timestamp: Date.now() - 41 * 60 * 1000, crawler_agent: 'Claude',     query_text: 'florist open sunday with online ordering' },
        { timestamp: Date.now() -  6 * 3600 * 1000, crawler_agent: 'Gemini', query_text: 'sympathy arrangements austin' },
        { timestamp: Date.now() - 26 * 3600 * 1000, crawler_agent: 'Perplexity', query_text: 'austin florist takes corporate orders' },
      ],
    },
    activity: {
      reservations: [
        { id: 'r_abc', status: 'confirmed', created_at: new Date(Date.now() - 5   * 60000).toISOString(), service: 'Same-day bouquet' },
        { id: 'r_def', status: 'confirmed', created_at: new Date(Date.now() - 2.5 * 3600000).toISOString(), service: 'Corporate order' },
        { id: 'r_ghi', status: 'held',      created_at: new Date(Date.now() - 5   * 3600000).toISOString(), service: 'Wedding consult' },
        { id: 'r_jkl', status: 'confirmed', created_at: new Date(Date.now() - 26  * 3600000).toISOString(), service: 'Anniversary bouquet' },
      ],
      handoffs: [
        { id: 'h_mno', delivered_via: 'sms',   created_at: new Date(Date.now() - 8   * 60000).toISOString() },
        { id: 'h_pqr', delivered_via: 'email', created_at: new Date(Date.now() - 3   * 3600000).toISOString() },
        { id: 'h_stu', delivered_via: 'sms',   created_at: new Date(Date.now() - 28  * 3600000).toISOString() },
      ],
      agent_requests: [
        { tool_called: 'query_business_agent', created_at: new Date(Date.now() - 3   * 60000).toISOString(), agent_id: 'claude-desktop/1.0' },
        { tool_called: 'reserve_slot',         created_at: new Date(Date.now() - 6   * 60000).toISOString(), agent_id: 'claude-desktop/1.0' },
        { tool_called: 'get_quote',            created_at: new Date(Date.now() - 15  * 60000).toISOString(), agent_id: 'cursor/0.42' },
        { tool_called: 'initiate_handoff',     created_at: new Date(Date.now() - 8   * 60000).toISOString(), agent_id: 'claude-desktop/1.0' },
        { tool_called: 'query_business_agent', created_at: new Date(Date.now() - 2.5 * 3600000).toISOString(), agent_id: 'chatgpt-actions/1.0' },
        { tool_called: 'get_availability',    created_at: new Date(Date.now() - 27  * 3600000).toISOString(), agent_id: 'cursor/0.42' },
      ],
    },
  };

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    // AdvocateChrome.getRange() resolves URL → localStorage → '30d' and
    // is available before fetchReal runs. window.AMCP_DATE_RANGE isn't
    // (it's created inside chrome.mount() which runs after fetch).
    const range = (window.AdvocateChrome && window.AdvocateChrome.getRange) ? window.AdvocateChrome.getRange() : '30d';
    const rangeQ = `?range=${encodeURIComponent(range)}`;
    const [m, a] = await Promise.all([
      af(`/api/client/metrics${rangeQ}`).then(r => r.ok ? r.json() : null).catch(() => null),
      af(`/api/client/activity-detail${rangeQ}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return { metrics: m || {}, activity: a || { reservations: [], handoffs: [], agent_requests: [] } };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtCount(v) { return v == null || isNaN(v) ? '—' : Number(v).toLocaleString(); }
  function timeOfDay(iso) {
    if (!iso) return '';
    const t = typeof iso === 'number' ? new Date(iso) : new Date(iso);
    if (isNaN(t.getTime())) return '';
    return t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function dayHeading(date) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const diffDays = Math.round((now.getTime() - d.getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7)   return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const KINDS = {
    reservation: { color: 'var(--maroon)',   label: 'Reservation' },
    handoff:     { color: 'var(--sage)',     label: 'Handoff' },
    agent:       { color: 'var(--amber)',    label: 'Agent call' },
    bot:         { color: 'var(--line-2)',   label: 'Bot mention' },
  };

  /* Merge all source arrays into one time-sorted event stream. */
  function buildEvents(data) {
    const out = [];
    const m = data.metrics || {};
    const a = data.activity || {};

    (a.reservations || []).forEach(r => {
      const ts = new Date(r.created_at).getTime();
      if (isNaN(ts)) return;
      out.push({
        ts, kind: 'reservation',
        label: `Reservation ${esc(r.status || 'new')}`,
        detail: r.service ? esc(r.service) : '',
      });
    });
    (a.handoffs || []).forEach(h => {
      const ts = new Date(h.created_at).getTime();
      if (isNaN(ts)) return;
      out.push({
        ts, kind: 'handoff',
        label: h.delivered_via
          ? `Handoff delivered via ${esc(h.delivered_via)}`
          : `Handoff routed`,
        detail: '',
      });
    });
    (a.agent_requests || []).forEach(ag => {
      const ts = new Date(ag.created_at).getTime();
      if (isNaN(ts)) return;
      out.push({
        ts, kind: 'agent',
        label: `Agent call · ${esc(ag.tool_called || 'tool')}`,
        detail: ag.agent_id ? `<span style="font-family:var(--mono);font-size:11.5px">${esc(ag.agent_id)}</span>` : '',
      });
    });
    (m.recent_queries || []).forEach(q => {
      const ts = typeof q.timestamp === 'number' ? q.timestamp : new Date(q.timestamp).getTime();
      if (isNaN(ts)) return;
      out.push({
        ts, kind: 'bot',
        label: `${esc(q.crawler_agent || 'Bot')} mention`,
        detail: q.query_text ? `<span style="font-style:italic">"${esc(q.query_text)}"</span>` : '',
      });
    });

    out.sort((x, y) => y.ts - x.ts);
    return out;
  }

  function render(data) {
    const events = buildEvents(data || {});
    const reservations  = ((data && data.activity && data.activity.reservations) || []).filter(r => r.status === 'held' || r.status === 'confirmed').length;
    const handoffs      = ((data && data.activity && data.activity.handoffs) || []).filter(h => h.delivered_via).length;
    const agentCalls    = ((data && data.activity && data.activity.agent_requests) || []).length;
    const uniqueAgents  = new Set(
      ((data && data.activity && data.activity.agent_requests) || [])
        .map(a => a.agent_id)
        .filter(Boolean)
    ).size;

    // Group by day
    const groups = [];
    let currentKey = null, currentGroup = null;
    events.forEach(e => {
      const d = new Date(e.ts); d.setHours(0, 0, 0, 0);
      const key = d.getTime();
      if (key !== currentKey) {
        currentKey = key;
        currentGroup = { label: dayHeading(e.ts), events: [] };
        groups.push(currentGroup);
      }
      currentGroup.events.push(e);
    });

    const feed = groups.length === 0
      ? `<div style="padding:28px 0;color:var(--muted);font-size:14px;text-align:center">No activity yet. As bots visit and agents call your tools, events will stream in here.</div>`
      : groups.map(g => {
          const items = g.events.map(e => {
            const meta = KINDS[e.kind] || KINDS.bot;
            return `<div class="feed-item" style="padding:12px 0;">
              <span class="dot" style="background:${meta.color}"></span>
              <div style="flex:1">
                <div><strong>${e.label}</strong>${e.detail ? ` — ${e.detail}` : ''}</div>
                <div class="t" style="margin-top:3px">${esc(timeOfDay(e.ts))}</div>
              </div>
              <span style="font-size:11px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase">${esc(meta.label)}</span>
            </div>`;
          }).join('');
          return `<div class="activity-day">
            <div class="activity-day-h">${esc(g.label)}</div>
            <div class="activity-day-items">${items}</div>
          </div>`;
        }).join('');

    return `
      <div class="plain-banner">
        <strong>In plain English:</strong>
        Every event across your crawlers, MCP agents, and reservations in one timeline.
      </div>

      <div class="kpis">
        <div class="kpi"><div class="head"><div class="k">Reservations</div></div><div class="v tabular">${fmtCount(reservations)}</div><div class="d">Held or confirmed</div></div>
        <div class="kpi"><div class="head"><div class="k">Handoffs</div></div><div class="v tabular">${fmtCount(handoffs)}</div><div class="d">Successfully delivered</div></div>
        <div class="kpi"><div class="head"><div class="k">Agent calls</div></div><div class="v tabular">${fmtCount(agentCalls)}</div><div class="d">MCP tool invocations</div></div>
        <div class="kpi"><div class="head"><div class="k">Unique agents</div></div><div class="v tabular">${fmtCount(uniqueAgents)}</div><div class="d">Distinct agent_ids seen</div></div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>Everything, in order</h3><div class="sub">All event types, newest first, grouped by day</div></div>
            <span class="chip sage dot-chip"><span class="dot"></span>Live</span>
          </div>
          <div class="activity-legend" style="display:flex;flex-wrap:wrap;gap:14px;margin:12px 0 20px;padding:12px 14px;background:var(--paper-2);border:1px solid var(--line);border-radius:10px;font-size:12.5px;color:var(--ink-2)">
            <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:999px;background:var(--maroon)"></span>Reservation</span>
            <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:999px;background:var(--sage)"></span>Handoff</span>
            <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:999px;background:var(--amber)"></span>Agent call</span>
            <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:999px;background:var(--line-2)"></span>Bot mention</span>
          </div>
          ${feed}
        </div>
      </div>

      <style>
        .activity-day + .activity-day { margin-top: 24px; }
        .activity-day-h {
          font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
          color: var(--muted); font-weight: 500;
          padding-bottom: 8px; margin-bottom: 6px;
          border-bottom: 1px solid var(--line);
        }
        .activity-day-items .feed-item { border-bottom: 1px dashed var(--line); }
        .activity-day-items .feed-item:last-child { border-bottom: 0; }
      </style>
    `;
  }

  window.AMCP_ACTIVITY = { demo: () => DEMO, fetch: fetchReal, render };

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
