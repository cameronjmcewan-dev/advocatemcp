/* Recommendations section, lives-data rec cards + optimization checklist,
 * fetched from GET /api/client/recommendations (Worker-side rules over
 * analytics + /agents/:slug/profile). Replaces the previous static
 * template-based cards.
 *
 * Registers as window.AMCP_SECTIONS['recommendations']. */
(function () {
  'use strict';

  var rendered = false;
  var abortCtrl = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function priorityBadge(p) {
    if (p === 'high') return '<span class="badge badge-red" style="margin-left:auto"><span class="badge-dot"></span>high</span>';
    if (p === 'med')  return '<span class="badge badge-yellow" style="margin-left:auto"><span class="badge-dot"></span>med</span>';
    return '<span class="badge badge-accent" style="margin-left:auto"><span class="badge-dot"></span>low</span>';
  }

  function renderRecs(recs) {
    var grid = document.getElementById('rec-grid');
    if (!grid) return;
    if (!Array.isArray(recs) || !recs.length) {
      grid.innerHTML = '<div class="db-card" style="grid-column:1/-1">' +
        '<div class="empty">' +
          '<div class="empty-icon"><i data-lucide="check-circle"></i></div>' +
          '<div class="empty-title">Everything looks good, no active recommendations.</div>' +
          '<div class="empty-desc">Keep monitoring your dashboard as traffic grows.</div>' +
        '</div></div>';
      if (window.lucide) lucide.createIcons();
      return;
    }
    grid.innerHTML = recs.map(function (r) {
      var action = (r.action_label && r.action_url)
        ? '<div style="margin-top:10px"><a href="' + esc(r.action_url) + '" class="btn-sm btn-ghost" ' +
             'style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;font-size:var(--tx-xs)">' +
             esc(r.action_label) +
          '</a></div>'
        : '';
      var impact = r.impact
        ? '<div style="margin-top:8px;font-size:var(--tx-xs);color:var(--muted);font-style:italic">' + esc(r.impact) + '</div>'
        : '';
      return '<div class="rec-card">' +
        '<div class="rec-card-title">' +
          '<div class="rec-icon"><i data-lucide="lightbulb"></i></div>' +
          '<span>' + esc(r.title || 'Recommendation') + '</span>' +
          priorityBadge(r.priority) +
        '</div>' +
        '<div class="rec-card-body">' + esc(r.body || '') + '</div>' +
        impact +
        action +
      '</div>';
    }).join('');
  }

  function renderChecklist(items) {
    var wrap = document.getElementById('checklist');
    if (!wrap) return;
    if (!Array.isArray(items) || !items.length) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted)">No checklist items.</div>';
      return;
    }
    wrap.innerHTML = items.map(function (item) {
      var done = !!item.done;
      return '<div class="check-item">' +
        '<div class="check-dot ' + (done ? 'check-dot-done' : 'check-dot-pend') + '">' +
          (done ? '<i data-lucide="check"></i>' : '') +
        '</div>' +
        '<span style="' + (done ? '' : 'color:var(--muted)') + '">' + esc(item.label || '') + '</span>' +
      '</div>';
    }).join('');
  }

  function showSkeleton() {
    var grid = document.getElementById('rec-grid');
    if (grid) grid.innerHTML =
      '<div class="skeleton" style="height:120px;border-radius:12px"></div>' +
      '<div class="skeleton" style="height:120px;border-radius:12px"></div>';
    var wrap = document.getElementById('checklist');
    if (wrap) wrap.innerHTML =
      '<div class="skeleton" style="height:20px;border-radius:4px"></div>' +
      '<div class="skeleton" style="height:20px;border-radius:4px;margin-top:8px"></div>' +
      '<div class="skeleton" style="height:20px;border-radius:4px;margin-top:8px"></div>';
  }

  function showError(msg) {
    var grid = document.getElementById('rec-grid');
    if (grid) grid.innerHTML = '<div class="db-card" style="grid-column:1/-1">' +
      '<div class="empty">' +
        '<div class="empty-title">Couldn\'t load recommendations</div>' +
        '<div class="empty-desc">' + esc(msg || 'Try refreshing in a moment.') + '</div>' +
      '</div></div>';
    var wrap = document.getElementById('checklist');
    if (wrap) wrap.innerHTML =
      '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted)">,</div>';
  }

  function render() {
    if (rendered) return;
    rendered = true;

    showSkeleton();
    var slug = (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
    var path = '/api/client/recommendations' + (slug ? '?slug=' + encodeURIComponent(slug) : '');

    // Abort any in-flight fetch before starting a new one so late-resolving
    // promises don't write to stale DOM if the user switches sections.
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    window.AMCP.authedFetch(path, { signal: abortCtrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        renderRecs(data && data.recommendations);
        renderChecklist(data && data.checklist);
        if (window.lucide) lucide.createIcons();
      })
      .catch(function (err) {
        // AbortError is benign, skip reporting.
        if (err && err.name === 'AbortError') return;
        showError(String(err && err.message || err));
      });
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['recommendations'] = render;
})();
