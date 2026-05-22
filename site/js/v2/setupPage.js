// site/js/v2/setupPage.js
//
// Phase-3 dedicated focus-mode page at /setup/traffic-impact. Renders
// all 6 integrations as <ConnectorCard surface="wizard"> cards in a
// vertical scroll, with a sticky left side rail showing progress +
// jump-to anchors. No v2 dashboard chrome — this is its own minimal
// page shell (see site/setup/traffic-impact.html).
//
// Reuses:
//   - Phase 1: /api/client/integrations/status, prereqCoach.js
//   - Phase 2 PR 1: runInlinePicker mountTarget option
//   - Phase 2 PR 2: connectorCard.js surface:"wizard"
//
// Spec: docs/superpowers/specs/2026-05-08-traffic-impact-setup-page-phase-3-design.md

(function () {
  'use strict';

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Maps integration_id → DOM id of legacy card on Settings.html.
  // Same mapping as traffic-impact.js's LEGACY_CARD_IDS — Phase 1.5 will
  // extract this into a shared connectorActions.js module.
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

  // ── renderContent ────────────────────────────────────────────────

  function renderContent(hub) {
    const root = document.getElementById('setup-page-content');
    if (!root) return;

    const integrations = (hub.integrations || []);
    const completion = hub.completion || { connected: 0, available: 0, pct: 0 };

    const welcomeHtml = `
      <div class="setup-page-welcome">
        <h1>These connections power your Traffic Impact dashboard.</h1>
        <p>Set them up in any order. Your dashboard fills in as data syncs from each connection.</p>
        <div class="setup-page-welcome-meta">${escHtml(completion.connected)} of ${escHtml(completion.available)} connected · ${escHtml(completion.pct)}% complete</div>
      </div>`;

    // Stable order: recommended chain first, then Salesforce. plan-locked
    // rows still render so Base tenants see what they're missing.
    const ORDER = ['ga4', 'gsc', 'hubspot', 'salesforce', 'stripe_webhook', 'authority'];
    const sorted = ORDER
      .map(id => integrations.find(i => i.id === id))
      .filter(Boolean);

    const cardsHtml = sorted.map(integration => {
      const cardHtml = (window.AMCP_CONNECTOR_CARD && window.AMCP_CONNECTOR_CARD.render)
        ? window.AMCP_CONNECTOR_CARD.render(integration, 'wizard')
        : `<div class="setup-page-error">Connector card module didn't load — refresh to retry.</div>`;
      return `<div class="setup-page-card-wrap" id="setup-card-${escHtml(integration.id)}">${cardHtml}</div>`;
    }).join('');

    root.innerHTML = welcomeHtml + cardsHtml;
  }

  // ── renderRail ───────────────────────────────────────────────────

  const STATUS_DOT = {
    not_connected:            '○',
    connecting:               '◐',
    connected_pending_config: '◐',
    connected_active:         '✓',
    connected_error:          '!',
    disconnected:             '○',
    plan_locked:              '🔒',
  };

  function renderRail(hub) {
    const rail = document.getElementById('setup-page-rail');
    if (!rail) return;

    const integrations = (hub.integrations || []);
    const completion = hub.completion || { connected: 0, available: 0, pct: 0 };

    const ORDER = ['ga4', 'gsc', 'hubspot', 'salesforce', 'stripe_webhook', 'authority'];
    const items = ORDER
      .map(id => integrations.find(i => i.id === id))
      .filter(Boolean);

    const itemsHtml = items.map(i => {
      const dot = STATUS_DOT[i.status] || '○';
      const isConnected = i.status === 'connected_active' || i.status === 'connected_pending_config' || i.status === 'connected_error';
      const cls = i.status === 'plan_locked'
        ? 'setup-rail-item-locked'
        : (isConnected ? 'setup-rail-item-done' : 'setup-rail-item-todo');
      return `
        <li class="setup-rail-item ${cls}">
          <a href="#setup-card-${escHtml(i.id)}" data-rail-jump="${escHtml(i.id)}">
            <span class="setup-rail-dot">${dot}</span>
            <span class="setup-rail-name">${escHtml(i.name)}</span>
          </a>
        </li>`;
    }).join('');

    rail.innerHTML = `
      <div class="setup-page-rail-inner">
        <div class="setup-page-rail-title">Progress</div>
        <div class="setup-page-rail-progress">
          <div class="setup-page-rail-progress-bar">
            <div class="setup-page-rail-progress-fill" style="width: ${escHtml(completion.pct)}%"></div>
          </div>
          <div class="setup-page-rail-progress-meta">${escHtml(completion.connected)} of ${escHtml(completion.available)} · ${escHtml(completion.pct)}%</div>
        </div>
        <ul class="setup-rail-list">${itemsHtml}</ul>
        <div class="setup-page-rail-footer">
          <button type="button" class="btn btn-ghost btn-sm setup-page-exit" id="setup-page-exit">Save & exit</button>
        </div>
      </div>`;
  }

  // ── wireActions ──────────────────────────────────────────────────

  function wireActions(_hub) {
    // Save & exit
    const exitBtn = document.getElementById('setup-page-exit');
    if (exitBtn) {
      exitBtn.addEventListener('click', () => {
        const ref = document.referrer;
        if (ref && ref.indexOf(window.location.origin) === 0) {
          window.location.href = ref;
        } else {
          window.location.href = '/Settings.html';
        }
      });
    }

    // Side rail jump-to (smooth scroll + brief highlight)
    const rail = document.getElementById('setup-page-rail');
    if (rail) {
      rail.addEventListener('click', (e) => {
        const link = e.target.closest('[data-rail-jump]');
        if (!link) return;
        e.preventDefault();
        const id = link.getAttribute('data-rail-jump');
        const target = document.getElementById('setup-card-' + id);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        flashHighlight(target);
      });
    }

    // Action buttons (data-cc-action) on connector cards
    const content = document.getElementById('setup-page-content');
    if (content) {
      content.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cc-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-cc-action');
        const id = btn.getAttribute('data-cc-id');
        if (!action || !id || action === 'upgrade') return;
        e.preventDefault();
        handleAction(id, action, btn);
      });
    }
  }

  function flashHighlight(el) {
    const original = el.style.boxShadow;
    el.style.transition = 'box-shadow 200ms';
    el.style.boxShadow = '0 0 0 3px var(--maroon, #7d2550)';
    setTimeout(() => { el.style.boxShadow = original; }, 1400);
  }

  function handleAction(integrationId, action, btn) {
    if (action === 'connect') {
      startConnect(integrationId, btn);
      return;
    }
    if (action === 'pick_property' || action === 'pick_site') {
      const card = btn.closest('.cc-wizard-card');
      const stepBody = card ? card.querySelector('.cc-wizard-step-body') : null;
      openPicker(integrationId, btn, stepBody);
      return;
    }
    // disconnect / resync / configure / generate / rotate / edit
    // → deep-link to legacy Settings card. Phase 1.5 inlines these forms.
    window.location.href = legacyCardUrl(integrationId);
  }

  async function startConnect(integrationId, btn) {
    const paths = {
      ga4:        '/api/client/ga4/start-link',
      gsc:        '/api/client/gsc/start-link',
      hubspot:    '/api/client/crm/start-link?provider=hubspot',
      salesforce: '/api/client/crm/start-link?provider=salesforce',
    };
    const path = paths[integrationId];
    if (!path) {
      // Authority + Stripe webhook don't OAuth-connect; deep-link to legacy.
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
      // Field-probe order standardised across the dashboard:
      // customer_message → error_code → message → error → literal fallback.
      // PR #247 surfaced why this chain matters — when the backend returns
      // {"error": "..."}, the previous (customer_message || error_code)
      // chain dropped the actual message and the user saw a meaningless
      // "Could not start" alert.
      throw new Error((j && (j.customer_message || j.error_code || j.message || j.error)) || 'Could not start');
    } catch (err) {
      alert('Could not connect: ' + (err.message || err));
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function openPicker(integrationId, btn, mountTarget) {
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
        buildBody:    (p) => ({ property_id: p.propertyId, property_label: p.displayName || p.propertyId }),
        isValid:      (p) => !!p.propertyId,
        rowLabel:     (p) => p.displayName || p.propertyId || '',
        rowSubLabel:  (p) => p.propertyId || '',
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
        buildBody:    (s) => ({ site_url: s.siteUrl }),
        isValid:      (s) => !!s.siteUrl,
        rowLabel:     (s) => s.siteUrl || '',
        rowSubLabel:  (s) => s.permissionLevel || '',
        emptyMessage: 'No verified sites visible on this Google account yet. Two common causes: (a) you connected a different Google account than the one you verified the site under — disconnect and reconnect with the right account; (b) you verified the site within the last few hours — Google Search Console takes up to 24 hours to surface newly-verified properties via its API. Come back later if so.',
        intro:        'Pick the site Advocate should pull data from. Selecting a site triggers an 18-month backfill — this can take 30 seconds.',
      });
    }
  }

  // ── boot ─────────────────────────────────────────────────────────

  async function boot() {
    const authed = await window.AMCP.requireAuth();
    if (!authed) return;

    // Sign-out wire
    const signOutBtn = document.getElementById('setup-page-signout');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', () => window.AMCP.logout());
    }

    // Fetch hub status
    let hub = null;
    try {
      const r = await window.AMCP.authedFetch('/api/client/integrations/status');
      if (r.ok) hub = await r.json();
    } catch (_) { /* hub stays null → render error */ }

    if (!hub) {
      const content = document.getElementById('setup-page-content');
      if (content) {
        content.innerHTML = '<div class="setup-page-error">Couldn\'t load your integrations. <button type="button" class="btn btn-ghost btn-sm" onclick="window.location.reload()">Refresh</button></div>';
      }
      const rail = document.getElementById('setup-page-rail');
      if (rail) rail.innerHTML = '';
      return;
    }

    renderRail(hub);
    renderContent(hub);
    wireActions(hub);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
