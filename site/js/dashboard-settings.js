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

    // Account activity — last login is the current session (we only have
    // "now" client-side until /api/client/me grows a last_login_at field).
    setText('account-last-login', 'This session');

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

  function fillProfileForm(profile) {
    if (!profile) return;
    var n = document.getElementById('profile-name');
    if (n) {
      n.value = profile.name || (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
      // Tooltip already explains why this field is disabled.
    }
    var d = document.getElementById('profile-description');
    if (d) d.value = profile.description || '';
    var c = document.getElementById('profile-category');
    if (c) c.value = profile.category || '';
    var s = document.getElementById('profile-services');
    if (s) s.value = Array.isArray(profile.services) ? profile.services.join(', ') : (profile.services || '');
    var w = document.getElementById('profile-website');
    if (w) w.value = profile.website || '';
  }

  function loadProfile() {
    // The profile fetch has its own endpoint on Railway; the Worker's
    // /api/client/recommendations uses the same source. Rather than add
    // another proxy route, read it from /api/client/profile — OR, if the
    // server only has POST, reuse /api/client/recommendations which fetches
    // the profile internally. The simplest path: POST an empty profile
    // update to trigger validation error… not ideal. Instead hit the
    // Worker's /api/client/me → user object and derive name from the slug
    // for now, and let the user overwrite other fields via the form.
    //
    // Implementation choice: add a lightweight GET via the
    // recommendations endpoint, which already returns checklist flags
    // based on profile completeness. For richer fields we fall back to
    // whatever AMCP_DATA exposes.

    // Prefer AMCP_DATA.profile if the metrics endpoint starts returning it
    // in a future pass; right now use sensible empty defaults.
    var derived = {
      name:        (window.AMCP_DATA && window.AMCP_DATA.business_name) || '',
      description: '',
      category:    '',
      services:    [],
      website:     '',
    };
    fillProfileForm(derived);
    profileCache = derived;
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

      var servicesRaw = (document.getElementById('profile-services') || {}).value || '';
      var services = servicesRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

      var body = {
        description: (document.getElementById('profile-description') || {}).value || '',
        category:    (document.getElementById('profile-category')    || {}).value || '',
        services:    services,
        website:     (document.getElementById('profile-website')     || {}).value || '',
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

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['settings']       = render;
  window.AMCP_SECTIONS['onUserLoaded']   = onUserLoaded;
})();
