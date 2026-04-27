/* v2 Settings & API — consolidates the spread-out legacy dashboard bits:
 *
 *   Connection      — domain + DNS status (launches DNS wizard modal later)
 *   API & Webhooks  — API key rotation + webhook URL
 *   Install         — AI Surfaces / JSON-LD snippet for the customer site
 *   Tutorial        — Replay welcome / Restart tour / Open Get Started
 *   Connected agents — remapped from "Team" — MCP agents by reputation tier
 *   Danger zone     — delete account mailto
 *
 * This page is read-mostly; the rotate-key button is the only mutating
 * action in Phase 3. Tutorial buttons rely on the existing
 * AMCP_ONBOARDING state machine from the legacy dashboard, which isn't
 * loaded here yet — so in the new chrome the tutorial card links back
 * to /dashboard.html for now. Full port happens in the Phase 5 tour swap. */
(function () {
  'use strict';

  const DEMO = {
    business_name: 'Preview Business',
    plan: 'base',
    slug: 'preview-demo',
    email: 'you@advocatemcp.com',
    domain: {
      hostname: 'www.example.com',
      status: 'active',
      last_bot_hit: new Date(Date.now() - 12 * 60000).toISOString(),
    },
    webhook_url: '',
    activity: {
      agent_reputation: [
        { agent_id: 'claude-desktop/1.0',  window: '7d', request_count: 58, quality: 0.82, tier: 'trusted' },
        { agent_id: 'cursor/0.42',         window: '7d', request_count: 14, quality: 0.64, tier: 'known' },
        { agent_id: 'chatgpt-actions/1.0', window: '7d', request_count: 6,  quality: 0.40, tier: 'unverified' },
      ],
    },
  };

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    const slug = (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
    const suffix = slug ? `?slug=${encodeURIComponent(slug)}` : '';
    const [me, metrics, domain, activity, revenue] = await Promise.all([
      af('/api/client/me').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/metrics').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/domain-info' + suffix).then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/activity-detail').then(r => r.ok ? r.json() : null).catch(() => null),
      // Revenue summary (Pro feature, Apr 27 2026). Used to prefill the
      // AOV input and indicate whether a webhook secret already exists
      // so the "Generate" button label can flip to "Rotate". Failure
      // (legacy worker, network blip) → no prefill, fresh "Generate"
      // state — non-critical.
      af('/api/client/revenue-summary').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return Object.assign({}, metrics || {}, {
      _me: me,
      domain:   domain || {},
      activity: activity || {},
      revenue:  revenue || null,
    });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtCount(v) { return v == null || isNaN(v) ? '—' : Number(v).toLocaleString(); }
  function fmtPct(v) { return v == null || isNaN(v) ? '—' : Math.round(v * 100) + '%'; }
  function timeAgo(iso) {
    if (!iso) return '—';
    const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
    if (isNaN(t)) return '—';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return Math.round(s) + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function tierChip(tier) {
    const cls = tier === 'trusted' ? 'sage' : tier === 'known' ? 'amber' : 'maroon';
    return `<span class="chip ${cls}">${esc(tier || 'unverified')}</span>`;
  }

  function mailtoLink(subject, body) {
    return `mailto:max@advocate-mcp.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function render(data) {
    const d = data || {};
    const slug  = d.slug || (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
    const email = (d._me && d._me.email) || d.email || (window.AMCP_DATA && window.AMCP_DATA.email) || '—';
    const biz   = d.business_name || (window.AMCP_DATA && window.AMCP_DATA.business_name) || 'your business';
    const plan  = (d.plan || (window.AMCP_DATA && window.AMCP_DATA.plan) || 'base').toLowerCase();
    const domain = d.domain || {};
    const reputation = (d.activity && d.activity.agent_reputation) || [];

    const jsonLdSnippet = `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "${esc(biz)}",
  "@id": "https://api.advocatemcp.com/agents/${esc(slug)}",
  "url": "${esc(domain.hostname ? 'https://' + domain.hostname : '')}",
  "additionalType": "https://advocatemcp.com/mcp-discovery"
}
<\/script>`;

    const repRows = reputation.length === 0
      ? `<tr><td colspan="4" style="padding:18px;color:var(--muted);font-size:13.5px;text-align:center">No identified agents yet. Agents surface here once they send an <code>x-agent-identity</code> header.</td></tr>`
      : reputation
          .slice()
          .sort((a, b) => (b.request_count || 0) - (a.request_count || 0))
          .slice(0, 10)
          .map(r => `<tr>
            <td><span style="font-family:var(--mono);font-size:12.5px">${esc(r.agent_id || '')}</span></td>
            <td class="t">${fmtCount(r.request_count)}</td>
            <td class="t">${fmtPct(r.quality)}</td>
            <td>${tierChip(r.tier)}</td>
          </tr>`).join('');

    return `
      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>Account</h3><div class="sub">Who's signed in and where you're pointing</div></div></div>
          <div class="set-row"><div class="l">Email</div><div class="r">${esc(email)}</div></div>
          <div class="set-row"><div class="l">Business name</div><div class="r">${esc(biz)}</div></div>
          <div class="set-row"><div class="l">Slug</div><div class="r"><span style="font-family:var(--mono);font-size:12.5px">${esc(slug)}</span></div></div>
          <div class="set-row"><div class="l">Plan</div><div class="r"><span class="chip ${plan === 'pro' ? 'maroon' : 'sage'}">${esc(plan.toUpperCase())}</span> · <a href="/Billing.html" style="color:var(--maroon);font-weight:500">Manage</a></div></div>
        </div>

        <div class="card-dash">
          <div class="card-head"><div><h3>Connection</h3><div class="sub">How AI crawlers reach your agent</div></div></div>
          <div class="set-row"><div class="l">Domain</div><div class="r">${domain.hostname ? esc(domain.hostname) : '<span style="color:var(--muted)">Not connected yet</span>'}</div></div>
          <div class="set-row"><div class="l">Status</div><div class="r">${
            // Hosted tenants don't run a DNS step — re-label the pending
            // chip so it doesn't suggest action they can't take.
            (() => {
              const isHosted = domain.hostname && /\.hosted\.advocatemcp\.com$/i.test(domain.hostname);
              if (domain.status === 'active') return `<span class="chip sage dot-chip"><span class="dot"></span>Active</span>`;
              if (domain.status === 'pending') return `<span class="chip amber">${isHosted ? 'Provisioning…' : 'Pending DNS'}</span>`;
              return `<span class="chip">Inactive</span>`;
            })()
          }</div></div>
          <div class="set-row"><div class="l">Last bot hit</div><div class="r">${esc(timeAgo(domain.last_bot_hit))}</div></div>
          ${
            // Hosted tenants get auto-provisioned subdomains. They don't
            // need (and can't usefully run) the DNS wizard. Show a
            // friendly note instead so they don't think the page is broken.
            (domain.hostname && /\.hosted\.advocatemcp\.com$/i.test(domain.hostname))
              ? `<div class="set-row" style="border-bottom:0;padding-top:16px">
                  <div class="l"></div>
                  <div class="r" style="color:var(--muted);font-size:13px">Your subdomain is automatically managed — no DNS setup required.</div>
                </div>`
              : `<div class="set-row" style="border-bottom:0;padding-top:16px">
                  <div class="l"></div>
                  <div class="r" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                    <button class="btn btn-ghost btn-sm" id="btn-open-dns-wizard" type="button">Open DNS wizard →</button>
                    <button class="btn btn-ghost btn-sm" id="btn-verify-dns" type="button">Verify DNS now</button>
                    <span id="verify-dns-status" style="font-size:12.5px;color:var(--muted)"></span>
                  </div>
                </div>`
          }
        </div>
      </div>

      <!-- Revenue tracking (Pro feature, Apr 27 2026). Two configuration
           paths: AOV (anyone can use, gives estimated revenue) or
           verified webhook (booking-system integration, gives actual).
           Both are independent — a tenant can set either, both, or
           neither. The pill on the dashboard's revenue card and the
           amount it displays are driven by /api/client/revenue-summary
           which reads these values. -->
      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>Revenue tracking <span class="chip maroon" style="margin-left:6px">Pro</span></h3>
              <div class="sub">Tell Advocate how to translate AI-attributed bookings into dollars on your dashboard</div>
            </div>
          </div>
          <div class="set-row" style="align-items:center">
            <div class="l">Average ticket
              <div style="font-size:11.5px;color:var(--muted);margin-top:2px;font-weight:400;line-height:1.4">Used to estimate revenue when a booking system isn't connected. Stored privately on your account.</div>
            </div>
            <div class="r" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span style="color:var(--muted);font-size:13px">$</span>
              <input type="number" id="rev-aov-input" step="1" min="0" max="100000" placeholder="450"
                     value="${d.revenue && d.revenue.aov_cents != null ? Math.round(d.revenue.aov_cents/100) : ''}"
                     class="key-input" style="width:120px">
              <button class="btn btn-ghost btn-sm" id="btn-save-aov" type="button">Save</button>
            </div>
          </div>
          <div class="set-row" style="align-items:flex-start">
            <div class="l">Verified-revenue webhook
              <div style="font-size:11.5px;color:var(--muted);margin-top:2px;font-weight:400;line-height:1.4">Optional. POST your bookings here so the dashboard shows verified actuals instead of estimates. Replaces the estimate when configured.</div>
            </div>
            <div class="r" style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;min-width:340px">
              <input type="text" id="rev-webhook-url" readonly placeholder="Click 'Generate' to create your endpoint"
                     value="${d.revenue && d.revenue.webhook_url ? esc(d.revenue.webhook_url) : ''}"
                     class="key-input" style="width:100%">
              <input type="text" id="rev-webhook-secret" readonly placeholder="Secret appears here on generate/rotate"
                     value=""
                     class="key-input" style="width:100%;font-family:var(--mono);font-size:12px">
              <div style="display:flex;gap:6px">
                <button class="btn btn-ghost btn-sm" id="btn-gen-revenue-secret" type="button">${d.revenue && d.revenue.webhook_configured ? 'Rotate secret' : 'Generate'}</button>
                <button class="btn btn-ghost btn-sm" id="btn-copy-rev-curl" type="button">Copy test curl</button>
              </div>
              <div id="rev-secret-status" style="font-size:11.5px;color:var(--muted);max-width:340px;text-align:right;line-height:1.5"></div>
            </div>
          </div>
          <div class="set-row" style="border-bottom:0">
            <div class="l">&nbsp;</div>
            <div class="r" style="font-size:11.5px;color:var(--muted);max-width:480px;line-height:1.55;font-style:italic">
              Estimated revenue is a calculation from your supplied average ticket. Actuals may differ.
              Configure the webhook for confirmed numbers. Not financial advice.
            </div>
          </div>
        </div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>API &amp; webhooks</h3><div class="sub">Programmatic access for your own code</div></div></div>
          <div class="set-row">
            <div class="l">API key</div>
            <div class="r">
              <span class="key-input">sk_live_••••••••••••${esc((window.AMCP_DATA && window.AMCP_DATA.slug ? window.AMCP_DATA.slug.slice(-4) : '0000'))}</span>
              <button class="btn btn-ghost btn-sm" id="btn-reveal-key" disabled style="opacity:.5" title="Reveal requires re-auth">Reveal</button>
              <button class="btn btn-ghost btn-sm" id="btn-rotate-key">Rotate</button>
            </div>
          </div>
          <div class="set-row">
            <div class="l">Webhook URL</div>
            <div class="r">
              <input type="url" id="webhook-url" class="key-input" value="${esc(d.webhook_url || '')}" placeholder="https://yoursite.com/api/advocate/webhook" style="min-width:240px">
              <button class="btn btn-ghost btn-sm" id="btn-save-webhook">Save</button>
            </div>
          </div>
          <div id="settings-status" style="margin-top:8px;font-size:12.5px;color:var(--muted)"></div>
        </div>

        <div class="card-dash">
          <div class="card-head"><div><h3>Install / JSON-LD</h3><div class="sub">Paste this on your website so search engines + AI crawlers pick up your Advocate profile</div></div></div>
          <pre class="install-snippet"><code>${esc(jsonLdSnippet)}</code></pre>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn-ghost btn-sm" id="btn-copy-snippet">Copy snippet</button>
            <a class="btn btn-ghost btn-sm" href="/dashboard.html#sec-surfaces" target="_blank" rel="noopener">Full install guide →</a>
          </div>
        </div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>Connected agents</h3><div class="sub">MCP agents calling your tools — tier by reputation over the last 7 days</div></div>
            <a href="/A2APipeline.html" class="btn btn-ghost btn-sm">Full pipeline →</a>
          </div>
          <table class="tbl">
            <thead><tr><th>Agent</th><th>Calls (7d)</th><th>Quality</th><th>Tier</th></tr></thead>
            <tbody>${repRows}</tbody>
          </table>
          <p style="font-size:12.5px;color:var(--muted);margin-top:12px;line-height:1.55">
            Tiers gate rate-limits: <strong>trusted</strong> agents (≥100 calls @ ≥0.5 quality over 7d) get 1000 req/min,
            <strong>known</strong> agents get 250 req/min, unverified agents get 100 req/min.
            Agents self-identify via the <code>x-agent-identity</code> header.
          </p>
        </div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>Tutorial</h3><div class="sub">Replay the welcome or restart the dashboard tour</div></div></div>
          <p style="font-size:13.5px;color:var(--ink-2);line-height:1.6;margin-bottom:12px">All tutorial flows live on the v2 dashboard now (Phase 5 done). Each button below kicks the matching action without leaving Settings.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-ghost btn-sm" id="btn-replay-welcome">Replay welcome</button>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-restart-tour">Restart tour</button>
            <a class="btn btn-ghost btn-sm" href="/app.html#get-started">Open Get Started</a>
          </div>
        </div>

        <div class="card-dash">
          <div class="card-head"><div><h3>Data &amp; privacy</h3><div class="sub">Your control</div></div></div>
          <div class="set-row"><div class="l">Data retention</div><div class="r">24 months</div></div>
          <div class="set-row"><div class="l">Export my data</div><div class="r"><a class="btn btn-ghost btn-sm" href="${mailtoLink('Data export', `Hi Advocate team,\n\nPlease send a CSV export for ${biz} (${slug}).\n\nThanks!`)}">Request CSV</a></div></div>
          <div class="set-row" style="border-bottom:0"><div class="l">Delete account</div><div class="r"><a class="btn btn-ghost btn-sm" style="color:var(--red);border-color:rgba(248,81,73,.35)" href="${mailtoLink('Delete account', `Hi Advocate team,\n\nI want to delete ${biz} (${slug}).\n\nThanks!`)}">Request deletion</a></div></div>
        </div>
      </div>

      <style>
        .set-row {
          display: flex; justify-content: space-between; gap: 16px;
          padding: 12px 0; border-bottom: 1px solid var(--line);
          font-size: 13.5px;
        }
        .set-row:last-child { border-bottom: 0; }
        .set-row .l { color: var(--muted); flex-shrink: 0; }
        .set-row .r { color: var(--ink); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .key-input {
          font-family: var(--mono); font-size: 12.5px;
          background: var(--paper-2); border: 1px solid var(--line);
          padding: 6px 10px; border-radius: 6px; color: var(--ink);
        }
        input.key-input { min-width: 180px; }
        .install-snippet {
          background: var(--paper-2); border: 1px solid var(--line);
          border-radius: 8px; padding: 14px 16px; margin: 12px 0 0;
          overflow-x: auto; font-family: var(--mono); font-size: 12px;
          line-height: 1.55; color: var(--ink-2);
        }
        .install-snippet code { color: inherit; }
      </style>
    `;
  }

  function afterMount(data) {
    const preview = !!window.__ADVOCATE_PREVIEW;
    const slug = (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
    const status = document.getElementById('settings-status');
    const setStatus = (msg, kind) => {
      if (!status) return;
      status.textContent = msg || '';
      status.style.color = kind === 'error' ? 'var(--red)' : kind === 'success' ? 'var(--sage)' : 'var(--muted)';
    };

    // Open DNS wizard — launches the existing legacy module in a modal.
    // The wizard's own public API (window.AMCP_DNS_WIZARD.open) is
    // unchanged. Its <script> + deps (dashboard-ui, dashboard-auth,
    // dashboard-onboarding) are loaded from Settings.html so the global
    // is available here. Preview mode falls through to the legacy page
    // because the wizard needs a real authedFetch and real slug to do
    // anything useful.
    const dnsBtn = document.getElementById('btn-open-dns-wizard');
    if (dnsBtn) {
      dnsBtn.addEventListener('click', () => {
        if (preview) {
          setStatus('DNS wizard requires a real account. Log in to use it.', '');
          return;
        }
        if (window.AMCP_DNS_WIZARD && typeof window.AMCP_DNS_WIZARD.open === 'function') {
          window.AMCP_DNS_WIZARD.open();
        } else {
          // Script failed to load — graceful fallback to the legacy entry
          // point so the customer isn't stranded.
          window.location.href = '/dashboard.html#sec-domains';
        }
      });
    }

    // "Verify DNS now" button (Phase B). Re-fetches /api/client/domain-info
    // and re-renders the page so the customer sees the latest status
    // without reloading. Useful for customers who closed the activation
    // tab, added DNS records on their own, and came back later wanting
    // to know if it worked.
    const verifyBtn = document.getElementById('btn-verify-dns');
    const verifyStatusEl = document.getElementById('verify-dns-status');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', async () => {
        if (preview) {
          if (verifyStatusEl) verifyStatusEl.textContent = 'Log in to use this.';
          return;
        }
        verifyBtn.disabled = true;
        const oldText = verifyBtn.textContent;
        verifyBtn.textContent = 'Checking…';
        if (verifyStatusEl) {
          verifyStatusEl.textContent = '';
          verifyStatusEl.style.color = 'var(--muted)';
        }
        try {
          const fetchFn = (window.AMCP && window.AMCP.authedFetch) || fetch;
          const res = await fetchFn('/api/client/domain-info?slug=' + encodeURIComponent(window.AMCP_DATA?.slug || ''));
          if (!res || !res.ok) throw new Error('lookup failed');
          const data = await res.json();
          // Did anything actually change vs. what's currently rendered?
          const currentStatus = (window.AMCP_DATA && window.AMCP_DATA.domain && window.AMCP_DATA.domain.status) || 'unknown';
          const newStatus = (data && data.status) || 'unknown';
          if (newStatus === 'active') {
            if (verifyStatusEl) {
              verifyStatusEl.textContent = '✓ DNS active. Refreshing…';
              verifyStatusEl.style.color = 'var(--sage)';
            }
            setTimeout(() => window.location.reload(), 800);
          } else if (newStatus === currentStatus) {
            if (verifyStatusEl) {
              verifyStatusEl.textContent = 'Still pending. DNS can take 5–15 minutes to propagate.';
              verifyStatusEl.style.color = 'var(--muted)';
            }
          } else {
            // Status changed (e.g. inactive → pending). Reload so the
            // chip updates.
            setTimeout(() => window.location.reload(), 400);
          }
        } catch (_) {
          if (verifyStatusEl) {
            verifyStatusEl.textContent = "Couldn't check. Try again in a moment.";
            verifyStatusEl.style.color = 'var(--maroon)';
          }
        } finally {
          verifyBtn.disabled = false;
          verifyBtn.textContent = oldText;
        }
      });
    }

    // Tutorial buttons — wire to v2 tour bridge if loaded, else fall
    // back to the legacy welcome overlay so the buttons never dead-end.
    const replayWelcomeBtn = document.getElementById('btn-replay-welcome');
    if (replayWelcomeBtn) {
      replayWelcomeBtn.addEventListener('click', () => {
        if (window.AMCP_TOUR && typeof window.AMCP_TOUR.showWelcome === 'function') {
          window.AMCP_TOUR.showWelcome();
        } else if (window.AMCP_ONBOARDING && typeof window.AMCP_ONBOARDING.openWelcome === 'function') {
          window.AMCP_ONBOARDING.openWelcome();
        } else {
          // Tour modules not loaded on this page (Settings.html doesn't
          // include tour-bridge.js by default since it's only on
          // /app.html). Send the user to Overview with the replay flag.
          window.location.href = '/app.html?replay=1';
        }
      });
    }
    const restartTourBtn = document.getElementById('btn-restart-tour');
    if (restartTourBtn) {
      restartTourBtn.addEventListener('click', () => {
        if (window.AMCP_TOUR && typeof window.AMCP_TOUR.start === 'function') {
          window.AMCP_TOUR.start();
        } else {
          window.location.href = '/app.html?replay=1';
        }
      });
    }

    // Rotate key
    const rotBtn = document.getElementById('btn-rotate-key');
    if (rotBtn) {
      rotBtn.addEventListener('click', async () => {
        if (!confirm('Rotate your API key? Your current key stops working immediately.')) return;
        rotBtn.disabled = true; rotBtn.textContent = 'Rotating…';
        setStatus('', '');
        try {
          if (preview) {
            await new Promise(r => setTimeout(r, 500));
            alert('New key generated (preview — not persisted).');
            setStatus('Key rotated (preview only)', 'success');
            return;
          }
          const res = await window.AMCP.authedFetch('/api/client/rotate-key', { method: 'POST' });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            setStatus('Rotation failed: ' + (body.error || 'unknown'), 'error');
          } else if (body.new_api_key) {
            prompt('New API key generated. Copy it now — it won\'t be shown again:', body.new_api_key);
            setStatus('Key rotated', 'success');
          } else {
            setStatus('Key rotated. Check your records for the new key.', 'success');
          }
        } catch (err) {
          setStatus(String(err && err.message || err), 'error');
        } finally {
          rotBtn.disabled = false; rotBtn.textContent = 'Rotate';
        }
      });
    }

    // Save webhook — the backend already accepts this via PATCH profile
    const whBtn = document.getElementById('btn-save-webhook');
    if (whBtn) {
      whBtn.addEventListener('click', async () => {
        const input = document.getElementById('webhook-url');
        const val = (input && input.value || '').trim();
        setStatus('Saving…', '');
        whBtn.disabled = true;
        try {
          if (preview) {
            await new Promise(r => setTimeout(r, 400));
            setStatus('Webhook saved (preview only)', 'success');
            return;
          }
          const suffix = slug ? `?slug=${encodeURIComponent(slug)}` : '';
          const res = await window.AMCP.authedFetch('/api/client/profile' + suffix, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ availability_webhook_url: val || null }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            setStatus('Save failed: ' + (body.error || `HTTP ${res.status}`), 'error');
          } else {
            setStatus('Webhook saved', 'success');
          }
        } catch (err) {
          setStatus(String(err && err.message || err), 'error');
        } finally {
          whBtn.disabled = false;
        }
      });
    }

    // Copy JSON-LD snippet
    const copyBtn = document.getElementById('btn-copy-snippet');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const pre = document.querySelector('.install-snippet code');
        if (!pre) return;
        try {
          await navigator.clipboard.writeText(pre.textContent);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy snippet'; }, 2000);
        } catch (_) {
          copyBtn.textContent = 'Copy failed';
          setTimeout(() => { copyBtn.textContent = 'Copy snippet'; }, 2000);
        }
      });
    }

    // ── Revenue tracking handlers (Pro feature, Apr 27 2026) ────────────
    const af = window.AMCP && window.AMCP.authedFetch;
    const revStatus = document.getElementById('rev-secret-status');
    function setRevStatus(msg, isError) {
      if (!revStatus) return;
      revStatus.textContent = msg;
      revStatus.style.color = isError ? 'var(--red)' : 'var(--muted)';
    }

    // Save AOV — POSTs the integer cents value to the worker. Empty/0
    // input clears the AOV and returns the tenant to the unconfigured
    // (no estimated dollars) state.
    const aovBtn = document.getElementById('btn-save-aov');
    const aovInput = document.getElementById('rev-aov-input');
    if (aovBtn && aovInput && af) {
      aovBtn.addEventListener('click', async () => {
        const dollars = aovInput.value.trim();
        const cents = dollars === '' ? null : Math.round(parseFloat(dollars) * 100);
        if (cents !== null && (isNaN(cents) || cents < 0)) {
          setRevStatus('Enter a positive number or leave blank to clear.', true);
          return;
        }
        aovBtn.disabled = true;
        aovBtn.textContent = 'Saving…';
        try {
          const res = await af('/api/client/revenue-aov', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avg_booking_value_cents: cents }),
          });
          if (!res.ok) throw new Error('save failed');
          aovBtn.textContent = 'Saved ✓';
          setRevStatus(cents === null
            ? 'Average ticket cleared. Dashboard will hide estimated revenue until you set one or configure a webhook.'
            : 'Average ticket saved. Refresh the dashboard to see updated estimates.',
          false);
          setTimeout(() => { aovBtn.textContent = 'Save'; aovBtn.disabled = false; }, 2000);
        } catch (_) {
          aovBtn.textContent = 'Save failed';
          aovBtn.disabled = false;
          setRevStatus('Could not save. Try again or contact max@advocate-mcp.com.', true);
        }
      });
    }

    // Generate / rotate webhook secret. The secret is shown ONCE inline;
    // we copy it to the visible input, the input is readonly so the
    // customer can copy/paste it. Subsequent loads of Settings hide
    // the secret (it's never re-fetched plaintext after rotation).
    const genBtn = document.getElementById('btn-gen-revenue-secret');
    const urlInput = document.getElementById('rev-webhook-url');
    const secretInput = document.getElementById('rev-webhook-secret');
    if (genBtn && af && urlInput && secretInput) {
      genBtn.addEventListener('click', async () => {
        const isRotate = genBtn.textContent.includes('Rotate');
        const confirmed = isRotate
          ? confirm('Rotate the webhook secret? Your booking system will stop signing successfully until you update it with the new secret.')
          : true;
        if (!confirmed) return;
        genBtn.disabled = true;
        genBtn.textContent = isRotate ? 'Rotating…' : 'Generating…';
        try {
          const res = await af('/api/client/revenue-webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rotate: isRotate }),
          });
          if (!res.ok) throw new Error('failed');
          const data = await res.json();
          urlInput.value = data.webhook_url || '';
          secretInput.value = data.secret || '';
          genBtn.textContent = 'Rotate secret';
          genBtn.disabled = false;
          setRevStatus('Secret shown above — copy it now. We won\'t show it again. Re-rotate if you lose it.', false);
        } catch (_) {
          genBtn.textContent = isRotate ? 'Rotate failed' : 'Generate failed';
          genBtn.disabled = false;
          setRevStatus('Could not generate. Try again or contact max@advocate-mcp.com.', true);
        }
      });
    }

    // Copy test curl — generates a one-liner the customer can paste into
    // their booking-system webhook config to test the integration.
    const curlBtn = document.getElementById('btn-copy-rev-curl');
    if (curlBtn && urlInput && secretInput) {
      curlBtn.addEventListener('click', async () => {
        const url = urlInput.value || 'https://customers.advocatemcp.com/api/revenue-event/<your-slug>';
        const secret = secretInput.value || '<your-webhook-secret>';
        const body = '{"amount_cents":24500,"external_ref":"BOOKING-12345","occurred_at":"' + new Date().toISOString() + '","reservation_id":"r_optional"}';
        // openssl gives us a portable HMAC for the snippet; works on macOS
        // + Linux. Customers on Windows can adapt it to PowerShell.
        const snippet = `BODY='${body}'\nSIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac '${secret}' | sed 's/^.* //')\ncurl -i -X POST '${url}' \\\n  -H "Content-Type: application/json" \\\n  -H "X-Advocate-Signature: sha256=$SIG" \\\n  -d "$BODY"`;
        try {
          await navigator.clipboard.writeText(snippet);
          curlBtn.textContent = 'Copied!';
          setTimeout(() => { curlBtn.textContent = 'Copy test curl'; }, 2000);
        } catch (_) {
          curlBtn.textContent = 'Copy failed';
          setTimeout(() => { curlBtn.textContent = 'Copy test curl'; }, 2000);
        }
      });
    }
  }

  window.AMCP_SETTINGS = { demo: () => DEMO, fetch: fetchReal, render, afterMount };
})();
