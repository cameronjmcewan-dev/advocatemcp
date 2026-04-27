/**
 * Support chat widget — opens a bottom-right drawer with a Claude-powered
 * assistant. Stateless on the server side; the conversation lives in this
 * page's memory until reload.
 *
 * Two mounting modes:
 *   1. Explicit trigger (Contact.html): page has a [data-support-chat-open]
 *      element; clicking it opens the drawer.
 *   2. Floating help button (dashboard, activate page, etc.): if no
 *      explicit trigger exists on the page, the widget injects a small
 *      floating "?" button bottom-right that opens the drawer.
 *
 * Either way:
 *   <script src="/js/support-chat.js" defer></script>
 *
 * Suppress the auto-floating button by setting
 *   <script>window.AMCP_CHAT_NO_FLOAT = true;</script>
 * BEFORE the support-chat.js script tag.
 *
 * Design notes:
 *   - Inline styles via injected <style> tag — no dep on the global
 *     stylesheet. Won't conflict with sharedLayout tokens.
 *   - Conversation persists in window.__supportChatHistory only (not
 *     localStorage) so a refresh starts fresh — keeps the prompt window
 *     small and avoids any PII leak surface.
 *   - Talk-to-human escalation surfaces email + phone + Calendly via a
 *     persistent footer button so the user is never trapped in the bot.
 */

(function () {
  'use strict';

  if (window.__supportChatMounted) return;
  window.__supportChatMounted = true;

  // ── Constants ────────────────────────────────────────────────────────────
  var ENDPOINT  = 'https://customers.advocatemcp.com/api/support-chat';
  var MAX_TURNS = 20;          // server enforces this too — frontend caps to give a nicer UX
  var SUPPORT_EMAIL = 'max@advocate-mcp.com';
  var SUPPORT_TEL   = '+18015205939';
  var SUPPORT_TEL_DISPLAY = '(801) 520-5939';
  var CALENDLY_URL  = 'https://calendly.com/cameronjmcewan/new-meeting';

  // Conversation transcript. Each turn: { role: 'user'|'assistant', content }.
  var history = [];

  // Greeting shown before the first user turn (NOT sent to the API).
  var GREETING = "Hi — I'm an AI assistant trained on AdvocateMCP. Ask me anything about pricing, onboarding, how the bot interception works, or whether it's right for your business. If I can't help, I'll hand you off to Max.";

  // ── Inject styles + drawer DOM ───────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '.amcp-chat-drawer{',
    '  position:fixed;right:24px;bottom:24px;z-index:9999;',
    '  width:380px;max-width:calc(100vw - 32px);',
    '  height:560px;max-height:calc(100vh - 80px);',
    '  background:#1a1815;color:#f3eee5;',
    '  border:1px solid #3a342c;border-radius:12px;',
    "  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;",
    '  display:flex;flex-direction:column;overflow:hidden;',
    '  box-shadow:0 12px 48px rgba(0,0,0,.4);',
    '  transform:translateY(20px);opacity:0;pointer-events:none;',
    '  transition:transform .2s ease, opacity .2s ease;',
    '}',
    '.amcp-chat-drawer.open{transform:translateY(0);opacity:1;pointer-events:auto}',
    '@media (prefers-color-scheme: light){',
    '  .amcp-chat-drawer{background:#fbf9f5;color:#1a1815;border-color:#d4ccbf}',
    '}',
    '.amcp-chat-head{',
    '  padding:14px 16px;border-bottom:1px solid #3a342c;',
    '  display:flex;align-items:center;justify-content:space-between;gap:12px;',
    '  background:#211d18;',
    '}',
    '@media (prefers-color-scheme: light){.amcp-chat-head{background:#f4f0e8;border-color:#d4ccbf}}',
    '.amcp-chat-head h3{margin:0;font-size:14px;font-weight:600;letter-spacing:-.01em}',
    '.amcp-chat-head .amcp-status{font-size:11px;color:#a89e8c;margin-top:2px}',
    '.amcp-chat-close{',
    '  background:none;border:none;color:inherit;cursor:pointer;',
    '  font-size:20px;line-height:1;padding:4px 8px;border-radius:6px;opacity:.7;',
    '}',
    '.amcp-chat-close:hover{opacity:1;background:rgba(125,37,80,.15)}',
    '.amcp-chat-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
    '.amcp-chat-msg{max-width:85%;padding:9px 12px;border-radius:14px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}',
    '.amcp-chat-msg.user{align-self:flex-end;background:#7d2550;color:#fff;border-bottom-right-radius:4px}',
    '.amcp-chat-msg.assistant{align-self:flex-start;background:#2a2620;color:#f3eee5;border-bottom-left-radius:4px}',
    '@media (prefers-color-scheme: light){.amcp-chat-msg.assistant{background:#ece6d8;color:#1a1815}}',
    '.amcp-chat-msg.system{align-self:center;background:transparent;color:#a89e8c;font-size:11.5px;text-align:center;padding:4px 0}',
    '.amcp-chat-typing{align-self:flex-start;color:#a89e8c;font-size:13px;padding:4px 0;display:flex;gap:4px}',
    '.amcp-chat-typing span{width:6px;height:6px;background:#a89e8c;border-radius:50%;animation:amcp-blink 1.4s infinite both}',
    '.amcp-chat-typing span:nth-child(2){animation-delay:.2s}',
    '.amcp-chat-typing span:nth-child(3){animation-delay:.4s}',
    '@keyframes amcp-blink{0%,80%,100%{opacity:.3}40%{opacity:1}}',
    '.amcp-chat-foot{padding:10px 12px;border-top:1px solid #3a342c;background:#211d18;display:flex;flex-direction:column;gap:8px}',
    '@media (prefers-color-scheme: light){.amcp-chat-foot{background:#f4f0e8;border-color:#d4ccbf}}',
    '.amcp-chat-input-row{display:flex;gap:8px;align-items:flex-end}',
    '.amcp-chat-input{',
    '  flex:1;resize:none;background:#1a1815;color:#f3eee5;',
    '  border:1px solid #3a342c;border-radius:8px;padding:8px 10px;',
    '  font-family:inherit;font-size:13.5px;line-height:1.4;min-height:34px;max-height:120px;',
    '}',
    '@media (prefers-color-scheme: light){.amcp-chat-input{background:#fff;color:#1a1815;border-color:#d4ccbf}}',
    '.amcp-chat-input:focus{outline:2px solid #7d2550;outline-offset:0;border-color:transparent}',
    '.amcp-chat-send{',
    '  background:#7d2550;color:#fff;border:none;border-radius:8px;',
    '  padding:0 14px;height:34px;cursor:pointer;font-size:13px;font-weight:500;',
    '}',
    '.amcp-chat-send:hover{background:#5c1a3c}',
    '.amcp-chat-send:disabled{opacity:.5;cursor:not-allowed}',
    '.amcp-chat-escalate{',
    '  display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:#a89e8c;',
    '}',
    '.amcp-chat-escalate a{color:#c5849f;text-decoration:none;margin:0 6px}',
    '.amcp-chat-escalate a:hover{text-decoration:underline}',
  ].join('');
  document.head.appendChild(style);

  var drawer = document.createElement('div');
  drawer.className = 'amcp-chat-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'AdvocateMCP support chat');
  drawer.innerHTML = [
    '<div class="amcp-chat-head">',
    '  <div>',
    '    <h3>Chat with Advocate</h3>',
    '    <div class="amcp-status">AI assistant — Max takes over for anything tricky</div>',
    '  </div>',
    '  <button class="amcp-chat-close" aria-label="Close chat">×</button>',
    '</div>',
    '<div class="amcp-chat-body" id="amcp-chat-body"></div>',
    '<div class="amcp-chat-foot">',
    '  <div class="amcp-chat-input-row">',
    '    <textarea class="amcp-chat-input" placeholder="Type a message…" rows="1"',
    '              aria-label="Message"></textarea>',
    '    <button class="amcp-chat-send" type="button">Send</button>',
    '  </div>',
    '  <div class="amcp-chat-escalate">',
    '    <span>Talk to a human:</span>',
    '    <span>',
    '      <a href="mailto:' + SUPPORT_EMAIL + '">email</a>·',
    '      <a href="tel:' + SUPPORT_TEL + '">' + SUPPORT_TEL_DISPLAY + '</a>·',
    '      <a href="' + CALENDLY_URL + '" target="_blank" rel="noopener">book a call</a>',
    '    </span>',
    '  </div>',
    '</div>',
  ].join('');
  document.body.appendChild(drawer);

  var bodyEl  = drawer.querySelector('#amcp-chat-body');
  var inputEl = drawer.querySelector('.amcp-chat-input');
  var sendEl  = drawer.querySelector('.amcp-chat-send');
  var closeEl = drawer.querySelector('.amcp-chat-close');

  // ── Helpers ──────────────────────────────────────────────────────────────
  function addMessage(role, content) {
    var msg = document.createElement('div');
    msg.className = 'amcp-chat-msg ' + role;
    msg.textContent = content;
    bodyEl.appendChild(msg);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    return msg;
  }

  function addSystemNote(content) {
    var msg = document.createElement('div');
    msg.className = 'amcp-chat-msg system';
    msg.textContent = content;
    bodyEl.appendChild(msg);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function showTyping() {
    var t = document.createElement('div');
    t.className = 'amcp-chat-typing';
    t.id = 'amcp-typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    bodyEl.appendChild(t);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    return t;
  }
  function hideTyping() {
    var t = document.getElementById('amcp-typing');
    if (t) t.remove();
  }

  function open() {
    drawer.classList.add('open');
    setTimeout(function () { inputEl.focus(); }, 220);
    if (history.length === 0 && !drawer.dataset.greeted) {
      addMessage('assistant', GREETING);
      drawer.dataset.greeted = '1';
    }
  }
  function close() {
    drawer.classList.remove('open');
  }

  async function send() {
    var text = (inputEl.value || '').trim();
    if (!text) return;
    if (history.length >= MAX_TURNS) {
      addSystemNote('Conversation limit reached — for anything more, email ' + SUPPORT_EMAIL + ' or book a call.');
      return;
    }

    addMessage('user', text);
    history.push({ role: 'user', content: text });
    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendEl.disabled = true;
    var typing = showTyping();

    try {
      var res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });
      hideTyping();
      sendEl.disabled = false;

      if (!res.ok) {
        var detail = '';
        try { var j = await res.json(); detail = (j && (j.detail || j.error)) || ''; } catch (_) {}
        addSystemNote("Couldn't reach the assistant" + (detail ? " (" + detail + ")" : "") + ". Email " + SUPPORT_EMAIL + " and we'll respond directly.");
        // Roll back the last user turn so the next attempt isn't poisoned.
        history.pop();
        return;
      }

      var data = await res.json();
      if (!data || !data.ok || !data.message) {
        addSystemNote('No response — try again, or email ' + SUPPORT_EMAIL + '.');
        history.pop();
        return;
      }

      addMessage('assistant', data.message);
      history.push({ role: 'assistant', content: data.message });
    } catch (err) {
      hideTyping();
      sendEl.disabled = false;
      addSystemNote("Network hiccup. Email " + SUPPORT_EMAIL + " and we'll pick up there.");
      history.pop();
    }
  }

  // ── Wire up triggers ─────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-support-chat-open]');
    if (t) { e.preventDefault(); open(); }
  });
  closeEl.addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer.classList.contains('open')) close();
  });

  // Floating help button — only when the page has NO explicit
  // [data-support-chat-open] trigger (i.e. the dashboard, activate page,
  // etc., where we want a "Need help?" handle without forcing every page
  // to template a button).
  function maybeMountFloatingButton() {
    if (window.AMCP_CHAT_NO_FLOAT) return;
    if (document.querySelector('[data-support-chat-open]')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-support-chat-open', '');
    btn.setAttribute('aria-label', 'Open support chat');
    btn.title = 'Need help? Chat with Advocate.';
    btn.textContent = '?';
    btn.style.cssText = [
      'position:fixed', 'right:24px', 'bottom:24px', 'z-index:9998',
      'width:48px', 'height:48px', 'border-radius:50%',
      'background:#7d2550', 'color:#fff', 'border:none',
      'font-size:22px', 'font-weight:600', 'cursor:pointer',
      'box-shadow:0 4px 16px rgba(0,0,0,.25)',
      'transition:transform .15s ease, background .15s ease',
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    ].join(';');
    btn.addEventListener('mouseenter', function () {
      btn.style.transform = 'scale(1.06)';
      btn.style.background = '#5c1a3c';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.transform = 'scale(1)';
      btn.style.background = '#7d2550';
    });
    document.body.appendChild(btn);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeMountFloatingButton);
  } else {
    maybeMountFloatingButton();
  }

  // Auto-grow textarea + Enter to send (Shift+Enter for newline).
  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendEl.addEventListener('click', send);

  // Expose for debugging / future programmatic opens.
  window.AMCP_SUPPORT_CHAT = { open: open, close: close };
})();
