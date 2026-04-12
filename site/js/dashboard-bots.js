/* Bot Activity section — crawler table, intent bars, 7×24 heatmap.
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

  var DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function botLabel(raw) { return BOT_LABELS[raw] || raw; }

  function fmtNum(n) {
    if (n === undefined || n === null) return '—';
    return String(n);
  }

  function esc(s) {
    return String(s)
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

    var rows = entries.map(function (pair) {
      var pct = total > 0 ? ((pair[1] / total) * 100).toFixed(1) : '0';
      return '<tr>' +
        '<td>' + esc(botLabel(pair[0])) + '</td>' +
        '<td style="text-align:right;font-variant-numeric:tabular-nums">' + fmtNum(pair[1]) + '</td>' +
        '<td style="text-align:right;color:var(--muted)">' + pct + '%</td>' +
        '</tr>';
    }).join('');

    wrap.innerHTML =
      '<table>' +
        '<thead><tr>' +
          '<th>Bot</th><th style="text-align:right">Queries</th><th style="text-align:right">Share</th>' +
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

  function renderHeatmap(data) {
    var wrap = document.getElementById('heatmap-wrap');
    if (!wrap) return;
    var raw = data.activity_by_dow_hour || [];

    /* Build a 7×24 lookup: grid[dow][hour] = count */
    var grid = [];
    for (var d = 0; d < 7; d++) {
      grid[d] = new Array(24).fill(0);
    }
    raw.forEach(function (cell) {
      if (cell.dow >= 0 && cell.dow < 7 && cell.hour >= 0 && cell.hour < 24) {
        grid[cell.dow][cell.hour] = cell.count;
      }
    });

    var maxVal = raw.reduce(function (m, c) { return Math.max(m, c.count); }, 0);

    function heatClass(count) {
      if (!count || maxVal === 0) return 'hm-0';
      var ratio = count / maxVal;
      if (ratio < 0.15) return 'hm-1';
      if (ratio < 0.35) return 'hm-2';
      if (ratio < 0.60) return 'hm-3';
      if (ratio < 0.85) return 'hm-4';
      return 'hm-5';
    }

    /* Hour header row */
    var hourLabels = '<div class="hm-label"></div>';
    for (var h = 0; h < 24; h++) {
      hourLabels += '<div class="hm-hour-label">' + (h % 6 === 0 ? h + 'h' : '') + '</div>';
    }

    /* Day rows */
    var dayRows = '';
    for (var dow = 0; dow < 7; dow++) {
      dayRows += '<div class="hm-label">' + DOW_LABELS[dow] + '</div>';
      for (var hour = 0; hour < 24; hour++) {
        var cnt = grid[dow][hour];
        var cls = heatClass(cnt);
        var title = DOW_LABELS[dow] + ' ' + hour + ':00 UTC — ' + cnt + ' queries';
        dayRows += '<div class="hm-cell ' + cls + '" title="' + esc(title) + '"></div>';
      }
    }

    wrap.innerHTML = '<div class="heatmap">' + hourLabels + dayRows + '</div>';
  }

  function render() {
    if (rendered) return;
    var data = window.AMCP_DATA;
    if (!data) return;

    if (typeof data.total_queries !== 'number') {
      var err = document.getElementById('bot-activity-error');
      if (err) { err.textContent = data.message || 'No data available yet.'; err.classList.add('show'); }
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
