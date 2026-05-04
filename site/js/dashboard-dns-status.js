/* Shared 5-light DNS status renderer for the wizard and the settings page.
 *
 * Public API on window.AMCP_DNS_STATUS:
 *   render(containerEl, status)
 *     Paint the 5 lights from a status payload into the given container.
 *     Pass `null` for status to show the empty/error state.
 *
 *   runOnce(slug) -> Promise<status>
 *     Fetch /api/client/domain-info?slug=X once and return the parsed payload.
 *
 *   startPolling(containerEl, slug, intervalMs, onAllGreen?) -> { stop() }
 *     Begin polling. Renders every tick. Calls onAllGreen exactly once when
 *     status.all_green flips to true. Returns a handle with stop().
 *
 * The DomainStatus shape comes from the Worker (see apiDomainInfo). It carries
 * a `signals` object with five entries — dns, cf_hostname, cf_ssl, worker_route,
 * live_request — each shaped as { state: 'ok'|'err'|'waiting', message: string, detail?: ... }.
 *
 * This module is framework-free. Wizard and Settings hand us a container element
 * and we own everything inside it. Do not reach outside the container.
 */
(function () {
  'use strict';

  var SIGNAL_ORDER = [
    { key: 'dns',          label: 'DNS pointing the right way' },
    { key: 'cf_hostname',  label: 'Cloudflare hostname active' },
    { key: 'cf_ssl',       label: 'SSL certificate issued' },
    { key: 'worker_route', label: 'Crawler route live' },
    { key: 'live_request', label: 'Real request reaches Advocate' },
  ];

  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function lightHtml(label, signal) {
    var state = (signal && signal.state) || 'waiting';
    var message = (signal && signal.message) || 'Checking…';
    return (
      '<div class="amcp-dns-light ' + escHtml(state) + '">' +
        '<span class="amcp-dns-light-dot"></span>' +
        '<div class="amcp-dns-light-body">' +
          '<div class="amcp-dns-light-label">' + escHtml(label) + '</div>' +
          '<div class="amcp-dns-light-message">' + escHtml(message) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function render(containerEl, status) {
    if (!containerEl) return;
    if (!status || !status.signals) {
      containerEl.innerHTML =
        '<div class="amcp-dns-empty">Could not load DNS status. Try again in a moment.</div>';
      return;
    }
    var html = SIGNAL_ORDER.map(function (s) {
      return lightHtml(s.label, status.signals[s.key]);
    }).join('');
    containerEl.innerHTML = '<div class="amcp-dns-lights">' + html + '</div>';
  }

  function runOnce(slug) {
    if (!window.AMCP || typeof window.AMCP.authedFetch !== 'function') {
      return Promise.reject(new Error('AMCP.authedFetch not available'));
    }
    var url = '/api/client/domain-info' + (slug ? '?slug=' + encodeURIComponent(slug) : '');
    return window.AMCP.authedFetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function startPolling(containerEl, slug, intervalMs, onAllGreen) {
    var stopped = false;
    var timer = null;
    var alreadyGreen = false;

    function tick() {
      if (stopped) return;
      runOnce(slug).then(function (status) {
        if (stopped) return;
        render(containerEl, status);
        if (status && status.all_green && !alreadyGreen) {
          alreadyGreen = true;
          if (typeof onAllGreen === 'function') onAllGreen(status);
        }
      }).catch(function () {
        if (stopped) return;
        render(containerEl, null);
      });
    }

    tick();
    timer = setInterval(tick, intervalMs || 10000);

    return {
      stop: function () {
        stopped = true;
        if (timer) { clearInterval(timer); timer = null; }
      },
    };
  }

  window.AMCP_DNS_STATUS = { render: render, runOnce: runOnce, startPolling: startPolling };
})();
