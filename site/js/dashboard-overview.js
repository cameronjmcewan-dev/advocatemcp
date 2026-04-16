/* Overview section — wires AMCP_DATA into the Overview section DOM.
 * Reads from window.AMCP_DATA (set by dashboard.html after metrics fetch).
 * Registers as window.AMCP_SECTIONS.overview. */
(function () {
  'use strict';

  var rendered = false;
  var overviewChart = null;

  /* Friendly names for crawler agents */
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

  function botLabel(raw) {
    return BOT_LABELS[raw] || raw;
  }

  function fmtNum(n) {
    if (n === undefined || n === null) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  /* Build the insight sentence shown at the top of Overview */
  function buildInsight(data) {
    var topBot = topKey(data.queries_by_crawler);
    var topIntent = topKey(data.queries_by_intent);
    var intentMap = {
      brand_direct:     'direct brand searches',
      emergency:        'emergency queries',
      affordable:       'affordability queries',
      best_top:         '"best of" queries',
      specific_service: 'specific service queries',
      general:          'general queries',
    };
    var intentDesc = intentMap[topIntent] || topIntent;
    var botName = topBot ? botLabel(topBot) : 'AI crawlers';
    return (
      'Most of your AI traffic comes from ' + botName +
      ', and the most common query type is ' + intentDesc + '.' +
      (data.referral_clicks > 0
        ? ' ' + data.referral_clicks + ' visitor' + (data.referral_clicks !== 1 ? 's' : '') +
          ' clicked through to your site.'
        : '')
    );
  }

  function topKey(obj) {
    if (!obj) return null;
    var keys = Object.keys(obj);
    if (!keys.length) return null;
    return keys.reduce(function (a, b) { return obj[a] >= obj[b] ? a : b; });
  }

  function renderKpis(data) {
    var grid = document.getElementById('kpi-grid');
    if (!grid) return;
    var topBot    = topKey(data.queries_by_crawler);
    var topIntent = topKey(data.queries_by_intent);
    grid.innerHTML =
      kpiCard('AI Queries', fmtNum(data.total_queries), 'Total all time') +
      kpiCard('Referral Clicks', fmtNum(data.referral_clicks), 'Clicks last 30 days: ' + fmtNum(data.referral_clicks_last_30_days)) +
      kpiCard('Top Bot', topBot ? botLabel(topBot) : '—', topBot ? (data.queries_by_crawler[topBot] || 0) + ' queries' : 'No data yet') +
      kpiCard('Top Intent', topIntent ? fmtIntent(topIntent) : '—', 'Most common query type');
  }

  function kpiCard(label, val, hint) {
    return '<div class="kpi-card">' +
      '<div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-val">' + esc(val) + '</div>' +
      '<div class="kpi-hint">' + esc(hint) + '</div>' +
      '</div>';
  }

  function fmtIntent(s) {
    return (s || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function renderTrendChart(data) {
    var canvas = document.getElementById('chart-overview-trend');
    if (!canvas) return;
    var days = (data.queries_last_30_days || []).slice(-30);
    var labels = days.map(function (d) {
      var dt = new Date(d.date);
      return (dt.getMonth() + 1) + '/' + dt.getDate();
    });
    var values = days.map(function (d) { return d.count; });

    if (overviewChart) { overviewChart.destroy(); overviewChart = null; }

    var isDark = (window.AMCP_THEME && window.AMCP_THEME.isDark)
      ? window.AMCP_THEME.isDark()
      : document.documentElement.getAttribute('data-theme') !== 'light';
    var accent = window.AMCP_THEME ? window.AMCP_THEME.accent() : '#7d2550';
    var gridColor = isDark ? 'rgba(57,56,54,.5)' : 'rgba(221,219,216,.7)';
    var textColor = isDark ? '#7a7875' : '#6b6967';

    overviewChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: window.AMCP_THEME ? window.AMCP_THEME.accentWithAlpha('55') : accent + '55',
          borderColor: accent,
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { color: textColor, maxTicksLimit: 8, font: { size: 10 } },
          },
          y: {
            grid: { color: gridColor },
            ticks: { color: textColor, font: { size: 10 }, precision: 0 },
            beginAtZero: true,
          },
        },
      },
    });
  }

  function renderBotBars(data) {
    var wrap = document.getElementById('overview-bot-bars');
    if (!wrap) return;
    var bots = Object.entries(data.queries_by_crawler || {})
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 6);
    if (!bots.length) {
      wrap.innerHTML = '<div class="empty"><div class="empty-desc">No bot traffic recorded yet</div></div>';
      return;
    }
    var max = bots[0][1];
    wrap.innerHTML = bots.map(function (pair) {
      var pct = max > 0 ? Math.round((pair[1] / max) * 100) : 0;
      return '<div class="bar-row">' +
        '<div class="bar-row-label"><span>' + esc(botLabel(pair[0])) + '</span><span>' + fmtNum(pair[1]) + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '</div>';
    }).join('');
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showEmptyState() {
    var grid = document.getElementById('kpi-grid');
    if (grid) grid.innerHTML =
      kpiCard('AI Queries', '0', 'No queries yet') +
      kpiCard('Referral Clicks', '0', 'No clicks yet') +
      kpiCard('Top Bot', '—', 'Waiting for traffic') +
      kpiCard('Top Intent', '—', 'Waiting for traffic');

    /* Replace trend chart canvas with empty-state message */
    var canvas = document.getElementById('chart-overview-trend');
    if (canvas && canvas.parentNode) {
      canvas.parentNode.innerHTML =
        '<div class="empty" style="padding:24px 0">' +
          '<div class="empty-title">No activity yet</div>' +
          '<div class="empty-desc">AI crawlers haven\'t visited your site during this window. Once you\'re live, traffic data will appear here.</div>' +
        '</div>';
    }

    var bars = document.getElementById('overview-bot-bars');
    if (bars) bars.innerHTML =
      '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:8px 0">No bot traffic yet</div>';
  }

  function render() {
    if (rendered) return;
    var data = window.AMCP_DATA;
    if (!data) return; // still loading

    /* Discriminate the two possible response shapes from /api/client/metrics */
    if (typeof data.total_queries !== 'number') {
      showEmptyState();
      rendered = true;
      return;
    }

    rendered = true;

    /* Insight banner */
    var insightEl = document.getElementById('overview-insight');
    var insightText = document.getElementById('overview-insight-text');
    if (insightEl && insightText && data.total_queries > 0) {
      insightText.textContent = buildInsight(data);
      insightEl.style.display = 'flex';
    }

    renderKpis(data);
    renderTrendChart(data);
    renderBotBars(data);

    if (window.lucide) lucide.createIcons();
  }

  /* Register with shell */
  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['overview'] = render;
})();
