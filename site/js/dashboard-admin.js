/* Admin god-mode: business switcher + aggregate overview
 * Only activates when /api/client/me returns role === "admin".
 * Registers on window.AMCP_ADMIN for the shell to call. */
(function () {
  'use strict';

  var adminData = null;     // cached all-metrics response
  var currentSlug = null;   // null = "All", string = specific business

  /* ── Build the business switcher dropdown ── */
  function injectSwitcher(businesses) {
    var nav = document.getElementById('db-nav');
    if (!nav || document.getElementById('biz-switcher')) return;

    var wrap = document.createElement('div');
    wrap.id = 'biz-switcher';
    wrap.style.cssText = 'padding:8px 8px 4px;border-bottom:1px solid var(--border);margin-bottom:4px';

    var label = document.createElement('div');
    label.style.cssText = 'font-size:var(--tx-xs);color:var(--muted);padding:0 2px 4px;font-weight:500;text-transform:uppercase;letter-spacing:.06em';
    label.textContent = 'Business';

    var sel = document.createElement('select');
    sel.id = 'biz-select';
    sel.style.cssText = 'width:100%;padding:7px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-md);color:var(--text);font-family:var(--font-body);font-size:var(--tx-sm);cursor:pointer';

    var allOpt = document.createElement('option');
    allOpt.value = '__all__';
    allOpt.textContent = 'All businesses (' + businesses.length + ')';
    sel.appendChild(allOpt);

    businesses.forEach(function (b) {
      var opt = document.createElement('option');
      opt.value = b.slug;
      opt.textContent = b.name;
      sel.appendChild(opt);
    });

    sel.addEventListener('change', function () {
      var v = sel.value;
      currentSlug = v === '__all__' ? null : v;
      if (currentSlug) {
        loadSingleBusiness(currentSlug);
      } else {
        renderAdminOverview();
      }
    });

    wrap.appendChild(label);
    wrap.appendChild(sel);
    nav.parentNode.insertBefore(wrap, nav);
  }

  /* ── Switch business via page reload ──
   *
   * Section modules cache `rendered = true` after first paint, so partial
   * in-place swaps leave stale data in AI Requests / Referral Clicks / Bot
   * Activity. A full page reload with `?slug=X` is the reliable path — the
   * shell's initial metrics fetch picks up the param and every section
   * renders fresh. */
  function loadSingleBusiness(slug) {
    var url = new URL(window.location.href);
    url.searchParams.set('slug', slug);
    window.location.href = url.toString();
  }

  /* ── Render admin aggregate overview ── */
  function renderAdminOverview() {
    if (!adminData) return;

    var t = adminData.totals;
    var bizArr = adminData.businesses;

    // Update KPIs with aggregate numbers
    var kpiGrid = document.getElementById('kpi-grid');
    if (kpiGrid) {
      kpiGrid.innerHTML =
        kpiCard('Businesses', t.business_count, 'Registered tenants') +
        kpiCard('Total AI Queries', t.total_queries, 'All time across all businesses') +
        kpiCard('Total Clicks', t.total_clicks, 'All time referral clicks') +
        kpiCard('Clicks (30d)', t.total_clicks_30d, 'Last 30 days');
      kpiGrid.style.display = '';
    }

    // Hide normal overview chart row, show admin table
    var normalRow = document.querySelector('#sec-overview .db-row');
    if (normalRow) normalRow.style.display = 'none';

    var existing = document.getElementById('admin-overview-table');
    if (existing) existing.remove();

    var tableWrap = document.createElement('div');
    tableWrap.id = 'admin-overview-table';
    tableWrap.className = 'tbl-wrap';
    tableWrap.innerHTML =
      '<div class="tbl-head"><div class="tbl-head-title">All Businesses</div></div>' +
      '<table><thead><tr>' +
      '<th>Business</th><th>Slug</th><th>Plan</th><th>Queries</th><th>Clicks</th><th>CTR</th><th>Top Crawler</th>' +
      '</tr></thead><tbody>' +
      bizArr.map(function (b) {
        var a = b.analytics;
        var queries = a ? (a.total_queries || 0) : 0;
        var clicks = a ? (a.referral_clicks || 0) : 0;
        var ctr = queries > 0 ? ((clicks / queries) * 100).toFixed(1) + '%' : '--';
        var topCrawler = '--';
        if (a && a.queries_by_crawler) {
          var entries = Object.entries(a.queries_by_crawler);
          if (entries.length > 0) {
            entries.sort(function (x, y) { return y[1] - x[1]; });
            topCrawler = entries[0][0];
          }
        }
        var planBadge = b.plan === 'pro'
          ? '<span class="badge badge-accent"><span class="badge-dot"></span>Pro</span>'
          : b.plan === 'base'
            ? '<span class="badge badge-green"><span class="badge-dot"></span>Base</span>'
            : '<span class="badge badge-yellow"><span class="badge-dot"></span>Free</span>';

        return '<tr style="cursor:pointer" onclick="document.getElementById(\'biz-select\').value=\'' + b.slug + '\';document.getElementById(\'biz-select\').dispatchEvent(new Event(\'change\'))">' +
          '<td style="font-weight:500">' + esc(b.name) + '</td>' +
          '<td style="font-family:var(--font-mono);font-size:var(--tx-xs);color:var(--muted)">' + esc(b.slug) + '</td>' +
          '<td>' + planBadge + '</td>' +
          '<td>' + queries + '</td>' +
          '<td>' + clicks + '</td>' +
          '<td>' + ctr + '</td>' +
          '<td style="font-size:var(--tx-xs)">' + esc(topCrawler) + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';

    // Insert after KPI grid
    var sec = document.getElementById('sec-overview');
    if (sec && kpiGrid) {
      kpiGrid.parentNode.insertBefore(tableWrap, kpiGrid.nextSibling);
    }

    // Update insight
    var insightEl = document.getElementById('overview-insight');
    var insightText = document.getElementById('overview-insight-text');
    if (insightEl && insightText) {
      var active = bizArr.filter(function (b) { return b.analytics && b.analytics.total_queries > 0; }).length;
      insightText.textContent = active + ' of ' + t.business_count + ' businesses have received AI crawler queries. ' +
        t.total_queries + ' total queries, ' + t.total_clicks + ' referral clicks.';
      insightEl.style.display = '';
    }
  }

  /* ── Helpers ── */
  function kpiCard(label, value, hint) {
    return '<div class="kpi-card">' +
      '<div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-val">' + value + '</div>' +
      '<div class="kpi-hint">' + esc(hint) + '</div></div>';
  }

  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ── Boot: called by dashboard shell after user info loads ── */
  window.AMCP_ADMIN = {
    init: function (user) {
      if (user.role !== 'admin') return;

      // If the URL has ?slug=X, we're in single-business mode — inject the
      // switcher pre-selected to that slug but skip the aggregate render.
      var urlSlug = new URLSearchParams(window.location.search).get('slug');

      window.AMCP.authedFetch('/api/client/all-metrics')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          adminData = data;
          injectSwitcher(data.businesses);

          if (urlSlug) {
            // Single-business mode — pre-select dropdown, leave sections rendering from AMCP_DATA
            var sel = document.getElementById('biz-select');
            if (sel) sel.value = urlSlug;
            currentSlug = urlSlug;
          } else {
            // Aggregate mode — render the all-businesses overview
            renderAdminOverview();
          }
        })
        .catch(function (err) { console.error('all-metrics failed', err); });
    },
  };
})();
