/*
 * Google Analytics 4 (gtag.js) install for advocatemcp.com.
 *
 * The measurement ID belongs to the GA4 property the operator's `advocate`
 * tenant has connected via OAuth in the customer portal — populating
 * traffic_daily there with real visitor data is what unlocks the Phase 1-6
 * cards on /TrafficImpact in production.
 *
 * Loads gtag.js dynamically so each marketing page only needs ONE include
 * line (the existing pages do not share a head template). Update the ID
 * here once and every page picks it up on the next Pages deploy.
 *
 * Honors Do-Not-Track and a localStorage opt-out (advocate_analytics=off)
 * so dogfooding visits + the operator's own browser don't pollute data.
 */
(function () {
  var MEASUREMENT_ID = 'G-XXXXXXXXXX'; // <-- replaced post-deploy with the real ID

  // No-op if the placeholder hasn't been replaced yet (avoids 404 noise on
  // googletagmanager.com for an unconfigured ID).
  if (!/^G-[A-Z0-9]+$/.test(MEASUREMENT_ID)) return;

  // Respect Do-Not-Track and an explicit opt-out.
  try {
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
    if (localStorage.getItem('advocate_analytics') === 'off') return;
  } catch (_) { /* localStorage may throw in private mode — fall through */ }

  var s = document.createElement('script');
  s.async = true;
  s.src   = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID, {
    // Don't send a hit on the initial page_view if the page calls gtag()
    // itself; we want the default page_view but no duplicates.
    send_page_view: true,
  });
})();
