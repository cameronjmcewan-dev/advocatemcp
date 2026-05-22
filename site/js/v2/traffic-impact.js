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
   * Returns the revenue banner HTML (one of five variants) plus an
   * optional side-by-side calibration strip below it.
   *
   *   conv     = data.conversions  (GA4 estimated, from /traffic-impact/conversions)
   *   verified = data.verifiedRevenue (webhook-verified, from /traffic-impact/verified-revenue)
   *   rangeLabel = human-readable window string e.g. "last 30 days"
   *
   * Render priority:
   *   V      — verified + webhook_configured + events > 0 → show verified banner
   *   V-empty — webhook configured but no events yet → show GA4 banner + note
   *   A/B/C  — fall through to existing GA4-only variants
   */
  function renderRevenueBanner(conv, verified, rangeLabel) {
    var banner = '';
    var compareCard = '';

    // ── Variant V — webhook verified with events ──────────────────────
    var verifiedHasEvents = verified && !verified.__planRequired
      && verified.webhook_configured === true
      && (verified.ai_cents > 0 || verified.total_events > 0);

    if (verifiedHasEvents) {
      var vCurrency  = verified.currency || 'USD';
      var evWord     = verified.ai_events === 1 ? 'verified event' : 'verified events';
      banner = [
        '<section class="card-dash" style="background:linear-gradient(135deg,var(--maroon-tint),transparent);border:1px solid var(--maroon-tint);padding:24px 28px;margin-bottom:16px;">',
        '  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;flex-wrap:wrap;">',
        '    <div>',
        '      <div style="font-size:13px;color:var(--maroon);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;display:flex;align-items:center;gap:8px;">',
        '        Verified revenue from AI search',
        '        <span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;padding:2px 8px;background:var(--sage-tint,#d8e8d2);color:var(--sage,#4a7a3e);border-radius:999px;font-weight:600">&#10003; Verified</span>',
        '      </div>',
        '      <div style="font-family:var(--serif);font-size:42px;line-height:1;">' + esc(formatMoney(verified.ai_cents / 100, vCurrency)) + '</div>',
        '      <div style="font-size:13px;color:var(--ink-2);margin-top:6px">',
        '        From ' + fmtCount(verified.ai_events) + ' ' + evWord + ' attributed to AI · ' + esc(rangeLabel || ''),
        '      </div>',
        '    </div>',
        '    <div style="text-align:right;font-size:13px;color:var(--muted)">',
        '      <div>' + esc(formatMoney(verified.unknown_cents / 100, vCurrency)) + ' unattributed</div>',
        '      <div style="margin-top:4px">' + fmtCount(verified.total_events) + ' total verified events</div>',
        '    </div>',
        '  </div>',
        '</section>',
      ].join('');

      // Side-by-side calibration card — only when GA4 estimated data also exists
      var convHasData = conv && !conv.__planRequired && conv.has_conversion_data;
      if (convHasData) {
        var estVal = (conv.ai || {}).revenue || 0;
        var verVal = (verified.ai_cents / 100) || 0;
        var deltaHtml = '';
        if (estVal > 0 && verVal > 0) {
          var delta = ((verVal - estVal) / estVal) * 100;
          var sign  = delta >= 0 ? '+' : '';
          var deltaColor = Math.abs(delta) > 25 ? 'var(--orange,#c87a3b)' : 'var(--ink-2)';
          var calibNote  = Math.abs(delta) > 25
            ? 'Worth a sanity check on event values in your booking system.'
            : 'Within expected calibration drift.';
          deltaHtml = '<div style="margin-top:10px;font-size:12.5px;color:' + deltaColor + '">'
            + 'Verified is ' + sign + Math.round(delta) + '% ' + (delta >= 0 ? 'above' : 'below') + ' the GA4 estimate. ' + calibNote
            + '</div>';
        }
        compareCard = [
          '<section class="card-dash" style="margin-bottom:16px;padding:16px 20px;">',
          '  <div style="font-size:13px;color:var(--ink-2);margin-bottom:10px">Estimated vs verified — calibration check</div>',
          '  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">',
          '    <div>',
          '      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:4px">GA4 estimated</div>',
          '      <div class="tabular" style="font-size:22px;">' + esc(formatMoney(estVal, conv.currency || 'USD')) + '</div>',
          '    </div>',
          '    <div>',
          '      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--maroon);margin-bottom:4px">Webhook verified</div>',
          '      <div class="tabular" style="font-size:22px;">' + esc(formatMoney(verVal, vCurrency)) + '</div>',
          '    </div>',
          '  </div>',
          deltaHtml,
          '</section>',
        ].join('');
      }
      return banner + compareCard;
    }

    // ── Variant V-empty — webhook configured but no events yet ────────
    var verifiedConfiguredEmpty = verified && !verified.__planRequired
      && verified.webhook_configured === true
      && (verified.total_events === 0);

    // For V-empty we still want to render the GA4 banner first, so we fall
    // through to the GA4 variants below and append the note after.

    // ── Variants A / B / C (GA4-based) ───────────────────────────────
    var ga4Banner = '';

    if (conv == null) {
      // nothing to render
    } else if (conv.__planRequired) {
      // Variant C — base tenant
      ga4Banner = [
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
    } else if (!conv.has_conversion_data) {
      // Variant B — Pro but no conversion data
      ga4Banner = [
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
    } else {
      // Variant A — Pro tenant with conversion data
      var aiRevenue    = (conv.ai    || {}).revenue     || 0;
      var humanRevenue = (conv.human || {}).revenue     || 0;
      var aiEventCount = (conv.ai    || {}).event_count || 0;
      var currency     = conv.currency || 'USD';
      var totalRevenue = aiRevenue + humanRevenue;
      var aiSharePct   = totalRevenue > 0 ? Math.round((aiRevenue / totalRevenue) * 100) : 0;
      var convWord     = aiEventCount === 1 ? 'conversion' : 'conversions';
      ga4Banner = [
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

    // Append the V-empty note below the GA4 banner when webhook is configured
    // but no events have arrived yet. Keeps the GA4 estimate visible while
    // signalling that verified actuals are incoming.
    if (verifiedConfiguredEmpty && ga4Banner) {
      ga4Banner += [
        '<div style="margin-top:-8px;margin-bottom:16px;padding:12px 16px;border-left:2px solid var(--sage,#4a7a3e);background:var(--paper);font-size:13px;color:var(--ink-2);">',
        '  &#10003; Verified-revenue webhook is configured. Once your booking system POSTs an event, you\'ll see verified dollar amounts here in addition to the estimate above.',
        '</div>',
      ].join('');
    }

    return ga4Banner;
  }

  /**
   * Renders the recent verified revenue events table.
   * Only called when Variant V is active and recent_events is non-empty.
   */
  function renderVerifiedRevenueEvents(verified) {
    if (!verified || !Array.isArray(verified.recent_events) || verified.recent_events.length === 0) return '';
    var rows = verified.recent_events.map(function (ev) {
      var whenStr = esc((ev.occurred_at || '').replace('T', ' ').replace('Z', ' UTC').slice(0, 19));
      var sourceCell;
      if (ev.referrer_classification === 'ai') {
        sourceCell = '<span style="display:inline-block;font-size:10.5px;font-weight:600;color:var(--maroon);background:var(--maroon-tint);padding:2px 8px;border-radius:999px;margin-right:6px">AI</span>'
          + esc(ev.first_touch_source || '—');
      } else {
        sourceCell = '<span style="display:inline-block;font-size:10.5px;font-weight:500;color:var(--muted);background:var(--paper-2);padding:2px 8px;border-radius:999px">Source unknown</span>';
      }
      var amt = formatMoney((ev.amount_cents || 0) / 100, ev.currency || 'USD');
      return '<tr>'
        + '<td>' + whenStr + '</td>'
        + '<td>' + sourceCell + '</td>'
        + '<td style="text-align:right" class="tabular">' + esc(amt) + '</td>'
        + '</tr>';
    }).join('');
    return [
      '<section class="card-dash">',
      '  <div class="card-head">',
      '    <div>',
      '      <h3>Recent verified revenue events</h3>',
      '      <div class="sub">Latest webhook deliveries from your booking system, with attribution.</div>',
      '    </div>',
      '  </div>',
      '  <table class="tbl" style="width:100%;font-size:13.5px">',
      '    <thead><tr>',
      '      <th style="text-align:left">When</th>',
      '      <th style="text-align:left">Source</th>',
      '      <th style="text-align:right">Amount</th>',
      '    </tr></thead>',
      '    <tbody>' + rows + '</tbody>',
      '  </table>',
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

  // ── AI Overview section helpers ───────────────────────────────────

  function topAiOverviewQueriesTable(queries) {
    if (!queries || queries.length === 0) {
      return '<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px">No AI Overviews detected for your queries in this window.</div>';
    }
    var rows = queries.slice(0, 10).map(function (q) {
      return '<tr>' +
        '<td>' + esc(q.query) + '</td>' +
        '<td style="text-align:right" class="tabular">' + fmtCount(q.impressions) + '</td>' +
        '<td style="text-align:right" class="tabular">' + fmtCount(q.clicks) + '</td>' +
        '<td style="text-align:right" class="tabular">' + (q.impressions > 0 ? Math.round((q.clicks / q.impressions) * 100) : 0) + '%</td>' +
        '</tr>';
    }).join('');
    return '<div style="margin-top:24px;">' +
      '<div style="font-size:13px; color:var(--ink-2); margin-bottom: 8px">Top queries triggering AI Overviews</div>' +
      '<table class="tbl" style="width:100%; font-size:13.5px">' +
        '<thead><tr>' +
          '<th style="text-align:left">Query</th>' +
          '<th style="text-align:right">Impressions</th>' +
          '<th style="text-align:right">Clicks</th>' +
          '<th style="text-align:right">CTR</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '</div>';
  }

  /**
   * Renders the AI Overview section for State C — one of four variants
   * depending on whether GSC is connected and whether the tenant is Pro.
   *
   * Variant A: Pro + connected + has data
   * Variant B: Pro + connected but no data / not connected
   * Variant C: Base tenant (planRequired flag)
   * Variant D: null/error — render nothing
   */
  function renderAiOverviewSection(gsc) {
    if (!gsc) return '';

    // Variant C — base tenant
    if (gsc.__planRequired) {
      return [
        '<section class="card-dash" style="background:var(--paper);border:1px solid var(--line);padding:20px 24px;">',
        '  <div style="display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap;">',
        '    <div>',
        '      <div style="display:inline-block;font-size:11px;font-weight:600;color:var(--maroon);background:var(--maroon-tint);padding:3px 10px;border-radius:999px;letter-spacing:0.05em;margin-bottom:8px">PRO</div>',
        '      <div style="font-size:14px;font-weight:500;color:var(--ink)">Detect Google AI Overview presence</div>',
        '      <div style="font-size:13px;color:var(--ink-2);margin-top:6px;max-width:560px;line-height:1.5">',
        '        Pro tenants can connect Google Search Console to see how often AI Overviews show for your top queries — and whether they\'re citing your site.',
        '      </div>',
        '    </div>',
        '    <a href="/Billing.html" class="btn btn-primary btn-sm">Upgrade to Pro →</a>',
        '  </div>',
        '</section>',
      ].join('');
    }

    // Variant B — Pro + not connected
    if (!gsc.gsc_connected) {
      return [
        '<section class="card-dash" style="border: 1px dashed var(--line); padding: 24px;">',
        '  <div style="display:flex; justify-content:space-between; align-items:center; gap:24px; flex-wrap:wrap;">',
        '    <div>',
        '      <div style="font-size:14px; font-weight:500; color:var(--ink);">Detect Google AI Overview presence</div>',
        '      <div style="font-size:13px; color:var(--ink-2); margin-top:6px; max-width:540px; line-height:1.5">',
        '        Connect Google Search Console to see how often AI Overviews show for your top queries — and whether they\'re citing your site.',
        '      </div>',
        '    </div>',
        '    <button class="btn btn-primary btn-sm" id="ti-gsc-connect">Connect Search Console →</button>',
        '  </div>',
        '</section>',
      ].join('');
    }

    // Variant B — connected but no daily data yet
    if (!gsc.daily || !gsc.daily.length) {
      return [
        '<section class="card-dash" style="border: 1px dashed var(--line); padding: 24px;">',
        '  <div>',
        '    <div style="font-size:14px; font-weight:500; color:var(--ink);">Google AI Overview presence</div>',
        '    <div style="font-size:13px; color:var(--ink-2); margin-top:6px; line-height:1.5">',
        '      Connected to <strong>' + esc(gsc.site_url || '') + '</strong>. No data yet — GSC data syncs daily.',
        '    </div>',
        '  </div>',
        '</section>',
      ].join('');
    }

    // Variant A — Pro + connected + has data
    return [
      '<section class="card-dash">',
      '  <div class="card-head">',
      '    <div>',
      '      <h3>Google AI Overview presence</h3>',
      '      <div class="sub">How often Google shows an AI Overview when someone searches for queries you rank for — and how often that Overview cites you.</div>',
      '    </div>',
      '  </div>',
      '  <div class="kpis" style="grid-template-columns: 1fr 1fr 1fr; padding-bottom: 16px;">',
      '    <div class="kpi"><div class="head"><div class="k">Impressions w/ AI Overview</div></div><div class="v tabular">' + pct(gsc.ai_overview_pct) + '</div><div class="d">' + fmtCount(gsc.ai_overview_impressions) + ' of ' + fmtCount(gsc.total_impressions) + '</div></div>',
      '    <div class="kpi"><div class="head"><div class="k">AI Overview cite rate</div></div><div class="v tabular">' + pct(gsc.cite_rate) + '</div><div class="d">Clicks per AI Overview impression</div></div>',
      '    <div class="kpi"><div class="head"><div class="k">Total Google clicks</div></div><div class="v tabular">' + fmtCount(gsc.total_clicks) + '</div><div class="d">From organic search</div></div>',
      '  </div>',
      '  <div id="gsc-ai-chart" style="width:100%; height: 240px"></div>',
      topAiOverviewQueriesTable(gsc.top_ai_overview_queries),
      '</section>',
    ].join('');
  }

  // ── LTV section renderer ──────────────────────────────────────────

  function renderLtvSection(ltv) {
    // Variant L-error — null/error
    if (!ltv) return '';

    // Variant L-pro-required — base tenant
    if (ltv.__planRequired) {
      return [
        '<section class="card-dash" style="background: var(--paper); border: 1px solid var(--line); padding: 20px 24px;">',
        '  <div style="display:flex; justify-content:space-between; align-items:center; gap:24px; flex-wrap:wrap;">',
        '    <div>',
        '      <div style="display:inline-block; font-size:11px; font-weight:600; color:var(--maroon); background:var(--maroon-tint); padding:3px 10px; border-radius:999px; letter-spacing:0.05em; margin-bottom:8px">PRO</div>',
        '      <div style="font-size:14px; font-weight:500; color:var(--ink)">See LTV per acquisition source from your HubSpot or Salesforce</div>',
        '      <div style="font-size:13px; color:var(--ink-2); margin-top:6px; max-width:560px; line-height:1.5">',
        '        Pro tenants connect their CRM and Advocate computes average lifetime value per AI-acquired vs unknown-source customer cohorts.',
        '      </div>',
        '    </div>',
        '    <a href="/Billing.html" class="btn btn-primary btn-sm">Upgrade to Pro →</a>',
        '  </div>',
        '</section>',
      ].join('');
    }

    // Variant L-not-connected — Pro + crm_connected: false
    if (!ltv.crm_connected) {
      return [
        '<section class="card-dash" style="border: 1px dashed var(--line); padding: 24px;">',
        '  <div style="display:flex; justify-content:space-between; align-items:center; gap:24px; flex-wrap:wrap;">',
        '    <div>',
        '      <div style="font-size:14px; font-weight:500; color:var(--ink);">Track customer LTV by acquisition source</div>',
        '      <div style="font-size:13px; color:var(--ink-2); margin-top:6px; max-width:540px; line-height:1.5">',
        '        Connect HubSpot or Salesforce so Advocate can show how much lifetime value AI-acquired customers generate vs unknown sources. Aggregate roll-ups only — your contact data stays in your CRM.',
        '      </div>',
        '    </div>',
        '    <div style="display:flex; gap:8px;">',
        '      <button class="btn btn-primary btn-sm" id="ti-crm-connect-hubspot">HubSpot →</button>',
        '      <button class="btn btn-ghost btn-sm" id="ti-crm-connect-salesforce">Salesforce →</button>',
        '    </div>',
        '  </div>',
        '</section>',
      ].join('');
    }

    // Variant L — Pro + crm_connected
    var ai      = ltv.ai      || { contact_count: 0, customer_count: 0, total_revenue_cents: 0, avg_ltv_cents: 0 };
    var unknown = ltv.unknown || { contact_count: 0, customer_count: 0, total_revenue_cents: 0, avg_ltv_cents: 0 };
    var provider = ltv.provider || 'CRM';

    // No contacts in last 90 days
    if (ai.contact_count === 0 && unknown.contact_count === 0) {
      return [
        '<section class="card-dash">',
        '  <div class="card-head">',
        '    <div>',
        '      <h3>Customer LTV by acquisition source</h3>',
        '      <div class="sub">Connected to ' + esc(provider) + ' CRM. No contacts created in the last 90 days yet.</div>',
        '    </div>',
        '  </div>',
        '  <div style="padding: 32px; text-align: center; color: var(--muted); font-size: 13.5px">',
        '    LTV data will appear here as new contacts land in your CRM.',
        '  </div>',
        '</section>',
      ].join('');
    }

    var customerWord = ai.customer_count === 1 ? 'customer' : 'customers';
    var leadWord     = ai.contact_count === 1 ? 'lead' : 'leads';
    var trendHtml = (ltv.trend && ltv.trend.length > 0)
      ? '<div id="ltv-trend-chart" style="width:100%; height: 280px; margin-top: 16px"></div>'
      : '';

    return [
      '<section class="card-dash">',
      '  <div class="card-head">',
      '    <div>',
      '      <h3>Customer LTV by acquisition source</h3>',
      '      <div class="sub">Average customer lifetime value split by first-touch attribution from your ' + esc(provider) + ' CRM. Contacts created in the last 90 days.</div>',
      '    </div>',
      '  </div>',
      '  <div class="kpis" style="grid-template-columns: 1fr 1fr;">',
      '    <div class="kpi" style="background: linear-gradient(135deg, var(--maroon-tint), transparent); border: 1px solid var(--maroon-tint);">',
      '      <div class="head"><div class="k" style="color:var(--maroon)">Acquired via AI search</div></div>',
      '      <div class="v tabular">' + formatMoney(ai.avg_ltv_cents / 100, 'USD') + '</div>',
      '      <div class="d">avg LTV \xb7 ' + ai.customer_count + ' ' + customerWord + ' from ' + ai.contact_count + ' ' + leadWord + '</div>',
      '    </div>',
      '    <div class="kpi" style="background: var(--paper-2); border: 1px solid var(--line);">',
      '      <div class="head"><div class="k">Source unknown</div></div>',
      '      <div class="v tabular">' + formatMoney(unknown.avg_ltv_cents / 100, 'USD') + '</div>',
      '      <div class="d">avg LTV \xb7 ' + unknown.customer_count + ' customers from ' + unknown.contact_count + ' leads</div>',
      '    </div>',
      '  </div>',
      trendHtml,
      '  <div style="margin-top: 16px; padding: 12px 16px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line);">',
      '    Attribution method: 24h time-window match against /r/&lt;token&gt; redirect clicks. “Source unknown” rows are leads we couldn’t match to an AI click — never assumed Human. Add UTM threading from your checkout to your CRM contact for deterministic attribution (future feature).',
      '  </div>',
      '</section>',
    ].join('');
  }

  // ── Off-site authority section ────────────────────────────────────

  function sentimentChip(score) {
    if (score == null) return '';
    var label, style;
    if (score >= 0.15) {
      label = 'positive';
      style = 'background:var(--sage-tint,#d8e8d2);color:var(--sage,#4a7a3e);border:1px solid rgba(74,122,62,.2)';
    } else if (score <= -0.15) {
      label = 'negative';
      style = 'background:rgba(234,99,53,.1);color:#c24a1a;border:1px solid rgba(234,99,53,.2)';
    } else {
      label = 'neutral';
      style = 'background:var(--paper-2);color:var(--muted);border:1px solid var(--line)';
    }
    return '<span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;' + style + '">' + label + '</span>';
  }

  function sentimentScoreChip(score) {
    if (score == null) return '<span style="color:var(--muted)">—</span>';
    var style;
    if (score >= 0.15) {
      style = 'color:var(--sage,#4a7a3e);font-weight:600';
    } else if (score <= -0.15) {
      style = 'color:#c24a1a;font-weight:600';
    } else {
      style = 'color:var(--muted)';
    }
    var s = score >= 0 ? '+' + score.toFixed(2) : score.toFixed(2);
    return '<span style="font-family:var(--mono);font-size:12.5px;' + style + '">' + s + '</span>';
  }

  function renderSentimentBar(positive, neutral, negative) {
    var total = (positive || 0) + (neutral || 0) + (negative || 0);
    if (!total) return '';
    var posPct = Math.round((positive || 0) / total * 100);
    var neuPct = Math.round((neutral  || 0) / total * 100);
    var negPct = 100 - posPct - neuPct;
    return [
      '<div style="display:flex;height:6px;border-radius:3px;overflow:hidden;margin:6px 0 4px">',
      '  <div style="flex:' + posPct + ';background:var(--sage,#4a7a3e)"></div>',
      '  <div style="flex:' + neuPct + ';background:var(--line)"></div>',
      '  <div style="flex:' + negPct + ';background:#e07040"></div>',
      '</div>',
      '<div style="display:flex;gap:12px;font-size:11px;color:var(--muted)">',
      '  <span style="color:var(--sage,#4a7a3e)">' + fmtCount(positive) + ' positive</span>',
      '  <span>' + fmtCount(neutral) + ' neutral</span>',
      '  <span style="color:#c24a1a">' + fmtCount(negative) + ' negative</span>',
      '</div>',
    ].join('');
  }

  function platformLabel(p) {
    if (p === 'reddit') return 'Reddit';
    if (p === 'google_reviews') return 'Google reviews';
    return esc(p);
  }

  function platformGlyph(p) {
    // Unicode-safe glyphs that render without icon fonts.
    if (p === 'reddit') return '&#128172;'; // speech-bubble
    if (p === 'google_reviews') return '&#9733;'; // star
    return '&#9679;';
  }

  function renderAuthoritySection(authority) {
    // Variant AU-error — null or network error
    if (!authority) return '';

    // Variant AU-pro-required — base tenant
    if (authority.__planRequired) {
      return [
        '<section class="card-dash">',
        '  <div class="card-head">',
        '    <div>',
        '      <h3>Off-site authority <span class="chip maroon" style="margin-left:6px">Pro</span></h3>',
        '      <div class="sub">Track what the public web is saying about you on Reddit and Google.</div>',
        '    </div>',
        '  </div>',
        '  <div style="padding:24px 0 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap">',
        '    <div style="font-size:13px;color:var(--ink-2);max-width:480px;line-height:1.5">',
        '      Upgrade to Pro to track brand mentions and sentiment across Reddit and Google reviews — automatically, every night.',
        '    </div>',
        '    <a href="/Billing.html" class="btn btn-primary btn-sm">Upgrade to Pro →</a>',
        '  </div>',
        '</section>',
      ].join('');
    }

    // Variant AU-not-configured — Pro but no brand_keyword or place_id
    if (!authority.configured) {
      return [
        '<section class="card-dash">',
        '  <div class="card-head">',
        '    <div>',
        '      <h3>Off-site authority</h3>',
        '      <div class="sub">Track what the public web is saying about you on Reddit and Google.</div>',
        '    </div>',
        '  </div>',
        '  <div style="padding:24px 0 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap">',
        '    <div style="font-size:13px;color:var(--ink-2);max-width:480px;line-height:1.5">',
        '      Connect your brand keyword and Google Place ID to start tracking public mentions and sentiment — runs nightly.',
        '    </div>',
        '    <a href="/Settings.html#legacy-authority-card" class="btn btn-primary btn-sm">Configure →</a>',
        '  </div>',
        '</section>',
      ].join('');
    }

    var platforms = Array.isArray(authority.platforms) ? authority.platforms : [];

    // Variant AU-empty — configured but no data rows yet
    if (!platforms.length) {
      var keyword = esc(authority.brand_keyword || 'your brand');
      return [
        '<section class="card-dash">',
        '  <div class="card-head">',
        '    <div>',
        '      <h3>Off-site authority</h3>',
        '      <div class="sub">Tracking <strong>' + keyword + '</strong> across Reddit and Google reviews.</div>',
        '    </div>',
        '  </div>',
        '  <div style="padding:32px;text-align:center;color:var(--muted);font-size:13.5px">',
        '    Connected to <strong>' + keyword + '</strong>. Waiting for the first sync — runs nightly.',
        '    You\'ll see public mentions + sentiment here once data lands.',
        '  </div>',
        '</section>',
      ].join('');
    }

    // Variant AU — Pro + configured + has data
    var syncLabel = authority.last_synced_at ? timeAgo(authority.last_synced_at) : 'Not synced yet';
    var errorPill = authority.last_sync_error
      ? '<span class="chip" style="background:rgba(180,40,40,.08);color:var(--red);border:1px solid rgba(180,40,40,.25);margin-left:8px">Sync error</span>'
      : '';

    var platformCards = platforms.map(function (p) {
      var ratingHtml = '';
      if (p.platform === 'google_reviews' && p.rating != null) {
        ratingHtml = [
          '<div style="display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">',
          '  <span style="font-size:13px;color:var(--muted)">Google rating</span>',
          '  <strong style="font-size:18px;font-family:var(--serif)">' + Number(p.rating).toFixed(1) + '</strong>',
          '  <span style="color:#d29922">★</span>',
          '  <span style="font-size:12.5px;color:var(--muted)">from ' + fmtCount(p.rating_count) + ' reviews</span>',
          '</div>',
        ].join('');
      }
      return [
        '<div style="flex:1;min-width:220px;border:1px solid var(--line);border-radius:8px;padding:16px">',
        '  <div style="font-size:22px;margin-bottom:4px">' + platformGlyph(p.platform) + '</div>',
        '  <div style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:2px">' + platformLabel(p.platform) + '</div>',
        '  <div style="font-size:28px;font-family:var(--serif);line-height:1.1">' + fmtCount(p.mentions) + '</div>',
        '  <div style="font-size:12px;color:var(--muted);margin-bottom:8px">mentions in window</div>',
        '  <div style="font-size:12px;color:var(--muted);margin-bottom:2px">Sentiment</div>',
        renderSentimentBar(p.positive, p.neutral, p.negative),
        '  <div style="margin-top:8px;display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted)">',
        '    Avg score: ' + sentimentScoreChip(p.avg_sentiment),
        '  </div>',
        ratingHtml,
        '</div>',
      ].join('');
    }).join('');

    // Top mentions list
    var topMentionRows = '';
    var topMentions = Array.isArray(authority.top_mentions) ? authority.top_mentions : [];
    var allMentions = [];
    topMentions.forEach(function (tm) {
      var list = Array.isArray(tm.mentions) ? tm.mentions : [];
      list.forEach(function (m) {
        allMentions.push({ platform: tm.platform, item: m });
      });
    });
    // Sort by absolute score (most extreme first)
    allMentions.sort(function (a, b) {
      return Math.abs((b.item.score || 0)) - Math.abs((a.item.score || 0));
    });
    var topN = allMentions.slice(0, 5);

    if (topN.length) {
      var mentionItems = topN.map(function (e) {
        var m = e.item;
        var linkHtml = m.permalink
          ? '<a href="' + esc(m.permalink) + '" target="_blank" rel="noopener" style="font-size:12px;color:var(--maroon);white-space:nowrap">View →</a>'
          : '';
        var themeHtml = m.theme
          ? '<span style="font-size:11px;color:var(--muted);font-style:italic">' + esc(m.theme) + '</span>'
          : '';
        return [
          '<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--line)">',
          '  <div style="flex:1">',
          '    <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">',
          '      <span style="font-size:11px;padding:2px 7px;border-radius:999px;background:var(--paper-2);color:var(--muted);border:1px solid var(--line)">' + platformLabel(e.platform) + '</span>',
          sentimentChip(m.score),
          themeHtml,
          '    </div>',
          '    <div style="font-size:13px;color:var(--ink-2);line-height:1.5">' + esc(String(m.text || '').slice(0, 200)) + (String(m.text || '').length > 200 ? '…' : '') + '</div>',
          '  </div>',
          linkHtml ? '<div style="flex-shrink:0;padding-top:2px">' + linkHtml + '</div>' : '',
          '</div>',
        ].join('');
      }).join('');

      topMentionRows = [
        '<div style="margin-top:20px">',
        '  <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:4px">Top mentions</div>',
        mentionItems,
        '</div>',
      ].join('');
    }

    return [
      '<section class="card-dash">',
      '  <div class="card-head">',
      '    <div>',
      '      <h3>Off-site authority</h3>',
      '      <div class="sub">Public brand mentions &amp; sentiment · last synced ' + esc(syncLabel) + errorPill + '</div>',
      '    </div>',
      '  </div>',
      '  <div style="display:flex;gap:16px;flex-wrap:wrap;padding:4px 0 8px">',
      platformCards,
      '  </div>',
      topMentionRows,
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
    const gsc       = d.gsc !== undefined ? d.gsc : null;
    const verified  = d.verifiedRevenue !== undefined ? d.verifiedRevenue : null;
    const ltv       = d.ltv !== undefined ? d.ltv : null;
    const authority = d.authority !== undefined ? d.authority : null;

    const clickCount = Array.isArray(clicksPay.clicks)
      ? clicksPay.clicks.length
      : (Array.isArray(clicksPay) ? clicksPay.length : 0);

    const clicksSection = `
      <details class="card-dash" style="padding:16px 20px;">
        <summary style="cursor:pointer; font-weight:500; font-size:14px;">Direct AI agent clicks (${fmtCount(clickCount)})</summary>
        <div style="margin-top:16px;">${renderClicksTable(clicksPay)}</div>
      </details>`;

    // Phase-2 wizard: when the tenant has 0–1 integrations connected, replace
    // the bare "Connect Google Analytics →" State A with the multi-step wizard.
    if (window.AMCP_TI_WIZARD && window.AMCP_TI_WIZARD.shouldRender(d.integrationsHub)) {
      return window.AMCP_TI_WIZARD.renderState(d.integrationsHub);
    }

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

    // State B — connected but ZERO days of data. This is the true
    // "waiting for first GA4 sync" case (just-connected GA4 with no
    // historical data yet, or stale cron). Show a single placeholder
    // panel with troubleshooting copy.
    //
    // Previously this branch ALSO fired for any `daily.length < 7`
    // (i.e. sparse-but-real data) which hid every chart for the first
    // week of a tenant's lifetime — even though pre/post comparisons
    // ARE statistically valid with whatever days we have, just less
    // confident. Tenants read the "Day 6 of 7" copy as "the dashboard
    // is broken." Now: any tenant with one or more days of data falls
    // through to State C, which renders the charts plus a sparse-data
    // calibration banner when `daily.length < MIN_DAILY_FOR_INSIGHT`.
    //
    // MIN_DAILY_FOR_INSIGHT stays at 7 because that's the threshold
    // below which we tell the user the trend lines are indicative
    // rather than significant; nothing's hidden, just labelled.
    const MIN_DAILY_FOR_INSIGHT = 7;
    if (daily.length === 0) {
      const body = 'Waiting for your first day of GA4 data. Google finalizes daily traffic stats within 24-48 hours after the day ends, and our nightly sync picks them up automatically.';
      const troubleshoot = `<p style="margin:0; color:var(--muted); font-size:13px;">No traffic in your GA4 property yet? Make sure the GA4 measurement code (gtag.js with your G-XXXXX ID) is installed on your site. Visit <a href="https://analytics.google.com" target="_blank" rel="noopener" style="color:var(--maroon)">analytics.google.com</a> &rarr; your property &rarr; Admin &rarr; Data Streams to verify.</p>`;
      return `
        <section class="card-dash" style="padding:32px; max-width:720px; margin:24px auto; border:1px solid var(--line);">
          <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
            <div style="width:10px; height:10px; border-radius:50%; background:var(--maroon); animation:pulse 2s infinite;"></div>
            <strong style="font-size:14px;">Connected to Google Analytics &middot; ${esc(propLabel || 'Your property')}</strong>
          </div>
          <p style="margin:0 0 16px; color:var(--ink-2); line-height:1.5;">${body}</p>
          ${troubleshoot}
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

    // Sparse-data calibration banner — shown only while the tenant has
    // fewer than MIN_DAILY_FOR_INSIGHT days of GA4 history. Tells them
    // the charts ARE real but the trend math isn't yet statistically
    // confident. Replaces the previous "hide everything until day 7"
    // behaviour that read as a broken dashboard.
    const sparseBanner = daily.length < MIN_DAILY_FOR_INSIGHT
      ? `
      <section class="card-dash" style="padding:14px 18px;margin:16px auto;max-width:1100px;background:rgba(232,168,56,0.06);border:1px solid rgba(232,168,56,0.35);">
        <div style="display:flex;align-items:center;gap:10px;font-size:13.5px;line-height:1.55;color:var(--ink-2)">
          <span style="font-size:16px;line-height:1" aria-hidden="true">⏳</span>
          <span>
            <strong>${daily.length} ${daily.length === 1 ? 'day' : 'days'} of data so far.</strong>
            Trend comparisons (pre- vs post-Advocate, AI share) get more
            confident around day ${MIN_DAILY_FOR_INSIGHT}. The charts below
            show your real data, but treat trend lines as indicative until
            you have a full week of history.
          </span>
        </div>
      </section>`
      : '';

    return `
      ${sparseBanner}
      ${renderRevenueBanner(conv, verified, rangeLabel)}

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
      ${renderAiOverviewSection(gsc)}
      ${(verified && !verified.__planRequired && verified.webhook_configured === true && (verified.ai_cents > 0 || verified.total_events > 0)) ? renderVerifiedRevenueEvents(verified) : ''}
      ${renderLtvSection(ltv)}
      ${renderAuthoritySection(authority)}
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

  function mountLtvTrendChart(trend) {
    var el = document.getElementById('ltv-trend-chart');
    if (!el || !window.echarts || !trend || trend.length === 0) return null;
    var maroon = readCssVar('--maroon', '#7d2550');
    var gray = '#a39b8e';
    var dates     = trend.map(function (t) { return t.date; });
    var aiLtv     = trend.map(function (t) { return (t.ai && t.ai.avg_ltv_cents) ? t.ai.avg_ltv_cents / 100 : 0; });
    var unknownLtv = trend.map(function (t) { return (t.unknown && t.unknown.avg_ltv_cents) ? t.unknown.avg_ltv_cents / 100 : 0; });

    var inst = window.echarts.init(el, 'advocate-maroon');
    inst.setOption({
      grid: { left: 60, right: 24, top: 36, bottom: 32 },
      tooltip: {
        trigger: 'axis',
        formatter: function (params) {
          return '<b>' + params[0].axisValue + '</b><br>' +
            params.map(function (p) {
              return '<span style="display:inline-block;width:9px;height:9px;background:' + p.color + ';border-radius:2px;margin-right:6px;vertical-align:middle"></span>' +
                p.seriesName + ': <b>$' + p.value.toLocaleString() + '</b>';
            }).join('<br>');
        },
      },
      legend: {
        data: [
          { name: 'Acquired via AI', icon: 'roundRect' },
          { name: 'Source unknown',  icon: 'roundRect' },
        ],
        top: 4, left: 0, itemWidth: 14, itemHeight: 14, itemGap: 18,
        textStyle: { color: 'var(--ink)', fontSize: 13 },
      },
      xAxis: { type: 'category', data: dates, boundaryGap: false },
      yAxis: { type: 'value', axisLabel: { formatter: '${value}' } },
      series: [
        { name: 'Acquired via AI',  type: 'line', data: aiLtv,      smooth: true, showSymbol: false, lineStyle: { width: 2, color: maroon }, areaStyle: { color: maroon, opacity: 0.18 }, color: maroon },
        { name: 'Source unknown',   type: 'line', data: unknownLtv, smooth: true, showSymbol: false, lineStyle: { width: 2, color: gray },   areaStyle: { color: gray, opacity: 0.18 },   color: gray },
      ],
    });
    return inst;
  }

  function mountChartAiOverview(daily) {
    var el = document.getElementById('gsc-ai-chart');
    if (!el || !window.echarts) return null;
    var maroon = readCssVar('--maroon', '#7d2550');
    var dates = daily.map(function (d) { return d.date; });
    var pcts  = daily.map(function (d) {
      return d.impressions > 0 ? Math.round((d.ai_overview_impressions / d.impressions) * 100) : 0;
    });
    var inst = window.echarts.init(el, 'advocate-maroon');
    inst.setOption({
      grid: { left: 48, right: 24, top: 24, bottom: 32 },
      tooltip: {
        trigger: 'axis',
        formatter: function (p) {
          return '<b>' + p[0].axisValue + '</b><br>' + p[0].value + '% of impressions w/ AI Overview';
        },
      },
      xAxis: { type: 'category', data: dates, boundaryGap: false },
      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
      series: [{
        type: 'line',
        data: pcts,
        smooth: true,
        showSymbol: false,
        lineStyle: { color: maroon, width: 2 },
        areaStyle: { color: maroon, opacity: 0.18 },
      }],
    });
    return inst;
  }

  // ── afterMount ────────────────────────────────────────────────────

  function afterMount(data) {
    const d      = data || {};
    const impact = d.impact || { ga4_connected: false, daily: [], bleed_at: null };

    // Mount the wizard if it took over the State A render.
    if (window.AMCP_TI_WIZARD && window.AMCP_TI_WIZARD.shouldRender(d.integrationsHub)) {
      // Provide the action map the wizard delegates to.
      window.AMCP_TI_WIZARD_ACTIONS = {
        startConnect: function (integrationId, btn) { return startGoogleOauthForId(integrationId, btn); },
        openPicker:   function (integrationId, btn, mountTarget) { return openInlinePickerForId(integrationId, btn, mountTarget); },
        dispatch:     function (integrationId, action, btn) { return dispatchHubAction(integrationId, action, btn); },
      };
      window.AMCP_TI_WIZARD.mount(d.integrationsHub, document.getElementById('page-content'));
      document.addEventListener('ti-wizard-dismissed', () => {
        if (window.AMCP_SHELL && typeof window.AMCP_SHELL.refresh === 'function') {
          window.AMCP_SHELL.refresh();
        } else {
          window.location.reload();
        }
      }, { once: true });
      return; // skip legacy State A wiring
    }

    // Phase 3: when the wizard isn't showing AND the tenant isn't fully
    // set up, surface a "Resume setup →" link in the topbar's right
    // cluster so users can return to the focused setup page anytime.
    // We mount inside .tb-right (not .topbar) because (a) the topbar's
    // space-between flex distributes children awkwardly when a third
    // child is appended at .topbar level, and (b) the link must be torn
    // down on SPA nav — router.js handles cleanup; we only inject when
    // the page is actively rendering.
    const hub = d.integrationsHub;
    if (hub && hub.completion && hub.completion.connected >= 2 && hub.recommended_next != null) {
      const tbRight = document.querySelector('.topbar .tb-right');
      if (tbRight && !tbRight.querySelector('.resume-setup-link')) {
        tbRight.insertAdjacentHTML('afterbegin',
          '<a href="/setup/traffic-impact" class="resume-setup-link" style="font-size:13.5px;color:var(--maroon);text-decoration:none;margin-right:8px;align-self:center">Resume setup →</a>');
      }
    }

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

    // State A — wire GSC connect button (ti-gsc-connect may appear in any state
    // where GSC is not yet connected, even in State C alongside GA4 data).
    var gscConnectBtn = document.getElementById('ti-gsc-connect');
    if (gscConnectBtn) {
      gscConnectBtn.addEventListener('click', async function (e) {
        e.preventDefault();
        gscConnectBtn.disabled = true;
        gscConnectBtn.textContent = 'Opening Google…';
        try {
          var r = await window.AMCP.authedFetch('/api/client/gsc/start-link', { method: 'POST' });
          var j = await r.json();
          if (j.url) { window.location.href = j.url; return; }
          throw new Error(j.customer_message || j.error_code || 'Could not start GSC connection');
        } catch (err) {
          gscConnectBtn.disabled = false;
          gscConnectBtn.textContent = 'Connect Search Console →';
          alert('Could not connect: ' + (err.message || err));
        }
      });
    }

    // CRM connect buttons — may appear in State C when crm_connected is false.
    function wireCrmConnectBtn(id, provider) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', async function (e) {
        e.preventDefault();
        btn.disabled = true;
        btn.textContent = 'Opening…';
        try {
          var r = await window.AMCP.authedFetch('/api/client/crm/start-link?provider=' + encodeURIComponent(provider), { method: 'POST' });
          var j = await r.json();
          if (j && j.url) { window.location.href = j.url; return; }
          throw new Error((j && (j.customer_message || j.error_code)) || 'Could not start CRM connection');
        } catch (err) {
          btn.disabled = false;
          btn.textContent = provider.charAt(0).toUpperCase() + provider.slice(1) + ' →';
          alert('Could not connect: ' + (err.message || err));
        }
      });
    }
    wireCrmConnectBtn('ti-crm-connect-hubspot', 'hubspot');
    wireCrmConnectBtn('ti-crm-connect-salesforce', 'salesforce');

    // State C — mount charts + lazy-load geography. Threshold matches
    // the render-side State B/C cutoff (MIN_DAILY_FOR_INSIGHT = 7); below
    // that, render() returned the State B "gathering data" panel and the
    // chart DOM doesn't exist for these mountChart* calls to attach to.
    if (impact.ga4_connected && impact.daily && impact.daily.length >= 7) {
      pollEcharts(function () {
        bootMaroonTheme();
        var instTotal      = mountChartTotal(impact.daily, impact.bleed_at);
        var instAiVsHuman  = mountChartAiVsHuman(impact.daily);

        // AI Overview chart — only mount when Variant A data is available.
        var gscData = d.gsc;
        var instAiOverview = null;
        if (gscData && !gscData.__planRequired && gscData.gsc_connected && gscData.daily && gscData.daily.length) {
          instAiOverview = mountChartAiOverview(gscData.daily);
        }

        // LTV trend chart — only mount when Variant L is active with trend data.
        var ltvData = d.ltv;
        var instLtvTrend = null;
        if (ltvData && !ltvData.__planRequired && ltvData.crm_connected && ltvData.trend && ltvData.trend.length > 0) {
          instLtvTrend = mountLtvTrendChart(ltvData.trend);
        }

        window.addEventListener('resize', function () {
          try { if (instTotal)      instTotal.resize();      } catch (_) {}
          try { if (instAiVsHuman)  instAiVsHuman.resize();  } catch (_) {}
          try { if (instAiOverview) instAiOverview.resize(); } catch (_) {}
          try { if (instLtvTrend)   instLtvTrend.resize();   } catch (_) {}
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
    const [status, impact, clicks, metrics, conversions, gscResult, verifiedRevResult, ltvResult, authorityResult, hubResult] = await Promise.allSettled([
      window.AMCP.authedFetch('/api/client/ga4/status').then(function (r) { return r.json(); }),
      window.AMCP.authedFetch('/api/client/traffic-impact' + rq).then(function (r) { return r.json(); }),
      window.AMCP.authedFetch('/api/client/clicks' + rq).then(function (r) { return r.json(); }),
      window.AMCP.authedFetch('/api/client/metrics' + rq).then(function (r) { return r.json(); }),
      window.AMCP.authedFetch('/api/client/traffic-impact/conversions').then(function (r) {
        if (r.status === 402) return { __planRequired: true };
        if (!r.ok) return null;
        return r.json();
      }),
      window.AMCP.authedFetch('/api/client/traffic-impact/gsc' + rq).then(function (r) {
        if (r.status === 402) return { __planRequired: true };
        if (!r.ok) return null;
        return r.json();
      }),
      window.AMCP.authedFetch('/api/client/traffic-impact/verified-revenue').then(function (r) {
        if (r.status === 402) return { __planRequired: true };
        if (!r.ok) return null;
        return r.json();
      }),
      window.AMCP.authedFetch('/api/client/traffic-impact/ltv').then(function (r) {
        if (r.status === 402) return { __planRequired: true };
        if (!r.ok) return null;
        return r.json();
      }),
      window.AMCP.authedFetch('/api/client/traffic-impact/authority' + rq).then(function (r) {
        if (r.status === 402) return { __planRequired: true };
        if (!r.ok) return null;
        return r.json();
      }),
      // Phase 2 PR 3: integrations hub feeds the wizard's State A takeover.
      window.AMCP.authedFetch('/api/client/integrations/status').then(function (r) {
        return r.ok ? r.json() : null;
      }).catch(function () { return null; }),
    ]);
    return {
      ga4Status:       status.status          === 'fulfilled' ? status.value          : { connected: false },
      impact:          impact.status          === 'fulfilled' ? impact.value          : { ga4_connected: false, daily: [], bleed_at: null },
      clicks:          clicks.status          === 'fulfilled' ? clicks.value          : { clicks: [] },
      metrics:         metrics.status         === 'fulfilled' ? (metrics.value.metrics || metrics.value) : {},
      conversions:     conversions.status     === 'fulfilled' ? conversions.value     : null,
      gsc:             gscResult.status       === 'fulfilled' ? gscResult.value       : null,
      verifiedRevenue: verifiedRevResult.status === 'fulfilled' ? verifiedRevResult.value : null,
      ltv:             ltvResult.status       === 'fulfilled' ? ltvResult.value       : null,
      authority:       authorityResult.status === 'fulfilled' ? authorityResult.value : null,
      integrationsHub: hubResult.status       === 'fulfilled' ? hubResult.value       : null,
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
    // Synthetic GSC daily data — 30 days of AI Overview presence
    var gscDaily = [];
    for (var gi = 29; gi >= 0; gi--) {
      var gd   = new Date(today.getTime() - gi * 86400000);
      var gdate = gd.toISOString().slice(0, 10);
      var gimp = Math.round(3800 + Math.random() * 800);
      var gai  = Math.round(gimp * (0.28 + Math.random() * 0.08));
      var gcl  = Math.round(gai * (0.10 + Math.random() * 0.06));
      gscDaily.push({ date: gdate, impressions: gimp, clicks: gcl, ai_overview_impressions: gai });
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
      gsc: {
        gsc_connected:           true,
        slug:                    'preview-demo',
        site_url:                'https://example.com/',
        total_impressions:       124000,
        total_clicks:            3200,
        ai_overview_impressions: 38000,
        ai_overview_pct:         0.31,
        cite_rate:               0.12,
        daily: gscDaily,
        top_ai_overview_queries: [
          { query: 'best ai search analytics tool',  impressions: 4200, clicks: 180 },
          { query: 'advocate vs scrunch',            impressions: 1800, clicks: 95 },
          { query: 'perplexity citation tracking',   impressions: 1500, clicks: 30 },
        ],
      },
      verifiedRevenue: {
        slug:               'preview-demo',
        currency:           'USD',
        webhook_configured: true,
        ai_cents:           512000,
        unknown_cents:      1840000,
        total_events:       47,
        ai_events:          14,
        recent_events: [
          { amount_cents: 38000, currency: 'USD', occurred_at: '2026-05-06T14:23:11Z', referrer_classification: 'ai',      first_touch_source: 'PerplexityBot' },
          { amount_cents: 89000, currency: 'USD', occurred_at: '2026-05-06T11:12:04Z', referrer_classification: 'unknown', first_touch_source: null            },
          { amount_cents: 24000, currency: 'USD', occurred_at: '2026-05-05T18:45:33Z', referrer_classification: 'ai',      first_touch_source: 'ChatGPT'        },
        ],
      },
      ltv: (function () {
        var ltvTrend = [];
        for (var li = 29; li >= 0; li--) {
          var ld = new Date(today.getTime() - li * 86400000);
          var ldate = ld.toISOString().slice(0, 10);
          // AI LTV grows from ~$140 to ~$180 over the period; unknown stays ~$110
          var aiAvg = Math.round(14000 + (29 - li) * 133 + (Math.random() * 800 - 400));
          var unAvg = Math.round(11000 + (Math.random() * 1000 - 500));
          var aiCust = Math.round(1 + Math.random() * 2);
          var unCust = Math.round(2 + Math.random() * 3);
          ltvTrend.push({
            date: ldate,
            ai:      { contact_count: aiCust + 1, customer_count: aiCust, total_revenue_cents: aiCust * aiAvg, avg_ltv_cents: aiAvg },
            unknown: { contact_count: unCust + 2, customer_count: unCust, total_revenue_cents: unCust * unAvg, avg_ltv_cents: unAvg },
          });
        }
        return {
          crm_connected: true,
          provider: 'hubspot',
          slug: 'preview-demo',
          since: new Date(today.getTime() - 90 * 86400000).toISOString(),
          ai:      { contact_count: 42, customer_count: 18, total_revenue_cents: 312000, avg_ltv_cents: 17333 },
          unknown: { contact_count: 187, customer_count: 64, total_revenue_cents: 720000, avg_ltv_cents: 11250 },
          errored: 0,
          total_contacts: 229,
          trend: ltvTrend,
        };
      }()),
      authority: (function () {
        var authDaily = [];
        for (var ai = 13; ai >= 0; ai--) {
          var ad = new Date(today.getTime() - ai * 86400000);
          var adate = ad.toISOString().slice(0, 10);
          authDaily.push(
            { date: adate, platform: 'reddit',         mention_count: Math.round(2 + Math.random() * 6),  avg_sentiment:  0.2 + Math.random() * 0.3 },
            { date: adate, platform: 'google_reviews', mention_count: Math.round(0 + Math.random() * 2),  avg_sentiment:  0.55 + Math.random() * 0.3 }
          );
        }
        return {
          slug: 'preview-demo',
          configured: true,
          brand_keyword: 'preview-demo',
          google_place_id: 'ChIJDemoPlace12345',
          last_synced_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
          last_sync_error: null,
          platforms: [
            { platform: 'reddit',         mentions: 47, positive: 21, neutral: 18, negative: 8, avg_sentiment: 0.32, rating: null,  rating_count: null, last_date: '2026-05-06' },
            { platform: 'google_reviews', mentions: 12, positive: 9,  neutral: 2,  negative: 1, avg_sentiment: 0.71, rating: 4.7,   rating_count: 312,  last_date: '2026-05-06' },
          ],
          daily: authDaily,
          top_mentions: [
            { platform: 'reddit', mentions: [
              { text: "Just started using @preview-demo for our agency’s SEO work, the AI dashboard is genuinely useful for client reporting...", score: 0.85, theme: 'product praise', permalink: 'https://reddit.com/r/marketing/comments/abc123/' },
              { text: "Anyone else having issues with @preview-demo’s onboarding flow? Took me 3 tries to get past the DNS step.", score: -0.65, theme: 'onboarding friction', permalink: 'https://reddit.com/r/saas/comments/def456/' },
            ]},
            { platform: 'google_reviews', mentions: [
              { text: "Excellent service, the team responded within an hour and resolved our analytics setup question.", score: 1.0, theme: 'support quality', permalink: null },
            ]},
          ],
        };
      }()),
    };
  }

  // ── Phase 2 PR 3: wizard action handlers ─────────────────────────
  //
  // The wizard module (`AMCP_TI_WIZARD`) delegates button clicks back to
  // these helpers via `window.AMCP_TI_WIZARD_ACTIONS`. They mirror the
  // OAuth/picker/disconnect flows that settings.js already implements;
  // we don't import settings.js's wire functions because they are
  // tightly bound to settings-page DOM (status spans, card layout).

  // Map from integration_id (returned by /api/client/integrations/status)
  // to the DOM id of the legacy card on Settings.html. Used by the wizard
  // to deep-link users to mid-flow editing surfaces. The mapping is not
  // 1:1 with the integration_id — settings.js groups HubSpot+Salesforce
  // into one CRM card, and the Stripe webhook is the "Revenue" card.
  const LEGACY_CARD_IDS = {
    ga4:            'legacy-ga4-card',
    gsc:            'legacy-gsc-card',
    hubspot:        'legacy-crm-card',
    salesforce:     'legacy-crm-card',
    stripe_webhook: 'legacy-revenue-webhook-card',
    authority:      'legacy-authority-card',
  };

  function legacyCardUrl(integrationId) {
    const id = LEGACY_CARD_IDS[integrationId];
    let url = id ? '/Settings.html#' + id : '/Settings.html';
    // Preserve admin impersonation across the deep-link. authedFetch
    // already does this for /api/* calls; nav links need it explicitly
    // since the browser strips query params when following an anchor href.
    try {
      const asSlug = new URL(window.location.href).searchParams.get('as');
      if (asSlug) {
        url = url.indexOf('#') >= 0
          ? url.replace('#', '?as=' + encodeURIComponent(asSlug) + '#')
          : url + '?as=' + encodeURIComponent(asSlug);
      }
    } catch (_) { /* URL parse error → no slug appended */ }
    return url;
  }

  async function startGoogleOauthForId(integrationId, btn) {
    // Maps integrationId → start-link path. Mirrors settings.js's startGoogleOauth.
    const paths = {
      ga4:        '/api/client/ga4/start-link',
      gsc:        '/api/client/gsc/start-link',
      hubspot:    '/api/client/crm/start-link?provider=hubspot',
      salesforce: '/api/client/crm/start-link?provider=salesforce',
    };
    const path = paths[integrationId];
    if (!path) {
      // Authority + Stripe webhook don't OAuth-connect; route them to Settings.
      window.location.href = legacyCardUrl(integrationId);
      return;
    }
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Opening Google…';
    try {
      const r = await window.AMCP.authedFetch(path, { method: 'POST' });
      const j = await r.json();
      if (j && j.url) { window.location.href = j.url; return; }
      throw new Error((j && (j.customer_message || j.error_code)) || 'Could not start');
    } catch (err) {
      alert('Could not connect: ' + (err.message || err));
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function openInlinePickerForId(integrationId, btn, mountTarget) {
    // The runInlinePicker function lives in settings.js — we expose it on
    // window in Step 6 below so this cross-module call works. Phase 2 PR 1
    // added the mountTarget option so the picker renders into the wizard's
    // .cc-wizard-step-body div without clobbering the wizard's nav buttons.
    if (typeof window.runInlinePicker !== 'function') {
      alert('Picker module not loaded — refresh and try again.');
      return;
    }
    if (integrationId === 'ga4') {
      window.runInlinePicker({
        anchorBtn:    btn,
        mountTarget:  mountTarget,
        listPath:     '/api/client/ga4/properties',
        listKey:      'properties',
        selectPath:   '/api/client/ga4/select-property',
        buildBody:    function (p) { return { property_id: p.propertyId, property_label: p.displayName || p.propertyId }; },
        isValid:      function (p) { return !!p.propertyId; },
        rowLabel:     function (p) { return p.displayName || p.propertyId || ''; },
        rowSubLabel:  function (p) { return p.propertyId || ''; },
        emptyMessage: 'No GA4 properties on this Google account. Create one in Analytics first.',
        intro:        'Pick the GA4 property Advocate should pull traffic from. Selecting a property triggers a backfill — this can take 30 seconds.',
      });
    } else if (integrationId === 'gsc') {
      window.runInlinePicker({
        anchorBtn:    btn,
        mountTarget:  mountTarget,
        listPath:     '/api/client/gsc/sites',
        listKey:      'sites',
        selectPath:   '/api/client/gsc/select-site',
        buildBody:    function (s) { return { site_url: s.siteUrl }; },
        isValid:      function (s) { return !!s.siteUrl; },
        rowLabel:     function (s) { return s.siteUrl || ''; },
        rowSubLabel:  function (s) { return s.permissionLevel || ''; },
        emptyMessage: 'No verified sites on this Google account. Add and verify a site in Search Console first.',
        intro:        'Pick the site Advocate should pull data from. Selecting a site triggers an 18-month backfill — this can take 30 seconds.',
      });
    }
  }

  function dispatchHubAction(integrationId, action, btn) {
    // Disconnect / resync / configure / generate / rotate / edit — Phase 2
    // mid-wizard handling: the simplest correct behavior is to send users
    // to the Settings page where the legacy editing surfaces live. The
    // wizard is for happy-path setup; advanced edits happen elsewhere.
    window.location.href = legacyCardUrl(integrationId);
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
