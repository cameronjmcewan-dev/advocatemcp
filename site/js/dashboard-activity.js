/* Activity section — reservations, handoffs, agent_requests, agent_reputation,
 * competitor radar polls for the current business.
 * Fetches lazily on first section open via GET /api/client/activity-detail.
 * Registers as window.AMCP_SECTIONS['activity']. */
(function () {
  'use strict';

  var rendered = false;

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTs(ts) {
    if (!ts) return '—';
    try {
      var d = new Date(ts);
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return esc(ts); }
  }

  function statusBadge(status) {
    var cls = 'badge-yellow';
    if (status === 'confirmed') cls = 'badge-green';
    else if (status === 'expired' || status === 'rejected') cls = 'badge-accent';
    else if (status === 'held') cls = 'badge-accent';
    return '<span class="badge ' + cls + '"><span class="badge-dot"></span>' + esc(status) + '</span>';
  }

  function modeBadge(mode) {
    var cls = mode === 'agent' ? 'badge-accent' : 'badge-green';
    return '<span class="badge ' + cls + '"><span class="badge-dot"></span>' + esc(mode) + '</span>';
  }

  function outcomeBadge(outcome) {
    if (!outcome || outcome === 'none') return '<span style="color:var(--muted)">—</span>';
    var cls = 'badge-accent';
    if (outcome === 'reservation_confirmed' || outcome === 'handoff_completed') cls = 'badge-green';
    if (outcome === 'error') cls = 'badge-yellow';
    return '<span class="badge ' + cls + '"><span class="badge-dot"></span>' + esc(outcome) + '</span>';
  }

  function srcBadge(src) {
    return '<span style="font-size:var(--tx-xs);color:var(--muted);font-family:var(--font-mono)">' + esc(src) + '</span>';
  }

  function kpi(id, label, value, hint) {
    return '<div class="kpi-card">' +
      '<div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-val" id="' + id + '">' + (value == null ? 0 : value) + '</div>' +
      '<div class="kpi-hint">' + esc(hint) + '</div></div>';
  }

  function tbl(headers, rows) {
    return '<table><thead><tr>' +
      headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  function render() {
    if (rendered) return;
    rendered = true;

    var slug = (window.AMCP_DATA && window.AMCP_DATA.slug) ||
               new URLSearchParams(window.location.search).get('slug') || '';

    var path = '/api/client/activity-detail' + (slug ? '?slug=' + encodeURIComponent(slug) : '');

    window.AMCP.authedFetch(path)
      .then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.json();
      })
      .then(function (data) {
        renderKpis(data);
        renderTables(data);
      })
      .catch(function (err) {
        var errEl = document.getElementById('activity-error');
        if (errEl) {
          errEl.textContent = 'Could not load activity data: ' + (err && err.message ? err.message : 'unknown error');
          errEl.classList.add('show');
        }
      });
  }

  function renderKpis(data) {
    var t = data.totals || {};
    var r = t.reservations || {};
    var h = t.handoffs || {};
    var ar = t.agent_requests || {};

    var grid = document.getElementById('activity-kpis');
    if (!grid) return;

    grid.innerHTML =
      kpi('kpi-res', 'Reservations', r.total || 0,
        (r.confirmed || 0) + ' confirmed · ' + (r.held || 0) + ' held · ' + (r.expired || 0) + ' expired') +
      kpi('kpi-ho', 'Handoffs', h.total || 0,
        (h.human || 0) + ' human · ' + (h.agent || 0) + ' agent') +
      kpi('kpi-calls', 'Agent Calls', ar.total_calls || 0, 'Identified MCP tool calls') +
      kpi('kpi-agents', 'Unique Agents', ar.unique_agents || 0, 'Distinct agent_id values');
  }

  function renderTables(data) {
    var anyData = false;

    // Reservations
    if (data.reservations && data.reservations.length > 0) {
      anyData = true;
      var resRows = data.reservations.map(function (r) {
        return '<tr>' +
          '<td style="font-family:var(--font-mono);font-size:var(--tx-xs)">' + esc(r.id) + '</td>' +
          '<td>' + statusBadge(r.status) + '</td>' +
          '<td style="font-size:var(--tx-xs)">' + esc(r.agent_id || '—') + '</td>' +
          '<td style="font-size:var(--tx-xs)">' + fmtTs(r.window_start) + ' → ' + fmtTs(r.window_end) + '</td>' +
          '<td style="font-size:var(--tx-xs);color:var(--muted)">' + fmtTs(r.requested_at) + '</td>' +
          '</tr>';
      });
      document.getElementById('activity-reservations').innerHTML =
        tbl(['ID', 'Status', 'Agent', 'Window', 'Requested'], resRows);
      document.getElementById('activity-reservations-wrap').style.display = '';
    }

    // Handoffs
    if (data.handoffs && data.handoffs.length > 0) {
      anyData = true;
      var hoRows = data.handoffs.map(function (h) {
        return '<tr>' +
          '<td style="font-family:var(--font-mono);font-size:var(--tx-xs)">' + esc(h.id) + '</td>' +
          '<td>' + modeBadge(h.mode) + '</td>' +
          '<td style="font-size:var(--tx-xs)">' + esc(h.delivered_via || '—') + '</td>' +
          '<td style="font-size:var(--tx-xs)">' + esc(h.agent_id || '—') + '</td>' +
          '<td style="font-size:var(--tx-xs);color:var(--muted)">' + fmtTs(h.created_at) + '</td>' +
          '</tr>';
      });
      document.getElementById('activity-handoffs').innerHTML =
        tbl(['ID', 'Mode', 'Via', 'Agent', 'Created'], hoRows);
      document.getElementById('activity-handoffs-wrap').style.display = '';
    }

    // Agent requests
    if (data.agent_requests && data.agent_requests.length > 0) {
      anyData = true;
      var agRows = data.agent_requests.map(function (a) {
        return '<tr>' +
          '<td style="font-family:var(--font-mono);font-size:var(--tx-xs)">' + esc(a.tool_called) + '</td>' +
          '<td style="font-size:var(--tx-xs)">' + esc(a.agent_id) + ' ' + srcBadge('(' + a.agent_id_source + ')') + '</td>' +
          '<td>' + outcomeBadge(a.outcome_signal) + '</td>' +
          '<td style="font-size:var(--tx-xs)">' + (a.latency_ms != null ? a.latency_ms + 'ms' : '—') + '</td>' +
          '<td style="font-size:var(--tx-xs)">' + (a.cost_cents != null ? '¢' + a.cost_cents : '—') + '</td>' +
          '<td style="font-size:var(--tx-xs);color:var(--muted)">' + fmtTs(a.timestamp) + '</td>' +
          '</tr>';
      });
      document.getElementById('activity-agents').innerHTML =
        tbl(['Tool', 'Agent', 'Outcome', 'Latency', 'Cost', 'When'], agRows);
      document.getElementById('activity-agents-wrap').style.display = '';
    }

    // Agent reputation
    if (data.agent_reputation && data.agent_reputation.length > 0) {
      anyData = true;
      var repRows = data.agent_reputation.map(function (r) {
        return '<tr>' +
          '<td style="font-family:var(--font-mono);font-size:var(--tx-xs)">' + esc(r.agent_id) + '</td>' +
          '<td><span class="badge badge-accent">' + esc(r.window) + '</span></td>' +
          '<td>' + (r.requests || 0) + '</td>' +
          '<td>' + (r.reservations_confirmed || 0) + '</td>' +
          '<td>' + ((r.conversion_rate || 0) * 100).toFixed(1) + '%</td>' +
          '<td>' + ((r.quality_score || 0) * 100).toFixed(0) + '</td>' +
          '</tr>';
      });
      document.getElementById('activity-reputation').innerHTML =
        tbl(['Agent', 'Window', 'Requests', 'Confirmed', 'Conv. rate', 'Quality'], repRows);
      document.getElementById('activity-reputation-wrap').style.display = '';
    }

    // Competitor radar
    if (data.competitor_polls && data.competitor_polls.length > 0) {
      anyData = true;
      var pollRows = data.competitor_polls.map(function (p) {
        var cited = p.tenant_cited ? '✓' : (p.citation_found ? '—' : 'no result');
        var cls = p.tenant_cited ? 'color:var(--green);font-weight:600' : 'color:var(--muted)';
        return '<tr>' +
          '<td style="font-size:var(--tx-sm)">' + esc(p.query_phrasing) + '</td>' +
          '<td style="' + cls + '">' + esc(cited) + '</td>' +
          '<td style="font-size:var(--tx-xs);color:var(--muted)">' + fmtTs(p.polled_at) + '</td>' +
          '</tr>';
      });
      document.getElementById('activity-radar').innerHTML =
        tbl(['Query', 'Cited?', 'Polled'], pollRows);
      document.getElementById('activity-radar-wrap').style.display = '';
    }

    if (!anyData) {
      document.getElementById('activity-empty').style.display = '';
    }
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['activity'] = render;
})();
