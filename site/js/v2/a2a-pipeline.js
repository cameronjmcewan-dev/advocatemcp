/* v2 A2A Pipeline — the reservations+handoffs funnel that replaces Max's
 * original "Revenue" page (we don't track dollar attribution yet, but we
 * do track the transaction funnel: agent call → reservation held →
 * confirmed → handoff delivered).
 *
 * This is the single most load-bearing real-data page for differentiation
 * vs. Profound/Scrunch. */
(function () {
  'use strict';

  const DEMO = {
    metrics: { business_name: 'Preview Business' },
    activity: {
      reservations: [
        { id: 'r_a1', status: 'confirmed', created_at: new Date(Date.now() -   5 * 60000).toISOString(), service: 'Same-day bouquet' },
        { id: 'r_a2', status: 'confirmed', created_at: new Date(Date.now() - 2.5 * 3600000).toISOString(), service: 'Corporate order' },
        { id: 'r_a3', status: 'held',      created_at: new Date(Date.now() -   5 * 3600000).toISOString(), service: 'Wedding consult' },
        { id: 'r_a4', status: 'confirmed', created_at: new Date(Date.now() -  26 * 3600000).toISOString(), service: 'Anniversary bouquet' },
        { id: 'r_a5', status: 'expired',   created_at: new Date(Date.now() -  48 * 3600000).toISOString(), service: 'Sympathy piece' },
        { id: 'r_a6', status: 'confirmed', created_at: new Date(Date.now() -  72 * 3600000).toISOString(), service: 'Subscription renewal' },
      ],
      handoffs: [
        { id: 'h_b1', delivered_via: 'sms',   created_at: new Date(Date.now() -  8 * 60000).toISOString() },
        { id: 'h_b2', delivered_via: 'email', created_at: new Date(Date.now() -  3 * 3600000).toISOString() },
        { id: 'h_b3', delivered_via: 'sms',   created_at: new Date(Date.now() - 28 * 3600000).toISOString() },
        { id: 'h_b4', delivered_via: null,    created_at: new Date(Date.now() - 50 * 3600000).toISOString() },  // undelivered
      ],
      agent_requests: [
        { tool_called: 'query_business_agent', created_at: new Date(Date.now() -  3 * 60000).toISOString(),   agent_id: 'claude-desktop/1.0' },
        { tool_called: 'reserve_slot',         created_at: new Date(Date.now() -  6 * 60000).toISOString(),   agent_id: 'claude-desktop/1.0' },
        { tool_called: 'get_quote',            created_at: new Date(Date.now() - 15 * 60000).toISOString(),   agent_id: 'cursor/0.42' },
        { tool_called: 'initiate_handoff',     created_at: new Date(Date.now() -  8 * 60000).toISOString(),   agent_id: 'claude-desktop/1.0' },
        { tool_called: 'query_business_agent', created_at: new Date(Date.now() - 150 * 60000).toISOString(), agent_id: 'chatgpt-actions/1.0' },
        { tool_called: 'get_availability',     created_at: new Date(Date.now() - 220 * 60000).toISOString(), agent_id: 'cursor/0.42' },
        { tool_called: 'query_business_agent', created_at: new Date(Date.now() - 5 * 3600000).toISOString(), agent_id: 'claude-desktop/1.0' },
        { tool_called: 'query_business_agent', created_at: new Date(Date.now() - 27 * 3600000).toISOString(),agent_id: 'cursor/0.42' },
      ],
      agent_reputation: [
        { agent_id: 'claude-desktop/1.0',  window: '7d', request_count: 58, quality: 0.82, tier: 'trusted' },
        { agent_id: 'cursor/0.42',         window: '7d', request_count: 14, quality: 0.64, tier: 'known' },
        { agent_id: 'chatgpt-actions/1.0', window: '7d', request_count: 6,  quality: 0.40, tier: 'unverified' },
      ],
    },
  };

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    const [m, a] = await Promise.all([
      af('/api/client/metrics').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/activity-detail').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return { metrics: m || {}, activity: a || { reservations: [], handoffs: [], agent_requests: [], agent_reputation: [] } };
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

  function tierChip(tier) {
    const cls = tier === 'trusted' ? 'sage'
              : tier === 'known'   ? 'amber'
              : 'maroon';
    return `<span class="chip ${cls}">${esc(tier || 'unverified')}</span>`;
  }

  function render(data) {
    const a = (data && data.activity) || {};
    const reservations = a.reservations || [];
    const handoffs     = a.handoffs || [];
    const agentReqs    = a.agent_requests || [];
    const reputation   = a.agent_reputation || [];

    const agentCalls = agentReqs.length;
    const held       = reservations.filter(r => r.status === 'held').length;
    const confirmed  = reservations.filter(r => r.status === 'confirmed').length;
    const expired    = reservations.filter(r => r.status === 'expired').length;
    const totalReservations = held + confirmed + expired;
    const handoffDelivered  = handoffs.filter(h => h.delivered_via).length;
    const handoffUndelivered = handoffs.filter(h => !h.delivered_via).length;

    const uniqueAgents = new Set(agentReqs.map(r => r.agent_id).filter(Boolean)).size;
    const confirmRate  = totalReservations ? (confirmed / totalReservations) : null;

    // Funnel stages
    const stages = [
      { label: 'Agent calls',           value: agentCalls,       hint: 'Total MCP tool invocations' },
      { label: 'Reservations held',     value: held + confirmed, hint: 'reserve_slot succeeded' },
      { label: 'Reservations confirmed',value: confirmed,        hint: '/a2a/confirm hit' },
      { label: 'Handoffs delivered',    value: handoffDelivered, hint: 'SMS or email reached a human' },
    ];
    const funnelMax = Math.max(1, ...stages.map(s => s.value));

    const funnelHtml = stages.map((s, i) => {
      const pct = Math.max(6, (s.value / funnelMax) * 100);
      // Drop-off vs previous stage
      const prev = i > 0 ? stages[i - 1].value : null;
      const drop = prev != null && prev > 0 ? Math.round((1 - s.value / prev) * 100) : null;
      const dropLabel = drop != null
        ? (drop > 0 ? `<span style="color:var(--muted);font-size:11px;margin-left:8px">${drop}% drop from previous</span>` : '')
        : '';
      return `<div class="funnel-row">
        <div class="funnel-label">
          <strong>${esc(s.label)}</strong>
          <span class="sub" style="font-size:12.5px;color:var(--muted);display:block;margin-top:2px">${esc(s.hint)}</span>
        </div>
        <div class="funnel-bar">
          <div class="funnel-fill" style="width:${pct}%">
            <span class="funnel-value">${fmtCount(s.value)}</span>
          </div>
        </div>
        <div class="funnel-drop">${dropLabel}</div>
      </div>`;
    }).join('');

    // Reputation table
    const repRows = reputation.length === 0
      ? `<tr><td colspan="4" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No identified agents yet. Agents announce themselves via the x-agent-identity header.</td></tr>`
      : reputation
          .slice()
          .sort((a, b) => (b.request_count || 0) - (a.request_count || 0))
          .slice(0, 12)
          .map(r => `<tr>
            <td><span style="font-family:var(--mono);font-size:12.5px">${esc(r.agent_id || '')}</span></td>
            <td class="t">${fmtCount(r.request_count)}</td>
            <td class="t">${fmtPct(r.quality)}</td>
            <td>${tierChip(r.tier)}</td>
          </tr>`).join('');

    // Recent transactions (reservations + handoffs merged)
    const txEvents = [];
    reservations.forEach(r => txEvents.push({ ts: new Date(r.created_at).getTime(), kind: 'Reservation', detail: esc(r.service || ''), status: r.status }));
    handoffs.forEach(h => txEvents.push({ ts: new Date(h.created_at).getTime(), kind: 'Handoff', detail: h.delivered_via ? `delivered via ${esc(h.delivered_via)}` : 'not delivered', status: h.delivered_via ? 'delivered' : 'failed' }));
    txEvents.sort((x, y) => y.ts - x.ts);
    const txRows = txEvents.length === 0
      ? `<tr><td colspan="4" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No transactions yet. These appear once agents invoke reserve_slot or initiate_handoff.</td></tr>`
      : txEvents.slice(0, 12).map(e => `<tr>
          <td class="t">${esc(timeAgo(e.ts))}</td>
          <td><strong>${esc(e.kind)}</strong></td>
          <td>${e.detail}</td>
          <td>${
            e.status === 'confirmed' || e.status === 'delivered' ? `<span class="st cited">✓ ${esc(e.status)}</span>` :
            e.status === 'held'                                   ? `<span class="st clicked">⏳ held</span>` :
            `<span class="st" style="color:var(--muted)">${esc(e.status)}</span>`
          }</td>
        </tr>`).join('');

    return `
      <div class="plain-banner">
        <strong>In plain English:</strong>
        This is where AI assistants turn into actual bookings. Every MCP tool call, every held reservation, every handoff delivered.
      </div>

      <div class="kpis">
        <div class="kpi"><div class="head"><div class="k">Agent calls</div></div><div class="v tabular">${fmtCount(agentCalls)}</div><div class="d">MCP tool invocations</div></div>
        <div class="kpi"><div class="head"><div class="k">Reservations</div></div><div class="v tabular">${fmtCount(totalReservations)}</div><div class="d">${fmtCount(held)} held · ${fmtCount(confirmed)} confirmed</div></div>
        <div class="kpi"><div class="head"><div class="k">Confirm rate</div></div><div class="v tabular">${fmtPct(confirmRate)}</div><div class="d">Held → confirmed</div></div>
        <div class="kpi"><div class="head"><div class="k">Unique agents</div></div><div class="v tabular">${fmtCount(uniqueAgents)}</div><div class="d">Distinct agent_ids</div></div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>Conversion funnel</h3><div class="sub">From first agent call to delivered handoff</div></div>
          </div>
          <div class="funnel">${funnelHtml}</div>
        </div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>Connected agents</h3><div class="sub">Which AI agents are actually using your tools</div></div>
          </div>
          <table class="tbl">
            <thead><tr><th>Agent</th><th>Calls (7d)</th><th>Quality</th><th>Tier</th></tr></thead>
            <tbody>${repRows}</tbody>
          </table>
        </div>
        <div class="card-dash">
          <div class="card-head">
            <div><h3>How this funnel works</h3><div class="sub">A2A tool chain</div></div>
          </div>
          <ol style="font-size:13.5px;line-height:1.7;color:var(--ink-2);padding-left:22px;margin:8px 0">
            <li><strong>Agent calls</strong> your MCP server (<code>query_business_agent</code>, <code>get_availability</code>, <code>get_quote</code>).</li>
            <li>If the agent calls <strong><code>reserve_slot</code></strong>, a 15-minute hold lands in the reservations table.</li>
            <li>Customer (or the agent on their behalf) hits <strong><code>/a2a/confirm</code></strong>, flipping the hold to confirmed.</li>
            <li>Agent calls <strong><code>initiate_handoff</code></strong> to notify a human via SMS/email through your configured lead routing.</li>
          </ol>
          <p style="font-size:12.5px;color:var(--muted);margin-top:12px;">Each drop-off percentage above tells you where the flow loses momentum — that's where to iterate.</p>
        </div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>Recent transactions</h3><div class="sub">Reservations and handoffs, newest first</div></div>
            <a href="/ActivityFeed.html" class="btn btn-ghost btn-sm">Full feed →</a>
          </div>
          <table class="tbl">
            <thead><tr><th>When</th><th>Kind</th><th>Detail</th><th>Status</th></tr></thead>
            <tbody>${txRows}</tbody>
          </table>
        </div>
      </div>

      <style>
        .funnel { display: flex; flex-direction: column; gap: 14px; margin-top: 12px; }
        .funnel-row {
          display: grid; grid-template-columns: 240px 1fr 180px; gap: 16px; align-items: center;
        }
        @media (max-width: 820px) {
          .funnel-row { grid-template-columns: 1fr; gap: 4px; }
          .funnel-drop { margin-left: 0; }
        }
        .funnel-label strong { font-size: 14px; color: var(--ink); }
        .funnel-bar {
          background: var(--paper-2); border: 1px solid var(--line); border-radius: 8px;
          height: 36px; position: relative; overflow: hidden;
        }
        .funnel-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--maroon), var(--maroon-2));
          display: flex; align-items: center; justify-content: flex-end; padding: 0 12px;
          min-width: 44px; border-radius: 8px 0 0 8px;
          transition: width .6s cubic-bezier(.2,.8,.2,1);
        }
        .funnel-value { color: #fff; font-weight: 600; font-size: 13.5px; font-variant-numeric: tabular-nums; }
        .funnel-drop { color: var(--muted); font-size: 12.5px; }
      </style>
    `;
  }

  window.AMCP_A2A = { demo: () => DEMO, fetch: fetchReal, render };
})();
