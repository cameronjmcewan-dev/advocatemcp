/* v2 Traffic Impact page — GA4-backed before/after view of how AI search
 * changed site traffic since Advocate activated.
 *
 * Three states:
 *   A — GA4 not connected: hero + connect CTA + tagged-URL clicks secondary
 *   B — GA4 connected, no data yet: status card + tagged-URL clicks secondary
 *   C — GA4 connected with data: KPI strip + two ECharts area charts + clicks
 *
 * Replaces /ClickThroughs.html for the new nav entry "Traffic Impact". */
(function () {
  'use strict';

  // ── Bot-family helpers (ported from clicks.js) ────────────────────

  function botFamily(name) {
    const s = String(name || '').toLowerCase();
    if (s.includes('claude') || s.includes('anthropic')) return 'Anthropic';
    if (s.includes('gpt') || s.includes('chatgpt') || s.includes('oai')) return 'OpenAI';
    if (s.includes('perplexity'))  return 'Perplexity';
    if (s.includes('google'))      return 'Google';
    if (s.includes('bing') || s.includes('microsoft')) return 'Microsoft';
    if (s.includes('meta') || s.includes('facebook'))  return 'Meta';
    if (s.includes('apple'))       return 'Apple';
    if (s.includes('cohere'))      return 'Cohere';
    if (s.includes('mistral'))     return 'Mistral';
    if (s.includes('xai') || s.includes('grok')) return 'xAI';
    if (s.includes('mcp'))         return 'MCP clients';
    return 'Other';
  }
  const BOT_FAMILY_COLOR = {
    'Anthropic':   '#7d2550',
    'OpenAI':      '#10a37f',
    'Google':      '#ea4335',
    'Perplexity':  '#5a9bd4',
    'Microsoft':   '#0078d4',
    'Meta':        '#1877f2',
    'Apple':       '#9b9b9b',
    'Cohere':      '#d29922',
    'Mistral':     '#fa520f',
    'xAI':         '#1a1a1a',
    'MCP clients': '#9b59b6',
    'Other':       '#766f63',
  };

  // ── Formatting helpers ────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtCount(v) { return v == null || isNaN(v) ? '—' : Number(v).toLocaleString(); }
  function fmtPct(v, signed) {
    if (v == null || isNaN(v)) return '—';
    const r = Math.round(v);
    return signed ? (r >= 0 ? '+' + r + '%' : r + '%') : r + '%';
  }
  function formatMoney(value, currency) {
    if (value == null || isNaN(value)) return '—';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: (currency || 'USD').toUpperCase(),
        maximumFractionDigits: value >= 1000 ? 0 : 2,
      }).format(value);
    } catch (_) {
      // Invalid currency code falls through to USD
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value >= 1000 ? 0 : 2 }).format(value);
    }
  }
  function formatPct(num, den) {
    if (!den || den <= 0) return '—';
    return Math.round((num / den) * 100) + '%';
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
    if (isNaN(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return Math.round(s) + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function fmtDate(isoDate) {
    if (!isoDate) return '';
    const d = new Date(isoDate + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ── Click-source resolver (ported from clicks.js) ─────────────────

  function refBucketName(ref, ua) {
    const src = (ref || '') + ' ' + (ua || '');
    if (/perplex/i.test(src))  return 'Perplexity';
    if (/chatgpt|openai|gpt/i.test(src))  return 'ChatGPT';
    if (/claude|anthropic/i.test(src))    return 'Claude';
    if (/gemini|google-extended|googlebot/i.test(src)) return 'Gemini / Google';
    if (/meta/i.test(src))     return 'Meta AI';
    if (/copilot|bing/i.test(src)) return 'Copilot';
    return ref || 'Other';
  }

  // ── Clicks table (ported from clicks.js) ─────────────────────────

  function renderClicksTable(clicksPayload) {
    const clicks = Array.isArray(clicksPayload)
      ? clicksPayload
      : (clicksPayload && Array.isArray(clicksPayload.clicks) ? clicksPayload.clicks : []);
    if (!clicks.length) {
      return `<table class="tbl"><thead><tr><th>When</th><th>Source</th><th>User agent</th></tr></thead>
        <tbody><tr><td colspan="3" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No click-throughs yet. AI-cited visitors will appear here.</td></tr></tbody></table>`;
    }
    const rows = clicks.slice(0, 25).map(c => `<tr>
      <td class="t">${esc(timeAgo(c.timestamp))}</td>
      <td><span class="bot-tag">${esc(refBucketName(c.ref, c.user_agent))}</span></td>
      <td style="font-family:var(--mono);font-size:12.5px;color:var(--muted)">${esc(c.user_agent || c.ref || '')}</td>
    </tr>`).join('');
    return `<table class="tbl">
      <thead><tr><th>When</th><th>Source</th><th>User agent</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // ── Engagement / acquisition helpers ─────────────────────────────

  /** Format 0..1 as percentage string, or '—' if null. */
  function pct(v) {
    if (v == null || isNaN(v)) return '—';
    return Math.round(v * 100) + '%';
  }

  /** Format integer seconds as m:ss, or '—' if null. */
  function formatDuration(sec) {
    if (sec == null || isNaN(sec)) return '—';
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /**
   * Compute session-count-weighted averages for engagement_rate, bounce_rate,
   * and avg_session_duration_sec across all daily rows.
   * Returns { engagement: 0..1|null, bounce: 0..1|null, duration: int|null,
   *           newTotal: int, returningTotal: int }.
   */
  function computeEngagementMetrics(daily) {
    var totalSessions = 0, engSum = 0, bounceSum = 0, durSum = 0;
    var hasEng = false, hasBounce = false, hasDur = false;
    var newTotal = 0, returningTotal = 0;

    for (var i = 0; i < daily.length; i++) {
      var r = daily[i];
      var s = r.total || 0;
      totalSessions += s;
      newTotal      += r.new_users      || 0;
      returningTotal += r.returning_users || 0;

      if (r.engagement_rate != null) { engSum   += r.engagement_rate * s; hasEng   = true; }
      if (r.bounce_rate     != null) { bounceSum += r.bounce_rate    * s; hasBounce = true; }
      if (r.avg_session_duration_sec != null) {
        durSum += r.avg_session_duration_sec * s; hasDur = true;
      }
    }
    return {
      engagement:  (hasEng   && totalSessions > 0) ? engSum   / totalSessions : null,
      bounce:      (hasBounce && totalSessions > 0) ? bounceSum / totalSessions : null,
      duration:    (hasDur   && totalSessions > 0) ? durSum   / totalSessions : null,
      newTotal:    newTotal,
      returningTotal: returningTotal,
    };
  }

  // ── KPI computations ──────────────────────────────────────────────

  function computeKpis(daily, bleedAt) {
    if (!daily || !daily.length) return { pre: null, post: null, uplift: null, aiShare: null };
    const bleedDate = bleedAt ? bleedAt.slice(0, 10) : null;

    let preDays = [], postDays = [], aiTotal = 0, humanTotal = 0;
    const last30 = daily.slice(-30);
    for (const row of daily) {
      if (bleedDate) {
        if (row.date < bleedDate) preDays.push(row.total);
        else postDays.push(row.total);
      }
      aiTotal    += row.ai    || 0;
      humanTotal += row.human || 0;
    }
    for (const row of last30) {
      // recalculate ai share from last 30 only
      void row;
    }
    const last30ai    = last30.reduce((s, r) => s + (r.ai    || 0), 0);
    const last30total = last30.reduce((s, r) => s + (r.total || 0), 0);

    const preAvg  = preDays.length  ? preDays.reduce((s, v) => s + v, 0)  / preDays.length  : null;
    const postAvg = postDays.length ? postDays.reduce((s, v) => s + v, 0) / postDays.length : null;
    const uplift  = preAvg != null && postAvg != null && preAvg > 0
      ? ((postAvg - preAvg) / preAvg) * 100 : null;
    const aiShare = last30total > 0 ? (last30ai / last30total) * 100 : null;

    return { pre: preAvg, post: postAvg, uplift, aiShare };
  }

  // ── New cards (engagement / acquisition / geography) ─────────────

  function renderEngagementCard(daily) {
    var m = computeEngagementMetrics(daily);
    return [
      '<section class="card-dash">',
      '  <div class="card-head"><div>',
      '    <h3>Engagement quality</h3>',
      '    <div class="sub">How engaged your visitors are overall — across the window.</div>',
      '  </div></div>',
      '  <div class="kpis" style="grid-template-columns:1fr 1fr 1fr">',
      '    <div class="kpi"><div class="head"><div class="k">Engagement rate</div></div>',
      '      <div class="v tabular">' + pct(m.engagement) + '</div></div>',
      '    <div class="kpi"><div class="head"><div class="k">Avg session duration</div></div>',
      '      <div class="v tabular">' + formatDuration(m.duration) + '</div></div>',
      '    <div class="kpi"><div class="head"><div class="k">Bounce rate</div></div>',
      '      <div class="v tabular">' + pct(m.bounce) + '</div></div>',
      '  </div>',
      '  <p style="margin:8px 20px 16px;font-size:11.5px;color:var(--muted)">',
      '    Engagement metrics are tenant-wide. GA4 doesn\'t expose per-source-class engagement separately.',
      '  </p>',
      '</section>',
    ].join('');
  }

  function renderAcquisitionCard(daily) {
    var m = computeEngagementMetrics(daily);
    var grand = m.newTotal + m.returningTotal;
    var newPct = grand > 0 ? m.newTotal / grand : null;
    var retPct = grand > 0 ? m.returningTotal / grand : null;
    return [
      '<section class="card-dash">',
      '  <div class="card-head"><div>',
      '    <h3>New vs returning</h3>',
      '    <div class="sub">First-time visitors vs ones who\'d been before — across all traffic.</div>',
      '  </div></div>',
      '  <div style="display:flex;gap:32px;align-items:center;padding:16px 0">',
      '    <div style="flex:1;text-align:center">',
      '      <div class="v tabular" style="font-size:42px">' + pct(newPct) + '</div>',
      '      <div class="d">New visitors</div>',
      '    </div>',
      '    <div style="flex:1;text-align:center">',
      '      <div class="v tabular" style="font-size:42px">' + pct(retPct) + '</div>',
      '      <div class="d">Returning visitors</div>',
      '    </div>',
      '  </div>',
      '  <p style="margin:0 20px 16px;font-size:11.5px;color:var(--muted)">',
      '    New/returning split is tenant-wide; GA4 doesn\'t break this down by source class.',
      '  </p>',
      '</section>',
    ].join('');
  }

  function renderGeographyCard() {
    // Populated lazily in afterMount → loadGeography().
    return [
      '<section class="card-dash" id="geo-card">',
      '  <div class="card-head"><div>',
      '    <h3>Where they\'re coming from</h3>',
      '    <div class="sub">Top countries &amp; cities for the selected window.</div>',
      '  </div></div>',
      '  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:16px">',
      '    <div>',
      '      <div style="font-size:12px;color:var(--maroon);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">From AI search</div>',
      '      <div id="geo-ai-list" style="display:flex;flex-direction:column;gap:6px">Loading&hellip;</div>',
      '    </div>',
      '    <div>',
      '      <div style="font-size:12px;color:#a39b8e;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">From everything else</div>',
      '      <div id="geo-human-list" style="display:flex;flex-direction:column;gap:6px">Loading&hellip;</div>',
      '    </div>',
      '  </div>',
      '</section>',
    ].join('');
  }

  function geoRow(row, side) {
    var label   = row.city ? (esc(row.city) + ', ' + esc(row.country || '')) : (esc(row.country) || '(unknown)');
    var sessions = row.sessions || 0;
    var color   = side === 'ai' ? 'var(--maroon)' : '#a39b8e';
    return '<div style="display:flex;justify-content:space-between;align-items:center;' +
      'padding:6px 8px;border-bottom:1px solid var(--line);font-size:13px">' +
      '<span>' + label + '</span>' +
      '<span class="tabular" style="color:' + color + ';font-weight:500">' + fmtCount(sessions) + '</span>' +
      '</div>';
  }

  // ── Conversion revenue banner ─────────────────────────────────────

  /**
   * Returns one of three banner variants based on Pro-gate + data state.
   * conv is data.conversions — null means skip entirely.
   */
  function renderRevenueBanner(conv, rangeLabel) {
    if (conv == null) return '';

    // Variant C — base tenant hit a 402
    if (conv.__planRequired) {
      return [
        '<section class="card-dash" style="background:var(--paper);border:1px solid var(--line);padding:20px 24px;margin-bottom:16px;">',
        '  <div style="display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap;">',
        '    <div>',
        '      <div style="display:inline-block;font-size:11px;font-weight:600;color:var(--maroon);background:var(--maroon-tint);padding:3px 10px;border-radius:999px;letter-spacing:0.05em;margin-bottom:8px">PRO</div>',
        '      <div style="font-size:14px;font-weight:500;color:var(--ink)">See exactly how much revenue AI search drove to your site</div>',
        '      <div style="font-size:13px;color:var(--ink-2);margin-top:6px;max-width:560px;line-height:1.5">',
        '        Pro tenants get verified per-event revenue attribution split AI vs Human. Connect your GA4 key events and Advocate calculates the dollars per source.',
        '      </div>',
        '    </div>',
        '    <a href="/Billing.html" class="btn btn-primary btn-sm">Upgrade to Pro →</a>',
        '  </div>',
        '</section>',
      ].join('');
    }

    // Variant B — Pro but no conversion data
    if (!conv.has_conversion_data) {
      return [
        '<section class="card-dash" style="border:1px dashed var(--line);padding:20px 24px;margin-bottom:16px;">',
        '  <div style="display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap;">',
        '    <div>',
        '      <div style="font-size:14px;font-weight:500;color:var(--ink);">Configure GA4 key events to unlock revenue tracking</div>',
        '      <div style="font-size:13px;color:var(--ink-2);margin-top:6px;max-width:560px;line-height:1.5">',
        '        Mark form submissions, purchases, or sign-ups as key events in your GA4 property and we\'ll show how much revenue each AI search engine drove to your site.',
        '      </div>',
        '    </div>',
        '    <a href="https://support.google.com/analytics/answer/12844695" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">How to set up key events →</a>',
        '  </div>',
        '</section>',
      ].join('');
    }

    // Variant A — Pro tenant with conversion data
    var aiRevenue   = (conv.ai    || {}).revenue     || 0;
    var humanRevenue= (conv.human || {}).revenue     || 0;
    var aiEventCount= (conv.ai    || {}).event_count || 0;
    var currency    = conv.currency || 'USD';
    var totalRevenue= aiRevenue + humanRevenue;
    var aiSharePct  = totalRevenue > 0 ? Math.round((aiRevenue / totalRevenue) * 100) : 0;
    var convWord    = aiEventCount === 1 ? 'conversion' : 'conversions';
    return [
      '<section class="card-dash" style="background:linear-gradient(135deg,var(--maroon-tint),transparent);border:1px solid var(--maroon-tint);padding:24px 28px;margin-bottom:16px;">',
      '  <div style="display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap;">',
      '    <div>',
      '      <div style="font-size:13px;color:var(--maroon);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Revenue from AI search</div>',
      '      <div style="font-family:var(--serif);font-size:42px;line-height:1;">' + esc(formatMoney(aiRevenue, currency)) + '</div>',
      '      <div style="font-size:13px;color:var(--ink-2);margin-top:6px">From ' + fmtCount(aiEventCount) + ' ' + convWord + ' attributed to AI sources · ' + esc(rangeLabel || '') + '</div>',
      '    </div>',
      '    <div style="text-align:right;font-size:13px;color:var(--muted)">',
      '      <div>vs ' + esc(formatMoney(humanRevenue, currency)) + ' from Human</div>',
      '      <div style="margin-top:4px">' + aiSharePct + '% of total revenue</div>',
      '    </div>',
      '  </div>',
      '</section>',
    ].join('');
  }

  /**
   * Renders the top conversions table. Only shown when Variant A.
   */
  function renderTopConversions(conv) {
    if (!conv || !conv.has_conversion_data) return '';
    var events = (conv.events || []).slice().sort(function (a, b) { return (b.revenue || 0) - (a.revenue || 0); });
    var currency = conv.currency || 'USD';
    if (!events.length) return '';
    var rows = events.map(function (ev) {
      return [
        '<tr>',
        '  <td><strong>' + esc(ev.event_name) + '</strong></td>',
        '  <td style="text-align:right" class="tabular">' + fmtCount(ev.ai) + '</td>',
        '  <td style="text-align:right" class="tabular">' + fmtCount(ev.human) + '</td>',
        '  <td style="text-align:right" class="tabular" style="color:var(--maroon)">' + esc(formatMoney(ev.revenue, currency)) + '</td>',
        '</tr>',
      ].join('');
    }).join('');
    return [
      '<section class="card-dash">',
      '  <div class="card-head">',
      '    <div>',
      '      <h3>Top conversions</h3>',
      '      <div class="sub">Which key events drove the most revenue this window — split AI vs Human.</div>',
      '    </div>',
      '  </div>',
      '  <table class="tbl" style="width:100%">',
      '    <thead><tr>',
      '      <th style="text-align:left">Event</th>',
      '      <th style="text-align:right">From AI</th>',
      '      <th style="text-align:right">From Human</th>',
      '      <th style="text-align:right">Revenue</th>',
      '    </tr></thead>',
      '    <tbody>' + rows + '</tbody>',
      '  </table>',
      '</section>',
    ].join('');
  }

  // ── Render ────────────────────────────────────────────────────────

  function render(data) {
    const d = data || {};
    const impact   = d.impact   || { ga4_connected: false, daily: [], bleed_at: null };
    const ga4St    = d.ga4Status || {};
    const clicksPay = d.clicks   || { clicks: [] };
    const connected = !!impact.ga4_connected;
    const daily     = impact.daily || [];
    const propLabel = ga4St.property_label || impact.property_label || '';
    const conv      = d.conversions !== undefined ? d.conversions : null;

    const clickCount = Array.isArray(clicksPay.clicks)
      ? clicksPay.clicks.length
      : (Array.isArray(clicksPay) ? clicksPay.length : 0);

    const clicksSection = `
      <details class="card-dash" style="padding:16px 20px;">
        <summary style="cursor:pointer; font-weight:500; font-size:14px;">Direct AI agent clicks (${fmtCount(clickCount)})</summary>
        <div style="margin-top:16px;">${renderClicksTable(clicksPay)}</div>
      </details>`;

    // State A — not connected
    if (!connected) {
      return `
        <section class="card-dash" style="text-align:center; padding:48px 24px; max-width:720px; margin:24px auto;">
          <div style="font-family:var(--serif); font-size:32px; line-height:1.2; margin-bottom:16px;">
            See how AI is moving your traffic.
          </div>
          <div style="color:var(--ink-2); font-size:15px; line-height:1.5; max-width:520px; margin:0 auto 28px;">
            Connect your Google Analytics so Advocate can show you how visits from ChatGPT, Perplexity, Claude, and Gemini grew after you turned us on. We read aggregate daily traffic only — no individual visitor data.
          </div>
          <button id="ga4-connect-btn" class="btn btn-primary btn-lg" style="font-size:15px; padding:12px 28px;">Connect Google Analytics &rarr;</button>
          <div style="margin-top:14px; font-size:13px; color:var(--muted);">
            Don't use GA4? <a href="mailto:max@advocatemcp.com?subject=Plausible%20%2F%20CF%20Analytics%20support" style="color:var(--maroon)">Email us</a> &mdash; we'll add Plausible / CF Analytics next.
          </div>
        </section>
        ${clicksSection}`;
    }

    // State B — connected, no data yet
    if (!daily.length) {
      return `
        <section class="card-dash" style="padding:32px; max-width:720px; margin:24px auto; border:1px solid var(--line);">
          <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
            <div style="width:10px; height:10px; border-radius:50%; background:var(--maroon); animation:pulse 2s infinite;"></div>
            <strong style="font-size:14px;">Connected to Google Analytics &middot; ${esc(propLabel || 'Your property')}</strong>
          </div>
          <p style="margin:0 0 16px; color:var(--ink-2); line-height:1.5;">
            Waiting for your first day of GA4 data. Google finalizes daily traffic stats within 24-48 hours after the day ends, and our nightly sync picks them up automatically.
          </p>
          <p style="margin:0; color:var(--muted); font-size:13px;">
            No traffic in your GA4 property yet? Make sure the GA4 measurement code (gtag.js with your G-XXXXX ID) is installed on your site. Visit <a href="https://analytics.google.com" target="_blank" rel="noopener" style="color:var(--maroon)">analytics.google.com</a> &rarr; your property &rarr; Admin &rarr; Data Streams to verify.
          </p>
        </section>
        <style>@keyframes pulse { 0%, 100% { opacity:1; } 50% { opacity:0.4; } }</style>
        ${clicksSection}`;
    }

    // State C — connected with data
    const kpis = computeKpis(daily, impact.bleed_at);
    const upliftColor = kpis.uplift == null ? '' :
      (kpis.uplift >= 0 ? 'color:#10a37f' : 'color:#ea4335');

    // Determine range label for the revenue banner subtitle
    const range = (window.AdvocateChrome && window.AdvocateChrome.getRange)
      ? window.AdvocateChrome.getRange() : '30d';
    const rangeLabel = range === '7d' ? 'last 7 days'
      : range === '90d' ? 'last 90 days'
      : range === '180d' ? 'last 180 days'
      : 'last 30 days';

    // Conversion KPI card — Variant A only
    const convHasData = conv && !conv.__planRequired && conv.has_conversion_data;
    const aiTotalSessions = daily.reduce(function (s, r) { return s + (r.ai || 0); }, 0);
    const humanTotalSessions = daily.reduce(function (s, r) { return s + (r.human || 0); }, 0);
    const convAiCount    = convHasData ? ((conv.ai || {}).event_count || 0) : 0;
    const convHumanCount = convHasData ? ((conv.human || {}).event_count || 0) : 0;
    const convKpiCard = convHasData ? `
        <div class="kpi">
          <div class="head"><div class="k">AI conversion rate</div></div>
          <div class="v tabular">${formatPct(convAiCount, aiTotalSessions)}</div>
          <div class="d">vs ${formatPct(convHumanCount, humanTotalSessions)} Human</div>
        </div>` : '';

    return `
      ${renderRevenueBanner(conv, rangeLabel)}

      <div class="plain-banner">
        <strong>In plain English:</strong> Here's how AI search has changed who's reaching your site, before vs after you turned Advocate on.
      </div>

      <div class="kpis">
        <div class="kpi">
          <div class="head"><div class="k">Pre-Advocate avg sessions/day</div></div>
          <div class="v tabular">${kpis.pre != null ? fmtCount(Math.round(kpis.pre)) : '—'}</div>
          <div class="d">Before activation</div>
        </div>
        <div class="kpi">
          <div class="head"><div class="k">Post-Advocate avg sessions/day</div></div>
          <div class="v tabular">${kpis.post != null ? fmtCount(Math.round(kpis.post)) : '—'}</div>
          <div class="d">After activation</div>
        </div>
        <div class="kpi">
          <div class="head"><div class="k">Traffic uplift</div></div>
          <div class="v tabular" style="${upliftColor}">${fmtPct(kpis.uplift, true)}</div>
          <div class="d">Post vs pre</div>
        </div>
        <div class="kpi">
          <div class="head"><div class="k">AI share (last 30d)</div></div>
          <div class="v tabular">${fmtPct(kpis.aiShare, false)}</div>
          <div class="d">Of total sessions</div>
        </div>
        ${convKpiCard}
      </div>

      <section class="card-dash">
        <div class="card-head">
          <div>
            <h3>Total traffic</h3>
            <div class="sub">Daily sessions across every channel. Color shifts at the day Advocate activated.</div>
          </div>
        </div>
        <div id="chart-total" style="width:100%; height:320px;"></div>
      </section>

      <section class="card-dash">
        <div class="card-head">
          <div>
            <h3>AI vs Human</h3>
            <div class="sub">Same window, broken down by what brought the visit.</div>
          </div>
        </div>
        <div id="chart-aivshuman" style="width:100%; height:320px;"></div>
      </section>

      ${renderEngagementCard(daily)}
      ${renderAcquisitionCard(daily)}
      ${convHasData ? renderTopConversions(conv) : ''}
      ${renderGeographyCard()}

      <details class="card-dash" style="padding:16px 20px;">
        <summary style="cursor:pointer; font-weight:500; font-size:14px;">Direct AI agent clicks (${fmtCount(clickCount)})</summary>
        <div style="margin-top:16px;">${renderClicksTable(clicksPay)}</div>
      </details>

      <p style="text-align:center; color:var(--muted); font-size:12px; margin:32px 0 16px;">
        Advocate reads aggregate daily traffic stats only. We never access individual visitor data, events, or PII.
      </p>`;
  }

  // ── ECharts helpers ───────────────────────────────────────────────

  function pollEcharts(cb, attempts) {
    attempts = attempts || 0;
    if (window.echarts) { cb(); return; }
    if (attempts > 50) return;
    setTimeout(function () { pollEcharts(cb, attempts + 1); }, 100);
  }

  function readCssVar(name, fallback) {
    return (getComputedStyle(document.documentElement).getPropertyValue(name) || fallback).trim();
  }

  function bootMaroonTheme() {
    if (!window.echarts) return;
    const maroon = readCssVar('--maroon', '#7d2550');
    const ink    = readCssVar('--ink',    '#141210');
    const muted  = readCssVar('--muted',  '#766f63');
    const line   = readCssVar('--line',   '#d4ccbf');
    window.echarts.registerTheme('advocate-maroon', {
      color: [maroon, '#10a37f', '#3a8c7c', '#d29922', '#5a7eaa'],
      backgroundColor: 'transparent',
      textStyle: { color: ink, fontFamily: 'inherit' },
      tooltip: { backgroundColor: 'rgba(20,18,16,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 } },
      categoryAxis: { axisLine: { lineStyle: { color: line } }, axisTick: { lineStyle: { color: line } }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: line } } },
      valueAxis:    { axisLine: { lineStyle: { color: line } }, axisTick: { lineStyle: { color: line } }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: line } } },
      legend: { textStyle: { color: muted } },
    });
  }

  function mountChartTotal(daily, bleedAt) {
    const el = document.getElementById('chart-total');
    if (!el || !window.echarts) return null;

    const maroon  = readCssVar('--maroon', '#7d2550');
    const grayHex = 'rgba(120,116,108,0.7)';
    const dates   = daily.map(function (d) { return d.date; });
    const totals  = daily.map(function (d) { return d.total; });
    const bleedDate = bleedAt ? bleedAt.slice(0, 10) : null;
    const bleedIdx  = bleedDate ? dates.indexOf(bleedDate) : -1;

    // Last 2 points flagged as "unfinalized" in tooltip
    const lastTwo = dates.length >= 2 ? [dates[dates.length - 2], dates[dates.length - 1]] : [];

    // Two-series approach for the bleed effect — visualMap with
    // dimension:0 doesn't match against category-axis string dates, so the
    // earlier single-series + visualMap approach rendered the line
    // invisibly. Splitting into pre/post series guarantees both segments
    // render at their respective colors. The bleed-day datum is shared by
    // both series so the line is visually continuous across the join.
    const preData  = totals.map(function (v, i) {
      if (bleedIdx < 0) return null;
      return i <= bleedIdx ? v : null;
    });
    const postData = totals.map(function (v, i) {
      if (bleedIdx < 0) return v;       // no bleed yet — color whole line maroon
      return i >= bleedIdx ? v : null;
    });

    // Bleed marker: a dashed vertical hairline plus a horizontal pill
    // label sitting just above the chart top (rotate:0, distance:-22 puts
    // the text outside the chart area so it doesn't overlap the line).
    const markLine = bleedIdx >= 0 ? {
      symbol: 'none',
      silent: true,
      label: {
        show: true,
        formatter: 'Advocate activated · ' + fmtDate(bleedDate),
        position: 'insideEndTop',
        rotate: 0,
        distance: -22,
        fontSize: 11,
        fontWeight: 500,
        color: maroon,
        backgroundColor: 'rgba(255,255,255,0.85)',
        padding: [3, 8],
        borderRadius: 4,
        borderColor: 'rgba(125,37,80,0.3)',
        borderWidth: 1,
      },
      lineStyle: { type: 'dashed', color: 'rgba(125,37,80,0.45)', width: 1.5 },
      data: [{ xAxis: bleedDate }],
    } : undefined;

    const inst = window.echarts.init(el, 'advocate-maroon');
    inst.setOption({
      grid: { left: 48, right: 24, top: 36, bottom: 32 },
      tooltip: {
        trigger: 'axis',
        formatter: function (params) {
          // Both series fire — pick the one that has a numeric value at this point
          const pt = params.find(function (p) { return p.value != null; }) || params[0];
          if (!pt || pt.value == null) return '';
          const isPost = bleedIdx >= 0 && dates.indexOf(pt.axisValue) >= bleedIdx;
          const tag = isPost
            ? '<span style="font-size:10.5px;color:' + maroon + ';text-transform:uppercase;letter-spacing:0.04em">post-Advocate</span>'
            : '<span style="font-size:10.5px;color:#888;text-transform:uppercase;letter-spacing:0.04em">pre-Advocate</span>';
          const suffix = lastTwo.indexOf(pt.axisValue) >= 0 ? '<br><span style="font-size:11px;color:#aaa">(GA4 finalizes within 48h)</span>' : '';
          return tag + '<br><b>' + pt.axisValue + '</b><br>' + fmtCount(pt.value) + ' sessions' + suffix;
        },
      },
      xAxis: { type: 'category', data: dates, boundaryGap: false },
      yAxis: { type: 'value' },
      series: [
        {
          name: 'Pre-Advocate',
          type: 'line',
          data: preData,
          showSymbol: false,
          smooth: true,
          lineStyle: { color: grayHex, width: 2 },
          areaStyle: { color: grayHex, opacity: 0.18 },
          itemStyle: { color: grayHex },
          markLine: markLine,  // attach to one series only
        },
        {
          name: 'Post-Advocate',
          type: 'line',
          data: postData,
          showSymbol: false,
          smooth: true,
          lineStyle: { color: maroon, width: 2.25 },
          areaStyle: { color: maroon, opacity: 0.22 },
          itemStyle: { color: maroon },
        },
      ],
    });
    return inst;
  }

  function mountChartAiVsHuman(daily) {
    const el = document.getElementById('chart-aivshuman');
    if (!el || !window.echarts) return null;

    const maroon  = readCssVar('--maroon', '#7d2550');
    const muted   = readCssVar('--muted',  '#766f63');
    const ink     = readCssVar('--ink',    '#1a1816');
    const humanColor = '#a39b8e';   // warm gray — opaque so the legend swatch reads cleanly
    const aiColor    = maroon;

    const dates  = daily.map(function (d) { return d.date; });
    const humans = daily.map(function (d) { return d.human; });
    const ais    = daily.map(function (d) { return d.ai; });

    const inst = window.echarts.init(el, 'advocate-maroon');
    inst.setOption({
      // Bigger top margin so the legend has its own breathing room
      // separate from the chart body — was previously overlapping the
      // x-axis labels at bottom:0.
      grid: { left: 48, right: 24, top: 56, bottom: 32 },
      tooltip: {
        trigger: 'axis',
        formatter: function (params) {
          const ai    = params.find(function (p) { return p.seriesName === 'AI search'; });
          const human = params.find(function (p) { return p.seriesName === 'Human'; });
          const aiVal = ai ? ai.value : 0;
          const huVal = human ? human.value : 0;
          const total = aiVal + huVal;
          const aiPct = total > 0 ? Math.round((aiVal / total) * 100) : 0;
          return '<b>' + (params[0] ? params[0].axisValue : '') + '</b><br>' +
            '<span style="display:inline-block;width:9px;height:9px;background:' + humanColor + ';border-radius:2px;margin-right:6px;vertical-align:middle"></span>' +
            'Human: <b>' + fmtCount(huVal) + '</b><br>' +
            '<span style="display:inline-block;width:9px;height:9px;background:' + aiColor + ';border-radius:2px;margin-right:6px;vertical-align:middle"></span>' +
            'AI search: <b>' + fmtCount(aiVal) + '</b> · ' + aiPct + '%<br>' +
            '<span style="font-size:11.5px;color:#888">Total: ' + fmtCount(total) + '</span>';
        },
      },
      legend: {
        // Top-positioned legend — left-aligned, big square swatches with
        // descriptive labels. Was previously overlapping the x-axis at
        // bottom:0 with tiny dot markers + bare "Human"/"AI" text.
        data: [
          { name: 'Human',     icon: 'roundRect' },
          { name: 'AI search', icon: 'roundRect' },
        ],
        top: 8,
        left: 0,
        itemWidth: 14,
        itemHeight: 14,
        itemGap: 18,
        textStyle: { color: ink, fontSize: 13, fontWeight: 500 },
      },
      xAxis: { type: 'category', data: dates, boundaryGap: false },
      yAxis: { type: 'value' },
      series: [
        {
          name: 'Human',
          type: 'line',
          stack: 'total',
          data: humans,
          // Solid color + slightly higher opacity reads cleanly on both
          // light + dark themes (rgba with low alpha was fading into the
          // background).
          areaStyle: { color: humanColor, opacity: 0.6 },
          lineStyle: { width: 0 },
          showSymbol: false,
          color: humanColor,
          smooth: true,
        },
        {
          name: 'AI search',
          type: 'line',
          stack: 'total',
          data: ais,
          areaStyle: { color: aiColor, opacity: 0.92 },
          lineStyle: { width: 0 },
          showSymbol: false,
          color: aiColor,
          smooth: true,
        },
      ],
    });
    return inst;
  }

  // ── afterMount ────────────────────────────────────────────────────

  function afterMount(data) {
    const d      = data || {};
    const impact = d.impact || { ga4_connected: false, daily: [], bleed_at: null };

    // State A — wire Connect button
    var btn = document.getElementById('ga4-connect-btn');
    if (btn) {
      btn.addEventListener('click', async function (e) {
        e.preventDefault();
        btn.disabled = true;
        btn.textContent = 'Opening Google…';
        try {
          const r = await window.AMCP.authedFetch('/api/client/ga4/start-link', { method: 'POST' });
          const j = await r.json();
          if (j.url) { window.location.href = j.url; return; }
          throw new Error(j.customer_message || j.error_code || 'Could not start GA4 connection');
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Connect Google Analytics →';
          alert('Could not connect: ' + (err.message || err));
        }
      });
    }

    // State C — mount charts + lazy-load geography
    if (impact.ga4_connected && impact.daily && impact.daily.length) {
      pollEcharts(function () {
        bootMaroonTheme();
        var instTotal      = mountChartTotal(impact.daily, impact.bleed_at);
        var instAiVsHuman  = mountChartAiVsHuman(impact.daily);
        window.addEventListener('resize', function () {
          try { if (instTotal)     instTotal.resize();     } catch (_) {}
          try { if (instAiVsHuman) instAiVsHuman.resize(); } catch (_) {}
        });
      });
      loadGeography();
    }
  }

  // ── Geography lazy-loader ─────────────────────────────────────────

  async function loadGeography() {
    var aiEl = document.getElementById('geo-ai-list');
    var huEl = document.getElementById('geo-human-list');
    if (!aiEl || !huEl) return;
    try {
      var range = (window.AdvocateChrome && window.AdvocateChrome.getRange)
        ? window.AdvocateChrome.getRange() : '30d';
      var r = await window.AMCP.authedFetch('/api/client/traffic-impact/geography?range=' + encodeURIComponent(range));
      var j = await r.json();
      aiEl.innerHTML = (!Array.isArray(j.ai) || j.ai.length === 0)
        ? '<div style="color:var(--muted);font-size:13px">No AI traffic by location yet.</div>'
        : j.ai.map(function (row) { return geoRow(row, 'ai'); }).join('');
      huEl.innerHTML = (!Array.isArray(j.human) || j.human.length === 0)
        ? '<div style="color:var(--muted);font-size:13px">No data yet.</div>'
        : j.human.map(function (row) { return geoRow(row, 'human'); }).join('');
    } catch (_err) {
      if (aiEl) aiEl.innerHTML = '<div style="color:var(--muted);font-size:13px">Couldn\'t load — try refresh.</div>';
      if (huEl) huEl.innerHTML = '';
    }
  }

  // ── fetch ─────────────────────────────────────────────────────────

  async function fetchAll() {
    const range = (window.AdvocateChrome && window.AdvocateChrome.getRange)
      ? window.AdvocateChrome.getRange() : '30d';
    const rq = '?range=' + encodeURIComponent(range);
    const [status, impact, clicks, metrics, conversions] = await Promise.allSettled([
      window.AMCP.authedFetch('/api/client/ga4/status').then(function (r) { return r.json(); }),
      window.AMCP.authedFetch('/api/client/traffic-impact' + rq).then(function (r) { return r.json(); }),
      window.AMCP.authedFetch('/api/client/clicks' + rq).then(function (r) { return r.json(); }),
      window.AMCP.authedFetch('/api/client/metrics' + rq).then(function (r) { return r.json(); }),
      window.AMCP.authedFetch('/api/client/traffic-impact/conversions').then(function (r) {
        if (r.status === 402) return { __planRequired: true };
        if (!r.ok) return null;
        return r.json();
      }),
    ]);
    return {
      ga4Status:   status.status      === 'fulfilled' ? status.value      : { connected: false },
      impact:      impact.status      === 'fulfilled' ? impact.value      : { ga4_connected: false, daily: [], bleed_at: null },
      clicks:      clicks.status      === 'fulfilled' ? clicks.value      : { clicks: [] },
      metrics:     metrics.status     === 'fulfilled' ? (metrics.value.metrics || metrics.value) : {},
      conversions: conversions.status === 'fulfilled' ? conversions.value : null,
    };
  }

  // ── demo ──────────────────────────────────────────────────────────

  function demoData() {
    const today   = new Date();
    const bleedAt = new Date(today.getTime() - 30 * 86400000).toISOString();
    const daily   = [];
    for (var i = 119; i >= 0; i--) {
      const d   = new Date(today.getTime() - i * 86400000);
      const date = d.toISOString().slice(0, 10);
      const isPre = d < new Date(bleedAt);
      const human = Math.round(80 + Math.random() * 40);
      const ai    = isPre
        ? Math.round(2 + Math.random() * 4)
        : Math.round(15 + Math.random() * 30 + (30 - i) * 0.6);
      daily.push({
        date: date, ai: ai, human: human, total: ai + human, top_sources: [],
        engagement_rate: 0.55 + Math.random() * 0.2,
        avg_session_duration_sec: Math.round(90 + Math.random() * 90),
        bounce_rate: 0.25 + Math.random() * 0.2,
        new_users: Math.round((ai + human) * (0.55 + Math.random() * 0.2)),
        returning_users: Math.round((ai + human) * (0.25 + Math.random() * 0.2)),
      });
    }
    return {
      ga4Status: { connected: true, property_label: 'Demo property' },
      impact:    { ga4_connected: true, bleed_at: bleedAt, slug: 'demo', daily: daily },
      clicks:    { clicks: [] },
      metrics:   {},
      conversions: {
        slug: 'preview-demo',
        currency: 'USD',
        ai:    { event_count: 47,  revenue: 12450 },
        human: { event_count: 162, revenue: 38200 },
        events: [
          { event_name: 'purchase',          ai: 24, human: 87, revenue: 38200 },
          { event_name: 'lead_form_submit',  ai: 18, human: 51, revenue: 8100 },
          { event_name: 'newsletter_signup', ai: 5,  human: 24, revenue: 0 },
        ],
        has_conversion_data: true,
      },
    };
  }

  // ── Public API ────────────────────────────────────────────────────

  window.AMCP_TRAFFIC_IMPACT = {
    fetch:      fetchAll,
    render:     render,
    afterMount: afterMount,
    demo:       demoData,
  };

  // Re-fetch + re-render when the topbar's date-range selector changes.
  if (typeof window !== 'undefined') {
    window.addEventListener('amcp:date-range-changed', function () {
      if (window.AMCP_SHELL && typeof window.AMCP_SHELL.refresh === 'function') {
        window.AMCP_SHELL.refresh();
      } else {
        window.location.reload();
      }
    });
  }
})();
