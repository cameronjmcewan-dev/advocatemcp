// site/js/v2/connectorCard.js
//
// Shared render function for any Traffic Impact integration in any of
// 7 status states (not_connected | connecting | connected_pending_config
// | connected_active | connected_error | disconnected | plan_locked).
// One source of truth for the visual contract across all 3 setup surfaces.
//
// Inputs: an integration object from /api/client/integrations/status,
// a `surface` prop ("hub" | "wizard" | "setup-page"), and an `actions`
// callback object that wires button clicks to the existing per-integration
// handlers in settings.js (wireGa4Card, wireGscCard, wireCrmCard,
// wireAuthorityCard, plus the revenue-webhook generate/rotate flow).
//
// Phase 1 surface: "hub" only. "wizard" + "setup-page" land in Phase 2-3.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-impact-setup-design.md

(function () {
  'use strict';

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function timeAgo(iso) {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
    if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
    return Math.floor(ms / 86_400_000) + 'd ago';
  }

  // Map status → status-pill class + label
  const STATUS_PILL = {
    not_connected:            { cls: 'chip',                       label: 'Not connected' },
    connecting:               { cls: 'chip amber dot-chip',        label: 'Connecting…' },
    connected_pending_config: { cls: 'chip amber dot-chip',        label: 'Connected · pick configuration' },
    connected_active:         { cls: 'chip sage dot-chip',         label: 'Connected' },
    connected_error:          { cls: 'chip',                       label: 'Sync error' },
    disconnected:             { cls: 'chip',                       label: 'Disconnected' },
    plan_locked:              { cls: 'chip maroon',                label: 'Pro' },
  };

  /**
   * Wizard-mode render: full-card layout for the Phase-2 stepper. Differs
   * from the hub's accordion row in:
   *   - larger heading, status pill on its own line
   *   - bulleted value_props (not just first oneliner)
   *   - <PrereqCoach> inlined above the action button
   *   - vertical action stack (primary CTA on top, ghost actions below)
   *   - dedicated <div class="cc-wizard-step-body"> the wizard stepper
   *     uses as the picker mountTarget so picker rendering doesn't
   *     clobber the wizard's own navigation buttons
   */
  function renderWizard(integration) {
    const pill = STATUS_PILL[integration.status] || STATUS_PILL.not_connected;
    const dot = pill.cls.indexOf('dot-chip') >= 0 ? '<span class="dot"></span>' : '';

    const values = (integration.value_props || []).map(v =>
      `<li>${escHtml(v)}</li>`
    ).join('');

    // Inline coaching for prereqs that have a coach_id
    const coachHtml = (integration.external_prereqs || [])
      .filter(p => p && p.coach_id)
      .map(p => {
        const coach = (window.AMCP_PREREQ_COACH && window.AMCP_PREREQ_COACH.render)
          ? window.AMCP_PREREQ_COACH.render(p.coach_id)
          : '';
        return coach;
      })
      .join('');

    // Same action labels + button styling rules as the hub render — kept inline
    // here rather than DRY'd into a shared helper because the wizard layout
    // stacks them vertically (primary CTA full-width, ghost actions below).
    const actionLabels = {
      connect:       'Connect →',
      pick_property: 'Pick property →',
      pick_site:     'Pick site →',
      configure:     'Configure →',
      generate:      'Generate webhook →',
      rotate:        'Rotate secret',
      resync:        'Resync now',
      disconnect:    'Disconnect',
      edit:          'Edit',
      upgrade:       'Upgrade to Pro →',
    };
    const actionsHtml = (integration.actions || []).map((a) => {
      const isPrimary = (a === 'connect' || a === 'configure' || a === 'generate' || a === 'upgrade');
      const cls = isPrimary ? 'btn btn-primary' : 'btn btn-ghost btn-sm';
      const href = a === 'upgrade' ? ' href="/Billing.html"' : '';
      const tag = a === 'upgrade' ? 'a' : 'button';
      const typeAttr = a === 'upgrade' ? '' : ' type="button"';
      return `<${tag} class="${cls}" data-cc-action="${escHtml(a)}" data-cc-id="${escHtml(integration.id)}"${typeAttr}${href}>${escHtml(actionLabels[a] || a)}</${tag}>`;
    }).join('');

    const errorPill = integration.last_sync_error
      ? `<div class="cc-wizard-error">${escHtml(String(integration.last_sync_error).slice(0, 200))}</div>`
      : '';

    return `
      <div class="cc-wizard-card" data-cc-row="${escHtml(integration.id)}">
        <div class="cc-wizard-name">${escHtml(integration.name)}</div>
        <div class="cc-wizard-status">
          <span class="${pill.cls}">${dot}${escHtml(pill.label)}</span>
        </div>
        ${values ? `<ul class="cc-wizard-values">${values}</ul>` : ''}
        ${coachHtml ? `<div class="cc-wizard-coach">${coachHtml}</div>` : ''}
        ${errorPill}
        <div class="cc-wizard-step-body"></div>
        <div class="cc-wizard-actions">${actionsHtml}</div>
      </div>`;
  }

  /**
   * Renders one connector card row. Returns HTML string.
   * Surface-specific layout — dispatches to renderWizard for the
   * Phase-2 wizard surface; default is the hub's accordion row.
   */
  function render(integration, surface) {
    surface = surface || 'hub';
    if (surface === 'wizard') return renderWizard(integration);
    const pill = STATUS_PILL[integration.status] || STATUS_PILL.not_connected;
    const dot = pill.cls.indexOf('dot-chip') >= 0 ? '<span class="dot"></span>' : '';
    const valueOneliner = (integration.value_props && integration.value_props[0]) || '';
    const lastSync = (integration.status === 'connected_active' || integration.status === 'connected_error')
      ? `<span class="cc-meta">Last sync ${escHtml(timeAgo(integration.last_sync_at))}</span>`
      : '';
    const summary = integration.config_summary
      ? `<span class="cc-summary">${escHtml(integration.config_summary)}</span>`
      : '';
    const errorPill = integration.last_sync_error
      ? `<span class="chip" style="background:rgba(180,40,40,.08);color:var(--red);border:1px solid rgba(180,40,40,.25);margin-left:6px">${escHtml(String(integration.last_sync_error).slice(0, 80))}</span>`
      : '';

    // Action buttons. Each action label is a known string from the aggregator;
    // settings.js wires click handlers via data-cc-action="${action}" + data-cc-id="${integration.id}".
    const actionLabels = {
      connect:       'Connect →',
      pick_property: 'Pick property →',
      pick_site:     'Pick site →',
      configure:     'Configure →',
      generate:      'Generate webhook →',
      rotate:        'Rotate secret',
      resync:        'Resync now',
      disconnect:    'Disconnect',
      edit:          'Edit',
      upgrade:       'Upgrade to Pro →',
    };
    const actionsHtml = (integration.actions || []).map((a, i) => {
      const cls = (a === 'connect' || a === 'configure' || a === 'generate' || a === 'upgrade')
        ? 'btn btn-primary btn-sm'
        : 'btn btn-ghost btn-sm';
      const href = a === 'upgrade' ? ' href="/Billing.html"' : '';
      const tag = a === 'upgrade' ? 'a' : 'button';
      const typeAttr = a === 'upgrade' ? '' : ' type="button"';
      const margin = i > 0 ? ' style="margin-left:6px"' : '';
      return `<${tag} class="${cls}" data-cc-action="${escHtml(a)}" data-cc-id="${escHtml(integration.id)}"${typeAttr}${href}${margin}>${escHtml(actionLabels[a] || a)}</${tag}>`;
    }).join('');

    return `
      <div class="cc-row" data-cc-row="${escHtml(integration.id)}">
        <div class="cc-row-head">
          <div class="cc-row-name">
            <strong>${escHtml(integration.name)}</strong>
            <span class="${pill.cls}" style="margin-left:8px">${dot}${escHtml(pill.label)}</span>
            ${errorPill}
          </div>
          ${valueOneliner ? `<div class="cc-row-value">${escHtml(valueOneliner)}</div>` : ''}
          <div class="cc-row-meta">${summary} ${lastSync}</div>
        </div>
        <div class="cc-row-actions">${actionsHtml}</div>
      </div>`;
  }

  /**
   * Renders the whole hub: one card containing N connector rows + a
   * header with completion + recommended-next callout.
   */
  function renderHub(payload) {
    const completion = payload.completion || { connected: 0, available: 0, pct: 0 };
    const recommended = payload.recommended_next;
    const recommendedRow = recommended
      ? (payload.integrations.find(i => i.id === recommended) || null)
      : null;
    const rows = (payload.integrations || []).map(i => render(i, 'hub')).join('');
    const recommendedCallout = recommendedRow
      ? `<div class="cc-recommended">
           <span class="cc-recommended-label">Recommended next:</span>
           <strong>${escHtml(recommendedRow.name)}</strong>
           <button type="button" class="btn btn-primary btn-sm" data-cc-action="${escHtml(recommendedRow.actions[0] || 'connect')}" data-cc-id="${escHtml(recommendedRow.id)}" style="margin-left:10px">${escHtml(recommendedRow.name)} →</button>
         </div>`
      : '';
    return `
      <div class="card-dash" id="cc-hub">
        <div class="card-head">
          <div>
            <h3>Traffic Impact integrations</h3>
            <div class="sub">${completion.connected} of ${completion.available} connected · ${completion.pct}% complete</div>
          </div>
        </div>
        ${recommendedCallout}
        <div class="cc-rows">${rows}</div>
      </div>`;
  }

  window.AMCP_CONNECTOR_CARD = { render, renderHub };
})();
