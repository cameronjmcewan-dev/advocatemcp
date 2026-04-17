// dashboard-theme.js — tiny runtime-theme helper exposed as window.AMCP_THEME.
// All section modules read accent colors through this shim instead of hardcoding
// hex values; keeps the brand palette swappable from a single CSS :root block.
(function () {
  'use strict';

  function accent() {
    var v = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent')
      .trim();
    return v || '#3d0a22';
  }

  function accentDim() {
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--accent-dim')
      .trim();
  }

  function isDark() {
    return document.documentElement.getAttribute('data-theme') !== 'light';
  }

  // Returns accent hex with a hex-alpha suffix appended (e.g. '55', '22').
  // Chart.js convenience so sections don't have to format rgba() strings
  // every time they want a translucent fill.
  function accentWithAlpha(hexAlpha) {
    return accent() + hexAlpha;
  }

  window.AMCP_THEME = {
    accent: accent,
    accentDim: accentDim,
    isDark: isDark,
    accentWithAlpha: accentWithAlpha,
  };
})();
