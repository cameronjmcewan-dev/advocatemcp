// dashboard-ui.js, shared UI primitives for the dashboard.
// All section modules consume helpers through window.AMCP_UI so visual
// language stays consistent (sparklines, count-ups, delta chips, the
// single drawer, and the single toast stack).
(function () {
  'use strict';

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function accent() {
    return (window.AMCP_THEME && window.AMCP_THEME.accent)
      ? window.AMCP_THEME.accent()
      : '#3d0a22';
  }
  function accentDim() {
    return (window.AMCP_THEME && window.AMCP_THEME.accentDim)
      ? window.AMCP_THEME.accentDim()
      : 'rgba(61,10,34,.18)';
  }

  // ── sparkline: 60×20 inline SVG polyline ─────────────────────────────────
  function sparkline(el, values, opts) {
    if (!el) return;
    opts = opts || {};
    var W = opts.width  || 60;
    var H = opts.height || 20;
    var stroke = opts.stroke || accent();
    var fill   = opts.fill   || accentDim();
    var vals = Array.isArray(values) ? values.map(Number) : [];
    if (!vals.length) { el.innerHTML = ''; return; }

    var min = Math.min.apply(null, vals);
    var max = Math.max.apply(null, vals);
    var range = max - min || 1;
    var pad = 1;
    var step = vals.length > 1 ? (W - pad * 2) / (vals.length - 1) : 0;
    var pts = vals.map(function (v, i) {
      var x = pad + i * step;
      var y = H - pad - ((v - min) / range) * (H - pad * 2);
      return x.toFixed(2) + ',' + y.toFixed(2);
    }).join(' ');

    // Area polygon closes the path along the baseline for a soft fill.
    var areaPts = pts + ' ' + (W - pad).toFixed(2) + ',' + (H - pad).toFixed(2)
                      + ' ' + pad.toFixed(2)       + ',' + (H - pad).toFixed(2);

    el.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<polygon points="' + areaPts + '" fill="' + fill + '" stroke="none"/>' +
        '<polyline points="' + pts + '" fill="none" stroke="' + stroke + '" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
  }

  // ── countUp: rAF tween of a numeric value ────────────────────────────────
  // A monotonically increasing token is stamped on the element on each call
  // so that if a second countUp lands on the same element mid-tween, the
  // earlier rAF loop bails on its next frame instead of fighting the new one.
  var countUpSeq = 0;
  function countUp(el, from, to, durationMs) {
    if (!el) return;
    var start  = Number(from) || 0;
    var end    = Number(to)   || 0;
    var dur    = Math.max(50, Number(durationMs) || 600);
    var t0     = null;
    var token  = ++countUpSeq;
    el.dataset.countUpToken = String(token);

    function step(ts) {
      if (el.dataset.countUpToken !== String(token)) return; // superseded
      if (t0 === null) t0 = ts;
      var elapsed = ts - t0;
      var pct = Math.min(1, elapsed / dur);
      // easeOutQuad for a calmer settle
      var eased = 1 - (1 - pct) * (1 - pct);
      var current = start + (end - start) * eased;
      // Whole numbers render whole, fractional render with 1 decimal.
      if (Number.isInteger(start) && Number.isInteger(end)) {
        el.textContent = Math.round(current).toLocaleString();
      } else {
        el.textContent = current.toFixed(1);
      }
      if (pct < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ── deltaChip: ↑/↓ %-change badge HTML ───────────────────────────────────
  function deltaChip(current, previous) {
    var c = Number(current);
    var p = Number(previous);
    if (!p || !isFinite(p) || p === 0) return '';
    var change = ((c - p) / p) * 100;
    if (!isFinite(change)) return '';
    var abs = Math.abs(change).toFixed(0);
    if (change > 0) {
      return '<span class="badge badge-green" title="vs. previous period">↑ ' + abs + '%</span>';
    }
    if (change < 0) {
      return '<span class="badge badge-red" title="vs. previous period">↓ ' + abs + '%</span>';
    }
    return '';
  }

  // ── swapContent: fade-out → replace → fade-in (300ms) ────────────────────
  function swapContent(el, newHTML) {
    if (!el) return;
    el.style.transition = 'opacity .3s ease';
    el.style.opacity = '0';
    setTimeout(function () {
      el.innerHTML = newHTML;
      // Force reflow so the opacity transition plays again.
      void el.offsetHeight;
      el.style.opacity = '1';
    }, 300);
  }

  // ── progressRing: sets CSS vars on .progress-ring elements ───────────────
  function progressRing(el, pct, opts) {
    if (!el) return;
    opts = opts || {};
    var p = Math.max(0, Math.min(100, Number(pct) || 0));
    el.classList.add('progress-ring');
    el.style.setProperty('--pct', p + '%');
    if (opts.size != null)        el.style.setProperty('--size', opts.size + 'px');
    if (opts.strokeWidth != null) el.style.setProperty('--sw',   opts.strokeWidth + 'px');
  }

  // ── activityRow: unified row HTML for mixed-type feed ────────────────────
  // item: { type, business_slug, business_name, title, meta[], timestamp, payload? }
  function activityRow(item) {
    if (!item) return '';
    var type  = escHtml(item.type || 'event');
    var biz   = item.business_name
      ? '<span class="amcp-activity-biz">' + escHtml(item.business_name) + '</span>'
      : '';
    var title = escHtml(item.title || '');
    var meta  = Array.isArray(item.meta) && item.meta.length
      ? ' <span style="color:var(--muted)">· ' + item.meta.map(escHtml).join(' · ') + '</span>'
      : '';
    var ts    = item.timestamp
      ? '<span class="amcp-activity-ts">' + escHtml(fmtTs(item.timestamp)) + '</span>'
      : '';
    return '<div class="amcp-activity-row" data-type="' + type + '"' +
           (item.business_slug ? ' data-slug="' + escHtml(item.business_slug) + '"' : '') + '>' +
             '<span class="amcp-activity-type">' + type + '</span>' +
             '<span class="amcp-activity-title">' + title + meta + '</span>' +
             biz +
             ts +
           '</div>';
  }

  // ── Drawer (single-instance slide-over) ──────────────────────────────────
  function getDrawerRefs() {
    return {
      overlay: document.getElementById('amcp-drawer-overlay'),
      panel:   document.getElementById('amcp-drawer-panel'),
      title:   document.getElementById('amcp-drawer-title'),
      body:    document.getElementById('amcp-drawer-body'),
      close:   document.getElementById('amcp-drawer-close'),
    };
  }

  var drawerListenersBound = false;
  var drawerOpen = false;
  var previouslyFocused = null;
  var FOCUSABLE_SEL = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  function getFocusableInPanel(panel) {
    if (!panel) return [];
    var nodes = panel.querySelectorAll(FOCUSABLE_SEL);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.hasAttribute('disabled') && n.getAttribute('aria-hidden') !== 'true') out.push(n);
    }
    return out;
  }

  function trapTab(ev) {
    if (!drawerOpen || ev.key !== 'Tab') return;
    var refs = getDrawerRefs();
    if (!refs.panel) return;
    var focusable = getFocusableInPanel(refs.panel);
    if (focusable.length === 0) { ev.preventDefault(); return; }
    var first = focusable[0];
    var last  = focusable[focusable.length - 1];
    var active = document.activeElement;
    if (ev.shiftKey && active === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  function bindDrawerListenersOnce() {
    if (drawerListenersBound) return;
    var refs = getDrawerRefs();
    if (!refs.overlay || !refs.panel) return;
    refs.overlay.addEventListener('click', closeDrawer);
    if (refs.close) refs.close.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeDrawer();
    });
    refs.panel.addEventListener('keydown', trapTab);
    drawerListenersBound = true;
  }

  /**
   * Open the right-side drawer with the given title and body HTML.
   *
   * SECURITY: bodyHTML is inserted verbatim via innerHTML. Callers MUST
   * pre-escape any untrusted content (agent IDs, query text, user input)
   * before passing it in. Trusted static template fragments are fine.
   */
  function openDrawer(title, bodyHTML) {
    bindDrawerListenersOnce();
    var refs = getDrawerRefs();
    if (!refs.overlay || !refs.panel) return;
    previouslyFocused = document.activeElement;
    if (refs.title) refs.title.textContent = title == null ? 'Details' : String(title);
    if (refs.body)  refs.body.innerHTML  = bodyHTML == null ? '' : bodyHTML;
    refs.overlay.classList.add('open');
    refs.panel.classList.add('open');
    refs.overlay.setAttribute('aria-hidden', 'false');
    refs.panel.setAttribute('aria-hidden', 'false');
    drawerOpen = true;
    // Prefer the close button; fall back to the first focusable descendant.
    var target = refs.close || getFocusableInPanel(refs.panel)[0] || null;
    if (target && typeof target.focus === 'function') {
      try { target.focus(); } catch (_) { /* ignore */ }
    }
  }
  function closeDrawer() {
    var refs = getDrawerRefs();
    if (!refs.overlay || !refs.panel) return;
    refs.overlay.classList.remove('open');
    refs.panel.classList.remove('open');
    refs.overlay.setAttribute('aria-hidden', 'true');
    refs.panel.setAttribute('aria-hidden', 'true');
    drawerOpen = false;
    if (previouslyFocused && document.contains(previouslyFocused) && typeof previouslyFocused.focus === 'function') {
      try { previouslyFocused.focus(); } catch (_) { /* ignore */ }
    }
    previouslyFocused = null;
  }

  // ── Toast stack (auto-dismiss 4s) ────────────────────────────────────────
  function toast(message, variant) {
    var stack = document.getElementById('amcp-toast-stack');
    if (!stack) return;
    var v = (variant === 'success' || variant === 'error' || variant === 'info') ? variant : 'info';
    var el = document.createElement('div');
    el.className = 'amcp-toast ' + v;
    el.textContent = String(message == null ? '' : message);
    stack.appendChild(el);
    // Force a frame so the slide-in transition plays.
    requestAnimationFrame(function () { el.classList.add('visible'); });
    setTimeout(function () {
      el.classList.remove('visible');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 300);
    }, 4000);
  }

  // ── Formatters ──────────────────────────────────────────────────────────
  /**
   * Parse a timestamp that may come from SQLite `datetime('now')` in the
   * form "YYYY-MM-DD HH:MM:SS" (space-separated, no timezone suffix).
   *
   * Chrome/Safari parse that string as LOCAL time instead of UTC, so a
   * value that's actually UTC becomes wall-clock-local and appears
   * several hours in the future for anyone in a negative UTC offset.
   * This is what produced the "Last bot hit: -11530s ago" bug on the
   * Domains dashboard (Austin = UTC-5, so SQLite's UTC-but-unlabeled
   * timestamp appeared 5 hours ahead).
   *
   * ISO 8601 with a timezone suffix ("2026-04-16T23:30:00Z" or +offset)
   * is parsed correctly, pass those through unchanged.
   */
  function parseServerTs(ts) {
    if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(ts)) {
      // SQLite datetime() shape, treat as UTC.
      return new Date(ts.replace(' ', 'T') + 'Z');
    }
    return new Date(ts);
  }

  function fmtTs(ts) {
    if (!ts) return '';
    var d = parseServerTs(ts);
    if (isNaN(d.getTime())) return String(ts);
    var now  = new Date();
    var diff = (now.getTime() - d.getTime()) / 1000;
    // Clock-drift safety: if the server's clock is a few seconds ahead
    // of ours, or if rounding pushes into the negative, treat as "just
    // now" rather than rendering "-4s ago". Beyond ~2 minutes of drift
    // we surface the raw date, signals a real problem worth noticing.
    if (diff < 0) {
      if (diff > -120) return 'just now';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    if (diff < 60)    return Math.floor(diff) + 's ago';
    if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function fmtNum(n) {
    var v = Number(n);
    if (!isFinite(v)) return '0';
    var abs = Math.abs(v);
    if (abs >= 1e9)  return (v / 1e9).toFixed(v % 1e9 === 0 ? 0 : 1) + 'b';
    if (abs >= 1e6)  return (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1) + 'm';
    if (abs >= 1e3)  return (v / 1e3).toFixed(v % 1e3 === 0 ? 0 : 1) + 'k';
    return String(Math.round(v));
  }

  window.AMCP_UI = {
    sparkline:    sparkline,
    countUp:      countUp,
    deltaChip:    deltaChip,
    swapContent:  swapContent,
    progressRing: progressRing,
    activityRow:  activityRow,
    openDrawer:   openDrawer,
    closeDrawer:  closeDrawer,
    toast:        toast,
    fmtTs:        fmtTs,
    fmtNum:       fmtNum,
  };
})();
