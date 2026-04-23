/* v2 Competitor Radar page — Pro-gated.
 *
 * Data lives at /api/client/radar and returns:
 *   { summary: { citation_rate, polls_this_week, wins_this_week, by_bot[] },
 *     basket:  { queries[] },
 *     losses:  { items[] },
 *     authority_report: { top_missing_keyword, ... } }
 *
 * Non-Pro tenants (plan === 'free' or 'base' and role !== 'admin') see a
 * locked-feature teaser with a clear upgrade path. Until a Stripe
 * customer-portal upgrade endpoint is wired, the CTA mails
 * hello@advocatemcp.com with a prefilled subject so we can process the
 * upgrade manually. That's intentionally friction-y — it guarantees a
 * founder touches every upgrade conversation in the early days. */
(function () {
  'use strict';

  const DEMO = {
    summary: {
      citation_rate: 0.64,
      polls_this_week: 48,
      wins_this_week: 31,
      by_bot: [
        { bot: 'Perplexity', rate: 0.71 },
        { bot: 'ChatGPT',    rate: 0.62 },
        { bot: 'Claude',     rate: 0.58 },
        { bot: 'Gemini',     rate: 0.50 },
      ],
    },
    basket: {
      queries: [
        { query: 'best florist in austin',                win_rate: 0.72, tests: 14, trend: 'up' },
        { query: 'same day delivery flowers austin',      win_rate: 0.58, tests: 11, trend: 'up' },
        { query: 'wedding florist south austin',          win_rate: 0.41, tests: 9,  trend: 'flat' },
        { query: 'corporate flower arrangements austin',  win_rate: 0.33, tests: 7,  trend: 'down' },
        { query: 'sympathy arrangements austin',          win_rate: 0.28, tests: 7,  trend: 'up' },
      ],
    },
    losses: {
      items: [
        { query: 'wedding florist south austin',         competitor: 'petalandtwig.com',    rank: 1, bot: 'Perplexity' },
        { query: 'corporate flower arrangements austin', competitor: 'gardengroveatx.com',  rank: 1, bot: 'ChatGPT' },
        { query: 'sympathy arrangements austin',         competitor: 'petalandtwig.com',    rank: 2, bot: 'Claude' },
      ],
    },
    authority_report: {
      top_missing_keyword: 'wedding florist',
      missing_keywords: ['wedding florist', 'same-day sympathy', 'corporate retainer'],
      suggestion: 'Add "wedding florist" to your services list — it came up in 4 of 5 losing answers this week.',
    },
  };

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    const r = await af('/api/client/radar');
    if (r.ok) return await r.json();
    if (r.status === 402 || r.status === 403) {
      // Plan-gated — surface the gate explicitly so render() shows the
      // upsell instead of an empty page.
      return { __gated: true };
    }
    return {};
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtPct(v) { return v == null || isNaN(v) ? '—' : Math.round(v * 100) + '%'; }
  function fmtCount(v) { return v == null || isNaN(v) ? '—' : Number(v).toLocaleString(); }
  function trendGlyph(t) {
    if (t === 'up')   return '<span style="color:var(--sage)">↑</span>';
    if (t === 'down') return '<span style="color:var(--red)">↓</span>';
    return '<span style="color:var(--muted)">→</span>';
  }

  function isPro() {
    const d = window.AMCP_DATA || {};
    return d.plan === 'pro' || d.user_role === 'admin';
  }

  function renderLocked() {
    const mailtoSubject = encodeURIComponent('Upgrade to Pro: Competitor Radar');
    const bizName = (window.AMCP_DATA && window.AMCP_DATA.business_name) || '';
    const slug    = (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
    const mailtoBody = encodeURIComponent(
      `Hi Advocate team,\n\nI'd like to upgrade to Pro to unlock Competitor Radar.\n\nBusiness: ${bizName}\nSlug: ${slug}\n\nThanks!`
    );
    return `
      <div class="plain-banner" style="background:var(--maroon-wash);border-color:var(--maroon-tint)">
        <strong>Pro feature.</strong>
        Competitor Radar tracks how often AI picks you vs. every nearby competitor — on queries your customers are actually asking.
      </div>

      <div class="row">
        <div class="card-dash" style="background:var(--paper);">
          <div class="card-head">
            <div>
              <h3>Unlock Competitor Radar</h3>
              <div class="sub">See exactly where you're winning and losing against local rivals</div>
            </div>
            <span class="chip maroon">PRO</span>
          </div>

          <ul style="list-style:none;padding:0;margin:16px 0;display:grid;gap:12px;">
            <li style="display:flex;align-items:flex-start;gap:12px;font-size:14.5px;line-height:1.55;color:var(--ink-2)">
              <span style="width:22px;height:22px;border-radius:6px;background:var(--maroon-tint);color:var(--maroon);display:grid;place-items:center;flex-shrink:0;font-size:13px">✓</span>
              <span><strong>Weekly polls</strong> — every relevant query, tested across Perplexity, ChatGPT, Claude, and Gemini.</span>
            </li>
            <li style="display:flex;align-items:flex-start;gap:12px;font-size:14.5px;line-height:1.55;color:var(--ink-2)">
              <span style="width:22px;height:22px;border-radius:6px;background:var(--maroon-tint);color:var(--maroon);display:grid;place-items:center;flex-shrink:0;font-size:13px">✓</span>
              <span><strong>Share of Model</strong> — what percentage of AI answers named you this week vs. each competitor.</span>
            </li>
            <li style="display:flex;align-items:flex-start;gap:12px;font-size:14.5px;line-height:1.55;color:var(--ink-2)">
              <span style="width:22px;height:22px;border-radius:6px;background:var(--maroon-tint);color:var(--maroon);display:grid;place-items:center;flex-shrink:0;font-size:13px">✓</span>
              <span><strong>Loss tracking</strong> — when AI picked someone else, we log which competitor domains got cited and at what rank, so you can see who's beating you week over week.</span>
            </li>
            <li style="display:flex;align-items:flex-start;gap:12px;font-size:14.5px;line-height:1.55;color:var(--ink-2)">
              <span style="width:22px;height:22px;border-radius:6px;background:var(--maroon-tint);color:var(--maroon);display:grid;place-items:center;flex-shrink:0;font-size:13px">✓</span>
              <span><strong>Keyword authority gaps</strong> — the single change most likely to tip next week's answers toward you.</span>
            </li>
            <li style="display:flex;align-items:flex-start;gap:12px;font-size:14.5px;line-height:1.55;color:var(--ink-2)">
              <span style="width:22px;height:22px;border-radius:6px;background:var(--maroon-tint);color:var(--maroon);display:grid;place-items:center;flex-shrink:0;font-size:13px">✓</span>
              <span><strong>Weekly digest email</strong> — Friday morning, a plain-English rundown of wins, losses, and one thing to try next week.</span>
            </li>
          </ul>

          <div style="background:var(--paper-2);border:1px solid var(--line);border-radius:10px;padding:20px;margin-top:8px;display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center;">
            <div>
              <div style="font-family:var(--serif);font-size:30px;color:var(--ink);line-height:1;">$349<small style="font-size:14px;color:var(--muted);font-family:var(--sans);margin-left:4px;">/month</small></div>
              <div style="font-size:13px;color:var(--muted);margin-top:4px;">Cancel any time · 14-day money-back guarantee</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <a href="mailto:hello@advocatemcp.com?subject=${mailtoSubject}&body=${mailtoBody}" class="btn btn-primary btn-sm">Upgrade now →</a>
              <a href="/Pricing.html" class="btn btn-ghost btn-sm" target="_blank" rel="noopener">See all plans</a>
            </div>
          </div>
        </div>

        <div class="card-dash" style="background:var(--paper-2);">
          <div class="card-head"><div><h3>What you'd see</h3><div class="sub">Preview of the Pro dashboard</div></div></div>
          <div style="filter:blur(3px) saturate(.7);pointer-events:none;user-select:none;">
            <div class="radar-you" style="color:var(--maroon)">64%</div>
            <div class="sub" style="color:var(--muted);font-size:13px;margin-top:4px;">AI picked you 64% of the time this week</div>
            <div style="margin-top:20px">
              <div class="bot-row"><span class="name">You</span><div class="track"><div class="fill" style="width:64%"></div></div><span class="n">64%</span></div>
              <div class="bot-row"><span class="name">Petal &amp; Twig</span><div class="track"><div class="fill" style="width:22%;background:var(--line-2);"></div></div><span class="n">22%</span></div>
              <div class="bot-row"><span class="name">Garden Grove</span><div class="track"><div class="fill" style="width:14%;background:var(--line-2);"></div></div><span class="n">14%</span></div>
            </div>
          </div>
          <p style="font-size:12.5px;color:var(--muted);margin-top:14px;text-align:center;font-style:italic;">Sample data · your real figures appear after you upgrade.</p>
        </div>
      </div>
    `;
  }

  function renderPro(radar) {
    const s = (radar && radar.summary) || {};
    const basket = (radar && radar.basket && radar.basket.queries) || [];
    const losses = (radar && radar.losses && radar.losses.items) || [];
    const auth   = (radar && radar.authority_report) || {};

    const rate = fmtPct(s.citation_rate);

    const byBotBars = (s.by_bot || []).length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">No per-bot breakdown yet — first weekly poll is still running.</div>`
      : s.by_bot.map(b => {
          const pct = Math.round((b.rate || 0) * 100);
          return `<div class="bot-row">
            <span class="name">${esc(b.bot)}</span>
            <div class="track"><div class="fill" style="width:${pct}%"></div></div>
            <span class="n">${pct}%</span>
          </div>`;
        }).join('');

    const basketRows = basket.length === 0
      ? `<tr><td colspan="4" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">Your query basket is empty. Add queries to start tracking.</td></tr>`
      : basket.map(q => `<tr>
          <td><span class="q">${esc(q.query)}</span></td>
          <td class="t" style="font-weight:500;color:${(q.win_rate || 0) >= 0.5 ? 'var(--sage)' : 'var(--red)'}">${fmtPct(q.win_rate)}</td>
          <td class="t">${fmtCount(q.tests)}</td>
          <td>${trendGlyph(q.trend)}</td>
        </tr>`).join('');

    const lossRows = losses.length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">No recent losses — you're winning your basket.</div>`
      : losses.map(l => `<div class="feed-item">
          <span class="dot" style="background:var(--red)"></span>
          <div>
            <strong>${esc(l.competitor)}</strong> won on <em>"${esc(l.query)}"</em>
            ${l.why ? `<div class="t" style="margin-top:4px">${esc(l.why)}</div>` : ''}
          </div>
        </div>`).join('');

    const tipHtml = auth.suggestion
      ? `<div class="radar-tip"><strong>Tip for next week:</strong> ${esc(auth.suggestion)}</div>`
      : auth.top_missing_keyword
        ? `<div class="radar-tip"><strong>Tip:</strong> Add "<em>${esc(auth.top_missing_keyword)}</em>" to your services — it came up most in queries where a competitor won.</div>`
        : '';

    return `
      <div class="plain-banner">
        <strong>In plain English:</strong>
        Every week we ask the major AI tools the questions your customers would ask, and log whether you or a competitor got named.
      </div>

      <div class="kpis">
        <div class="kpi"><div class="head"><div class="k">Citation rate</div></div><div class="v tabular">${rate}</div><div class="d">This week's average</div></div>
        <div class="kpi"><div class="head"><div class="k">Wins</div></div><div class="v tabular">${fmtCount(s.wins_this_week)}</div><div class="d">Queries where AI named you</div></div>
        <div class="kpi"><div class="head"><div class="k">Total polls</div></div><div class="v tabular">${fmtCount(s.polls_this_week)}</div><div class="d">Queries tested this week</div></div>
        <div class="kpi"><div class="head"><div class="k">Tracked queries</div></div><div class="v tabular">${fmtCount(basket.length)}</div><div class="d">In your basket</div></div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>Citation rate by AI tool</h3><div class="sub">Where you perform strongest</div></div></div>
          ${byBotBars}
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>Next move</h3><div class="sub">Authority gap we'd close first</div></div></div>
          ${tipHtml || `<p style="color:var(--muted);font-size:13.5px">No authority gaps surfaced yet. Check back after next week's poll.</p>`}
        </div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head"><div><h3>Query basket</h3><div class="sub">The phrasings we poll weekly — edit any time</div></div></div>
          <table class="tbl">
            <thead><tr><th>Query</th><th>Win rate</th><th>Tests this week</th><th>Trend</th></tr></thead>
            <tbody>${basketRows}</tbody>
          </table>
        </div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head"><div><h3>Recent losses</h3><div class="sub">Who beat you and what worked for them</div></div></div>
          ${lossRows}
        </div>
      </div>
    `;
  }

  function render(radar) {
    if (radar && radar.__gated) return renderLocked();
    if (!isPro()) return renderLocked();
    return renderPro(radar || {});
  }

  window.AMCP_RADAR = { demo: () => DEMO, fetch: fetchReal, render };
})();
