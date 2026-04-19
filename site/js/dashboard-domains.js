/* Domains section — renders real CF SaaS hostname + Worker Route status.
 *
 * Fetches GET /api/client/domain-info (session-authed) and surfaces:
 *   - Business header (name + domain)
 *   - Three status pills (CF hostname, SSL, Worker Route)
 *   - DNS records hint
 *   - "Test bot traffic" button → GET /api/client/domain-test (server-side
 *     fetch with PerplexityBot UA since browsers can't override User-Agent)
 *   - Admin-only rotate-key button that prompts for ADMIN_SECRET and calls
 *     POST /admin/businesses/:slug/resync-api-key
 *
 * Registers as window.AMCP_SECTIONS['domains']. */
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

  function currentSlug() {
    return (window.AMCP_DATA && window.AMCP_DATA.slug) ||
      new URLSearchParams(window.location.search).get('slug') || '';
  }

  function showError(msg) {
    var errEl = document.getElementById('domains-error');
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.classList.add('show');
  }

  function clearError() {
    var errEl = document.getElementById('domains-error');
    if (!errEl) return;
    errEl.textContent = '';
    errEl.classList.remove('show');
  }

  // CF hostname status → badge color.
  function pill(label, state) {
    var cls = 'badge-yellow';
    if (state === 'ok')      cls = 'badge-green';
    else if (state === 'bad') cls = 'badge-red';
    else if (state === 'unknown') cls = 'badge-yellow';
    else if (state === 'accent')  cls = 'badge-accent';
    return '<span class="badge ' + cls + '"><span class="badge-dot"></span>' + esc(label) + '</span>';
  }

  function renderHeader(info) {
    var hdr = document.getElementById('domain-header');
    if (!hdr) return;
    var lastHit = info.last_bot_hit
      ? 'Last bot hit: ' + esc(AMCP_UI.fmtTs(info.last_bot_hit))
      : 'No bot hits recorded yet';
    hdr.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">' +
        '<div>' +
          '<div style="font-size:var(--tx-md);font-weight:600">' + esc(info.business_name || info.slug) + '</div>' +
          '<div style="font-size:var(--tx-sm);color:var(--muted);font-family:var(--font-mono)">' + esc(info.domain || '— no domain registered') + '</div>' +
        '</div>' +
        '<div style="font-size:var(--tx-xs);color:var(--muted)">' + lastHit + '</div>' +
      '</div>';
  }

  function renderStatus(info) {
    var wrap = document.getElementById('status-pills');
    if (!wrap) return;
    var cf = info.cf_hostname || {};
    var wr = info.worker_route || {};

    var cfState = 'unknown';
    if (cf.status === 'active') cfState = 'ok';
    else if (cf.status === 'pending' || cf.status === 'pending_validation') cfState = 'unknown';
    else if (cf.status && cf.status !== 'active') cfState = 'bad';

    var sslState = cf.ssl_status === 'active' ? 'ok'
                 : cf.ssl_status === 'pending_validation' ? 'unknown'
                 : cf.ssl_status === 'unknown' ? 'unknown'
                 : 'bad';

    var routeLabel, routeState;
    if (wr.present === true) {
      routeLabel = 'Worker Route ✓ present';
      routeState = 'ok';
    } else if (wr.present === false) {
      routeLabel = 'Worker Route ✗ missing';
      routeState = 'bad';
    } else {
      routeLabel = 'Worker Route ? unknown';
      routeState = 'unknown';
    }

    wrap.innerHTML =
      pill('CF SaaS hostname ' + (cfState === 'ok' ? '✓' : cfState === 'bad' ? '✗' : '?') +
           ' ' + (cf.status || 'unknown'), cfState) +
      pill('SSL ' + (sslState === 'ok' ? '✓' : sslState === 'bad' ? '✗' : '?') +
           ' ' + (cf.ssl_status || 'unknown'), sslState) +
      pill(routeLabel, routeState);

    var meta = document.getElementById('status-meta');
    if (meta) {
      var parts = [];
      if (cf.note) parts.push(esc(cf.note));
      if (wr.pattern) parts.push('Expected route pattern: <code>' + esc(wr.pattern) + '</code>');
      if (wr.present === null) parts.push('Full Worker Route introspection requires Workers Routes:Read scope on the admin token.');
      meta.innerHTML = parts.length ? parts.join(' · ') : '';
    }
  }

  function renderDns(info) {
    var wrap = document.getElementById('dns-records');
    if (!wrap) return;
    if (!info.domain) {
      wrap.innerHTML = '<div class="empty-desc" style="font-size:var(--tx-sm);color:var(--muted);padding:8px 0">No domain registered for this business.</div>';
      return;
    }
    wrap.innerHTML =
      '<div style="font-size:var(--tx-sm);font-family:var(--font-mono);background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:12px">' +
        '<div style="margin-bottom:6px"><strong>CNAME</strong></div>' +
        '<div style="color:var(--muted)">' + esc(info.domain) + '  →  customers.advocatemcp.com</div>' +
      '</div>' +
      '<div style="font-size:var(--tx-xs);color:var(--muted);margin-top:10px">' +
        'These are the records you configured at your registrar to route AI crawler traffic through Advocate.' +
      '</div>';
  }

  function runBotTest() {
    var btn = document.getElementById('btn-test-bot');
    var result = document.getElementById('test-bot-result');
    if (!btn || !result) return;
    var slug = currentSlug();
    btn.disabled = true;
    btn.textContent = 'Testing…';
    result.innerHTML = '<div class="skeleton" style="height:60px;border-radius:6px"></div>';

    var path = '/api/client/domain-test' + (slug ? '?slug=' + encodeURIComponent(slug) : '');
    window.AMCP.authedFetch(path)
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j }; }); })
      .then(function (wrapResp) {
        if (!wrapResp.ok) {
          var msg = (wrapResp.json && wrapResp.json.error) || ('HTTP ' + wrapResp.status);
          result.innerHTML = '<div style="padding:10px 12px;background:rgba(248,81,73,.08);border:1px solid rgba(248,81,73,.2);border-radius:6px;color:var(--red);font-size:var(--tx-sm)">' + esc(msg) + '</div>';
          return;
        }
        var data = wrapResp.json || {};
        var statusCls = data.status >= 200 && data.status < 300 ? 'badge-green'
                      : data.status >= 300 && data.status < 400 ? 'badge-yellow'
                      : 'badge-red';
        result.innerHTML =
          '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">' +
            '<span class="badge ' + statusCls + '"><span class="badge-dot"></span>' + esc(String(data.status || '—')) + ' ' + esc(data.status_text || '') + '</span>' +
            '<span style="font-family:var(--font-mono);font-size:var(--tx-xs);color:var(--muted)">' + esc(data.url || '') + '</span>' +
          '</div>' +
          '<pre style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;font-family:var(--font-mono);font-size:var(--tx-xs);white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;margin:0">' +
            esc(data.snippet || '(no body)') +
          '</pre>';
      })
      .catch(function (err) {
        result.innerHTML = '<div style="padding:10px 12px;background:rgba(248,81,73,.08);border:1px solid rgba(248,81,73,.2);border-radius:6px;color:var(--red);font-size:var(--tx-sm)">Test failed: ' + esc(err && err.message ? err.message : String(err)) + '</div>';
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Run test';
      });
  }

  // Admin rotate-key flow — pops the drawer with a form for the ADMIN_SECRET
  // bearer token, confirms, then calls the Worker endpoint.
  function openAdminRotateDrawer() {
    var slug = currentSlug();
    var body =
      '<div style="display:flex;flex-direction:column;gap:10px">' +
        '<div style="font-size:var(--tx-sm);color:var(--text)">' +
          'This rotates the api_key on Railway and resyncs it into D1. The previous key will stop working immediately.' +
        '</div>' +
        '<div style="padding:10px 12px;background:rgba(210,153,34,.08);border:1px solid rgba(210,153,34,.2);border-radius:6px;color:var(--yellow);font-size:var(--tx-xs)">' +
          'This endpoint requires the ADMIN_SECRET bearer token. It is NOT the same as your session — paste it below.' +
        '</div>' +
        '<label style="display:flex;flex-direction:column;gap:4px;font-size:var(--tx-xs);color:var(--muted)">' +
          'Admin secret' +
          '<input type="password" class="fi" id="admin-secret-input" placeholder="Bearer token from wrangler secrets" autocomplete="off">' +
        '</label>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:4px">' +
          '<button type="button" class="btn-sm btn-primary-sm" id="confirm-rotate">Rotate key for ' + esc(slug) + '</button>' +
          '<span id="rotate-status-drawer" style="font-size:var(--tx-xs);color:var(--muted)"></span>' +
        '</div>' +
      '</div>';
    AMCP_UI.openDrawer('Rotate api_key (admin)', body);

    // Wire the confirm button post-insert.
    setTimeout(function () {
      var btn = document.getElementById('confirm-rotate');
      var input = document.getElementById('admin-secret-input');
      var status = document.getElementById('rotate-status-drawer');
      if (!btn || !input || !status) return;
      btn.addEventListener('click', function () {
        var secret = (input.value || '').trim();
        if (!secret) {
          status.textContent = 'Paste the admin secret first.';
          status.style.color = 'var(--yellow)';
          return;
        }
        btn.disabled = true;
        status.textContent = 'Rotating…';
        status.style.color = 'var(--muted)';

        // Call the Worker admin endpoint directly — it's on the same origin
        // the session-authed API uses, so AMCP.API_BASE works.
        fetch(window.AMCP.API_BASE + '/admin/businesses/' + encodeURIComponent(slug) + '/resync-api-key', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + secret },
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j }; }); })
          .then(function (w) {
            if (!w.ok) {
              status.textContent = (w.json && w.json.error) || ('HTTP ' + w.status);
              status.style.color = 'var(--red)';
              btn.disabled = false;
              return;
            }
            status.textContent = 'Key rotated and resynced.';
            status.style.color = 'var(--green)';
            AMCP_UI.toast('API key rotated for ' + slug, 'success');
          })
          .catch(function (err) {
            status.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
            status.style.color = 'var(--red)';
            btn.disabled = false;
          });
      });
    }, 0);
  }

  function wireActions() {
    var testBtn = document.getElementById('btn-test-bot');
    if (testBtn && !testBtn.dataset.bound) {
      testBtn.dataset.bound = '1';
      testBtn.addEventListener('click', runBotTest);
    }
    var rotateBtn = document.getElementById('btn-rotate-key-admin');
    if (rotateBtn && !rotateBtn.dataset.bound) {
      rotateBtn.dataset.bound = '1';
      rotateBtn.addEventListener('click', openAdminRotateDrawer);
    }
  }

  function render() {
    if (rendered) return;
    rendered = true;
    clearError();

    // Admin-only controls get a card if the shell flagged admin mode.
    // Admin detection: either AMCP_ADMIN_MODE is set, OR the admin switcher
    // injected itself (#biz-select). Both signals are set by dashboard-admin.js
    // after /api/client/me.
    var isAdmin = window.AMCP_ADMIN_MODE === 'all' || !!document.getElementById('biz-select');
    var adminCard = document.getElementById('admin-domain-actions');
    if (adminCard && isAdmin) adminCard.style.display = '';

    // Hosted (wizard-signup) tenants have *.hosted.advocatemcp.com managed
    // for them — no DNS to configure. If a non-admin somehow lands on this
    // section (direct URL, anchor click before the nav hide applied), show a
    // short message instead of fetching CF hostname status they can't act on.
    var isHosted = !!(window.AMCP_DATA && window.AMCP_DATA.is_hosted);
    if (isHosted && !isAdmin) {
      var hdr = document.getElementById('domain-header');
      if (hdr) {
        hdr.innerHTML =
          '<div style="font-size:var(--tx-md);font-weight:600;margin-bottom:6px">Hosted subdomain</div>' +
          '<div style="font-size:var(--tx-sm);color:var(--muted)">' +
            'Your agent lives at <span style="font-family:var(--font-mono)">' +
            esc((window.AMCP_DATA && window.AMCP_DATA.domain) || '') +
            '</span>. DNS is managed for you — nothing to configure here.' +
          '</div>';
      }
      // Hide the cards below the header so the section stays compact.
      ['status-pills-wrap', 'dns-records-wrap', 'test-bot-wrap'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      return;
    }

    var slug = currentSlug();
    var path = '/api/client/domain-info' + (slug ? '?slug=' + encodeURIComponent(slug) : '');

    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    window.AMCP.authedFetch(path, { signal: abortCtrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.json();
      })
      .then(function (info) {
        renderHeader(info);
        renderStatus(info);
        renderDns(info);
        wireActions();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        showError('Could not load domain info: ' + (err && err.message ? err.message : 'unknown error'));
      });
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['domains'] = render;
})();
