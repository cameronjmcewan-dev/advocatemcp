/* Activity section — reservations, handoffs, agent_requests, agent_reputation,
 * competitor radar polls for the current business (single-biz mode) or an
 * aggregate cross-business feed (admin scope=all).
 *
 * D7 polish: opens rich detail drawers on row click for reservations /
 * handoffs / agent calls, renders a reservation funnel bar (held → confirmed
 * → handoff_completed), shows per-row progress rings on agent_reputation, and
 * renders aggregate-mode feed via AMCP_UI.activityRow() with per-business
 * summary cards that include a mini-sparkline.
 *
 * Registers as window.AMCP_SECTIONS['activity']. */
(function () {
  'use strict';

  var rendered = false;
  var abortCtrl = null;
  var cachedPayload = null; // keep single-business payload around so drawers can reopen

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

  // Pretty-printed JSON for drawer bodies — already-escaped via a <pre> wrapper.
  function jsonBlock(label, obj) {
    var body;
    try {
      body = JSON.stringify(obj, null, 2);
    } catch (_) {
      body = String(obj);
    }
    return '<div style="margin-top:12px">' +
      '<div style="font-size:var(--tx-xs);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px">' + esc(label) + '</div>' +
      '<pre style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;font-family:var(--font-mono);font-size:var(--tx-xs);white-space:pre-wrap;word-break:break-word;margin:0">' + esc(body) + '</pre>' +
      '</div>';
  }

  function kvRow(k, v) {
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--border);font-size:var(--tx-sm)">' +
      '<span style="color:var(--muted)">' + esc(k) + '</span>' +
      '<span style="text-align:right;word-break:break-word">' + (v == null ? '<span style="color:var(--muted)">—</span>' : v) + '</span>' +
      '</div>';
  }

  // ── Drawer openers ───────────────────────────────────────────────────────

  function openReservationDrawer(r) {
    var body =
      kvRow('Reservation ID', '<code>' + esc(r.id) + '</code>') +
      kvRow('Status', statusBadge(r.status)) +
      kvRow('Agent', r.agent_id ? '<code>' + esc(r.agent_id) + '</code>' : null) +
      kvRow('Window start', esc(fmtTs(r.window_start))) +
      kvRow('Window end', esc(fmtTs(r.window_end))) +
      kvRow('Requested', esc(fmtTs(r.requested_at))) +
      kvRow('Expires', esc(fmtTs(r.expires_at))) +
      jsonBlock('Full payload', r);
    AMCP_UI.openDrawer('Reservation', body);
  }

  function openHandoffDrawer(h) {
    var body =
      kvRow('Handoff ID', '<code>' + esc(h.id) + '</code>') +
      kvRow('Mode', modeBadge(h.mode)) +
      kvRow('Delivered via', h.delivered_via ? esc(h.delivered_via) : null) +
      kvRow('Reservation ID', h.reservation_id ? '<code>' + esc(h.reservation_id) + '</code>' : null) +
      kvRow('Agent', h.agent_id ? '<code>' + esc(h.agent_id) + '</code>' : null) +
      kvRow('Created', esc(fmtTs(h.created_at))) +
      jsonBlock('Full payload', h);
    AMCP_UI.openDrawer('Handoff', body);
  }

  function openAgentRequestDrawer(a) {
    var body =
      kvRow('Tool', '<code>' + esc(a.tool_called) + '</code>') +
      kvRow('Agent', '<code>' + esc(a.agent_id) + '</code>') +
      kvRow('Identity source', srcBadge(a.agent_id_source || '—')) +
      kvRow('Outcome', outcomeBadge(a.outcome_signal)) +
      kvRow('Latency', a.latency_ms != null ? esc(a.latency_ms + ' ms') : null) +
      kvRow('Cost', a.cost_cents != null ? esc('¢' + a.cost_cents) : null) +
      kvRow('Timestamp', esc(fmtTs(a.timestamp))) +
      jsonBlock('Full request context', a);
    AMCP_UI.openDrawer('Agent request', body);
  }

  // ── Row click wiring (delegated) ─────────────────────────────────────────

  function bindRowClicks() {
    // Reservations
    var resWrap = document.getElementById('activity-reservations-wrap');
    if (resWrap && !resWrap.dataset.bound) {
      resWrap.dataset.bound = '1';
      resWrap.addEventListener('click', function (e) {
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-kind="reservation"]') : null;
        if (!tr || !cachedPayload) return;
        var id = tr.getAttribute('data-id');
        var r = (cachedPayload.reservations || []).find(function (x) { return x.id === id; });
        if (r) openReservationDrawer(r);
      });
      resWrap.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-kind="reservation"]') : null;
        if (!tr || !cachedPayload) return;
        e.preventDefault();
        var id = tr.getAttribute('data-id');
        var r = (cachedPayload.reservations || []).find(function (x) { return x.id === id; });
        if (r) openReservationDrawer(r);
      });
    }

    // Handoffs
    var hoWrap = document.getElementById('activity-handoffs-wrap');
    if (hoWrap && !hoWrap.dataset.bound) {
      hoWrap.dataset.bound = '1';
      hoWrap.addEventListener('click', function (e) {
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-kind="handoff"]') : null;
        if (!tr || !cachedPayload) return;
        var id = tr.getAttribute('data-id');
        var h = (cachedPayload.handoffs || []).find(function (x) { return x.id === id; });
        if (h) openHandoffDrawer(h);
      });
      hoWrap.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-kind="handoff"]') : null;
        if (!tr || !cachedPayload) return;
        e.preventDefault();
        var id = tr.getAttribute('data-id');
        var h = (cachedPayload.handoffs || []).find(function (x) { return x.id === id; });
        if (h) openHandoffDrawer(h);
      });
    }

    // Agent requests (key is composite since there's no server id in the client payload — use index)
    var agWrap = document.getElementById('activity-agents-wrap');
    if (agWrap && !agWrap.dataset.bound) {
      agWrap.dataset.bound = '1';
      agWrap.addEventListener('click', function (e) {
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-kind="agent_request"]') : null;
        if (!tr || !cachedPayload) return;
        var idx = Number(tr.getAttribute('data-idx'));
        var a = (cachedPayload.agent_requests || [])[idx];
        if (a) openAgentRequestDrawer(a);
      });
      agWrap.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-kind="agent_request"]') : null;
        if (!tr || !cachedPayload) return;
        e.preventDefault();
        var idx = Number(tr.getAttribute('data-idx'));
        var a = (cachedPayload.agent_requests || [])[idx];
        if (a) openAgentRequestDrawer(a);
      });
    }
  }

  // ── Reservation funnel ───────────────────────────────────────────────────
  // Inline horizontal bars: held (denominator) → confirmed → handoff_completed.
  // Widths are proportional to held so the reader sees drop-off at a glance.
  function renderFunnel(data) {
    var container = document.getElementById('activity-funnel-wrap');
    if (!container) return;
    var t = (data && data.totals) || {};
    var r = t.reservations || {};
    var h = t.handoffs || {};
    var held       = Number(r.held || 0) + Number(r.confirmed || 0) + Number(r.expired || 0);
    var confirmed  = Number(r.confirmed || 0);
    // Approximate handoff-completed as total handoffs — server-side outcome_signal
    // rollup isn't in the totals envelope yet; agent_requests totals won't carry
    // it either, so we use total handoffs as a reasonable proxy.
    var completed  = Number(h.total || 0);

    if (held === 0 && confirmed === 0 && completed === 0) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';

    var max = Math.max(held, confirmed, completed, 1);
    function bar(label, n, colorVar) {
      var pct = Math.round((n / max) * 100);
      // Minimum 4% so zero-count stages still render a faint track.
      var w = n > 0 ? Math.max(pct, 4) : 0;
      return '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">' +
        '<div style="flex:0 0 160px;font-size:var(--tx-xs);color:var(--muted)">' + esc(label) + '</div>' +
        '<div style="flex:1;height:18px;background:var(--surface-2);border-radius:4px;overflow:hidden">' +
          '<div style="height:100%;width:' + w + '%;background:var(' + colorVar + ');transition:width .4s ease"></div>' +
        '</div>' +
        '<div style="flex:0 0 56px;text-align:right;font-size:var(--tx-sm);font-weight:600">' + esc(String(n)) + '</div>' +
      '</div>';
    }

    container.innerHTML =
      '<div class="db-card">' +
        '<div class="db-card-title">Reservation funnel <span class="db-card-sub">held → confirmed → handoff completed</span></div>' +
        bar('Reservations (any state)', held,      '--accent') +
        bar('Confirmed',                confirmed, '--green')  +
        bar('Handoffs completed',       completed, '--accent-dk') +
      '</div>';
  }

  // ── Aggregate-mode renderer (admin scope=all) ────────────────────────────
  // Mini sparkline buckets — we don't receive per-day counts in the aggregate
  // payload so derive a synthetic 7-slot sparkline from the most recent items'
  // timestamps to give each business row a shape-at-a-glance.
  function syntheticSparkBuckets(items, slots) {
    if (!Array.isArray(items) || items.length === 0) {
      return new Array(slots).fill(0);
    }
    var now = Date.now();
    var span = 7 * 24 * 60 * 60 * 1000; // 7-day window
    var buckets = new Array(slots).fill(0);
    items.forEach(function (it) {
      var ts = it.timestamp || it.requested_at || it.created_at;
      if (!ts) return;
      var t = new Date(ts).getTime();
      if (isNaN(t)) return;
      var age = now - t;
      if (age < 0 || age > span) return;
      var idx = slots - 1 - Math.floor((age / span) * slots);
      if (idx < 0) idx = 0;
      if (idx >= slots) idx = slots - 1;
      buckets[idx]++;
    });
    return buckets;
  }

  function renderAggregate(data) {
    var content = document.getElementById('content');
    if (!content) return;

    // KPI header — 4 aggregate metrics
    var agg = data.aggregate_totals || {};
    var r = agg.reservations || {};
    var h = agg.handoffs || {};
    var ar = agg.agent_requests || {};

    var grid = document.getElementById('activity-kpis');
    if (grid) {
      grid.innerHTML =
        kpi('kpi-res', 'Reservations', r.total || 0,
          (r.confirmed || 0) + ' confirmed · ' + (r.held || 0) + ' held · ' + (r.expired || 0) + ' expired') +
        kpi('kpi-ho', 'Handoffs', h.total || 0,
          (h.human || 0) + ' human · ' + (h.agent || 0) + ' agent') +
        kpi('kpi-calls', 'Agent Calls', ar.total_calls || 0, 'Across all tenants') +
        kpi('kpi-agents', 'Unique Agents', ar.unique_agents || 0, 'Distinct agent_id values');
    }

    // Hide single-biz-only tables / funnel
    ['activity-reservations-wrap', 'activity-handoffs-wrap', 'activity-agents-wrap',
      'activity-reputation-wrap', 'activity-radar-wrap', 'activity-funnel-wrap'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
    var emptyEl = document.getElementById('activity-empty');
    if (emptyEl) emptyEl.style.display = 'none';

    // Ensure/refresh aggregate container
    var sec = document.getElementById('sec-activity');
    if (!sec) return;
    var aggWrap = document.getElementById('activity-aggregate-wrap');
    if (!aggWrap) {
      aggWrap = document.createElement('div');
      aggWrap.id = 'activity-aggregate-wrap';
      aggWrap.style.marginTop = '20px';
      sec.appendChild(aggWrap);
    }

    // Unified feed via AMCP_UI.activityRow()
    var feed = Array.isArray(data.feed) ? data.feed : [];
    var feedHtml = feed.length === 0
      ? '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 20px">No recent activity across any tenant.</div>'
      : feed.map(function (item) {
          var title, meta = [];
          if (item.type === 'reservation') {
            title = 'Reservation ' + (item.id || '');
            if (item.status) meta.push(item.status);
            if (item.agent_id) meta.push(item.agent_id);
          } else if (item.type === 'handoff') {
            title = 'Handoff ' + (item.id || '');
            if (item.mode) meta.push(item.mode);
            if (item.delivered_via) meta.push(item.delivered_via);
          } else if (item.type === 'agent_call') {
            title = item.tool_called || 'agent call';
            if (item.agent_id) meta.push(item.agent_id);
            if (item.outcome_signal && item.outcome_signal !== 'none') meta.push(item.outcome_signal);
            if (item.latency_ms != null) meta.push(item.latency_ms + 'ms');
          } else {
            title = item.type;
          }
          return AMCP_UI.activityRow({
            type: item.type,
            business_slug: item.business_slug,
            business_name: item.business_name,
            title: title,
            meta: meta,
            timestamp: item.timestamp,
          });
        }).join('');

    // Per-business summary cards with mini sparkline
    var bizArr = Array.isArray(data.businesses) ? data.businesses : [];
    var bizCards = bizArr.map(function (b) {
      var tt = b.totals || {};
      var res = tt.reservations || {};
      var ho  = tt.handoffs || {};
      var ag  = tt.agent_requests || {};
      var recent = Array.isArray(b.recent_items) ? b.recent_items : [];
      var sparkId = 'agg-spark-' + esc(b.slug);
      return '<div class="db-card" style="padding:16px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">' +
          '<div style="font-weight:600;font-size:var(--tx-sm)">' + esc(b.name || b.slug) + '</div>' +
          '<div id="' + sparkId + '" style="width:60px;height:20px"></div>' +
        '</div>' +
        '<div style="display:flex;gap:14px;font-size:var(--tx-xs);color:var(--muted)">' +
          '<span><strong style="color:var(--text);font-weight:600">' + (res.total || 0) + '</strong> res</span>' +
          '<span><strong style="color:var(--text);font-weight:600">' + (ho.total || 0) + '</strong> handoffs</span>' +
          '<span><strong style="color:var(--text);font-weight:600">' + (ag.total_calls || 0) + '</strong> calls</span>' +
        '</div>' +
      '</div>';
    }).join('');

    aggWrap.innerHTML =
      (bizCards
        ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:20px">' + bizCards + '</div>'
        : '') +
      '<div class="tbl-wrap">' +
        '<div class="tbl-head"><div class="tbl-head-title">Recent activity — all tenants</div></div>' +
        '<div style="max-height:500px;overflow:auto">' + feedHtml + '</div>' +
      '</div>';

    // Paint sparklines post-mount
    bizArr.forEach(function (b) {
      var el = document.getElementById('agg-spark-' + b.slug);
      if (!el) return;
      var vals = syntheticSparkBuckets(b.recent_items || [], 7);
      AMCP_UI.sparkline(el, vals, { width: 60, height: 20 });
    });
  }

  // ── Single-business renderer ─────────────────────────────────────────────
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

    // Reservations — rows are clickable drawer triggers.
    if (data.reservations && data.reservations.length > 0) {
      anyData = true;
      var resRows = data.reservations.map(function (r) {
        return '<tr data-kind="reservation" data-id="' + esc(r.id) + '" role="button" tabindex="0" style="cursor:pointer">' +
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

    // Handoffs — clickable drawer triggers.
    if (data.handoffs && data.handoffs.length > 0) {
      anyData = true;
      var hoRows = data.handoffs.map(function (h) {
        return '<tr data-kind="handoff" data-id="' + esc(h.id) + '" role="button" tabindex="0" style="cursor:pointer">' +
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

    // Agent requests — clickable drawer triggers. Use index because the
    // Railway payload doesn't expose a stable request id client-side.
    if (data.agent_requests && data.agent_requests.length > 0) {
      anyData = true;
      var agRows = data.agent_requests.map(function (a, i) {
        return '<tr data-kind="agent_request" data-idx="' + i + '" role="button" tabindex="0" style="cursor:pointer">' +
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

    // Agent reputation — progress ring cell shows quality_score * 100%.
    if (data.agent_reputation && data.agent_reputation.length > 0) {
      anyData = true;
      var repRows = data.agent_reputation.map(function (r, i) {
        var ringId = 'rep-ring-' + i;
        var pct = Math.round((Number(r.quality_score) || 0) * 100);
        return '<tr>' +
          '<td style="font-family:var(--font-mono);font-size:var(--tx-xs)">' + esc(r.agent_id) + '</td>' +
          '<td><span class="badge badge-accent">' + esc(r.window) + '</span></td>' +
          '<td>' + (r.requests || 0) + '</td>' +
          '<td>' + (r.reservations_confirmed || 0) + '</td>' +
          '<td>' + ((r.conversion_rate || 0) * 100).toFixed(1) + '%</td>' +
          '<td>' +
            '<div style="display:flex;align-items:center;gap:8px">' +
              '<div id="' + ringId + '" style="flex-shrink:0"></div>' +
              '<span style="font-size:var(--tx-xs);color:var(--muted)">' + pct + '%</span>' +
            '</div>' +
          '</td>' +
          '</tr>';
      });
      document.getElementById('activity-reputation').innerHTML =
        tbl(['Agent', 'Window', 'Requests', 'Confirmed', 'Conv. rate', 'Quality'], repRows);
      document.getElementById('activity-reputation-wrap').style.display = '';

      // Paint rings post-mount.
      data.agent_reputation.forEach(function (r, i) {
        var el = document.getElementById('rep-ring-' + i);
        if (el) {
          AMCP_UI.progressRing(el, (Number(r.quality_score) || 0) * 100, { size: 22, strokeWidth: 3 });
        }
      });
    }

    // Competitor radar
    if (data.competitor_polls && data.competitor_polls.length > 0) {
      anyData = true;
      var pollRows = data.competitor_polls.map(function (p) {
        var cited = p.tenant_cited ? '✓' : (p.citation_count > 0 ? '—' : 'no result');
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

    bindRowClicks();
  }

  function render() {
    if (rendered) return;
    rendered = true;

    // Admin god-mode scope=all when URL has no explicit slug and the current
    // user is admin (signaled by window.AMCP_ADMIN_MODE set from dashboard-admin.js).
    var urlSlug = new URLSearchParams(window.location.search).get('slug');
    var useAggregate = !urlSlug && window.AMCP_ADMIN_MODE === 'all';

    var slug = (window.AMCP_DATA && window.AMCP_DATA.slug) || urlSlug || '';
    var path = useAggregate
      ? '/api/client/activity-detail?scope=all'
      : '/api/client/activity-detail' + (slug ? '?slug=' + encodeURIComponent(slug) : '');

    // Abort any in-flight fetch before starting a new one (defence against
    // race conditions flagged in D3/D5 review).
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    window.AMCP.authedFetch(path, { signal: abortCtrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (useAggregate && data && data.scope === 'all') {
          renderAggregate(data);
          return;
        }
        cachedPayload = data;
        renderKpis(data);
        renderFunnel(data);
        renderTables(data);
      })
      .catch(function (err) {
        // AbortError is benign — skip reporting.
        if (err && err.name === 'AbortError') return;
        var errEl = document.getElementById('activity-error');
        if (errEl) {
          errEl.textContent = 'Could not load activity data: ' + (err && err.message ? err.message : 'unknown error');
          errEl.classList.add('show');
        }
      });
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['activity'] = render;
})();
