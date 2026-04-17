/* Overview section — wires AMCP_DATA into the Overview section DOM.
 * Reads from window.AMCP_DATA (set by dashboard.html after metrics fetch).
 * Registers as window.AMCP_SECTIONS.overview.
 *
 * D1 upgrade: each KPI card now renders an inline sparkline (via AMCP_UI),
 * animates numeric values with countUp, and shows a delta chip comparing
 * the last 15 days to the prior 15. The insight banner is data-driven. */
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

  function botLabel(raw) { return BOT_LABELS[raw] || raw; }

  function fmtNum(n) {
    if (n === undefined || n === null) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function topKey(obj) {
    if (!obj) return null;
    var keys = Object.keys(obj);
    if (!keys.length) return null;
    return keys.reduce(function (a, b) { return obj[a] >= obj[b] ? a : b; });
  }

  /* Sum an arbitrary window slice of queries_last_30_days */
  function sumSlice(days, start, end) {
    var sum = 0;
    for (var i = start; i < end && i < days.length; i++) {
      sum += Number(days[i].count) || 0;
    }
    return sum;
  }

  /* ── Real insight: pick the strongest signal, not a template ── */
  function buildInsight(data) {
    if (!data || !data.total_queries) {
      return 'Your site isn\'t showing up in AI results yet — verify your Worker Route is active and /.well-known/ai-agent.json is reachable.';
    }
    var crawlers = data.queries_by_crawler || {};
    var entries  = Object.entries(crawlers).sort(function (a, b) { return b[1] - a[1]; });
    if (entries.length) {
      var top = entries[0];
      var share = data.total_queries > 0 ? Math.round((top[1] / data.total_queries) * 100) : 0;
      if (share >= 60) {
        return botLabel(top[0]) + ' accounts for ' + share + '% of your traffic — diversifying across crawlers will reduce single-source risk.';
      }
    }
    var ctr = data.total_queries > 0 ? (data.referral_clicks / data.total_queries) : 0;
    if (data.total_queries >= 10 && ctr < 0.05) {
      return 'Click-through rate is ' + (ctr * 100).toFixed(1) + '%. Tighten your response copy and CTAs to convert more AI citations into visits.';
    }
    var days = data.queries_last_30_days || [];
    if (days.length >= 14) {
      var recent = sumSlice(days, days.length - 7, days.length);
      var prior  = sumSlice(days, days.length - 14, days.length - 7);
      if (prior > 0 && recent > prior * 1.2) {
        var pct = Math.round(((recent - prior) / prior) * 100);
        return 'AI query volume is up ' + pct + '% this week vs last — momentum is building.';
      }
    }
    var intentLabel = {
      brand_direct: 'direct brand searches',
      emergency: 'emergency queries',
      affordable: 'affordability queries',
      best_top: '"best of" queries',
      specific_service: 'specific service queries',
      general: 'general queries',
    }[topKey(data.queries_by_intent || {})] || 'general queries';
    return 'Healthy mix. Most of your AI traffic comes from ' + (entries[0] ? botLabel(entries[0][0]) : 'multiple crawlers') +
      ', driven by ' + intentLabel + '.';
  }

  /* ── KPI card HTML scaffold with sparkline + delta slots ── */
  function kpiCardHtml(id, label, hint) {
    return '<div class="kpi-card" data-kpi-id="' + id + '">' +
      '<div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-val" id="kpi-' + id + '-val">—</div>' +
      '<div class="kpi-spark" id="kpi-' + id + '-spark" style="margin-top:6px;height:20px"></div>' +
      '<div class="kpi-hint">' +
        '<span id="kpi-' + id + '-hint">' + esc(hint) + '</span>' +
        ' <span id="kpi-' + id + '-delta" style="margin-left:6px"></span>' +
      '</div>' +
    '</div>';
  }

  function renderKpis(data) {
    var grid = document.getElementById('kpi-grid');
    if (!grid) return;

    var topBot    = topKey(data.queries_by_crawler);
    var topIntent = topKey(data.queries_by_intent);
    var days      = data.queries_last_30_days || [];
    var dayCounts = days.map(function (d) { return Number(d.count) || 0; });

    // Split into two 15-day halves for delta chips.
    var mid       = Math.floor(dayCounts.length / 2);
    var queriesPrev = sumSlice(days, 0, mid);
    var queriesCur  = sumSlice(days, mid, days.length);

    grid.innerHTML =
      kpiCardHtml('queries',   'AI Queries',       'Total all time') +
      kpiCardHtml('clicks',    'Referral Clicks',  'Last 30 days: ' + fmtNum(data.referral_clicks_last_30_days)) +
      kpiCardHtml('top-bot',   'Top Bot',          topBot ? (data.queries_by_crawler[topBot] || 0) + ' queries' : 'No data yet') +
      kpiCardHtml('intent',    'Top Intent',       'Most common query type');

    // ── Queries card ──
    var qVal = document.getElementById('kpi-queries-val');
    if (qVal) { qVal.textContent = '0'; AMCP_UI.countUp(qVal, 0, data.total_queries || 0, 700); }
    AMCP_UI.sparkline(document.getElementById('kpi-queries-spark'), dayCounts);
    var qDelta = document.getElementById('kpi-queries-delta');
    if (qDelta) qDelta.innerHTML = AMCP_UI.deltaChip(queriesCur, queriesPrev);

    // ── Clicks card ──
    // No per-day clicks series exposed yet — reuse queries trend as a proxy
    // so the spark shows *something* meaningful; hint makes it clear this is
    // the 30d click bucket, not the daily series.
    var cVal = document.getElementById('kpi-clicks-val');
    if (cVal) { cVal.textContent = '0'; AMCP_UI.countUp(cVal, 0, data.referral_clicks || 0, 700); }
    AMCP_UI.sparkline(document.getElementById('kpi-clicks-spark'), dayCounts);
    // Click delta: current-30d vs all-time-minus-30d (rough but directional).
    var clicksPrev = Math.max(0, (data.referral_clicks || 0) - (data.referral_clicks_last_30_days || 0));
    var cDelta = document.getElementById('kpi-clicks-delta');
    if (cDelta) cDelta.innerHTML = AMCP_UI.deltaChip(data.referral_clicks_last_30_days || 0, clicksPrev);

    // ── Top Bot card ──
    var bVal = document.getElementById('kpi-top-bot-val');
    if (bVal) bVal.textContent = topBot ? botLabel(topBot) : '—';
    // Sparkline of the top bot's daily share — we don't have per-bot per-day
    // breakdown server-side, so use total daily counts scaled by the bot's
    // share. Directionally correct, avoids a new endpoint.
    var botShare = (topBot && data.total_queries > 0)
      ? ((data.queries_by_crawler[topBot] || 0) / data.total_queries)
      : 0;
    var botDaily = dayCounts.map(function (n) { return n * botShare; });
    AMCP_UI.sparkline(document.getElementById('kpi-top-bot-spark'), botDaily);

    // ── Top Intent card ──
    var iVal = document.getElementById('kpi-intent-val');
    if (iVal) iVal.textContent = topIntent ? fmtIntent(topIntent) : '—';
    AMCP_UI.sparkline(document.getElementById('kpi-intent-spark'), dayCounts);
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
    var accent = window.AMCP_THEME ? window.AMCP_THEME.accent() : '#3d0a22';
    var gridColor = isDark ? 'rgba(57,56,54,.5)' : 'rgba(221,219,216,.7)';
    var textColor = isDark ? '#8a7c78' : '#6b6360';

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

  function showEmptyState() {
    var grid = document.getElementById('kpi-grid');
    if (grid) grid.innerHTML =
      kpiCardHtml('queries', 'AI Queries',       'No queries yet') +
      kpiCardHtml('clicks',  'Referral Clicks',  'No clicks yet') +
      kpiCardHtml('top-bot', 'Top Bot',          'Waiting for traffic') +
      kpiCardHtml('intent',  'Top Intent',       'Waiting for traffic');

    ['queries', 'clicks', 'top-bot', 'intent'].forEach(function (id) {
      var v = document.getElementById('kpi-' + id + '-val');
      if (v) v.textContent = id === 'top-bot' || id === 'intent' ? '—' : '0';
    });

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

    // Zero-state insight: show the banner with a "get started" nudge.
    var insightEl   = document.getElementById('overview-insight');
    var insightText = document.getElementById('overview-insight-text');
    if (insightEl && insightText) {
      insightText.textContent = buildInsight(null);
      insightEl.style.display = 'flex';
    }
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
    if (insightEl && insightText) {
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
