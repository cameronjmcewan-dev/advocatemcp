// site/js/v2/prereqCoach.js
//
// Static coaching content for the external prerequisites that block
// some integration setups (Stripe webhook, Google Place ID lookup,
// GSC site verification). Same content surfaces in all 3 surfaces
// (Settings hub, Traffic Impact wizard, dedicated setup page) — the
// outer layout differs but the steps + helper links are constant.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-impact-setup-design.md
// Phase 1 of the Traffic Impact setup redesign.

(function () {
  'use strict';

  const COACHES = {
    stripe_webhook: {
      title: 'Connect Stripe to send revenue events to Advocate',
      steps: [
        { text: 'Click Generate below — Advocate will mint a webhook URL + signing secret for you.' },
        { text: 'Open your Stripe dashboard → Developers → Webhooks → Add endpoint.' },
        { text: 'Paste the URL into the Endpoint URL field. Subscribe to: charge.succeeded, payment_intent.succeeded, invoice.paid.' },
        { text: 'Stripe will ask for a signing secret — paste the secret Advocate generated above.' },
        { text: 'Save in Stripe. The first event we receive flips this card to Connected.' },
      ],
      helper_links: [{ label: 'Stripe webhook docs', url: 'https://stripe.com/docs/webhooks' }],
    },
    google_place_id: {
      title: 'Find your Google Place ID',
      steps: [
        { text: 'Open Google\'s Place ID Finder.' },
        { text: 'Search for your business by name (the same way customers find you).' },
        { text: 'Copy the Place ID — it looks like ChIJ… and is shown beneath the business name.' },
        { text: 'Paste it into the field below.' },
      ],
      helper_links: [{ label: 'Place ID Finder', url: 'https://developers.google.com/maps/documentation/places/web-service/place-id' }],
    },
    gsc_verification: {
      title: 'Verify your site in Google Search Console first',
      steps: [
        { text: 'Open Google Search Console.' },
        { text: 'Add your site as a property if it isn\'t already there.' },
        { text: 'Verify ownership using whichever method works (DNS TXT record, HTML file upload, or your existing Google Analytics).' },
        { text: 'Once verified, come back and click Connect — your verified site will appear in the picker.' },
      ],
      helper_links: [{ label: 'Search Console', url: 'https://search.google.com/search-console' }],
    },
  };

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Render coach HTML for a given coach_id. Returns '' if the coach_id
   * isn't in the COACHES map (so callers can blindly call this with
   * the prereq's coach_id).
   */
  function render(coachId) {
    const coach = COACHES[coachId];
    if (!coach) return '';
    const stepsHtml = coach.steps.map((s, i) => `
      <li class="coach-step">
        <span class="coach-step-num">${i + 1}</span>
        <span class="coach-step-text">${escHtml(s.text)}</span>
      </li>`).join('');
    const linksHtml = (coach.helper_links || []).map(l =>
      `<a href="${escHtml(l.url)}" target="_blank" rel="noopener" class="coach-link">${escHtml(l.label)} →</a>`
    ).join(' ');
    return `
      <div class="prereq-coach">
        <div class="coach-title">${escHtml(coach.title)}</div>
        <ol class="coach-steps">${stepsHtml}</ol>
        ${linksHtml ? `<div class="coach-links">${linksHtml}</div>` : ''}
      </div>`;
  }

  window.AMCP_PREREQ_COACH = { render, COACHES };
})();
