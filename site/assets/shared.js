/* Shared site chrome: nav, footer, tweaks, reveals. */
(function () {
  // Nav items for the marketing site chrome.
  // "Dashboard" intentionally omitted here during Phase 1 of the design
  // rollout — the new v2 dashboard isn't live yet, and the existing
  // /dashboard.html is gated behind login. "Sign in" in the CTA handles
  // the entry point for authed users.
  const NAV_ITEMS = [
    { href: '/',                label: 'Home' },
    { href: '/Features.html',   label: 'Features' },
    { href: '/Industries.html', label: 'Industries' },
    { href: '/Pricing.html',    label: 'Pricing' },
    { href: '/audit.html',      label: 'Free Audit' },
  ];

  function currentPage() {
    const p = location.pathname;
    if (p === '/' || p.endsWith('/index.html')) return '/';
    // Treat '/Foo' and '/Foo.html' as equivalent so the active state
    // resolves whether Cloudflare Pages serves the page with or without
    // the extension.
    const tail = p.split('/').pop() || '';
    return tail.endsWith('.html') ? '/' + tail : '/' + tail + '.html';
  }

  window.AdvocateChrome = {
    renderNav(mountId) {
      const mount = document.getElementById(mountId);
      if (!mount) return;
      const cur = currentPage();
      mount.innerHTML = `
        <nav class="nav">
          <div class="container nav-inner">
            <a href="/" class="brand">
              <span class="brand-mark">A</span>
              <span>Advocate</span>
            </a>
            <ul class="nav-links">
              ${NAV_ITEMS.map(i => `<li><a href="${i.href}" class="${cur === i.href ? 'active' : ''}">${i.label}</a></li>`).join('')}
            </ul>
            <div class="nav-cta">
              <a href="/login.html" class="btn btn-ghost btn-sm">Sign in</a>
              <a href="/Pricing.html" class="btn btn-primary btn-sm">Start free trial</a>
            </div>
          </div>
        </nav>
      `;
    },

    renderFooter(mountId) {
      const mount = document.getElementById(mountId);
      if (!mount) return;
      mount.innerHTML = `
        <footer class="footer">
          <div class="container footer-inner">
            <div>
              <a href="/" class="brand" style="margin-bottom:12px">
                <span class="brand-mark">A</span>
                <span>Advocate</span>
              </a>
              <p class="text-sm" style="max-width:320px;margin-top:12px;color:var(--muted)">
                Helping small businesses get found, remembered, and recommended by AI.
              </p>
            </div>
            <div>
              <h4>Product</h4>
              <ul>
                <li><a href="/Features.html">Features</a></li>
                <li><a href="/Industries.html">Industries</a></li>
                <li><a href="/Pricing.html">Pricing</a></li>
                <li><a href="/research/">Research</a></li>
              </ul>
            </div>
            <div>
              <h4>Company</h4>
              <ul>
                <li><a href="/Contact.html">Contact</a></li>
                <li><a href="mailto:hello@advocatemcp.com">Email us</a></li>
              </ul>
            </div>
            <div>
              <h4>Support</h4>
              <ul>
                <li><a href="/FAQs.html">FAQs</a></li>
                <li><a href="/Contact.html">Book a call</a></li>
                <li><a href="/privacy.html">Privacy</a></li>
                <li><a href="/terms.html">Terms</a></li>
              </ul>
            </div>
          </div>
          <div class="container footer-bottom">
            <span>© 2026 Advocate · Made for small businesses.</span>
            <span>All systems normal <span class="chip sage" style="margin-left:8px"><span class="dot"></span>online</span></span>
          </div>
        </footer>
      `;
    },

    setupReveals() {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      }, { threshold: 0.12 });
      document.querySelectorAll('.reveal').forEach(el => io.observe(el));
    },

    /* --- Tweaks ---
       This panel is a designer-iframe tool. In production (top-level window)
       we no-op so the panel never mounts and we never override the user's
       system color-scheme preference. The panel still activates if the page
       is loaded inside an edit-mode iframe (window.parent !== window). */
    renderTweaks(config) {
      const isEmbedded = (function () {
        try { return window.parent !== window; } catch { return false; }
      })();
      if (!isEmbedded) return { state: null, apply: () => {} };

      const defaults = config.defaults || {};
      const state = Object.assign({}, defaults, readLocal());

      function readLocal() {
        try { return JSON.parse(localStorage.getItem('advocate-tweaks') || '{}'); }
        catch { return {}; }
      }
      function writeLocal() { localStorage.setItem('advocate-tweaks', JSON.stringify(state)); }

      function apply() {
        document.documentElement.dataset.theme = state.theme || 'light';
        document.documentElement.dataset.density = state.density || 'comfortable';
        if (config.onChange) config.onChange(state);
      }

      // Mount panel
      const panel = document.createElement('div');
      panel.className = 'tweaks-panel';
      panel.id = 'tweaks-panel';
      panel.innerHTML = `
        <h4>Tweaks</h4>
        <div class="tweaks-row">
          <label>Theme</label>
          <div class="tweaks-seg" data-key="theme">
            <button data-v="light">Light</button>
            <button data-v="dark">Dark</button>
          </div>
        </div>
        <div class="tweaks-row">
          <label>Density</label>
          <div class="tweaks-seg" data-key="density">
            <button data-v="comfortable">Comfy</button>
            <button data-v="compact">Compact</button>
          </div>
        </div>
        <div class="tweaks-row">
          <label>Tutorial style</label>
          <div class="tweaks-seg" data-key="tutorial">
            <button data-v="spotlight">Spotlight</button>
            <button data-v="sidebar">Sidebar</button>
          </div>
        </div>
      `;
      document.body.appendChild(panel);

      function syncSegs() {
        panel.querySelectorAll('.tweaks-seg').forEach(seg => {
          const key = seg.dataset.key;
          seg.querySelectorAll('button').forEach(b => {
            b.classList.toggle('active', b.dataset.v === state[key]);
          });
        });
      }

      panel.addEventListener('click', (e) => {
        const btn = e.target.closest('.tweaks-seg button');
        if (!btn) return;
        const key = btn.parentElement.dataset.key;
        state[key] = btn.dataset.v;
        writeLocal(); apply(); syncSegs();
      });

      // Edit-mode protocol
      window.addEventListener('message', (ev) => {
        if (ev.data?.type === '__activate_edit_mode') panel.classList.add('open');
        if (ev.data?.type === '__deactivate_edit_mode') panel.classList.remove('open');
      });
      try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch {}

      apply(); syncSegs();
      return { state, apply };
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    AdvocateChrome.setupReveals();
  });
})();
