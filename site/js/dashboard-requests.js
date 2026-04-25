/* AI Requests section, trend chart, top queries list, intent bars,
 * and a Recent Queries table that opens a drawer with the full Claude
 * response for each row. Registers as window.AMCP_SECTIONS['ai-requests']. */
(function () {
  'use strict';

  var rendered = false;
  var requestsChart = null;

  var BOT_LABELS = {
    'PerplexityBot':        'Perplexity',
    'GPTBot':               'ChatGPT',
    'OAI-SearchBot':        'OpenAI Search',
    'ClaudeBot':            'Claude',
    'anthropic-ai':         'Anthropic',
    'Google-Extended':      'Google AI',
    'Googlebot':            'Google',
    'cohere-ai':            'Cohere',
    'meta-externalagent':   'Meta AI',
  };

  var INTENT_LABELS = {
    brand_direct:     'Brand Direct',
    emergency:        'Emergency',
    affordable:       'Affordable',
    best_top:         'Best / Top',
    specific_service: 'Specific Service',
    general:          'General',
  };

  function botLabel(raw) { return BOT_LABELS[raw] || raw; }

  function fmtNum(n) {
    if (n === undefined || n === null) return ',';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1).trim() + '…' : s;
  }

  function renderTrend(data) {
    var canvas = document.getElementById('chart-requests-trend');
    if (!canvas) return;
    var days = (data.queries_last_30_days || []).slice(-30);
    var labels = days.map(function (d) {
      var dt = new Date(d.date);
      return (dt.getMonth() + 1) + '/' + dt.getDate();
    });
    var values = days.map(function (d) { return d.count; });

    if (requestsChart) { requestsChart.destroy(); requestsChart = null; }

    var isDark = (window.AMCP_THEME && window.AMCP_THEME.isDark)
      ? window.AMCP_THEME.isDark()
      : document.documentElement.getAttribute('data-theme') !== 'light';
    var accent  = window.AMCP_THEME ? window.AMCP_THEME.accent() : '#3d0a22';
    var gridCol = isDark ? 'rgba(57,56,54,.5)' : 'rgba(221,219,216,.7)';
    var txtCol  = isDark ? '#8a7c78' : '#6b6360';

    requestsChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          borderColor: accent,
          backgroundColor: window.AMCP_THEME ? window.AMCP_THEME.accentWithAlpha('22') : accent + '22',
          borderWidth: 2,
          pointRadius: 2,
          fill: true,
          tension: 0.3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
        scales: {
          x: {
            grid: { color: gridCol },
            ticks: { color: txtCol, maxTicksLimit: 10, font: { size: 10 } },
          },
          y: {
            grid: { color: gridCol },
            ticks: { color: txtCol, font: { size: 10 }, precision: 0 },
            beginAtZero: true,
          },
        },
      },
    });
  }

  function renderTopQueries(data) {
    var wrap = document.getElementById('top-queries-list');
    if (!wrap) return;
    var queries = data.top_queries || [];
    if (!queries.length) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 0">No queries recorded yet</div>';
      return;
    }
    wrap.innerHTML = queries.slice(0, 10).map(function (q, i) {
      return '<div class="list-item">' +
        '<div class="list-num">' + (i + 1) + '</div>' +
        '<div>' + esc(q) + '</div>' +
        '</div>';
    }).join('');
  }

  function renderIntentBars(data) {
    var wrap = document.getElementById('intent-bars');
    if (!wrap) return;
    var entries = Object.entries(data.queries_by_intent || {})
      .sort(function (a, b) { return b[1] - a[1]; });
    if (!entries.length) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted)">No intent data yet</div>';
      return;
    }
    var total = entries.reduce(function (sum, e) { return sum + e[1]; }, 0);
    wrap.innerHTML = entries.map(function (pair) {
      var pct = total > 0 ? Math.round((pair[1] / total) * 100) : 0;
      var label = INTENT_LABELS[pair[0]] || pair[0];
      return '<div class="bar-row">' +
        '<div class="bar-row-label"><span>' + esc(label) + '</span><span>' + pct + '%</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '</div>';
    }).join('');
  }

  // ── Recent Queries table + per-row drawer ────────────────────────────────
  // Stash the list for the drawer click handler; the drawer opens on demand
  // and needs to look up the full response_text by query id.
  var recentById = new Map();

  function rowHtml(q, idx) {
    var crawler  = botLabel(q.crawler_agent || 'unknown');
    var intent   = q.intent ? (INTENT_LABELS[q.intent] || q.intent) : ',';
    var clicked  = q.referral_clicked ? '<span style="color:var(--accent);font-weight:600">✓</span>' : '<span style="color:var(--muted)">,</span>';
    var when     = AMCP_UI.fmtTs(q.timestamp);
    var queryTxt = truncate(q.query_text || '', 80);
    return '<div class="amcp-activity-row" role="button" tabindex="0" data-recent-id="' + esc(idx) + '" ' +
             'title="Click to see full response">' +
             '<span class="badge badge-accent"><span class="badge-dot"></span>' + esc(crawler) + '</span>' +
             '<span class="amcp-activity-title">' + esc(queryTxt) + '</span>' +
             '<span style="font-size:var(--tx-xs);color:var(--muted);flex-shrink:0">' + esc(intent) + '</span>' +
             '<span style="font-size:var(--tx-xs);flex-shrink:0">' + clicked + '</span>' +
             '<span class="amcp-activity-ts">' + esc(when) + '</span>' +
           '</div>';
  }

  function renderRecentQueries(data) {
    var wrap = document.getElementById('recent-queries-wrap');
    if (!wrap) return;
    var rows = (data.recent_queries || []).slice(0, 20);

    recentById = new Map();
    rows.forEach(function (q, i) { recentById.set(String(i), q); });

    if (!rows.length) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 0">No queries logged yet</div>';
      return;
    }

    wrap.innerHTML = rows.map(rowHtml).join('');

    // Delegated click + keyboard handlers. Using delegation keeps listener
    // count constant regardless of row count.
    wrap.addEventListener('click', function (ev) {
      var row = ev.target.closest('[data-recent-id]');
      if (!row || !wrap.contains(row)) return;
      openRowDrawer(row.dataset.recentId);
    });
    wrap.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var row = ev.target.closest('[data-recent-id]');
      if (!row) return;
      ev.preventDefault();
      openRowDrawer(row.dataset.recentId);
    });
  }

  function openRowDrawer(id) {
    var q = recentById.get(String(id));
    if (!q) return;

    var crawler  = botLabel(q.crawler_agent || 'unknown');
    var intent   = q.intent ? (INTENT_LABELS[q.intent] || q.intent) : ',';
    var clicked  = q.referral_clicked ? 'Yes' : 'No';
    var when     = AMCP_UI.fmtTs(q.timestamp);
    var response = q.response_text || '';

    // SECURITY: every user-authored string here is escaped with esc() before
    // being spliced into innerHTML. AMCP_UI.openDrawer injects bodyHTML
    // verbatim per its documented contract.
    var meta =
      '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 14px;' +
         'font-size:var(--tx-sm);margin-bottom:16px;padding:12px;' +
         'background:var(--surface-2);border:1px solid var(--border);border-radius:8px">' +
        '<span style="color:var(--muted)">Crawler</span><span>' + esc(crawler) + '</span>' +
        '<span style="color:var(--muted)">Intent</span><span>' + esc(intent) + '</span>' +
        '<span style="color:var(--muted)">Referral clicked</span><span>' + esc(clicked) + '</span>' +
        '<span style="color:var(--muted)">When</span><span>' + esc(when) + '</span>' +
      '</div>';

    var queryBlock =
      '<div style="margin-bottom:14px">' +
        '<div style="font-size:var(--tx-xs);color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Query</div>' +
        '<div style="font-size:var(--tx-sm);line-height:1.5">' + esc(q.query_text || '') + '</div>' +
      '</div>';

    var responseBlock =
      '<div>' +
        '<div style="font-size:var(--tx-xs);color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Claude response</div>' +
        '<div style="font-size:var(--tx-sm);line-height:1.6;white-space:pre-wrap;' +
                 'padding:12px;background:var(--surface-2);border:1px solid var(--border);' +
                 'border-radius:8px;max-height:50vh;overflow:auto">' +
          (response ? esc(response) : '<span style="color:var(--muted)">No response text recorded.</span>') +
        '</div>' +
      '</div>';

    var title = truncate(q.query_text || 'Query', 80);
    AMCP_UI.openDrawer(title, meta + queryBlock + responseBlock);
  }

  var EMPTY_MSG =
    '<div class="empty" style="padding:24px 0">' +
      '<div class="empty-title">No requests yet</div>' +
      '<div class="empty-desc">AI crawlers will start logging requests here once your site is activated.</div>' +
    '</div>';

  function showEmptyState() {
    var canvas = document.getElementById('chart-requests-trend');
    if (canvas && canvas.parentNode) canvas.parentNode.innerHTML = EMPTY_MSG;

    var queries = document.getElementById('top-queries-list');
    if (queries) queries.innerHTML =
      '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 0">No queries recorded yet</div>';

    var intents = document.getElementById('intent-bars');
    if (intents) intents.innerHTML =
      '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted)">No intent data yet</div>';

    var recent = document.getElementById('recent-queries-wrap');
    if (recent) recent.innerHTML =
      '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 0">No recent queries</div>';
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
    renderTrend(data);
    renderTopQueries(data);
    renderIntentBars(data);
    renderRecentQueries(data);
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['ai-requests'] = render;
})();
