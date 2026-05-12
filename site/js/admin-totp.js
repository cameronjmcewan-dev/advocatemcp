/* TOTP enrollment + disable flows for /admin/security.html.
 *
 * Talks to three Worker endpoints introduced in worker/src/routes/authTotp.ts:
 *   POST /api/auth/totp/enroll-start    -> { secret, otpauth_uri }
 *   POST /api/auth/totp/enroll-confirm  -> { ok: true, totp_enabled_at }
 *   POST /api/auth/totp/disable         -> { ok: true }
 *
 * UI lifecycle (single mount point #totp-app):
 *   1. Status check on mount (any 401 redirects to /login.html via the
 *      v2 shell). Status surfaces through /api/auth/refresh + a probe
 *      of /api/auth/totp/enroll-start: a 409 totp_already_enabled means
 *      enrolled; success means we just generated a new secret and the
 *      app moves into "scan + confirm" state; anything else surfaces an
 *      error.
 *      The probe-as-status pattern avoids a fourth endpoint just to
 *      read state; the secret returned during probe is the very secret
 *      we'd want anyway if the user is enrolling.
 *   2. ENROLLED state: shows "MFA is on" + Disable form.
 *   3. PENDING state: shows secret + otpauth URI + confirm form.
 *
 * NO QR rendering — we deliberately avoid pulling in a QR encoder
 * dependency. Customers paste the otpauth URI into their authenticator
 * app (every major app supports manual URI import) or type the secret
 * by hand. The secret is displayed in 4-char groups for legibility.
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function setStatus(html) { $('totp-status').innerHTML = html; }

  function formatSecret(s) {
    // 32-char base32 secret -> 8 groups of 4 for readability.
    return s.replace(/(.{4})/g, '$1 ').trim();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function call(path, body) {
    var res = await window.AMCP.authedFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
    });
    var data = null;
    try { data = await res.json(); } catch (_) { data = {}; }
    return { res: res, data: data };
  }

  function renderEnrolled(enabledAt) {
    var when = enabledAt
      ? new Date(enabledAt).toLocaleString()
      : 'previously';
    setStatus(
      '<div class="totp-box totp-box--ok">' +
        '<h3>Two-factor authentication is enabled</h3>' +
        '<p>Enrolled ' + escapeHtml(when) + '. ' +
          'Sign-in requires a 6-digit code from your authenticator app.</p>' +
      '</div>' +
      '<form id="totp-disable-form" class="totp-form">' +
        '<h4>Disable two-factor authentication</h4>' +
        '<p class="totp-warn">Requires your current password AND a current 6-digit code. ' +
          'Disabling MFA weakens your account&rsquo;s defenses against credential theft.</p>' +
        '<div class="fg">' +
          '<label class="fl" for="dis-password">Current password</label>' +
          '<input class="fi" id="dis-password" type="password" autocomplete="current-password" required />' +
        '</div>' +
        '<div class="fg">' +
          '<label class="fl" for="dis-code">Current 6-digit code</label>' +
          '<input class="fi" id="dis-code" type="text" inputmode="numeric" maxlength="6" pattern="\\d{6}" required />' +
        '</div>' +
        '<button type="submit" class="btn-danger" id="dis-btn">Disable MFA</button>' +
        '<div class="totp-err" id="dis-err" role="alert"></div>' +
      '</form>',
    );
    $('totp-disable-form').addEventListener('submit', onDisableSubmit);
  }

  function renderPending(secret, otpauth) {
    setStatus(
      '<div class="totp-box">' +
        '<h3>Set up two-factor authentication</h3>' +
        '<ol class="totp-steps">' +
          '<li>Open your authenticator app (Google Authenticator, 1Password, Authy, Bitwarden, etc.).</li>' +
          '<li>Add a new entry. Most apps accept the URI below directly; otherwise paste the secret manually.</li>' +
          '<li>Enter the 6-digit code your app shows to confirm.</li>' +
        '</ol>' +
        '<label class="fl">otpauth URI (paste into your app)</label>' +
        '<textarea class="fi totp-uri" id="totp-uri" readonly rows="2">' + escapeHtml(otpauth) + '</textarea>' +
        '<button type="button" class="btn-secondary" id="totp-uri-copy">Copy URI</button>' +
        '<label class="fl" style="margin-top:16px">Or enter the secret manually</label>' +
        '<div class="totp-secret"><code>' + escapeHtml(formatSecret(secret)) + '</code></div>' +
        '<p class="totp-meta">SHA-1, 30 second period, 6 digits.</p>' +
      '</div>' +
      '<form id="totp-confirm-form" class="totp-form">' +
        '<h4>Confirm the code</h4>' +
        '<div class="fg">' +
          '<label class="fl" for="conf-code">6-digit code</label>' +
          '<input class="fi" id="conf-code" type="text" inputmode="numeric" maxlength="6" pattern="\\d{6}" required autofocus />' +
        '</div>' +
        '<button type="submit" class="btn-primary" id="conf-btn">Confirm and enable</button>' +
        '<div class="totp-err" id="conf-err" role="alert"></div>' +
      '</form>',
    );
    $('totp-confirm-form').addEventListener('submit', onConfirmSubmit);
    $('totp-uri-copy').addEventListener('click', function () {
      try {
        navigator.clipboard.writeText(otpauth);
        $('totp-uri-copy').textContent = 'Copied';
        setTimeout(function () { $('totp-uri-copy').textContent = 'Copy URI'; }, 1500);
      } catch (_) { /* clipboard unavailable; user can still select+copy manually */ }
    });
  }

  async function onConfirmSubmit(e) {
    e.preventDefault();
    var err = $('conf-err');
    err.textContent = '';
    var btn = $('conf-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
      var out = await call('/api/auth/totp/enroll-confirm', {
        code: $('conf-code').value.trim(),
      });
      if (!out.res.ok) {
        var code = (out.data && out.data.error) || 'platform_error';
        err.textContent =
          code === 'invalid_code'  ? 'That code did not match. Double-check the time on your device.' :
          code === 'invalid_body'  ? 'Please enter the 6-digit code.' :
          code === 'totp_not_pending' ? 'Enrollment is not in progress. Reload the page.' :
          code === 'totp_already_enabled' ? 'Already enabled.' :
                                     'Something went wrong. Try again.';
        return;
      }
      renderEnrolled(out.data.totp_enabled_at);
    } catch (_) {
      err.textContent = 'Network error. Please try again.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirm and enable';
    }
  }

  async function onDisableSubmit(e) {
    e.preventDefault();
    var err = $('dis-err');
    err.textContent = '';
    var btn = $('dis-btn');
    btn.disabled = true;
    btn.textContent = 'Disabling…';
    try {
      var out = await call('/api/auth/totp/disable', {
        password: $('dis-password').value,
        code: $('dis-code').value.trim(),
      });
      if (!out.res.ok) {
        var code = (out.data && out.data.error) || 'platform_error';
        err.textContent =
          code === 'invalid_credentials' ? 'Password or code did not match.' :
          code === 'invalid_body'        ? 'Please enter your password and the 6-digit code.' :
          code === 'totp_not_enabled'    ? 'MFA is not enabled on this account.' :
                                           'Something went wrong. Try again.';
        return;
      }
      setStatus(
        '<div class="totp-box totp-box--warn">' +
          '<h3>Two-factor authentication disabled</h3>' +
          '<p>You can re-enable it at any time below.</p>' +
        '</div>',
      );
      // After disable, immediately offer re-enrollment.
      setTimeout(mount, 600);
    } catch (_) {
      err.textContent = 'Network error. Please try again.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Disable MFA';
    }
  }

  async function mount() {
    setStatus('<p class="totp-loading">Checking status…</p>');
    // Probe enroll-start. 200 = pending secret returned. 409 = already enrolled.
    var out;
    try {
      out = await call('/api/auth/totp/enroll-start');
    } catch (_) {
      setStatus('<p class="totp-err">Network error. Reload the page to try again.</p>');
      return;
    }
    if (out.res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    if (out.res.ok && out.data && out.data.secret) {
      renderPending(out.data.secret, out.data.otpauth_uri);
      return;
    }
    if (out.res.status === 409 && out.data && out.data.error === 'totp_already_enabled') {
      // Already enrolled. We don't have the enrollment timestamp at hand
      // (a future /api/auth/totp/status endpoint could return it). Show
      // generic ENABLED state.
      renderEnrolled(null);
      return;
    }
    setStatus(
      '<p class="totp-err">Could not load enrollment state ' +
      '(' + escapeHtml(String(out.res.status)) + ').</p>',
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
