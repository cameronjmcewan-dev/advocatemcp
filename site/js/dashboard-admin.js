/* Admin god-mode: business switcher + aggregate overview
 * Only activates when /api/client/me returns role === "admin".
 * Registers on window.AMCP_ADMIN for the shell to call.
 *
 * D10 enhancements on renderAdminOverview:
 *   - Sparkline column (last 7 days of queries_last_30_days per business)
 *   - "Last active" column (max timestamp from recent_queries, via fmtTs)
 *   - "Alert" column (No traffic / No data pills)
 *   - Client-side filter input (name/slug substring match)
 *   - Sort dropdown (name, queries, clicks, last active)
 */
(function () {
  'use strict';

  var adminData = null;     // cached all-metrics response
  var currentSlug = null;   // null = "All", string = specific business
  var uiState = { filter: '', sort: 'name' };

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
   * Activity. A full page reload with `?slug=X` is the reliable path, the
   * shell's initial metrics fetch picks up the param and every section
   * renders fresh. */
  function loadSingleBusiness(slug) {
    var url = new URL(window.location.href);
    url.searchParams.set('slug', slug);
    window.location.href = url.toString();
  }

  /* ── D10 helpers: derive per-row stats from analytics payload ── */

  // Last 7 days of queries from the tail of queries_last_30_days.
  function last7DayCounts(a) {
    var days = (a && a.queries_last_30_days) || [];
    var tail = days.slice(-7);
    return tail.map(function (d) { return Number(d.count) || 0; });
  }

  // Most recent query timestamp, scan recent_queries for max.
  function lastActiveTs(a) {
    var recents = (a && a.recent_queries) || [];
    if (!recents.length) return null;
    var max = null;
    for (var i = 0; i < recents.length; i++) {
      var t = recents[i].timestamp;
      if (!t) continue;
      if (max === null || t > max) max = t;
    }
    return max;
  }

  // Alert pill, catches zero-traffic and no-data states.
  function alertPill(b) {
    if (!b.analytics) {
      return '<span class="badge badge-red" title="No analytics response, likely api_key divergence or backend down"><span class="badge-dot"></span>No data</span>';
    }
    var queries30d = 0;
    var days = (b.analytics.queries_last_30_days) || [];
    for (var i = 0; i < days.length; i++) queries30d += Number(days[i].count) || 0;
    if (queries30d === 0 && (b.analytics.total_queries || 0) === 0) {
      return '<span class="badge badge-yellow" title="Zero queries in last 30 days"><span class="badge-dot"></span>No traffic</span>';
    }
    return '<span style="color:var(--muted);font-size:var(--tx-xs)">,</span>';
  }

  function sortKey(b) {
    var a = b.analytics || {};
    switch (uiState.sort) {
      case 'queries':   return -(a.total_queries || 0);
      case 'clicks':    return -(a.referral_clicks || 0);
      case 'last-active':
        var t = lastActiveTs(a);
        return t ? -new Date(t).getTime() : Infinity;
      case 'name':
      default:
        return (b.name || '').toLowerCase();
    }
  }

  function compareRows(x, y) {
    var kx = sortKey(x), ky = sortKey(y);
    if (kx < ky) return -1;
    if (kx > ky) return 1;
    return 0;
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

    // Filter + sort controls live inside the tbl-head.
    var controls =
      '<div class="tbl-head" style="gap:12px;flex-wrap:wrap">' +
        '<div class="tbl-head-title">All Businesses</div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-left:auto;flex-wrap:wrap">' +
          '<input type="text" class="fi" id="admin-filter" placeholder="Filter by name or slug" value="' + esc(uiState.filter) + '" style="max-width:220px;padding:6px 10px;font-size:var(--tx-xs)">' +
          '<select class="fi" id="admin-sort" style="max-width:200px;padding:6px 10px;font-size:var(--tx-xs);cursor:pointer">' +
            '<option value="name"' + (uiState.sort === 'name' ? ' selected' : '') + '>Name (A→Z)</option>' +
            '<option value="queries"' + (uiState.sort === 'queries' ? ' selected' : '') + '>Queries (desc)</option>' +
            '<option value="clicks"' + (uiState.sort === 'clicks' ? ' selected' : '') + '>Clicks (desc)</option>' +
            '<option value="last-active"' + (uiState.sort === 'last-active' ? ' selected' : '') + '>Last active (desc)</option>' +
          '</select>' +
        '</div>' +
      '</div>';

    tableWrap.innerHTML = controls + renderTableBody(bizArr);

    // Insert after KPI grid
    var sec = document.getElementById('sec-overview');
    if (sec && kpiGrid) {
      kpiGrid.parentNode.insertBefore(tableWrap, kpiGrid.nextSibling);
    }

    wireFilterSort();
    paintSparklines(bizArr);

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

  function renderTableBody(bizArr) {
    var filter = (uiState.filter || '').toLowerCase().trim();
    var filtered = filter
      ? bizArr.filter(function (b) {
          return (b.name || '').toLowerCase().indexOf(filter) !== -1 ||
                 (b.slug || '').toLowerCase().indexOf(filter) !== -1;
        })
      : bizArr.slice();
    filtered.sort(compareRows);

    var rows = filtered.map(function (b) {
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

      var lastTs = lastActiveTs(a);
      var lastLabel = lastTs ? (window.AMCP_UI ? AMCP_UI.fmtTs(lastTs) : String(lastTs))
                             : '<span style="color:var(--muted)">,</span>';

      var sparkId = 'admin-spark-' + b.slug;

      return '<tr data-slug="' + esc(b.slug) + '" role="button" tabindex="0" style="cursor:pointer">' +
        '<td style="font-weight:500">' + esc(b.name) + '</td>' +
        '<td style="font-family:var(--font-mono);font-size:var(--tx-xs);color:var(--muted)">' + esc(b.slug) + '</td>' +
        '<td>' + planBadge + '</td>' +
        '<td>' + queries + '</td>' +
        '<td>' + clicks + '</td>' +
        '<td>' + ctr + '</td>' +
        '<td style="font-size:var(--tx-xs)">' + esc(topCrawler) + '</td>' +
        '<td><div id="' + sparkId + '" style="width:60px;height:20px"></div></td>' +
        '<td style="font-size:var(--tx-xs);color:var(--muted);white-space:nowrap">' + lastLabel + '</td>' +
        '<td>' + alertPill(b) + '</td>' +
        '</tr>';
    }).join('');

    return '<table><thead><tr>' +
      '<th>Business</th><th>Slug</th><th>Plan</th><th>Queries</th><th>Clicks</th>' +
      '<th>CTR</th><th>Top Crawler</th><th>Trend</th><th>Last active</th><th>Alert</th>' +
      '</tr></thead><tbody id="admin-tbody">' + rows + '</tbody></table>' +
      (filtered.length === 0
        ? '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:24px;text-align:center">No businesses match "' + esc(filter) + '".</div>'
        : '');
  }

  function wireFilterSort() {
    var filterEl = document.getElementById('admin-filter');
    var sortEl = document.getElementById('admin-sort');
    var tableWrap = document.getElementById('admin-overview-table');
    if (!tableWrap) return;

    if (filterEl && !filterEl.dataset.bound) {
      filterEl.dataset.bound = '1';
      var debounce = null;
      filterEl.addEventListener('input', function () {
        clearTimeout(debounce);
        debounce = setTimeout(function () {
          uiState.filter = filterEl.value;
          redrawTableBody();
        }, 80);
      });
    }
    if (sortEl && !sortEl.dataset.bound) {
      sortEl.dataset.bound = '1';
      sortEl.addEventListener('change', function () {
        uiState.sort = sortEl.value;
        redrawTableBody();
      });
    }

    // Delegated row click → reload with slug param (mirrors the dropdown path).
    if (!tableWrap.dataset.rowBound) {
      tableWrap.dataset.rowBound = '1';
      tableWrap.addEventListener('click', function (e) {
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-slug]') : null;
        if (!tr) return;
        // Don't hijack clicks on the interactive controls row.
        if (e.target.closest('input, select, button')) return;
        loadSingleBusiness(tr.getAttribute('data-slug'));
      });
      tableWrap.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-slug]') : null;
        if (!tr) return;
        e.preventDefault();
        loadSingleBusiness(tr.getAttribute('data-slug'));
      });
    }
  }

  function redrawTableBody() {
    var tableWrap = document.getElementById('admin-overview-table');
    if (!tableWrap || !adminData) return;
    var newBody = renderTableBody(adminData.businesses);
    // Replace only the table portion, keep the tbl-head controls so the
    // inputs don't get re-rendered mid-keystroke.
    var existingTable = tableWrap.querySelector('table');
    var existingEmpty = tableWrap.querySelector('.empty-desc');
    if (existingTable) existingTable.remove();
    if (existingEmpty) existingEmpty.remove();
    tableWrap.insertAdjacentHTML('beforeend', newBody);
    paintSparklines(adminData.businesses);
  }

  function paintSparklines(bizArr) {
    if (!window.AMCP_UI) return;
    bizArr.forEach(function (b) {
      var el = document.getElementById('admin-spark-' + b.slug);
      if (!el) return;
      var vals = last7DayCounts(b.analytics);
      AMCP_UI.sparkline(el, vals, { width: 60, height: 20 });
    });
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
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ── Boot: called by dashboard shell after user info loads ── */
  window.AMCP_ADMIN = {
    init: function (user) {
      if (user.role !== 'admin') return;

      // If the URL has ?slug=X, we're in single-business mode, inject the
      // switcher pre-selected to that slug but skip the aggregate render.
      var urlSlug = new URLSearchParams(window.location.search).get('slug');

      window.AMCP.authedFetch('/api/client/all-metrics')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          adminData = data;
          injectSwitcher(data.businesses);

          if (urlSlug) {
            // Single-business mode, pre-select dropdown, leave sections rendering from AMCP_DATA
            var sel = document.getElementById('biz-select');
            if (sel) sel.value = urlSlug;
            currentSlug = urlSlug;
          } else {
            // Aggregate mode, flag for section modules (Activity) that support
            // scope=all fetches, unlock the Radar sidebar item for admin
            // inspection of any tenant's radar, then render the aggregate view.
            window.AMCP_ADMIN_MODE = 'all';
            document.body.classList.add('pro-tier');
            renderAdminOverview();
          }
        })
        .catch(function (err) { console.error('all-metrics failed', err); });
    },
  };
})();
