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
    const [me, metrics, domain, activity] = await Promise.all([
      af('/api/client/me').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/metrics').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/domain-info' + suffix).then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/activity-detail').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return Object.assign({}, metrics || {}, {
      _me: me,
      domain:   domain || {},
      activity: activity || {},
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
  }

  window.AMCP_SETTINGS = { demo: () => DEMO, fetch: fetchReal, render, afterMount };
})();
