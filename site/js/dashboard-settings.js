/* Settings section — account info from /api/client/me, API key rotate.
 * Registers as window.AMCP_SECTIONS['settings'] and
 * window.AMCP_SECTIONS.onUserLoaded. */
(function () {
  'use strict';

  var userCache = null;

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val || '—';
  }

  function populateUser(user) {
    setText('settings-email', user.email);
    setText('settings-plan',  user.role === 'admin' ? 'Admin' : 'Pro');

    /* Slug comes from metrics data — already set by shell if available */
    var slugEl = document.getElementById('settings-slug');
    if (slugEl && slugEl.textContent === '—') {
      if (window.AMCP_DATA && window.AMCP_DATA.slug) {
        slugEl.textContent = window.AMCP_DATA.slug;
      }
    }

    /* Update plan badge in sidebar */
    var badge = document.getElementById('plan-badge');
    if (badge) badge.textContent = user.role === 'admin' ? 'Admin' : 'Pro';
  }

  function render() {
    if (userCache) {
      populateUser(userCache);
    }
    /* User data may not have arrived yet — onUserLoaded will fire when it does */
  }

  /* Called by shell once /api/client/me resolves */
  function onUserLoaded(user) {
    userCache = user;
    populateUser(user);
  }

  /* ── API key rotation ── */
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

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('btn-rotate-key');
    if (!btn) return;

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
          return;
        }

        var newKey = data.api_key || data.key || '';
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
        } else {
          setRotateStatus('Key rotated. Reload to see the masked key.', false);
        }
      } catch (err) {
        setRotateStatus('Network error. Please try again.', true);
      } finally {
        rotating = false;
        btn.disabled = false;
        btn.textContent = 'Rotate';
      }
    });
  });

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['settings']       = render;
  window.AMCP_SECTIONS['onUserLoaded']   = onUserLoaded;
})();
