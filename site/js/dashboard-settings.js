/* Settings section — account info, API key rotate, profile edit, and a
 * minimal account activity card.
 *
 * D6 upgrade:
 *  - Plan badge reads real AMCP_DATA.plan ('free'|'base'|'pro'), not role.
 *  - Profile form fetches /agents/:slug/profile via the Worker proxy
 *    (piggy-backed on /api/client/recommendations' fetchProfile path —
 *    see the new /api/client/profile endpoint for writes).
 *  - Account activity card surfaces last sign-in + last rotation when
 *    we have them; falls back to "Unknown" otherwise.
 *
 * Registers as window.AMCP_SECTIONS['settings'] and
 * window.AMCP_SECTIONS.onUserLoaded. */
(function () {
  'use strict';

  var userCache    = null;
  var profileCache = null;

  var LAST_ROTATE_KEY = 'amcp-last-rotate';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val || '—';
  }

  function planLabel(plan) {
    if (plan === 'pro')  return 'Pro';
    if (plan === 'base') return 'Base';
    if (plan === 'admin') return 'Admin';
    return 'Free';
  }

  function populateAccount(user) {
    setText('settings-email', user.email);

    var plan = (window.AMCP_DATA && window.AMCP_DATA.plan) || (user.role === 'admin' ? 'admin' : 'free');
    setText('settings-plan', planLabel(plan));

    // Update sidebar plan badge too.
    var badge = document.getElementById('plan-badge');
    if (badge) badge.textContent = planLabel(plan);

    if (window.AMCP_DATA && window.AMCP_DATA.slug) {
      var slugEl = document.getElementById('settings-slug');
      if (slugEl) slugEl.textContent = window.AMCP_DATA.slug;
    }

    // Account activity — we don't yet have a last_login_at field from
    // /api/client/me, so show an em-dash instead of a cosmetic "This session"
    // placeholder. Flip to a real value once the endpoint exposes it.
    setText('account-last-login', '—');

    var lastRotate = null;
    try { lastRotate = localStorage.getItem(LAST_ROTATE_KEY); } catch (_) { /* ignore */ }
    if (lastRotate) {
      try {
        var d = new Date(lastRotate);
        setText('account-last-rotate', d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
      } catch (_) {
        setText('account-last-rotate', lastRotate);
      }
    } else {
      setText('account-last-rotate', 'Unknown');
    }
  }

  function setVal(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val == null ? '' : String(val);
  }

  function csvJoin(v) {
    if (Array.isArray(v)) return v.join(', ');
    return v == null ? '' : String(v);
  }

  function fillProfileForm(profile) {
    if (!profile) return;
    var n = document.getElementById('profile-name');
    if (n) {
      n.value = profile.name || (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
      // Tooltip already explains why this field is disabled.
    }
    setVal('profile-description',           profile.description);
    setVal('profile-category',              profile.category);
    setVal('profile-services',              csvJoin(profile.services));
    setVal('profile-website',               profile.website);
    setVal('profile-referral-url',          profile.referral_url);
    setVal('profile-differentiator',        profile.differentiator);
    setVal('profile-top-services',          csvJoin(profile.top_services));
    setVal('profile-phone',                 profile.phone);
    setVal('profile-location',              profile.location);
    setVal('profile-tone',                  profile.tone);
    setVal('profile-pricing-tier',          profile.pricing_tier);
    setVal('profile-pricing',               profile.pricing);
    setVal('profile-years-in-business',     profile.years_in_business);
    setVal('profile-star-rating',           profile.star_rating);
    setVal('profile-review-count',          profile.review_count);
    setVal('profile-service-radius-miles',  profile.service_radius_miles);
    setVal('profile-service-area-keywords', csvJoin(profile.service_area_keywords));
    setVal('profile-certifications',        csvJoin(profile.certifications));
    setVal('profile-availability',          profile.availability);
  }

  var profileAbortCtrl = null;

  function loadProfile() {
    // Pre-fill the form with empty defaults so the UI has something to show
    // while the fetch is in flight, then overlay real values once Railway
    // responds. This also keeps the form usable if the proxy fails.
    var fallback = {
      name: (window.AMCP_DATA && window.AMCP_DATA.business_name) || '',
    };
    fillProfileForm(fallback);
    profileCache = fallback;

    var slug = window.AMCP_DATA && window.AMCP_DATA.slug;
    if (!slug) return;

    // Abort any in-flight profile fetch before starting a new one.
    if (profileAbortCtrl) profileAbortCtrl.abort();
    profileAbortCtrl = new AbortController();

    window.AMCP.authedFetch('/api/client/profile?slug=' + encodeURIComponent(slug), {
      signal: profileAbortCtrl.signal,
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (profile) {
        if (!profile) return;
        fillProfileForm(profile);
        profileCache = profile;
      })
      .catch(function (err) {
        // AbortError is benign; other failures are non-fatal — the form
        // stays with the fallback defaults.
        if (err && err.name === 'AbortError') return;
      });
  }

  function render() {
    if (userCache) populateAccount(userCache);
    loadProfile();
  }

  /* Called by shell once /api/client/me resolves */
  function onUserLoaded(user) {
    userCache = user;
    populateAccount(user);
  }

  // ── Profile save ────────────────────────────────────────────────────────
  var saving = false;

  function setProfileStatus(msg, variant) {
    var el = document.getElementById('profile-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = variant === 'error' ? 'var(--red)' : variant === 'success' ? 'var(--green)' : 'var(--muted)';
  }

  var profileForm = document.getElementById('profile-form');
  if (profileForm) {
    profileForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (saving) return;

      var slug = window.AMCP_DATA && window.AMCP_DATA.slug;
      if (!slug) {
        AMCP_UI.toast('Business not loaded yet', 'error');
        return;
      }

      function csvSplit(id) {
        var raw = (document.getElementById(id) || {}).value || '';
        return raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      }
      function strVal(id) {
        return (document.getElementById(id) || {}).value || '';
      }
      function numVal(id) {
        var raw = strVal(id).trim();
        if (raw === '') return null;
        var n = Number(raw);
        return Number.isFinite(n) ? n : null;
      }

      var body = {
        description:           strVal('profile-description'),
        category:              strVal('profile-category'),
        services:              csvSplit('profile-services'),
        website:               strVal('profile-website'),
        referral_url:          strVal('profile-referral-url'),
        differentiator:        strVal('profile-differentiator'),
        top_services:          csvSplit('profile-top-services'),
        phone:                 strVal('profile-phone'),
        location:              strVal('profile-location'),
        tone:                  strVal('profile-tone'),
        pricing_tier:          strVal('profile-pricing-tier'),
        pricing:               strVal('profile-pricing'),
        years_in_business:     numVal('profile-years-in-business'),
        star_rating:           numVal('profile-star-rating'),
        review_count:          numVal('profile-review-count'),
        service_radius_miles:  numVal('profile-service-radius-miles'),
        service_area_keywords: csvSplit('profile-service-area-keywords'),
        certifications:        csvSplit('profile-certifications'),
        availability:          strVal('profile-availability'),
      };

      saving = true;
      var btn = document.getElementById('btn-save-profile');
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      setProfileStatus('', '');

      try {
        var res = await window.AMCP.authedFetch('/api/client/profile?slug=' + encodeURIComponent(slug), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          AMCP_UI.toast('Save failed', 'error');
          setProfileStatus(String((data && data.error) || ('HTTP ' + res.status)), 'error');
        } else {
          AMCP_UI.toast('Profile saved', 'success');
          setProfileStatus('Saved just now', 'success');
        }
      } catch (err) {
        AMCP_UI.toast('Save failed', 'error');
        setProfileStatus(String(err && err.message || err), 'error');
      } finally {
        saving = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Save profile'; }
      }
    });
  }

  // ── API key rotation ────────────────────────────────────────────────────
  var rotating = false;

  function setRotateStatus(msg, isError) {
    var el = document.getElementById('rotate-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--red)' : 'var(--green)';
  }

  function clearRotateStatus() {
    var el = document.getElementById('rotate-status');
    if (el) el.textContent = '';
  }

  var btn = document.getElementById('btn-rotate-key');
  if (btn) {
    btn.addEventListener('click', async function () {
      if (rotating) return;

      var slug = window.AMCP_DATA && window.AMCP_DATA.slug;
      if (!slug) {
        setRotateStatus('Cannot rotate: business slug not loaded yet.', true);
        return;
      }

      if (!confirm('Rotate your API key? Your current key stops working immediately.')) return;

      rotating = true;
      btn.disabled = true;
      btn.textContent = 'Rotating\u2026';
      clearRotateStatus();

      try {
        var res = await window.AMCP.authedFetch('/api/client/rotate-key', { method: 'POST' });
        var data = await res.json();

        if (!res.ok) {
          setRotateStatus('Rotation failed: ' + (data.error || 'unknown error'), true);
          AMCP_UI.toast('Rotation failed', 'error');
          return;
        }

        var newKey = data.new_api_key || '';
        if (newKey) {
          var display = document.getElementById('new-key-display');
          if (display) {
            display.value = newKey;
            display.type = 'text';
          }
          var copyBtn = document.getElementById('copy-new-key');
          if (copyBtn) {
            copyBtn.style.display = '';
            copyBtn.onclick = function () {
              navigator.clipboard.writeText(newKey).then(function () {
                copyBtn.textContent = 'Copied!';
                setTimeout(function () { copyBtn.textContent = 'Copy'; }, 2000);
              });
            };
          }
          setRotateStatus('New key generated. Copy it now — it won\'t be shown again.', false);
          AMCP_UI.toast('API key rotated', 'success');
          var nowIso = new Date().toISOString();
          try { localStorage.setItem(LAST_ROTATE_KEY, nowIso); } catch (_) { /* ignore */ }
          try {
            var d = new Date(nowIso);
            setText('account-last-rotate', d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
          } catch (_) { /* ignore */ }
        } else {
          setRotateStatus('Key rotated. Reload to see the masked key.', false);
        }
      } catch (err) {
        setRotateStatus('Network error. Please try again.', true);
        AMCP_UI.toast('Network error', 'error');
      } finally {
        rotating = false;
        btn.disabled = false;
        btn.textContent = 'Rotate';
      }
    });
  }

  // ── Tutorial controls ───────────────────────────────────────────────────
  var replayBtn = document.getElementById('btn-replay-welcome');
  if (replayBtn) {
    replayBtn.addEventListener('click', function () {
      if (window.AMCP_ONBOARDING && window.AMCP_ONBOARDING.openWelcome) {
        window.AMCP_ONBOARDING.openWelcome();
      }
    });
  }

  var restartBtn = document.getElementById('btn-restart-tour');
  if (restartBtn) {
    restartBtn.addEventListener('click', function () {
      if (window.AMCP_ONBOARDING && window.AMCP_ONBOARDING.restart) {
        window.AMCP_ONBOARDING.restart();
      }
    });
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['settings']       = render;
  window.AMCP_SECTIONS['onUserLoaded']   = onUserLoaded;
})();
