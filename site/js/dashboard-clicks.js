/* Referral Clicks section — KPIs, click-through rate, bot source bars.
 * Registers as window.AMCP_SECTIONS['referral-clicks']. */
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

  function botLabel(raw) { return BOT_LABELS[raw] || raw; }

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

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function render() {
    if (rendered) return;
    var data = window.AMCP_DATA;
    if (!data) return;

    if (typeof data.total_queries !== 'number') {
      var err = document.getElementById('clicks-error');
      if (err) { err.textContent = data.message || 'No data available yet.'; err.classList.add('show'); }
      rendered = true;
      return;
    }

    rendered = true;

    /* KPIs */
    setText('kpi-clicks-total', fmtNum(data.referral_clicks));
    setText('kpi-clicks-30d',   fmtNum(data.referral_clicks_last_30_days));

    var ctr = data.total_queries > 0
      ? ((data.referral_clicks / data.total_queries) * 100).toFixed(1) + '%'
      : '0%';
    setText('kpi-ctr', ctr);

    /* Bot source bars (derived from queries_by_crawler as a proxy for click sources) */
    var wrap = document.getElementById('clicks-bot-bars');
    if (wrap) {
      var bots = Object.entries(data.queries_by_crawler || {})
        .sort(function (a, b) { return b[1] - a[1]; })
        .slice(0, 5);

      if (!bots.length) {
        wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted)">No bot traffic yet</div>';
      } else {
        var max = bots[0][1];
        wrap.innerHTML = bots.map(function (pair) {
          var pct = max > 0 ? Math.round((pair[1] / max) * 100) : 0;
          return '<div class="bar-row">' +
            '<div class="bar-row-label"><span>' + esc(botLabel(pair[0])) + '</span><span>' + fmtNum(pair[1]) + ' queries</span></div>' +
            '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
            '</div>';
        }).join('');
      }
    }
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['referral-clicks'] = render;
})();
