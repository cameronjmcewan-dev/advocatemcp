/* Competitor Radar section — Pro-only (admin always sees it).
 *
 * Fetches GET /api/client/radar (which combines summary, basket, losses) and
 * renders 3 KPI sparklines, a recent polls table, a weekly trend, and a
 * basket manager with add/remove CRUD.
 *
 * Registers as window.AMCP_SECTIONS['radar']. */
(function () {
  'use strict';

  var rendered = false;
  var abortCtrl = null;

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTs(ts) {
    if (!ts) return '—';
    try {
      var d = new Date(ts);
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return esc(ts); }
  }

  function currentSlug() {
    return (window.AMCP_DATA && window.AMCP_DATA.slug) ||
      new URLSearchParams(window.location.search).get('slug') || '';
  }

  function currentPlan() {
    return (window.AMCP_DATA && window.AMCP_DATA.plan) || 'free';
  }

  function showError(msg) {
    var errEl = document.getElementById('radar-error');
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.classList.add('show');
  }

  function clearError() {
    var errEl = document.getElementById('radar-error');
    if (!errEl) return;
    errEl.textContent = '';
    errEl.classList.remove('show');
  }

  function kpi(label, value, hint, sparkValues) {
    var sparkId = 'radar-spark-' + label.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return '<div class="kpi-card">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
        '<div>' +
          '<div class="kpi-label">' + esc(label) + '</div>' +
          '<div class="kpi-val">' + esc(String(value)) + '</div>' +
          '<div class="kpi-hint">' + esc(hint) + '</div>' +
        '</div>' +
        '<div id="' + sparkId + '" style="width:60px;height:20px;flex-shrink:0"></div>' +
      '</div>' +
    '</div>';
  }

  // Compute citation rate over the most recent N weeks. Returns array of
  // { week: '2026-W14', rate: 0.xx, wins, total } with the oldest first.
  function bucketWeekly(polls, weeks) {
    var buckets = [];
    var now = new Date();
    for (var i = weeks - 1; i >= 0; i--) {
      var end = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
      var start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
      buckets.push({ start: start, end: end, wins: 0, total: 0 });
    }
    (polls || []).forEach(function (p) {
      if (!p.polled_at) return;
      var t = new Date(p.polled_at).getTime();
      if (isNaN(t)) return;
      for (var i = 0; i < buckets.length; i++) {
        if (t >= buckets[i].start.getTime() && t < buckets[i].end.getTime()) {
          buckets[i].total++;
          if (p.tenant_cited) buckets[i].wins++;
          break;
        }
      }
    });
    return buckets.map(function (b) {
      return {
        wins: b.wins,
        total: b.total,
        rate: b.total > 0 ? b.wins / b.total : 0,
      };
    });
  }

  function renderKpis(summary, weekly) {
    var grid = document.getElementById('radar-kpis');
    if (!grid) return;

    var basketSize   = summary && typeof summary.basket_size === 'number' ? summary.basket_size : 0;
    var citationRate = summary && typeof summary.citation_rate_7d === 'number' ? summary.citation_rate_7d : 0;
    var wins7d       = summary && typeof summary.wins_7d === 'number' ? summary.wins_7d : 0;

    var rateSpark = weekly.map(function (w) { return Math.round(w.rate * 100); });
    var winsSpark = weekly.map(function (w) { return w.wins; });
    var sizeSpark = [basketSize]; // static — no history for basket size

    grid.innerHTML =
      kpi('Basket size',        basketSize,                                                  'Queries we poll weekly', sizeSpark) +
      kpi('Citation rate (7d)', (citationRate * 100).toFixed(1) + '%',                        'Polls where we were cited', rateSpark) +
      kpi('Wins (7d)',          wins7d,                                                       'Cited polls last 7 days', winsSpark);

    // Paint sparklines post-DOM.
    var rateEl = document.getElementById('radar-spark-citationrate7d');
    if (rateEl && rateSpark.length) AMCP_UI.sparkline(rateEl, rateSpark);
    var winsEl = document.getElementById('radar-spark-wins7d');
    if (winsEl && winsSpark.length) AMCP_UI.sparkline(winsEl, winsSpark);
    var sizeEl = document.getElementById('radar-spark-basketsize');
    if (sizeEl) AMCP_UI.sparkline(sizeEl, sizeSpark);
  }

  function renderTrend(weekly) {
    var wrap = document.getElementById('radar-trend');
    if (!wrap) return;
    if (!weekly || weekly.length === 0) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:8px 0">Not enough data yet.</div>';
      return;
    }
    var vals = weekly.map(function (w) { return Math.round(w.rate * 100); });
    var totals = weekly.map(function (w) { return w.total; });

    // Inline SVG mini-chart stretched full width.
    var W = 600, H = 60, pad = 6;
    var step = vals.length > 1 ? (W - pad * 2) / (vals.length - 1) : 0;
    var accent = window.AMCP_THEME ? window.AMCP_THEME.accent() : '#3d0a22';
    var accentDim = window.AMCP_THEME ? window.AMCP_THEME.accentDim() : 'rgba(61,10,34,.18)';

    var pts = vals.map(function (v, i) {
      var x = pad + i * step;
      var y = H - pad - (v / 100) * (H - pad * 2);
      return x.toFixed(2) + ',' + y.toFixed(2);
    }).join(' ');
    var areaPts = pts + ' ' + (W - pad).toFixed(2) + ',' + (H - pad).toFixed(2) +
                  ' ' + pad.toFixed(2) + ',' + (H - pad).toFixed(2);

    var labels = weekly.map(function (w, i) {
      return '<div style="flex:1;text-align:center;font-size:var(--tx-xs);color:var(--muted)">' +
             'W' + (i + 1) + ' <span style="color:var(--text)">' + Math.round(w.rate * 100) + '%</span>' +
             ' <span style="color:var(--muted)">(' + w.wins + '/' + w.total + ')</span>' +
             '</div>';
    }).join('');

    wrap.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" width="100%" height="' + H + '" aria-hidden="true">' +
        '<polygon points="' + areaPts + '" fill="' + accentDim + '" stroke="none"/>' +
        '<polyline points="' + pts + '" fill="none" stroke="' + accent + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>' +
      '<div style="display:flex;margin-top:6px">' + labels + '</div>';
    // Silence linter — totals kept for future reuse.
    void totals;
  }

  function renderByBot(summary) {
    var wrap = document.getElementById('radar-by-bot');
    if (!wrap) return;
    var rows = (summary && Array.isArray(summary.by_bot)) ? summary.by_bot : [];
    if (rows.length === 0) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:8px 0">No polls yet — wait for the next weekly run.</div>';
      return;
    }
    var cells = rows.map(function (r) {
      var label = r.bot === 'perplexity' ? 'Perplexity' : (r.bot === 'openai' ? 'ChatGPT (OpenAI)' : esc(r.bot));
      var rate  = typeof r.citation_rate === 'number' ? (r.citation_rate * 100).toFixed(1) + '%' : '—';
      var rank  = typeof r.avg_rank === 'number' && r.avg_rank ? r.avg_rank.toFixed(1) : '—';
      return '<div class="kpi-card" style="flex:1">' +
        '<div class="kpi-label">' + label + '</div>' +
        '<div class="kpi-val">' + rate + '</div>' +
        '<div class="kpi-hint">' + r.cited + '/' + r.total + ' polls cited · avg rank ' + rank + '</div>' +
      '</div>';
    }).join('');
    wrap.innerHTML = '<div style="display:flex;gap:12px;flex-wrap:wrap">' + cells + '</div>';
  }

  function renderDescriptors(summary) {
    var wrap = document.getElementById('radar-descriptors');
    if (!wrap) return;
    var rows = (summary && Array.isArray(summary.top_descriptors)) ? summary.top_descriptors : [];
    if (rows.length === 0) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:8px 0">No descriptors extracted yet. Descriptors surface when an AI cites you by name in its answer.</div>';
      return;
    }
    var chips = rows.map(function (r) {
      return '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;' +
        'border:1px solid var(--border);border-radius:999px;font-size:var(--tx-sm);' +
        'background:var(--bg2)">' +
        esc(r.descriptor) +
        '<span style="color:var(--muted);font-size:var(--tx-xs)">' + r.count + '</span>' +
      '</span>';
    }).join(' ');
    wrap.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:4px 0">' + chips + '</div>';
  }

  function renderAuthority(authority) {
    var wrap = document.getElementById('radar-authority');
    if (!wrap) return;
    var rows = (authority && Array.isArray(authority.authorities)) ? authority.authorities : [];
    if (rows.length === 0) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:8px 0">No polls yet &mdash; wait for the next weekly run, then this lists the sites AI reaches for when answering about your category.</div>';
      return;
    }
    var top = rows.slice(0, 12);
    var tRows = top.map(function (a) {
      var share = typeof a.share_of_polls === 'number'
        ? (a.share_of_polls * 100).toFixed(0) + '%'
        : '—';
      var bots = Array.isArray(a.by_bot) && a.by_bot.length > 0
        ? a.by_bot.map(function (b) {
            var label = b.bot === 'perplexity' ? 'PPX' : (b.bot === 'openai' ? 'GPT' : esc(b.bot));
            return '<span style="display:inline-block;padding:1px 6px;margin-right:4px;border:1px solid var(--border);border-radius:4px;font-size:var(--tx-xs);color:var(--muted)">' +
              label + ' ' + b.count + '</span>';
          }).join('')
        : '<span style="color:var(--muted);font-size:var(--tx-xs)">—</span>';
      return '<tr>' +
        '<td style="font-size:var(--tx-sm);font-family:var(--mono)">' + esc(a.domain) + '</td>' +
        '<td style="font-size:var(--tx-sm);text-align:right;white-space:nowrap">' + a.polls_cited_in + '</td>' +
        '<td style="font-size:var(--tx-sm);text-align:right;color:var(--muted);white-space:nowrap">' + share + '</td>' +
        '<td style="white-space:nowrap">' + bots + '</td>' +
        '</tr>';
    }).join('');
    wrap.innerHTML =
      '<table style="width:100%"><thead><tr>' +
        '<th style="text-align:left">Domain</th>' +
        '<th style="text-align:right">Polls</th>' +
        '<th style="text-align:right">Share</th>' +
        '<th style="text-align:left">By provider</th>' +
      '</tr></thead><tbody>' + tRows + '</tbody></table>';
  }

  function renderPolls(polls) {
    var wrap = document.getElementById('radar-polls');
    if (!wrap) return;
    if (!Array.isArray(polls) || polls.length === 0) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:12px 20px">No polls yet — Perplexity runs on a weekly cadence.</div>';
      return;
    }
    var rows = polls.slice(0, 50).map(function (p) {
      var cited = p.tenant_cited
        ? '<span class="badge badge-green"><span class="badge-dot"></span>win</span>'
        : '<span class="badge badge-yellow"><span class="badge-dot"></span>loss</span>';
      var competitors = Array.isArray(p.competitor_domains)
        ? p.competitor_domains.slice(0, 3).map(esc).join(', ') +
          (p.competitor_domains.length > 3 ? ' +' + (p.competitor_domains.length - 3) + ' more' : '')
        : '—';
      return '<tr>' +
        '<td style="font-size:var(--tx-sm)">' + esc(p.query_phrasing || '—') + '</td>' +
        '<td>' + cited + '</td>' +
        '<td style="font-size:var(--tx-xs);color:var(--muted)">' + competitors + '</td>' +
        '<td style="font-size:var(--tx-xs);color:var(--muted);white-space:nowrap">' + esc(fmtTs(p.polled_at)) + '</td>' +
        '</tr>';
    }).join('');

    wrap.innerHTML =
      '<table><thead><tr>' +
        '<th>Query</th><th>Result</th><th>Competitors cited</th><th>Polled</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderBasket(basket) {
    var wrap = document.getElementById('radar-basket-list');
    if (!wrap) return;
    var items = Array.isArray(basket) ? basket : (basket && Array.isArray(basket.queries) ? basket.queries : []);
    if (items.length === 0) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:8px 0">Basket is empty. Add a query below to start polling.</div>';
      return;
    }
    wrap.innerHTML = items.map(function (q) {
      var id  = esc(q.id != null ? q.id : q.basket_id);
      var txt = esc(q.query_phrasing || q.query || '—');
      var src = q.is_auto_seeded ? '<span style="font-size:var(--tx-xs);color:var(--muted);margin-left:6px">auto</span>' : '';
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border)">' +
        '<div style="font-size:var(--tx-sm)">' + txt + src + '</div>' +
        '<button type="button" class="btn-sm btn-ghost" data-basket-remove="' + id + '" aria-label="Remove query">&times;</button>' +
      '</div>';
    }).join('');
  }

  // Basket CRUD handlers — wired once via delegation.
  function wireBasketHandlers() {
    var list = document.getElementById('radar-basket-list');
    if (list && !list.dataset.bound) {
      list.dataset.bound = '1';
      list.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-basket-remove]') : null;
        if (!btn) return;
        var id = btn.getAttribute('data-basket-remove');
        if (!id) return;
        removeBasketItem(id, btn);
      });
    }

    var form = document.getElementById('radar-basket-form');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = document.getElementById('radar-basket-input');
        if (!input) return;
        var qp = (input.value || '').trim();
        if (!qp) return;
        addBasketItem(qp, input);
      });
    }
  }

  function addBasketItem(qp, input) {
    var slug = currentSlug();
    var path = '/api/client/radar/basket' + (slug ? '?slug=' + encodeURIComponent(slug) : '');
    window.AMCP.authedFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_phrasing: qp }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.json();
      })
      .then(function () {
        AMCP_UI.toast('Query added to basket', 'success');
        input.value = '';
        // Re-fetch to refresh the basket list.
        rendered = false;
        render();
      })
      .catch(function (err) {
        AMCP_UI.toast('Could not add: ' + (err && err.message ? err.message : 'error'), 'error');
      });
  }

  function removeBasketItem(id, btn) {
    if (btn) btn.disabled = true;
    var slug = currentSlug();
    var path = '/api/client/radar/basket/' + encodeURIComponent(id) + (slug ? '?slug=' + encodeURIComponent(slug) : '');
    window.AMCP.authedFetch(path, { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.json();
      })
      .then(function () {
        AMCP_UI.toast('Removed from basket', 'success');
        rendered = false;
        render();
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        AMCP_UI.toast('Could not remove: ' + (err && err.message ? err.message : 'error'), 'error');
      });
  }

  function render() {
    if (rendered) return;

    // Gate on Pro tier. Admin in aggregate mode unlocks the view so they can
    // inspect any tenant's radar; tenant users on free/base see the locked card.
    var isAdminMode = window.AMCP_ADMIN_MODE === 'all';
    var isPro = currentPlan() === 'pro';
    if (!isPro && !isAdminMode) {
      rendered = true;
      document.getElementById('radar-locked').style.display = '';
      document.getElementById('radar-content').style.display = 'none';
      return;
    }

    rendered = true;
    document.getElementById('radar-locked').style.display = 'none';
    document.getElementById('radar-content').style.display = '';
    clearError();

    // In admin aggregate mode we don't have a slug baked into AMCP_DATA —
    // the user must pick a business first from the switcher. Fall back to an
    // empty state with a hint.
    var slug = currentSlug();
    if (!slug && isAdminMode) {
      document.getElementById('radar-kpis').innerHTML =
        '<div class="db-card" style="grid-column:1 / -1"><div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:8px 0">Admin aggregate: pick a business from the switcher to view its radar.</div></div>';
      document.getElementById('radar-polls').innerHTML = '';
      document.getElementById('radar-basket-list').innerHTML = '';
      document.getElementById('radar-trend').innerHTML = '';
      return;
    }

    var path = '/api/client/radar' + (slug ? '?slug=' + encodeURIComponent(slug) : '');
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    window.AMCP.authedFetch(path, { signal: abortCtrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.json();
      })
      .then(function (data) {
        var summary   = data.summary   || {};
        var basket    = data.basket    || {};
        var losses    = data.losses    || {};
        var authority = data.authority || {};
        var polls   = summary.recent_polls || losses.losses || [];
        var allPolls = (summary.recent_polls || []).concat(losses.losses || []);

        var weekly = bucketWeekly(allPolls, 6);
        renderKpis(summary, weekly);
        renderTrend(weekly);
        renderByBot(summary);
        renderDescriptors(summary);
        renderAuthority(authority);
        renderPolls(polls);
        renderBasket(basket.queries || basket);
        wireBasketHandlers();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        showError('Could not load radar data: ' + (err && err.message ? err.message : 'unknown error'));
      });
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['radar'] = render;
})();
