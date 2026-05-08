// site/js/v2/trafficImpactWizard.js
//
// Phase-2 wizard for /TrafficImpact.html empty state. Replaces the
// legacy "Connect Google Analytics →" State A with a guided stepper
// that walks the user through the server's recommended_next chain.
//
// State model: server-driven. recommended_next IS the cursor. Each
// completed integration triggers a natural OAuth-redirect-or-picker-
// reload; the page boots fresh and the wizard re-evaluates against
// the new payload. No localStorage. No cross-session state.
//
// Reuses connectorCard.js's surface:"wizard" mode (PR 2) and
// runInlinePicker's mountTarget option (PR 1).
//
// Spec: docs/superpowers/specs/2026-05-08-traffic-impact-wizard-phase-2-design.md

(function () {
  'use strict';

  // In-tab session flag for "Skip All" — resets on page reload, which
  // matches the user-chosen UX of "auto-wizard until 2+ connected".
  let dismissedThisSession = false;

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Pure: returns true if the wizard should mount instead of the legacy
   * State A. Called by traffic-impact.js's render path. Falls back to
   * legacy on any input that doesn't satisfy the threshold.
   */
  function shouldRender(hub) {
    if (dismissedThisSession) return false;
    if (!hub) return false;
    const completion = hub.completion || {};
    const connected = Number(completion.connected || 0);
    return connected < 2 && hub.recommended_next != null;
  }

  // Phase 2 PR 3 stages 1-4 add: renderState, mount, helpers below.
  // Skeleton only in this task.
  function renderState() { return ''; }
  function mount() {}

  window.AMCP_TI_WIZARD = { shouldRender, renderState, mount };
})();
