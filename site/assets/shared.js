/* Shared site chrome: nav, footer, tweaks, reveals. */
(function () {
  // Cloudflare Web Analytics token. Set to the token string emitted when
  // Web Analytics is enabled on the `advocatemcp-site` Pages project in
  // the Cloudflare dashboard (Analytics → Web Analytics → "Manual" →
  // copy the `data-cf-beacon` token). Empty string = analytics off.
  const CF_BEACON_TOKEN = "";


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
    { href: '/Contact.html',    label: 'Contact' },
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

  /* Dogfood JSON-LD — every customer of Advocate ships structured
   * data pointing AI crawlers at their per-business agent. We do the
   * same for ourselves on every marketing page (except index.html
   * which has the canonical static block — this skips that one to
   * avoid duplicate-schema warnings).
   *
   * Idempotent: if a JSON-LD block matching our @id is already in the
   * page, we don't add a second one. Apr 28 2026.
   */
  function injectAdvocateJsonLd() {
    if (document.getElementById('amcp-jsonld')) return;
    // Static index.html block already covers the homepage.
    if (location.pathname === '/' || location.pathname.endsWith('/index.html')) return;
    const el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = 'amcp-jsonld';
    el.textContent = JSON.stringify({
      "@context": "https://schema.org",
      "@type": ["Organization", "SoftwareApplication"],
      "@id": "https://advocatemcp.com/#advocate",
      "name": "Advocate",
      "alternateName": "AdvocateMCP",
      "url": "https://advocatemcp.com",
      "logo": "https://advocatemcp.com/icon-192.png",
      "image": "https://advocatemcp.com/og-image.png",
      "description": "Advocate is the AI search visibility platform for local and small businesses. We intercept AI-crawler traffic at the edge (ChatGPT, Perplexity, Claude, Gemini, Copilot) and serve every bot a citation-ready response tailored to its query — so when someone asks an AI for a business like yours, your name comes up with a direct, tracked link back to you.",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "Web (browser, MCP, Claude Desktop, Cursor, ChatGPT)",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Austin",
        "addressRegion": "TX",
        "addressCountry": "US"
      },
      "telephone": "+1-801-520-5939",
      "email": "max@advocate-mcp.com",
      "foundingDate": "2026",
      "founder": { "@type": "Person", "name": "Cameron McEwan" },
      "offers": [
        { "@type": "Offer", "name": "Base",       "price": "149", "priceCurrency": "USD",
          "description": "Single-location AI search visibility — accurate AI answers, plain-English dashboard, tracked click-back links, weekly digest, email support." },
        { "@type": "Offer", "name": "Pro",        "price": "349", "priceCurrency": "USD",
          "description": "Everything in Base plus Competitor Radar, revenue attribution, up to 3 locations, monthly performance review, 1-hour priority support." },
        { "@type": "Offer", "name": "Enterprise", "priceCurrency": "USD",
          "description": "Custom — unlimited locations, team accounts and role-based access, dedicated success manager, custom integrations on request." }
      ],
      "potentialAction": {
        "@type": "SearchAction",
        "name": "Query Advocate via MCP",
        "target": "https://api.advocatemcp.com/agents/advocate/query?q={search_term_string}",
        "query-input": "required name=search_term_string"
      },
      "termsOfService": "https://advocatemcp.com/terms.html",
      "privacyPolicy": "https://advocatemcp.com/privacy.html"
    });
    document.head.appendChild(el);

    // Also expose the well-known endpoints so MCP-aware crawlers can
    // discover them without parsing JSON-LD's potentialAction.
    if (!document.querySelector('link[href*="/.well-known/ai-agent.json"]')) {
      const l1 = document.createElement('link');
      l1.rel  = 'alternate';
      l1.type = 'application/json';
      l1.title= 'Advocate AI agent (MCP)';
      l1.href = 'https://customers.advocatemcp.com/.well-known/ai-agent.json';
      document.head.appendChild(l1);
    }
    if (!document.querySelector('link[href*="/.well-known/mcp.json"]')) {
      const l2 = document.createElement('link');
      l2.rel  = 'alternate';
      l2.type = 'application/json';
      l2.title= 'Advocate MCP server manifest';
      l2.href = 'https://api.advocatemcp.com/.well-known/mcp.json';
      document.head.appendChild(l2);
    }
  }
  // Fire as soon as the script runs — head is already parseable when
  // shared.js loads. Injecting before <body> ensures crawlers that read
  // <head> see the schema even if they don't execute the rest of the
  // page's JS.
  injectAdvocateJsonLd();

  window.AdvocateChrome = {
    renderNav(mountId) {
      const mount = document.getElementById(mountId);
      if (!mount) return;
      // Piggyback on the nav mount (every marketing page calls renderNav
      // exactly once) to fire the analytics beacon. Keeps pages from
      // having to individually opt in to tracking.
      this.mountAnalytics();
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
              <a href="/onboarding.html" class="btn btn-primary btn-sm">Start free trial</a>
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
                <li><a href="mailto:max@advocate-mcp.com">Email us</a></li>
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

    /* Cloudflare Web Analytics (free, privacy-first, no cookies).
     *
     * Token is read from a `<meta name="cf-beacon" content="{token}">` tag
     * on the page. Enable Web Analytics on the `advocatemcp-site` Pages
     * project in the Cloudflare dashboard — it emits the token there. Drop
     * it into the meta tag once and every marketing page that loads
     * shared.js starts reporting.
     *
     * When the meta is absent, this is a no-op — the dashboard-hosted
     * automatic beacon still fires (Pages can inject it for us) so we're
     * not strictly required to mount anything, but having the explicit
     * beacon gives us richer custom-event support if we need it later. */
    mountAnalytics() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('cf-beacon-script')) return;
      // Token comes from the module-level CF_BEACON_TOKEN constant so there's
      // a single place to flip analytics on for the whole site. Fallback to
      // a `<meta name="cf-beacon" content="...">` if a page wants to override.
      const meta = document.querySelector('meta[name="cf-beacon"]');
      const token = CF_BEACON_TOKEN || (meta && meta.getAttribute('content'));
      if (!token) return;
      const s = document.createElement('script');
      s.id = 'cf-beacon-script';
      s.defer = true;
      s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
      s.setAttribute('data-cf-beacon', JSON.stringify({ token }));
      document.head.appendChild(s);
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
