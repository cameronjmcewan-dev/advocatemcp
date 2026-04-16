/* AI Requests section — trend chart, top queries list, intent bars.
 * Registers as window.AMCP_SECTIONS['ai-requests']. */
(function () {
  'use strict';

  var rendered = false;
  var requestsChart = null;

  var INTENT_LABELS = {
    brand_direct:     'Brand Direct',
    emergency:        'Emergency',
    affordable:       'Affordable',
    best_top:         'Best / Top',
    specific_service: 'Specific Service',
    general:          'General',
  };

  function fmtNum(n) {
    if (n === undefined || n === null) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    var accent  = window.AMCP_THEME ? window.AMCP_THEME.accent() : '#7d2550';
    var gridCol = isDark ? 'rgba(57,56,54,.5)' : 'rgba(221,219,216,.7)';
    var txtCol  = isDark ? '#7a7875' : '#6b6967';

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
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['ai-requests'] = render;
})();
