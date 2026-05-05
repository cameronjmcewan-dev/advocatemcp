/* Settings section, account info, API key rotate, profile edit, and a
 * minimal account activity card.
 *
 * D6 upgrade:
 *  - Plan badge reads real AMCP_DATA.plan ('free'|'base'|'pro'), not role.
 *  - Profile form fetches /agents/:slug/profile via the Worker proxy
 *    (piggy-backed on /api/client/recommendations' fetchProfile path,
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
    if (el) el.textContent = val || ',';
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

    var input = document.getElementById('settings-full-name');
    if (input) input.value = (user && user.full_name) || '';

    // Account activity, we don't yet have a last_login_at field from
    // /api/client/me, so show an em-dash instead of a cosmetic "This session"
    // placeholder. Flip to a real value once the endpoint exposes it.
    setText('account-last-login', ',');

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
        fillOpsForm(profile);
        profileCache = profile;
      })
      .catch(function (err) {
        // AbortError is benign; other failures are non-fatal, the form
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

  // ── Agent Operations: hours / pricing ranges / lead routing / tz / webhook ──
  var DAYS = [
    { key: 'mon', label: 'Mon' },
    { key: 'tue', label: 'Tue' },
    { key: 'wed', label: 'Wed' },
    { key: 'thu', label: 'Thu' },
    { key: 'fri', label: 'Fri' },
    { key: 'sat', label: 'Sat' },
    { key: 'sun', label: 'Sun' },
  ];
  var UNIT_OPTIONS = ['job', 'hour', 'visit', 'sqft'];

  function renderHoursGrid(hours) {
    var grid = document.getElementById('hours-grid');
    if (!grid) return;
    grid.innerHTML = '';
    DAYS.forEach(function (d) {
      var day = hours && hours[d.key];
      var isOpen = !!(day && day.open && day.close);
      var row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:60px 24px 1fr 1fr;gap:8px;align-items:center';
      row.innerHTML =
        '<span style="font-size:var(--tx-xs);color:var(--muted)">' + d.label + '</span>' +
        '<input type="checkbox" data-hours-open="' + d.key + '"' + (isOpen ? ' checked' : '') + '>' +
        '<input type="time" class="fi" data-hours-field="' + d.key + '-open"' +
          ' value="' + (isOpen ? String(day.open) : '') + '"' +
          (isOpen ? '' : ' disabled') + '>' +
        '<input type="time" class="fi" data-hours-field="' + d.key + '-close"' +
          ' value="' + (isOpen ? String(day.close) : '') + '"' +
          (isOpen ? '' : ' disabled') + '>';
      grid.appendChild(row);

      var cb = row.querySelector('[data-hours-open="' + d.key + '"]');
      cb.addEventListener('change', function () {
        var openEl  = row.querySelector('[data-hours-field="' + d.key + '-open"]');
        var closeEl = row.querySelector('[data-hours-field="' + d.key + '-close"]');
        openEl.disabled  = !cb.checked;
        closeEl.disabled = !cb.checked;
        if (cb.checked) {
          if (!openEl.value)  openEl.value  = '09:00';
          if (!closeEl.value) closeEl.value = '17:00';
        }
      });
    });
  }

  function collectHoursJson() {
    var out = { emergency_24_7: !!(document.getElementById('ops-emergency-24-7') || {}).checked };
    DAYS.forEach(function (d) {
      var cb = document.querySelector('[data-hours-open="' + d.key + '"]');
      var openEl  = document.querySelector('[data-hours-field="' + d.key + '-open"]');
      var closeEl = document.querySelector('[data-hours-field="' + d.key + '-close"]');
      if (cb && cb.checked && openEl && closeEl && openEl.value && closeEl.value) {
        out[d.key] = { open: openEl.value, close: closeEl.value };
      } else {
        out[d.key] = null;
      }
    });
    return out;
  }

  function makeRangeRow(range) {
    var row = document.createElement('div');
    row.className = 'pricing-range-row';
    row.style.cssText = 'display:grid;grid-template-columns:2fr 1fr 1fr 110px 28px;gap:6px;align-items:center';
    var unit = (range && range.unit) || 'job';
    row.innerHTML =
      '<input type="text" class="fi" data-range-field="service" placeholder="Service name" value="' + esc((range && range.service) || '') + '">' +
      '<input type="number" min="0" step="0.01" class="fi" data-range-field="min" placeholder="Min" value="' + (range && range.min != null ? range.min : '') + '">' +
      '<input type="number" min="0" step="0.01" class="fi" data-range-field="max" placeholder="Max" value="' + (range && range.max != null ? range.max : '') + '">' +
      '<select class="fi" data-range-field="unit">' +
        UNIT_OPTIONS.map(function (u) {
          return '<option value="' + u + '"' + (u === unit ? ' selected' : '') + '>per ' + u + '</option>';
        }).join('') +
      '</select>' +
      '<button type="button" class="btn-sm btn-ghost" data-range-remove style="padding:0 8px">×</button>';
    row.querySelector('[data-range-remove]').addEventListener('click', function () {
      row.parentNode && row.parentNode.removeChild(row);
    });
    return row;
  }

  function renderPricingRanges(pricing) {
    var wrap = document.getElementById('pricing-ranges');
    if (!wrap) return;
    wrap.innerHTML = '';
    var ranges = (pricing && Array.isArray(pricing.ranges)) ? pricing.ranges : [];
    ranges.forEach(function (r) { wrap.appendChild(makeRangeRow(r)); });
    var cfq = document.getElementById('ops-call-for-quote');
    var fe  = document.getElementById('ops-free-estimates');
    if (cfq) cfq.checked = !!(pricing && pricing.call_for_quote);
    if (fe)  fe.checked  = !!(pricing && pricing.free_estimates);
  }

  function collectPricingJson() {
    var rows = document.querySelectorAll('#pricing-ranges .pricing-range-row');
    var ranges = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var service = row.querySelector('[data-range-field="service"]').value.trim();
      var minRaw  = row.querySelector('[data-range-field="min"]').value.trim();
      var maxRaw  = row.querySelector('[data-range-field="max"]').value.trim();
      var unit    = row.querySelector('[data-range-field="unit"]').value;
      if (!service && !minRaw && !maxRaw) continue; // skip fully-empty rows
      ranges.push({
        service: service,
        min: minRaw === '' ? 0 : Number(minRaw),
        max: maxRaw === '' ? 0 : Number(maxRaw),
        unit: unit,
      });
    }
    return {
      ranges: ranges,
      call_for_quote: !!(document.getElementById('ops-call-for-quote') || {}).checked,
      free_estimates: !!(document.getElementById('ops-free-estimates') || {}).checked,
    };
  }

  function fillRouting(routing) {
    setVal('ops-routing-channel',  routing && routing.preferred_channel);
    setVal('ops-routing-phone',    routing && routing.phone);
    setVal('ops-routing-email',    routing && routing.email);
    setVal('ops-routing-form-url', routing && routing.form_url);
  }

  function collectRouting() {
    var channel = (document.getElementById('ops-routing-channel') || {}).value || '';
    if (!channel) return null;
    var out = { preferred_channel: channel };
    var phone  = (document.getElementById('ops-routing-phone')   || {}).value.trim();
    var email  = (document.getElementById('ops-routing-email')   || {}).value.trim();
    var form   = (document.getElementById('ops-routing-form-url')|| {}).value.trim();
    if (phone) out.phone = phone;
    if (email) out.email = email;
    if (form)  out.form_url = form;
    return out;
  }

  function fillOpsForm(profile) {
    renderHoursGrid(profile && profile.hours_json);
    var em = document.getElementById('ops-emergency-24-7');
    if (em) em.checked = !!(profile && profile.hours_json && profile.hours_json.emergency_24_7);
    setVal('ops-timezone', profile && profile.timezone);
    setVal('ops-availability-webhook-url', profile && profile.availability_webhook_url);
    renderPricingRanges(profile && profile.pricing_json_v2);
    fillRouting(profile && profile.lead_routing_json);
  }

  // Mount initial empty state so controls render before the first profile fetch lands.
  renderHoursGrid(null);
  renderPricingRanges(null);

  var addRangeBtn = document.getElementById('btn-add-pricing-range');
  if (addRangeBtn) {
    addRangeBtn.addEventListener('click', function () {
      var wrap = document.getElementById('pricing-ranges');
      if (wrap) wrap.appendChild(makeRangeRow(null));
    });
  }

  function setOpsStatus(msg, variant) {
    var el = document.getElementById('ops-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = variant === 'error' ? 'var(--red)' : variant === 'success' ? 'var(--green)' : 'var(--muted)';
  }

  var savingOps = false;
  var opsForm = document.getElementById('ops-form');
  if (opsForm) {
    opsForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (savingOps) return;
      var slug = window.AMCP_DATA && window.AMCP_DATA.slug;
      if (!slug) { AMCP_UI.toast('Business not loaded yet', 'error'); return; }

      var tz = (document.getElementById('ops-timezone') || {}).value.trim();
      var hook = (document.getElementById('ops-availability-webhook-url') || {}).value.trim();

      var body = {
        hours_json:      collectHoursJson(),
        pricing_json_v2: collectPricingJson(),
        lead_routing_json: collectRouting(),
        timezone: tz || null,
        availability_webhook_url: hook || null,
      };

      savingOps = true;
      var opsBtn = document.getElementById('btn-save-ops');
      if (opsBtn) { opsBtn.disabled = true; opsBtn.textContent = 'Saving…'; }
      setOpsStatus('', '');

      try {
        var res = await window.AMCP.authedFetch('/api/client/profile?slug=' + encodeURIComponent(slug), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          AMCP_UI.toast('Save failed', 'error');
          var detail = data && data.error ? data.error : ('HTTP ' + res.status);
          if (data && data.details && data.details.fieldErrors) {
            var firstField = Object.keys(data.details.fieldErrors)[0];
            var firstMsg   = data.details.fieldErrors[firstField] && data.details.fieldErrors[firstField][0];
            if (firstField && firstMsg) detail += ', ' + firstField + ': ' + firstMsg;
          }
          setOpsStatus(String(detail), 'error');
        } else {
          AMCP_UI.toast('Operations saved', 'success');
          setOpsStatus('Saved just now', 'success');
        }
      } catch (err) {
        AMCP_UI.toast('Save failed', 'error');
        setOpsStatus(String(err && err.message || err), 'error');
      } finally {
        savingOps = false;
        if (opsBtn) { opsBtn.disabled = false; opsBtn.textContent = 'Save operations'; }
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
          setRotateStatus('New key generated. Copy it now, it won\'t be shown again.', false);
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

  // Reveal the Get Started nav item (hidden by default once onboarded_at is
  // set) and navigate there. Checklist items that were already completed
  // remain checked, the user can click into any specific one to re-run it.
  var openGsBtn = document.getElementById('btn-open-get-started');
  if (openGsBtn) {
    openGsBtn.addEventListener('click', function () {
      var navItem = document.querySelector('[data-onboarding-nav]');
      if (navItem) navItem.style.display = '';
      var gs = document.querySelector('[data-section="getting-started"]');
      if (gs) gs.click();
    });
  }

  // Save full name button handler
  var saveNameBtn = document.getElementById('btn-save-name');
  if (saveNameBtn) {
    saveNameBtn.addEventListener('click', function () {
      var input = document.getElementById('settings-full-name');
      var status = document.getElementById('name-save-status');
      var newName = (input.value || '').trim();
      if (!newName) { if (status) { status.textContent = 'Name cannot be empty'; status.style.color = 'var(--red)'; } return; }
      saveNameBtn.disabled = true;
      var prevText = saveNameBtn.textContent;
      saveNameBtn.textContent = 'Saving...';
      window.AMCP.authedFetch('/api/client/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: newName }),
      }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (data) {
          if (window.AMCP_DATA) window.AMCP_DATA.full_name = data.full_name || newName;
          if (status) { status.textContent = 'Saved'; status.style.color = 'var(--green)'; }
        })
        .catch(function (err) {
          if (status) { status.textContent = 'Save failed: ' + (err.message || err); status.style.color = 'var(--red)'; }
        })
        .finally(function () { saveNameBtn.disabled = false; saveNameBtn.textContent = prevText; });
    });
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['settings']       = render;
  window.AMCP_SECTIONS['onUserLoaded']   = onUserLoaded;
})();
