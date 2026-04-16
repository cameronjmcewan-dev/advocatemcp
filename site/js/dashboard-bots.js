/* Bot Activity section — crawler table, intent bars, 7×24 heatmap.
 * D4 upgrade: adds a UTC / Local time toggle (persisted in localStorage),
 * a 6-stop color legend, exact tooltips on every cell, and a "Last seen"
 * column derived from recent_queries grouped by crawler.
 *
 * Registers as window.AMCP_SECTIONS['bot-activity']. */
(function () {
  'use strict';

  var rendered = false;

  var BOT_LABELS = {
    'PerplexityBot':      'Perplexity',
    'GPTBot':             'ChatGPT',
    'OAI-SearchBot':      'OpenAI Search',
    'ClaudeBot':          'Claude',
    'anthropic-ai':       'Anthropic',
    'Google-Extended':    'Google AI',
    'Googlebot':          'Google',
    'cohere-ai':          'Cohere',
    'meta-externalagent': 'Meta AI',
  };

  var INTENT_LABELS = {
    brand_direct:     'Brand Direct',
    emergency:        'Emergency',
    affordable:       'Affordable',
    best_top:         'Best / Top',
    specific_service: 'Specific Service',
    general:          'General',
  };

  var DOW_LABELS_UTC = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Local labels are the same — only the content of the grid shifts.
  var DOW_LABELS_LOCAL = DOW_LABELS_UTC;

  var TZ_KEY = 'amcp-bot-tz'; // 'utc' | 'local'

  function getTzMode() {
    var v = localStorage.getItem(TZ_KEY);
    return v === 'local' ? 'local' : 'utc';
  }
  function setTzMode(v) {
    try { localStorage.setItem(TZ_KEY, v === 'local' ? 'local' : 'utc'); } catch (_) { /* ignore */ }
  }

  function botLabel(raw) { return BOT_LABELS[raw] || raw; }

  function fmtNum(n) {
    if (n === undefined || n === null) return '—';
    return String(n);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderCrawlerTable(data) {
    var wrap = document.getElementById('crawler-table-wrap');
    if (!wrap) return;
    var entries = Object.entries(data.queries_by_crawler || {})
      .sort(function (a, b) { return b[1] - a[1]; });
    var total = entries.reduce(function (s, e) { return s + e[1]; }, 0);

    if (!entries.length) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 0">No bot traffic yet</div>';
      return;
    }

    // Compute last-seen per crawler from recent_queries.
    var lastSeen = {};
    (data.recent_queries || []).forEach(function (q) {
      var key = q.crawler_agent;
      if (!key || !q.timestamp) return;
      if (!lastSeen[key] || q.timestamp > lastSeen[key]) lastSeen[key] = q.timestamp;
    });

    var rows = entries.map(function (pair) {
      var pct = total > 0 ? ((pair[1] / total) * 100).toFixed(1) : '0';
      var ts  = lastSeen[pair[0]];
      return '<tr>' +
        '<td>' + esc(botLabel(pair[0])) + '</td>' +
        '<td style="text-align:right;font-variant-numeric:tabular-nums">' + fmtNum(pair[1]) + '</td>' +
        '<td style="text-align:right;color:var(--muted)">' + pct + '%</td>' +
        '<td style="text-align:right;color:var(--muted);white-space:nowrap">' + (ts ? esc(AMCP_UI.fmtTs(ts)) : '—') + '</td>' +
        '</tr>';
    }).join('');

    wrap.innerHTML =
      '<table>' +
        '<thead><tr>' +
          '<th>Bot</th>' +
          '<th style="text-align:right">Queries</th>' +
          '<th style="text-align:right">Share</th>' +
          '<th style="text-align:right">Last seen</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  function renderIntentBars(data) {
    var wrap = document.getElementById('bot-intent-bars');
    if (!wrap) return;
    var entries = Object.entries(data.queries_by_intent || {})
      .sort(function (a, b) { return b[1] - a[1]; });
    if (!entries.length) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted)">No intent data yet</div>';
      return;
    }
    var total = entries.reduce(function (s, e) { return s + e[1]; }, 0);
    wrap.innerHTML = entries.map(function (pair) {
      var pct = total > 0 ? Math.round((pair[1] / total) * 100) : 0;
      var label = INTENT_LABELS[pair[0]] || pair[0];
      return '<div class="bar-row">' +
        '<div class="bar-row-label"><span>' + esc(label) + '</span><span>' + pct + '%</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '</div>';
    }).join('');
  }

  // Shift a UTC dow/hour pair to local time using the browser's offset.
  // Server always emits UTC — we reconstruct a "last Sunday at hour:00 UTC"
  // instant, apply the offset, and re-read dow/hour in local time.
  function shiftCell(dow, hour) {
    // Synthetic UTC moment: pick any Sunday and add (dow*24 + hour) hours.
    // The anchor is arbitrary — we only care about the weekday + hour.
    var base = Date.UTC(2024, 0, 7, 0, 0, 0); // Jan 7 2024 was a Sunday
    var t = base + ((dow * 24 + hour) * 3600 * 1000);
    var d = new Date(t);
    return { dow: d.getDay(), hour: d.getHours() };
  }

  function buildGrid(raw, tzMode) {
    var grid = [];
    for (var d = 0; d < 7; d++) grid[d] = new Array(24).fill(0);
    raw.forEach(function (cell) {
      if (cell.dow < 0 || cell.dow >= 7 || cell.hour < 0 || cell.hour >= 24) return;
      var ref = tzMode === 'local' ? shiftCell(cell.dow, cell.hour) : { dow: cell.dow, hour: cell.hour };
      grid[ref.dow][ref.hour] += (Number(cell.count) || 0);
    });
    return grid;
  }

  function renderHeatmap(data) {
    var wrap = document.getElementById('heatmap-wrap');
    if (!wrap) return;
    var raw = data.activity_by_dow_hour || [];

    var tz = getTzMode();
    var grid = buildGrid(raw, tz);
    var maxVal = 0;
    for (var d = 0; d < 7; d++) {
      for (var h = 0; h < 24; h++) {
        if (grid[d][h] > maxVal) maxVal = grid[d][h];
      }
    }

    var dowLabels = tz === 'local' ? DOW_LABELS_LOCAL : DOW_LABELS_UTC;
    var tzSuffix  = tz === 'local' ? 'local' : 'UTC';

    function heatClass(count) {
      if (!count || maxVal === 0) return 'hm-0';
      var ratio = count / maxVal;
      if (ratio < 0.15) return 'hm-1';
      if (ratio < 0.35) return 'hm-2';
      if (ratio < 0.60) return 'hm-3';
      if (ratio < 0.85) return 'hm-4';
      return 'hm-5';
    }

    // Toggle bar — UTC / Local with aria-pressed + keyboard handler.
    var toggleBar =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px">' +
        '<div style="font-size:var(--tx-xs);color:var(--muted)">Showing: ' + esc(tzSuffix) + ' time</div>' +
        '<div role="group" aria-label="Time zone" style="display:inline-flex;gap:4px">' +
          '<button type="button" class="btn-sm btn-ghost amcp-tz-btn" data-tz="utc" aria-pressed="' + (tz === 'utc' ? 'true' : 'false') + '" ' +
             'style="padding:4px 10px;font-size:var(--tx-xs)' + (tz === 'utc' ? ';background:var(--accent-dim);color:var(--accent)' : '') + '">UTC</button>' +
          '<button type="button" class="btn-sm btn-ghost amcp-tz-btn" data-tz="local" aria-pressed="' + (tz === 'local' ? 'true' : 'false') + '" ' +
             'style="padding:4px 10px;font-size:var(--tx-xs)' + (tz === 'local' ? ';background:var(--accent-dim);color:var(--accent)' : '') + '">Local</button>' +
        '</div>' +
      '</div>';

    // Hour header row
    var hourLabels = '<div class="hm-label"></div>';
    for (var h = 0; h < 24; h++) {
      hourLabels += '<div class="hm-hour-label">' + (h % 6 === 0 ? h + 'h' : '') + '</div>';
    }

    var dayRows = '';
    for (var dow = 0; dow < 7; dow++) {
      dayRows += '<div class="hm-label">' + esc(dowLabels[dow]) + '</div>';
      for (var hour = 0; hour < 24; hour++) {
        var cnt = grid[dow][hour];
        var cls = heatClass(cnt);
        var title = dowLabels[dow] + ' ' + hour + ':00 ' + tzSuffix + ' → ' + cnt + ' quer' + (cnt === 1 ? 'y' : 'ies');
        dayRows += '<div class="hm-cell ' + cls + '" title="' + esc(title) + '" role="img" aria-label="' + esc(title) + '"></div>';
      }
    }

    // Color legend — 6 stops None → High
    var legend =
      '<div style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:var(--tx-xs);color:var(--muted)">' +
        '<span>None</span>' +
        '<div style="display:flex;gap:2px">' +
          '<div class="hm-cell hm-0" style="width:14px;height:14px;border-radius:2px"></div>' +
          '<div class="hm-cell hm-1" style="width:14px;height:14px;border-radius:2px"></div>' +
          '<div class="hm-cell hm-2" style="width:14px;height:14px;border-radius:2px"></div>' +
          '<div class="hm-cell hm-3" style="width:14px;height:14px;border-radius:2px"></div>' +
          '<div class="hm-cell hm-4" style="width:14px;height:14px;border-radius:2px"></div>' +
          '<div class="hm-cell hm-5" style="width:14px;height:14px;border-radius:2px"></div>' +
        '</div>' +
        '<span>High</span>' +
      '</div>';

    wrap.innerHTML = toggleBar + '<div class="heatmap">' + hourLabels + dayRows + '</div>' + legend;

    // Wire the toggle buttons — rebuild the heatmap in place when switched.
    wrap.querySelectorAll('.amcp-tz-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = btn.dataset.tz;
        if (next !== 'utc' && next !== 'local') return;
        if (next === getTzMode()) return;
        setTzMode(next);
        renderHeatmap(data);
      });
    });
  }

  function showEmptyState() {
    var emptyHtml =
      '<div class="empty" style="padding:24px 0">' +
        '<div class="empty-title">No bot activity yet</div>' +
        '<div class="empty-desc">Crawler visits will appear here once AI platforms start indexing your content.</div>' +
      '</div>';

    var table = document.getElementById('crawler-table-wrap');
    if (table) table.innerHTML = emptyHtml;

    var intents = document.getElementById('bot-intent-bars');
    if (intents) intents.innerHTML =
      '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted)">No intent data yet</div>';

    var heatmap = document.getElementById('heatmap-wrap');
    if (heatmap) heatmap.innerHTML =
      '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 0">No activity data yet</div>';
  }

  function render() {
    if (rendered) return;
    var data = window.AMCP_DATA;
    if (!data) return;

    if (typeof data.total_queries !== 'number') {
      showEmptyState();
      rendered = true;
      return;
    }

    rendered = true;
    renderCrawlerTable(data);
    renderIntentBars(data);
    renderHeatmap(data);
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['bot-activity'] = render;
})();
