/* Referral Clicks section, pulls real click_events from
 * /api/client/clicks (Worker → Railway proxy) instead of proxying
 * queries_by_crawler as a misleading stand-in for click sources.
 *
 * Registers as window.AMCP_SECTIONS['referral-clicks']. */
(function () {
  'use strict';

  var rendered = false;
  var clicksTrendChart = null;
  var abortCtrl = null;

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

  function botLabel(raw) { return BOT_LABELS[raw] || raw || 'unknown'; }

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

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function showEmptyState() {
    setText('kpi-clicks-total', '0');
    setText('kpi-clicks-30d',   '0');
    setText('kpi-ctr',          '0%');

    var wrap = document.getElementById('clicks-bot-bars');
    if (wrap) wrap.innerHTML =
      '<div class="empty" style="padding:24px 0">' +
        '<div class="empty-title">No clicks yet</div>' +
        '<div class="empty-desc">Clicks from AI citations back to your site will appear here once traffic starts.</div>' +
      '</div>';

    var chartWrap = document.getElementById('chart-clicks-trend');
    if (chartWrap && chartWrap.parentNode) {
      chartWrap.parentNode.innerHTML =
        '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:8px 0">No click trend yet</div>';
    }

    var recent = document.getElementById('recent-clicks-wrap');
    if (recent) recent.innerHTML =
      '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 0">No recent clicks</div>';
  }

  // ── Bucket clicks into per-day counts over the last 30 days ──────────────
  // Returned as an array of {date: YYYY-MM-DD, count} so it can be zipped
  // against queries_last_30_days for the CTR trend chart.
  function bucketClicksByDay(clicks) {
    var buckets = [];
    var now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    var keyToIdx = {};
    for (var i = 29; i >= 0; i--) {
      var d = new Date(now);
      d.setUTCDate(now.getUTCDate() - i);
      var key = d.toISOString().slice(0, 10);
      keyToIdx[key] = buckets.length;
      buckets.push({ date: key, count: 0 });
    }
    clicks.forEach(function (c) {
      if (!c.timestamp) return;
      var key = new Date(c.timestamp).toISOString().slice(0, 10);
      if (key in keyToIdx) buckets[keyToIdx[key]].count++;
    });
    return buckets;
  }

  function renderBotBars(clicks) {
    var wrap = document.getElementById('clicks-bot-bars');
    if (!wrap) return;
    var counts = {};
    clicks.forEach(function (c) {
      var ref = c.ref || 'direct';
      counts[ref] = (counts[ref] || 0) + 1;
    });
    var bots = Object.entries(counts).sort(function (a, b) { return b[1] - a[1] }).slice(0, 8);
    if (!bots.length) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted)">No click sources yet</div>';
      return;
    }
    var max = bots[0][1];
    wrap.innerHTML = bots.map(function (pair) {
      var pct = max > 0 ? Math.round((pair[1] / max) * 100) : 0;
      return '<div class="bar-row">' +
        '<div class="bar-row-label"><span>' + esc(botLabel(pair[0])) + '</span><span>' + fmtNum(pair[1]) + ' clicks</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '</div>';
    }).join('');
  }

  function renderTrendChart(clickDaily, queryDaily) {
    var canvas = document.getElementById('chart-clicks-trend');
    if (!canvas) return;

    // Align both series by date; map query day → count via a lookup.
    var qMap = {};
    (queryDaily || []).forEach(function (d) { qMap[d.date] = d.count; });

    var labels = clickDaily.map(function (d) {
      var dt = new Date(d.date);
      return (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate();
    });
    var clickVals = clickDaily.map(function (d) { return d.count; });
    var queryVals = clickDaily.map(function (d) { return qMap[d.date] || 0; });

    if (clicksTrendChart) { clicksTrendChart.destroy(); clicksTrendChart = null; }

    var isDark = (window.AMCP_THEME && window.AMCP_THEME.isDark)
      ? window.AMCP_THEME.isDark()
      : document.documentElement.getAttribute('data-theme') !== 'light';
    var accent  = window.AMCP_THEME ? window.AMCP_THEME.accent() : '#3d0a22';
    var gridCol = isDark ? 'rgba(57,56,54,.5)' : 'rgba(221,219,216,.7)';
    var txtCol  = isDark ? '#8a7c78' : '#6b6360';
    var mutedFill = isDark ? 'rgba(122,120,117,.12)' : 'rgba(107,105,103,.12)';
    var mutedLine = isDark ? 'rgba(122,120,117,.5)' : 'rgba(107,105,103,.5)';

    clicksTrendChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Queries',
            data: queryVals,
            borderColor: mutedLine,
            backgroundColor: mutedFill,
            borderWidth: 1.5,
            pointRadius: 0,
            fill: true,
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Clicks',
            data: clickVals,
            borderColor: accent,
            backgroundColor: window.AMCP_THEME ? window.AMCP_THEME.accentWithAlpha('33') : accent + '33',
            borderWidth: 2,
            pointRadius: 2,
            fill: true,
            tension: 0.3,
            yAxisID: 'y',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'bottom', labels: { color: txtCol, font: { size: 11 }, boxWidth: 10 } },
          tooltip: { mode: 'index', intersect: false },
        },
        scales: {
          x: {
            grid: { color: gridCol },
            ticks: { color: txtCol, maxTicksLimit: 8, font: { size: 10 } },
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

  function renderRecentClicks(clicks) {
    var wrap = document.getElementById('recent-clicks-wrap');
    if (!wrap) return;
    if (!clicks.length) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 0">No recent clicks</div>';
      return;
    }
    // Cap to 50 rows (Railway already caps at 50 but defense-in-depth).
    var rows = clicks.slice(0, 50).map(function (c) {
      var ref = esc(botLabel(c.ref || 'direct'));
      var ua  = esc(truncate(c.user_agent || '', 60));
      var ts  = esc(AMCP_UI.fmtTs(c.timestamp));
      return '<tr>' +
        '<td><span class="badge badge-accent"><span class="badge-dot"></span>' + ref + '</span></td>' +
        '<td style="color:var(--muted);font-family:var(--font-mono);font-size:var(--tx-xs)">' + ua + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' + ts + '</td>' +
      '</tr>';
    }).join('');

    wrap.innerHTML =
      '<table>' +
        '<thead><tr>' +
          '<th style="text-align:left">Source</th>' +
          '<th style="text-align:left">User-Agent</th>' +
          '<th style="text-align:right">When</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
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

    // Synchronous rendering of the scalar KPIs + placeholders while the
    // real click list fetches in the background.
    setText('kpi-clicks-total', fmtNum(data.referral_clicks));
    setText('kpi-clicks-30d',   fmtNum(data.referral_clicks_last_30_days));

    var ctr = data.total_queries > 0
      ? ((data.referral_clicks / data.total_queries) * 100).toFixed(1) + '%'
      : '0%';
    setText('kpi-ctr', ctr);

    // Placeholders while /api/client/clicks resolves.
    var wrap = document.getElementById('clicks-bot-bars');
    if (wrap) wrap.innerHTML =
      '<div class="skeleton" style="height:36px;border-radius:6px;margin-bottom:8px"></div>' +
      '<div class="skeleton" style="height:36px;border-radius:6px"></div>';

    var slug = (data && data.slug) || '';
    var path = '/api/client/clicks' + (slug ? '?slug=' + encodeURIComponent(slug) : '');

    // Abort any in-flight fetch before starting a new one so late-resolving
    // promises don't write to stale DOM if the user switches sections.
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    window.AMCP.authedFetch(path, { signal: abortCtrl.signal })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        var clicks = (resp && resp.clicks) || [];
        renderBotBars(clicks);
        var daily = bucketClicksByDay(clicks);
        renderTrendChart(daily, data.queries_last_30_days || []);
        renderRecentClicks(clicks);
      })
      .catch(function (err) {
        // AbortError is benign, skip reporting.
        if (err && err.name === 'AbortError') return;
        // Preserve the KPIs but surface a soft failure in the slots that
        // depend on the clicks payload.
        var barWrap = document.getElementById('clicks-bot-bars');
        if (barWrap) barWrap.innerHTML =
          '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted)">Couldn\'t load clicks. ' + esc(String(err && err.message || err)) + '</div>';
        var recent = document.getElementById('recent-clicks-wrap');
        if (recent) recent.innerHTML =
          '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 0">Couldn\'t load recent clicks.</div>';
      });
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['referral-clicks'] = render;
})();
