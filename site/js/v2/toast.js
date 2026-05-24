/* AMCP.toast — non-blocking notification component.
 *
 * Replaces window.alert() / window.confirm() across the dashboard.
 * The legacy alerts are modal and break flow; this surface stacks
 * up to 3 toasts in the bottom-right (bottom-stretch on mobile),
 * auto-dismisses after 5s (success/info) or 10s (error), supports
 * action buttons + a Promise-based confirm, and is keyboard / screen-
 * reader accessible (role=status for info/success, role=alert for
 * error; aria-live polite/assertive accordingly).
 *
 * API (attached to window.AMCP.toast):
 *   info(message, opts?)      → { id, dismiss }
 *   success(message, opts?)   → { id, dismiss }
 *   error(message, opts?)     → { id, dismiss }
 *   confirm(question, opts?)  → Promise<boolean>
 *
 * opts (info/success/error):
 *   detail?  — secondary line in muted text. Use for the actual error
 *              string when message is the user-facing summary.
 *   actions? — Array<{ label, kind?: 'primary' | 'danger' | '', onClick }>.
 *              When actions are present, the toast does NOT auto-dismiss
 *              (user must choose) unless ttl is set explicitly.
 *   ttl?     — milliseconds before auto-dismiss. Default 5000 (10000 for
 *              error). Set 0 to disable auto-dismiss.
 *   onDismiss? — fired when the close button is clicked.
 *
 * opts (confirm):
 *   detail?       — secondary line.
 *   confirmLabel? — defaults to "Confirm".
 *   cancelLabel?  — defaults to "Cancel".
 *   danger?       — bool. Renders the confirm button red instead of maroon.
 *
 * Reuses the existing CSS tokens (--maroon, --sage, --red, --paper,
 * --line, --muted, --ink) so the toasts match the dashboard's voice. */
(function () {
  'use strict';

  const MAX_TOASTS = 3;
  let nextId = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ensureStyles() {
    if (document.getElementById('amcp-toast-styles')) return;
    const s = document.createElement('style');
    s.id = 'amcp-toast-styles';
    s.textContent = [
      '#amcp-toast-container { position: fixed; bottom: 24px; right: 24px;',
      '  z-index: 200; display: flex; flex-direction: column; gap: 10px;',
      '  max-width: min(420px, calc(100vw - 48px)); pointer-events: none; }',
      '.amcp-toast { pointer-events: auto; background: var(--paper, #fbf9f5);',
      '  color: var(--ink, #141210); border: 1px solid var(--line, #e6e1d8);',
      '  border-left: 4px solid var(--muted, #8a7c78); border-radius: 8px;',
      '  padding: 14px 16px; font-size: 14px; line-height: 1.45;',
      '  box-shadow: 0 6px 24px rgba(0,0,0,.10), 0 1px 2px rgba(0,0,0,.05);',
      '  display: flex; gap: 12px; align-items: flex-start;',
      '  animation: amcp-toast-in .22s ease-out; }',
      '.amcp-toast.is-leaving { animation: amcp-toast-out .18s ease-in forwards; }',
      '.amcp-toast--success { border-left-color: var(--sage, #4a7a3e); }',
      '.amcp-toast--error   { border-left-color: var(--red,  #b04040); }',
      '.amcp-toast--info    { border-left-color: var(--maroon, #7d2550); }',
      '.amcp-toast-body { flex: 1; min-width: 0; }',
      '.amcp-toast-title { font-weight: 600; word-break: break-word; }',
      '.amcp-toast-detail { color: var(--muted, #6b655c); font-size: 12.5px;',
      '  margin-top: 4px; word-break: break-word; }',
      '.amcp-toast-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }',
      '.amcp-toast-actions button { background: transparent;',
      '  border: 1px solid var(--line, #e6e1d8); color: var(--ink, #141210);',
      '  padding: 5px 10px; border-radius: 6px; font: inherit; font-size: 13px;',
      '  cursor: pointer; }',
      '.amcp-toast-actions button:hover { background: var(--paper-2, #f4efe6); }',
      '.amcp-toast-actions button.primary { background: var(--maroon, #7d2550);',
      '  color: #fff; border-color: var(--maroon, #7d2550); }',
      '.amcp-toast-actions button.primary:hover { background: var(--maroon-dark, #5e1b3c); }',
      '.amcp-toast-actions button.danger { background: var(--red, #b04040);',
      '  color: #fff; border-color: var(--red, #b04040); }',
      '.amcp-toast-close { background: none; border: none; font-size: 18px;',
      '  line-height: 1; color: var(--muted, #8a7c78); cursor: pointer;',
      '  padding: 0 4px; flex-shrink: 0; }',
      '.amcp-toast-close:hover { color: var(--ink, #141210); }',
      '@keyframes amcp-toast-in  { from { transform: translateY(8px); opacity: 0; }',
      '                            to   { transform: translateY(0);   opacity: 1; } }',
      '@keyframes amcp-toast-out { from { transform: translateY(0);   opacity: 1; }',
      '                            to   { transform: translateY(8px); opacity: 0; } }',
      '@media (max-width: 480px) {',
      '  #amcp-toast-container { left: 12px; right: 12px; bottom: 12px; max-width: none; }',
      '}',
      '@media (prefers-reduced-motion: reduce) { .amcp-toast { animation: none; } }',
    ].join('\n');
    document.head.appendChild(s);
  }

  function ensureContainer() {
    let el = document.getElementById('amcp-toast-container');
    if (el) return el;
    ensureStyles();
    el = document.createElement('div');
    el.id = 'amcp-toast-container';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(el);
    return el;
  }

  function show(kind, message, opts) {
    opts = opts || {};
    const container = ensureContainer();

    // Cap to MAX_TOASTS — drop the oldest if we'd exceed.
    while (container.children.length >= MAX_TOASTS) {
      container.removeChild(container.firstChild);
    }

    const id = 'amcp-toast-' + (++nextId);
    const el = document.createElement('div');
    el.id = id;
    el.className = 'amcp-toast amcp-toast--' + kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');

    const detailHtml = opts.detail
      ? '<div class="amcp-toast-detail">' + esc(opts.detail) + '</div>'
      : '';
    const hasActions = Array.isArray(opts.actions) && opts.actions.length > 0;
    const actionsHtml = hasActions
      ? '<div class="amcp-toast-actions">' +
        opts.actions.map((a, i) =>
          '<button data-action="' + i + '" class="' + esc(a.kind || '') + '">' +
          esc(a.label) + '</button>'
        ).join('') +
        '</div>'
      : '';

    el.innerHTML =
      '<div class="amcp-toast-body">' +
      '<div class="amcp-toast-title">' + esc(message) + '</div>' +
      detailHtml + actionsHtml +
      '</div>' +
      '<button class="amcp-toast-close" aria-label="Dismiss notification">×</button>';

    container.appendChild(el);

    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 200);
    }

    el.querySelector('.amcp-toast-close').addEventListener('click', () => {
      if (typeof opts.onDismiss === 'function') opts.onDismiss();
      dismiss();
    });

    if (hasActions) {
      el.querySelectorAll('[data-action]').forEach((btn, i) => {
        btn.addEventListener('click', () => {
          const handler = opts.actions[i] && opts.actions[i].onClick;
          if (typeof handler === 'function') handler();
          dismiss();
        });
      });
    }

    // Auto-dismiss. Toasts with actions sit until the user picks one
    // (or dismisses) unless an explicit ttl is set.
    const defaultTtl = kind === 'error' ? 10000 : 5000;
    const ttl = opts.ttl != null ? opts.ttl : (hasActions ? 0 : defaultTtl);
    if (ttl > 0) setTimeout(dismiss, ttl);

    return { id, dismiss };
  }

  /**
   * Non-blocking confirm. Returns a Promise that resolves with the
   * user's choice. Dismissing via the X resolves false (same as
   * cancel) so callers can `await` without worrying about pending
   * promises.
   */
  function confirmInline(question, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      show('info', question, {
        detail: opts.detail || '',
        actions: [
          {
            label: opts.cancelLabel || 'Cancel',
            onClick: () => settle(false),
          },
          {
            label: opts.confirmLabel || 'Confirm',
            kind: opts.danger ? 'danger' : 'primary',
            onClick: () => settle(true),
          },
        ],
        ttl: 0,
        onDismiss: () => settle(false),
      });
    });
  }

  const api = {
    info:    function (msg, opts) { return show('info',    msg, opts); },
    success: function (msg, opts) { return show('success', msg, opts); },
    error:   function (msg, opts) { return show('error',   msg, opts); },
    confirm: confirmInline,
  };

  // Attach to window.AMCP (set up by dashboard-auth.js). If for some
  // reason AMCP doesn't exist yet (e.g. a standalone page loads toast
  // before auth), create a thin namespace so callers don't crash.
  if (window.AMCP) {
    window.AMCP.toast = api;
  } else {
    window.AMCP = { toast: api };
  }
})();
