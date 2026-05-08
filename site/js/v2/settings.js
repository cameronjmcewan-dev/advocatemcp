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
    ga4Status:  { connected: false },
    gscStatus:  { connected: false },
  };

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    const slug = (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
    const suffix = slug ? `?slug=${encodeURIComponent(slug)}` : '';
    const [me, metrics, domain, activity, revenue, ga4Status, gscStatus, verifiedRevenue, crmHubspot, crmSalesforce, authorityStatus] = await Promise.all([
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
      // GA4 connection status — populates the "Web traffic data" section
      // (May 6 2026 PR 3). Endpoint added in PR 1, returns
      //   { connected, slug, property_id, property_label, status,
      //     last_sync_at, last_sync_error, connected_at } or { connected:false }.
      af('/api/client/ga4/status').then(r => r.ok ? r.json() : { connected: false }).catch(() => ({ connected: false })),
      // GSC connection status — populates the Search Console card
      // (May 6 2026 PR 5). Returns { connected, slug, site_url, status,
      //   last_sync_at, last_sync_error } or { connected: false }.
      af('/api/client/gsc/status').then(r => r.ok ? r.json() : { connected: false }).catch(() => ({ connected: false })),
      // Verified-revenue feed status (PR 2). Shows webhook configured/event
      // counts in the Revenue tracking card without touching secret management.
      // 402 means Pro gate — treat as null (no status row shown).
      af('/api/client/traffic-impact/verified-revenue').then(r => {
        if (r.status === 402) return null;
        return r.ok ? r.json() : null;
      }).catch(() => null),
      // CRM connection status — HubSpot (PR 4). 402 = Pro gate → null.
      af('/api/client/crm/status?provider=hubspot').then(r => r.ok ? r.json() : null).catch(() => null),
      // CRM connection status — Salesforce (PR 4). 402 = Pro gate → null.
      af('/api/client/crm/status?provider=salesforce').then(r => r.ok ? r.json() : null).catch(() => null),
      // Authority Kit config status (Phase 6 PR 3). 402 = Pro gate → null.
      af('/api/client/authority/status').then(r => {
        if (r.status === 402) return null;
        return r.ok ? r.json() : null;
      }).catch(() => null),
    ]);
    return Object.assign({}, metrics || {}, {
      _me: me,
      domain:          domain || {},
      activity:        activity || {},
      revenue:         revenue || null,
      ga4Status:       ga4Status        || { connected: false },
      gscStatus:       gscStatus        || { connected: false },
      verifiedRevenue: verifiedRevenue  || null,
      crmHubspot:      crmHubspot       || null,
      crmSalesforce:   crmSalesforce    || null,
      authorityStatus: authorityStatus  || null,
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
    const verifiedRevenue = d.verifiedRevenue || null;
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

      <!-- Web traffic data (May 6 2026 PR 3). Manages the GA4 OAuth
           connection that powers /TrafficImpact.html. -->
      <div class="row single">
        ${renderGa4Card(d.ga4Status || { connected: false })}
      </div>

      <!-- Google Search Console (May 6 2026 PR 5). Manages the GSC OAuth
           connection that powers the AI Overview section on /TrafficImpact.html.
           Pro-only — base tenants see an upgrade CTA. -->
      <div class="row single">
        ${renderGscCard(d.gscStatus || { connected: false }, plan)}
      </div>

      <!-- CRM integration (May 6 2026 PR 4). Manages HubSpot + Salesforce OAuth
           connections that power the LTV section on /TrafficImpact.html.
           Pro-only — base tenants see an upgrade CTA. -->
      <div class="row single">
        ${renderCrmCard(d.crmHubspot || null, d.crmSalesforce || null, plan)}
      </div>

      <!-- Authority Kit (Phase 6 PR 3). Brand keyword + Google Place ID
           configuration for the off-site authority nightly cron.
           Pro-only — base tenants see an upgrade CTA. -->
      <div class="row single" id="authority">
        ${renderAuthorityCard(d.authorityStatus || null, plan)}
      </div>

      <!-- Team (Apr 27 2026 Enterprise honesty pass). Owner-only invite/
           remove/role-change controls. Plan caps: base=1, pro=5,
           enterprise=∞. Editor + viewer roles defined in
           worker/src/routes/team.ts. -->
      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>Team <span class="chip ${plan === 'enterprise' ? 'enterprise' : plan === 'pro' ? 'maroon' : 'sage'}" style="margin-left:6px">${plan === 'enterprise' ? 'Enterprise' : plan === 'pro' ? 'Pro' : 'Base'}</span></h3>
              <div class="sub" id="team-cap-sub">Loading…</div>
            </div>
            <button class="btn btn-primary btn-sm" id="btn-invite-member" type="button" style="display:none">Invite team member</button>
          </div>
          <div id="team-list">
            <div style="padding:18px;color:var(--muted);font-size:13.5px;text-align:center">Loading team…</div>
          </div>
        </div>
      </div>

      <!-- Multi-location (Pro = up to 3, Enterprise = unlimited).
           Apr 27 2026. The card lists every location for the tenant
           with edit + delete + promote-to-primary controls. The "Add
           location" button is hidden once the plan cap is hit; the
           server returns 402 with cap details if the customer races
           past the cap (e.g. via direct API). -->
      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div><h3>Locations <span class="chip ${plan === 'enterprise' ? 'enterprise' : plan === 'pro' ? 'maroon' : 'sage'}" style="margin-left:6px">${plan === 'enterprise' ? 'Enterprise' : plan === 'pro' ? 'Pro' : 'Base'}</span></h3>
              <div class="sub" id="loc-cap-sub">Loading…</div>
            </div>
            <button class="btn btn-primary btn-sm" id="btn-add-location" type="button" style="display:none">Add location</button>
          </div>
          <div id="loc-list">
            <div style="padding:18px;color:var(--muted);font-size:13.5px;text-align:center">Loading locations…</div>
          </div>
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
              <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
                <button class="btn btn-ghost btn-sm" id="btn-gen-revenue-secret" type="button">${d.revenue && d.revenue.webhook_configured ? 'Rotate secret' : 'Generate'}</button>
                <button class="btn btn-ghost btn-sm" id="btn-copy-rev-secret" type="button" disabled style="opacity:.5" title="Generate a secret first">Copy secret</button>
                <button class="btn btn-ghost btn-sm" id="btn-copy-rev-curl" type="button">Copy test curl</button>
              </div>
              <div id="rev-secret-status" style="font-size:11.5px;color:var(--muted);max-width:340px;text-align:right;line-height:1.5"></div>
            </div>
          </div>
          ${verifiedRevenue && verifiedRevenue.webhook_configured === true ? `
          <div class="set-row" style="border-bottom:0">
            <div class="l">Webhook status</div>
            <div class="r">
              <span class="chip sage dot-chip"><span class="dot"></span>Configured</span>
              ${verifiedRevenue.total_events > 0
                ? `<span style="font-size:12.5px;color:var(--muted);margin-left:10px">${verifiedRevenue.total_events} event${verifiedRevenue.total_events === 1 ? '' : 's'} received · ${verifiedRevenue.ai_events} attributed to AI</span>`
                : `<span style="font-size:12.5px;color:var(--muted);margin-left:10px">Awaiting first event</span>`
              }
            </div>
          </div>` : `
          <div class="set-row" style="border-bottom:0">
            <div class="l">&nbsp;</div>
            <div class="r" style="font-size:11.5px;color:var(--muted);max-width:480px;line-height:1.55;font-style:italic">
              Estimated revenue is a calculation from your supplied average ticket. Actuals may differ.
              Configure the webhook for confirmed numbers. Not financial advice.
            </div>
          </div>`}
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
            <a class="btn btn-ghost btn-sm" href="/app.html">Open Get Started</a>
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

  /* GA4 connection card — May 6 2026, PR 3 of the Traffic Impact feature.
   *
   * Three render states matching /TrafficImpact.html itself:
   *   1. Not connected → Connect button (POST /api/client/ga4/start-link)
   *   2. Connected with no property selected → property picker
   *   3. Connected with property → status row + Resync + Disconnect
   */
  function renderGa4Card(s) {
    const connected = !!(s && s.connected);
    const hasProperty = connected && !!s.property_id;
    const errorPill = (s && s.last_sync_error)
      ? `<span class="chip" style="background:rgba(180,40,40,.08);color:var(--red);border:1px solid rgba(180,40,40,.25)">Sync error</span>`
      : '';

    let body;
    if (!connected) {
      body = `
        <div class="set-row"><div class="l">Status</div><div class="r"><span class="chip">Not connected</span></div></div>
        <div class="set-row" style="border-bottom:0;padding-top:14px">
          <div class="l"></div>
          <div class="r" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" id="btn-ga4-connect" type="button">Connect Google Analytics →</button>
            <span id="ga4-status-msg" style="font-size:12.5px;color:var(--muted)"></span>
          </div>
        </div>
        <div class="set-row" style="border-bottom:0;padding-top:0">
          <div class="l"></div>
          <div class="r" style="font-size:12.5px;color:var(--muted);max-width:520px;line-height:1.5">
            We read aggregate daily traffic only — never individual visitor data, events, or PII. Disconnect any time.
          </div>
        </div>`;
    } else if (!hasProperty) {
      body = `
        <div class="set-row"><div class="l">Status</div><div class="r"><span class="chip amber dot-chip"><span class="dot"></span>Connected · pick a property</span></div></div>
        <div class="set-row" style="border-bottom:0;padding-top:14px">
          <div class="l"></div>
          <div class="r">
            <button class="btn btn-ghost btn-sm" id="btn-ga4-pick-property" type="button">Choose property →</button>
            <button class="btn btn-ghost btn-sm" id="btn-ga4-disconnect" type="button" style="margin-left:6px">Disconnect</button>
            <span id="ga4-status-msg" style="font-size:12.5px;color:var(--muted);margin-left:10px"></span>
          </div>
        </div>`;
    } else {
      body = `
        <div class="set-row"><div class="l">Status</div><div class="r"><span class="chip sage dot-chip"><span class="dot"></span>Connected</span> ${errorPill}</div></div>
        <div class="set-row"><div class="l">Property</div><div class="r"><strong>${esc(s.property_label || 'GA4 property')}</strong> <span style="font-family:var(--mono);font-size:12px;color:var(--muted);margin-left:6px">${esc(s.property_id || '')}</span></div></div>
        <div class="set-row"><div class="l">Last sync</div><div class="r">${esc(timeAgo(s.last_sync_at))}${s.last_sync_error ? ` <span style="color:var(--red);font-size:12.5px">· ${esc(String(s.last_sync_error).slice(0, 120))}</span>` : ''}</div></div>
        <div class="set-row" style="border-bottom:0;padding-top:14px">
          <div class="l"></div>
          <div class="r" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" id="btn-ga4-resync" type="button">Resync now</button>
            <button class="btn btn-ghost btn-sm" id="btn-ga4-disconnect" type="button">Disconnect</button>
            <a class="btn btn-ghost btn-sm" href="/TrafficImpact.html">View charts →</a>
            <span id="ga4-status-msg" style="font-size:12.5px;color:var(--muted)"></span>
          </div>
        </div>`;
    }

    return `
      <div class="card-dash">
        <div class="card-head">
          <div>
            <h3>Web traffic data</h3>
            <div class="sub">Connect Google Analytics so the Traffic Impact dashboard can show how AI search is moving your site visits.</div>
          </div>
        </div>
        ${body}
      </div>`;
  }

  /* Wires the GA4 card buttons. Called from afterMount(). All buttons go
   * through AMCP.authedFetch so the bearer token is injected. The Connect
   * button POSTs /api/client/ga4/start-link → window.location.href to the
   * returned Google authorize URL (same pattern the Traffic Impact page uses
   * in its empty-state CTA). */
  function wireGa4Card() {
    const af = window.AMCP && window.AMCP.authedFetch;
    const msg = document.getElementById('ga4-status-msg');
    const setMsg = (text, kind) => {
      if (!msg) return;
      msg.textContent = text || '';
      msg.style.color = kind === 'error' ? 'var(--red)' : kind === 'success' ? 'var(--sage)' : 'var(--muted)';
    };

    const connectBtn = document.getElementById('btn-ga4-connect');
    if (connectBtn) {
      connectBtn.addEventListener('click', async () => {
        connectBtn.disabled = true;
        setMsg('Opening Google…');
        try {
          const r = await af('/api/client/ga4/start-link', { method: 'POST' });
          const j = await r.json();
          if (j && j.url) { window.location.href = j.url; return; }
          throw new Error(j && (j.customer_message || j.error_code) || 'Could not start GA4 connection');
        } catch (err) {
          setMsg(String(err && err.message || err), 'error');
          connectBtn.disabled = false;
        }
      });
    }

    const resyncBtn = document.getElementById('btn-ga4-resync');
    if (resyncBtn) {
      resyncBtn.addEventListener('click', async () => {
        resyncBtn.disabled = true;
        setMsg('Pulling last 7 days from Google…');
        try {
          const r = await af('/api/client/ga4/resync', { method: 'POST' });
          const j = await r.json();
          if (j && j.error) throw new Error(j.error);
          setMsg(`Synced — ${j.rows_received || 0} rows from GA4 across ${j.days_upserted || 0} days.`, 'success');
          // Reload after 1.5s so the status card re-renders with fresh
          // last_sync_at timestamp + cleared error.
          setTimeout(() => window.location.reload(), 1500);
        } catch (err) {
          setMsg('Sync failed: ' + String(err && err.message || err), 'error');
          resyncBtn.disabled = false;
        }
      });
    }

    const disconnectBtn = document.getElementById('btn-ga4-disconnect');
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', async () => {
        if (!window.confirm('Disconnect Google Analytics? Imported daily traffic stays in your account; new data will stop syncing until you reconnect.')) return;
        disconnectBtn.disabled = true;
        setMsg('Disconnecting…');
        try {
          await af('/api/client/ga4/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          setMsg('Disconnected.', 'success');
          setTimeout(() => window.location.reload(), 1000);
        } catch (err) {
          setMsg('Could not disconnect: ' + String(err && err.message || err), 'error');
          disconnectBtn.disabled = false;
        }
      });
    }

    // Property-picker — fetches /api/client/ga4/properties, renders an
    // inline list, then POSTs /api/client/ga4/select-property on
    // selection (which runs an 18-month backfill server-side).
    const pickBtn = document.getElementById('btn-ga4-pick-property');
    if (pickBtn) {
      pickBtn.addEventListener('click', () => {
        runInlinePicker({
          anchorBtn:    pickBtn,
          listPath:     '/api/client/ga4/properties',
          listKey:      'properties',
          selectPath:   '/api/client/ga4/select-property',
          // GA4 select-property requires BOTH property_id + property_label.
          buildBody:    (p) => ({ property_id: p.propertyId, property_label: p.displayName || p.propertyId }),
          isValid:      (p) => !!p.propertyId,
          rowLabel:     (p) => p.displayName || p.propertyId || '',
          rowSubLabel:  (p) => p.propertyId || '',
          emptyMessage: 'No GA4 properties on this Google account. Create one in Analytics first.',
          intro:        'Pick the GA4 property Advocate should pull traffic from. Selecting a property triggers a backfill — this can take 30 seconds.',
        });
      });
    }
  }

  /* GSC connection card — May 6 2026, PR 5 of the Traffic Impact feature.
   *
   * Four render states:
   *   1. Base tenant           → Pro upsell card
   *   2. Pro, not connected    → Connect button
   *   3. Pro, connected, no site selected → site picker
   *   4. Pro, connected with site → status row + Resync + Disconnect + View link
   */
  function renderGscCard(s, plan) {
    const isPro = plan === 'pro' || plan === 'enterprise';

    // Variant: base tenant — upsell
    if (!isPro) {
      return `
        <div class="card-dash">
          <div class="card-head">
            <div>
              <h3>Google Search Console <span class="chip maroon" style="margin-left:6px">Pro</span></h3>
              <div class="sub">See how often Google shows AI Overviews for your queries — and whether they cite you.</div>
            </div>
          </div>
          <div class="set-row" style="border-bottom:0;padding:20px 0">
            <div class="l"></div>
            <div class="r" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
              <div style="font-size:13px;color:var(--ink-2);max-width:480px;line-height:1.5">
                Connect Search Console to track AI Overview presence rate and cite rate — the best signal GSC gives for whether Google's AI answers are citing your site.
              </div>
              <a href="/Billing.html" class="btn btn-primary btn-sm">Upgrade to Pro →</a>
            </div>
          </div>
        </div>`;
    }

    const connected = !!(s && s.connected);
    const hasSite = connected && !!s.site_url;
    const errorPill = (s && s.last_sync_error)
      ? `<span class="chip" style="background:rgba(180,40,40,.08);color:var(--red);border:1px solid rgba(180,40,40,.25)">Sync error</span>`
      : '';

    let body;
    if (!connected) {
      body = `
        <div class="set-row"><div class="l">Status</div><div class="r"><span class="chip">Not connected</span></div></div>
        <div class="set-row" style="border-bottom:0;padding-top:14px">
          <div class="l"></div>
          <div class="r" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" id="btn-gsc-connect" type="button">Connect Search Console →</button>
            <span id="gsc-status-msg" style="font-size:12.5px;color:var(--muted)"></span>
          </div>
        </div>
        <div class="set-row" style="border-bottom:0;padding-top:0">
          <div class="l"></div>
          <div class="r" style="font-size:12.5px;color:var(--muted);max-width:520px;line-height:1.5">
            We read aggregate impression and click data only — never individual query data or PII. Disconnect any time.
          </div>
        </div>`;
    } else if (!hasSite) {
      body = `
        <div class="set-row"><div class="l">Status</div><div class="r"><span class="chip amber dot-chip"><span class="dot"></span>Connected · pick a site</span></div></div>
        <div class="set-row" style="border-bottom:0;padding-top:14px">
          <div class="l"></div>
          <div class="r">
            <button class="btn btn-ghost btn-sm" id="btn-gsc-pick-site" type="button">Choose site →</button>
            <button class="btn btn-ghost btn-sm" id="btn-gsc-disconnect" type="button" style="margin-left:6px">Disconnect</button>
            <span id="gsc-status-msg" style="font-size:12.5px;color:var(--muted);margin-left:10px"></span>
          </div>
        </div>`;
    } else {
      body = `
        <div class="set-row"><div class="l">Status</div><div class="r"><span class="chip sage dot-chip"><span class="dot"></span>Connected</span> ${errorPill}</div></div>
        <div class="set-row"><div class="l">Site</div><div class="r"><strong>${esc(s.site_url || '')}</strong></div></div>
        <div class="set-row"><div class="l">Last sync</div><div class="r">${esc(timeAgo(s.last_sync_at))}${s.last_sync_error ? ` <span style="color:var(--red);font-size:12.5px">· ${esc(String(s.last_sync_error).slice(0, 120))}</span>` : ''}</div></div>
        <div class="set-row" style="border-bottom:0;padding-top:14px">
          <div class="l"></div>
          <div class="r" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" id="btn-gsc-resync" type="button">Resync now</button>
            <button class="btn btn-ghost btn-sm" id="btn-gsc-disconnect" type="button">Disconnect</button>
            <a class="btn btn-ghost btn-sm" href="/TrafficImpact.html">View AI Overviews →</a>
            <span id="gsc-status-msg" style="font-size:12.5px;color:var(--muted)"></span>
          </div>
        </div>`;
    }

    return `
      <div class="card-dash">
        <div class="card-head">
          <div>
            <h3>Google Search Console</h3>
            <div class="sub">Track AI Overview presence and cite rate for your top queries.</div>
          </div>
        </div>
        ${body}
      </div>`;
  }

  /* Wires the GSC card buttons. Called from afterMount(). Mirrors wireGa4Card()
   * but points at the /api/client/gsc/* endpoints. The Connect button POSTs
   * /api/client/gsc/start-link → window.location.href to the returned OAuth URL. */
  function wireGscCard() {
    const af = window.AMCP && window.AMCP.authedFetch;
    const msg = document.getElementById('gsc-status-msg');
    const setMsg = (text, kind) => {
      if (!msg) return;
      msg.textContent = text || '';
      msg.style.color = kind === 'error' ? 'var(--red)' : kind === 'success' ? 'var(--sage)' : 'var(--muted)';
    };

    const connectBtn = document.getElementById('btn-gsc-connect');
    if (connectBtn) {
      connectBtn.addEventListener('click', async () => {
        connectBtn.disabled = true;
        setMsg('Opening Google…');
        try {
          const r = await af('/api/client/gsc/start-link', { method: 'POST' });
          const j = await r.json();
          if (j && j.url) { window.location.href = j.url; return; }
          throw new Error(j && (j.customer_message || j.error_code) || 'Could not start GSC connection');
        } catch (err) {
          setMsg(String(err && err.message || err), 'error');
          connectBtn.disabled = false;
        }
      });
    }

    const resyncBtn = document.getElementById('btn-gsc-resync');
    if (resyncBtn) {
      resyncBtn.addEventListener('click', async () => {
        resyncBtn.disabled = true;
        setMsg('Pulling last 7 days from Search Console…');
        try {
          const r = await af('/api/client/gsc/resync', { method: 'POST' });
          const j = await r.json();
          if (j && j.error) throw new Error(j.error);
          setMsg(`Synced — ${j.rows_written || 0} rows written.`, 'success');
          // Reload after 1.5s so the status card re-renders with fresh
          // last_sync_at timestamp + cleared error.
          setTimeout(() => window.location.reload(), 1500);
        } catch (err) {
          setMsg('Sync failed: ' + String(err && err.message || err), 'error');
          resyncBtn.disabled = false;
        }
      });
    }

    const disconnectBtn = document.getElementById('btn-gsc-disconnect');
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', async () => {
        if (!window.confirm('Disconnect Google Search Console? Imported data stays in your account; new syncs will stop until you reconnect.')) return;
        disconnectBtn.disabled = true;
        setMsg('Disconnecting…');
        try {
          await af('/api/client/gsc/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          setMsg('Disconnected.', 'success');
          setTimeout(() => window.location.reload(), 1000);
        } catch (err) {
          setMsg('Could not disconnect: ' + String(err && err.message || err), 'error');
          disconnectBtn.disabled = false;
        }
      });
    }

    // Site-picker — fetches /api/client/gsc/sites, renders an inline
    // list, then POSTs /api/client/gsc/select-site on selection (which
    // runs an 18-month backfill server-side).
    const pickSiteBtn = document.getElementById('btn-gsc-pick-site');
    if (pickSiteBtn) {
      pickSiteBtn.addEventListener('click', () => {
        runInlinePicker({
          anchorBtn:    pickSiteBtn,
          listPath:     '/api/client/gsc/sites',
          listKey:      'sites',
          selectPath:   '/api/client/gsc/select-site',
          buildBody:    (s) => ({ site_url: s.siteUrl }),
          isValid:      (s) => !!s.siteUrl,
          rowLabel:     (s) => s.siteUrl || '',
          rowSubLabel:  (s) => s.permissionLevel || '',
          emptyMessage: 'No verified sites on this Google account. Add and verify a site in Search Console first.',
          intro:        'Pick the site Advocate should pull data from. Selecting a site triggers an 18-month backfill — this can take 30 seconds.',
        });
      });
    }
  }

  /* Generic inline picker for "Connected · pick X" states (GA4 properties,
   * GSC sites). Replaces the button row with a list of selectable items
   * fetched from listPath, then POSTs the chosen value to selectPath which
   * runs a server-side backfill and persists the choice. Reloads the page
   * on success so the card re-renders from the live status endpoint.
   *
   * Shape of opts:
   *   anchorBtn    — the clicked "Choose X" button. Its parent .r row is
   *                  replaced with the picker UI.
   *   listPath     — GET endpoint that returns { [listKey]: [item, ...] }.
   *   listKey      — top-level key in the list response holding the items.
   *   selectPath   — POST endpoint that persists the selection.
   *   buildBody    — fn(item) -> object sent as the JSON request body.
   *                  Lets endpoints that need multiple fields (e.g. GA4's
   *                  property_id + property_label) work without bespoke wiring.
   *   isValid      — fn(item) -> boolean. Skips invalid rows on click.
   *   rowLabel     — fn(item) -> primary display string.
   *   rowSubLabel  — fn(item) -> secondary display string (mono, muted).
   *   emptyMessage — text shown when the list is empty.
   *   intro        — paragraph above the list explaining what selection does.
   */
  function runInlinePicker(opts) {
    const af = window.AMCP && window.AMCP.authedFetch;
    const anchor = opts.anchorBtn;
    const container = anchor && anchor.parentElement;
    if (!af || !container) return;

    // Find an adjacent status-msg span to surface the loading state while
    // the list endpoint is in flight. The pickers reuse the same gscStatus/
    // ga4Status spans that live next to the buttons.
    const initialMsg = container.querySelector('[id$="-status-msg"]');
    const setInitial = (text, kind) => {
      if (!initialMsg) return;
      initialMsg.textContent = text || '';
      initialMsg.style.color = kind === 'error' ? 'var(--red)' : kind === 'success' ? 'var(--sage)' : 'var(--muted)';
    };

    anchor.disabled = true;
    setInitial('Loading…');

    af(opts.listPath)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) {
          throw new Error((j && (j.customer_message || j.error_code)) || 'Could not load list');
        }
        const items = (j && j[opts.listKey]) || [];
        if (items.length === 0) {
          setInitial(opts.emptyMessage, 'error');
          anchor.disabled = false;
          return;
        }

        const rows = items.map((it, i) => {
          const label = opts.rowLabel(it);
          const sub   = opts.rowSubLabel ? opts.rowSubLabel(it) : '';
          return `
            <button type="button" class="btn btn-ghost btn-sm picker-row" data-pick-index="${i}"
                    style="display:block;width:100%;text-align:left;margin-bottom:6px">
              <span style="font-weight:500">${esc(label)}</span>
              ${sub ? ` <span style="font-family:var(--mono);font-size:12px;color:var(--muted);margin-left:6px">${esc(sub)}</span>` : ''}
            </button>`;
        }).join('');

        container.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:0;max-width:520px">
            <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px;line-height:1.5">${esc(opts.intro)}</div>
            ${rows}
            <button type="button" class="btn btn-ghost btn-sm picker-cancel" style="margin-top:8px;align-self:flex-start">Cancel</button>
            <span class="picker-msg" style="font-size:12.5px;color:var(--muted);margin-top:8px"></span>
          </div>`;

        const msgEl = container.querySelector('.picker-msg');
        const setPickerMsg = (text, kind) => {
          if (!msgEl) return;
          msgEl.textContent = text || '';
          msgEl.style.color = kind === 'error' ? 'var(--red)' : kind === 'success' ? 'var(--sage)' : 'var(--muted)';
        };

        container.querySelectorAll('.picker-row').forEach((rowBtn) => {
          rowBtn.addEventListener('click', async () => {
            const idx = Number(rowBtn.getAttribute('data-pick-index'));
            const item = items[idx];
            if (!item) return;
            if (typeof opts.isValid === 'function' && !opts.isValid(item)) return;
            // Disable every button in the picker while the backfill runs
            container.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            setPickerMsg('Backfilling — this can take up to 30 seconds. Don’t close this tab.');
            try {
              const body = opts.buildBody(item) || {};
              // Impersonation fix: select-site/select-property read slug from
              // the JSON body, not the query string. authedFetch adds ?slug=
              // to the URL automatically but the workers ignore it on these
              // endpoints. Mirror it into the body so admin ?as=<slug> flows
              // resolve to the impersonated tenant.
              try {
                const asSlug = new URL(window.location.href).searchParams.get('as');
                if (asSlug && !body.slug) body.slug = asSlug;
              } catch (_) { /* URL parse error → no slug, server uses businesses[0] */ }
              const r = await af(opts.selectPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              });
              const j = await r.json();
              if (!r.ok || (j && j.error)) {
                throw new Error((j && (j.customer_message || j.error_code || j.error)) || 'Selection failed');
              }
              const days = (j && j.backfill && j.backfill.days_upserted) || 0;
              setPickerMsg(days > 0 ? `Selected — ${days} days backfilled.` : 'Selected.', 'success');
              setTimeout(() => window.location.reload(), 1200);
            } catch (err) {
              setPickerMsg(String(err && err.message || err), 'error');
              container.querySelectorAll('button').forEach((b) => { b.disabled = false; });
            }
          });
        });

        const cancelBtn = container.querySelector('.picker-cancel');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', () => {
            window.location.reload();
          });
        }
      })
      .catch((err) => {
        setInitial(String(err && err.message || err), 'error');
        anchor.disabled = false;
      });
  }

  /* CRM connection card — PR 4 of the Traffic Impact feature.
   *
   * Shows HubSpot and Salesforce connections side-by-side.
   * Base tenants see an upgrade CTA. Pro tenants see connect/disconnect
   * controls per provider. A tenant can have both connected simultaneously.
   */
  function renderCrmCard(hubspot, salesforce, plan) {
    const isPro = plan === 'pro' || plan === 'enterprise';

    // Base tenant — upsell
    if (!isPro) {
      return `
        <div class="card-dash">
          <div class="card-head">
            <div>
              <h3>CRM integration <span class="chip maroon" style="margin-left:6px">Pro</span></h3>
              <div class="sub">Connect HubSpot or Salesforce to track LTV by AI vs unknown acquisition source.</div>
            </div>
          </div>
          <div class="set-row" style="border-bottom:0;padding:20px 0">
            <div class="l"></div>
            <div class="r" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
              <div style="font-size:13px;color:var(--ink-2);max-width:480px;line-height:1.5">
                Pro tenants connect their CRM and Advocate computes average lifetime value per AI-acquired vs unknown-source customer cohorts. Aggregate roll-ups only — contact data stays in your CRM.
              </div>
              <a href="/Billing.html" class="btn btn-primary btn-sm">Upgrade to Pro →</a>
            </div>
          </div>
        </div>`;
    }

    function providerSection(provider, s, labelTitle) {
      const connected = !!(s && s.connected);
      const errorPill = (s && s.last_sync_error)
        ? `<span class="chip" style="background:rgba(180,40,40,.08);color:var(--red);border:1px solid rgba(180,40,40,.25)">Sync error</span>`
        : '';
      const btnId = 'btn-crm-' + provider;
      if (!connected) {
        return `
          <div style="flex:1;min-width:220px;border:1px solid var(--line);border-radius:8px;padding:16px">
            <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:8px">${esc(labelTitle)}</div>
            <div style="margin-bottom:10px"><span class="chip">Not connected</span></div>
            <button class="btn btn-primary btn-sm" id="${btnId}-connect" type="button">Connect ${esc(labelTitle)} →</button>
            <span id="${btnId}-msg" style="display:block;margin-top:6px;font-size:12.5px;color:var(--muted)"></span>
          </div>`;
      }
      return `
        <div style="flex:1;min-width:220px;border:1px solid var(--line);border-radius:8px;padding:16px">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:8px">${esc(labelTitle)}</div>
          <div style="margin-bottom:6px"><span class="chip sage dot-chip"><span class="dot"></span>Connected</span> ${errorPill}</div>
          ${s && s.last_used_at ? `<div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">Last used ${esc(timeAgo(s.last_used_at))}</div>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="btn btn-ghost btn-sm" id="${btnId}-disconnect" type="button">Disconnect</button>
            <a class="btn btn-ghost btn-sm" href="/TrafficImpact.html">View LTV →</a>
          </div>
          <span id="${btnId}-msg" style="display:block;margin-top:6px;font-size:12.5px;color:var(--muted)"></span>
        </div>`;
    }

    return `
      <div class="card-dash">
        <div class="card-head">
          <div>
            <h3>CRM integration</h3>
            <div class="sub">Connect your CRM to see customer lifetime value split by AI vs unknown acquisition source on the Traffic Impact page.</div>
          </div>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;padding:4px 0 8px">
          ${providerSection('hubspot', hubspot, 'HubSpot')}
          ${providerSection('salesforce', salesforce, 'Salesforce')}
        </div>
      </div>`;
  }

  /* Wires the CRM card buttons. Called from afterMount(). Mirrors wireGscCard()
   * but points at /api/client/crm/* endpoints with a provider query param. */
  function wireCrmCard() {
    const af = window.AMCP && window.AMCP.authedFetch;

    function wireProvider(provider) {
      const labelTitle = provider.charAt(0).toUpperCase() + provider.slice(1);
      const btnId = 'btn-crm-' + provider;
      const msgEl = document.getElementById(btnId + '-msg');
      const setMsg = (text, kind) => {
        if (!msgEl) return;
        msgEl.textContent = text || '';
        msgEl.style.color = kind === 'error' ? 'var(--red)' : kind === 'success' ? 'var(--sage)' : 'var(--muted)';
      };

      const connectBtn = document.getElementById(btnId + '-connect');
      if (connectBtn) {
        connectBtn.addEventListener('click', async () => {
          connectBtn.disabled = true;
          setMsg('Opening ' + labelTitle + '…');
          try {
            const r = await af('/api/client/crm/start-link?provider=' + encodeURIComponent(provider), { method: 'POST' });
            const j = await r.json();
            if (j && j.url) { window.location.href = j.url; return; }
            throw new Error((j && (j.customer_message || j.error_code)) || 'Could not start CRM connection');
          } catch (err) {
            setMsg(String(err && err.message || err), 'error');
            connectBtn.disabled = false;
          }
        });
      }

      const disconnectBtn = document.getElementById(btnId + '-disconnect');
      if (disconnectBtn) {
        disconnectBtn.addEventListener('click', async () => {
          if (!window.confirm('Disconnect ' + labelTitle + '? Imported LTV data stays in your account; new syncs will stop until you reconnect.')) return;
          disconnectBtn.disabled = true;
          setMsg('Disconnecting…');
          try {
            await af('/api/client/crm/disconnect?provider=' + encodeURIComponent(provider), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            setMsg('Disconnected.', 'success');
            setTimeout(() => window.location.reload(), 1000);
          } catch (err) {
            setMsg('Could not disconnect: ' + String(err && err.message || err), 'error');
            disconnectBtn.disabled = false;
          }
        });
      }
    }

    wireProvider('hubspot');
    wireProvider('salesforce');
  }

  /* Authority Kit card — Phase 6 PR 3.
   *
   * Three variants:
   *   1. Base tenant        → Pro upsell
   *   2. Pro, not configured → empty inputs + Save
   *   3. Pro, configured    → current values (editable) + last sync timestamp
   */
  function renderAuthorityCard(authorityStatus, plan) {
    const isPro = plan === 'pro' || plan === 'enterprise';

    // Base tenant — upsell
    if (!isPro) {
      return `
        <div class="card-dash">
          <div class="card-head">
            <div>
              <h3>Off-site authority <span class="chip maroon" style="margin-left:6px">Pro</span></h3>
              <div class="sub">Track public brand mentions and sentiment across Reddit and Google reviews.</div>
            </div>
          </div>
          <div class="set-row" style="border-bottom:0;padding:20px 0">
            <div class="l"></div>
            <div class="r" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
              <div style="font-size:13px;color:var(--ink-2);max-width:480px;line-height:1.5">
                Upgrade to Pro to track what the public web says about you — brand mentions on Reddit and Google reviews, with sentiment breakdown, synced nightly.
              </div>
              <a href="/Billing.html" class="btn btn-primary btn-sm">Upgrade to Pro →</a>
            </div>
          </div>
        </div>`;
    }

    const cfg = authorityStatus && authorityStatus.config ? authorityStatus.config : null;
    const isConfigured = !!(cfg && (cfg.brand_keyword || cfg.google_place_id));
    const syncLabel = cfg && cfg.last_synced_at ? timeAgo(cfg.last_synced_at) : null;
    const syncError = cfg && cfg.last_sync_error ? String(cfg.last_sync_error).slice(0, 120) : null;

    return `
      <div class="card-dash">
        <div class="card-head">
          <div>
            <h3>Off-site authority</h3>
            <div class="sub">Connect a brand keyword + Google Place ID to track public mentions and sentiment — synced nightly.</div>
          </div>
        </div>
        <div class="set-row" style="align-items:center">
          <div class="l">Brand keyword
            <div style="font-size:11.5px;color:var(--muted);margin-top:2px;font-weight:400;line-height:1.4">Searched on Reddit. Use your business name or product name.</div>
          </div>
          <div class="r">
            <input type="text" id="authority-brand-keyword" class="key-input" style="min-width:220px"
                   value="${cfg && cfg.brand_keyword ? esc(cfg.brand_keyword) : ''}"
                   placeholder="e.g. Advocate MCP">
          </div>
        </div>
        <div class="set-row" style="align-items:center">
          <div class="l">Google Place ID
            <div style="font-size:11.5px;color:var(--muted);margin-top:2px;font-weight:400;line-height:1.4">From Google Maps. Optional — needed for Google review tracking.</div>
          </div>
          <div class="r">
            <input type="text" id="authority-place-id" class="key-input" style="min-width:220px"
                   value="${cfg && cfg.google_place_id ? esc(cfg.google_place_id) : ''}"
                   placeholder="e.g. ChIJ…">
          </div>
        </div>
        ${isConfigured && syncLabel ? `
        <div class="set-row">
          <div class="l">Last sync</div>
          <div class="r">
            ${esc(syncLabel)}
            ${syncError ? `<span style="color:var(--red);font-size:12.5px;margin-left:8px">· ${esc(syncError)}</span>` : ''}
          </div>
        </div>` : ''}
        <div class="set-row" style="border-bottom:0;padding-top:14px">
          <div class="l"></div>
          <div class="r" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" id="btn-authority-save" type="button">${isConfigured ? 'Save changes' : 'Save configuration'}</button>
            ${isConfigured ? `<button class="btn btn-ghost btn-sm" id="btn-authority-disconnect" type="button" style="color:var(--red)">Disconnect</button>` : ''}
            <a class="btn btn-ghost btn-sm" href="/TrafficImpact.html">View mentions →</a>
            <span id="authority-status-msg" style="font-size:12.5px;color:var(--muted)"></span>
          </div>
        </div>
      </div>`;
  }

  /* Wires the Authority Kit card buttons. Called from afterMount(). */
  function wireAuthorityCard() {
    const af = window.AMCP && window.AMCP.authedFetch;
    const msg = document.getElementById('authority-status-msg');
    const setMsg = (text, kind) => {
      if (!msg) return;
      msg.textContent = text || '';
      msg.style.color = kind === 'error' ? 'var(--red)' : kind === 'success' ? 'var(--sage)' : 'var(--muted)';
    };

    const saveBtn = document.getElementById('btn-authority-save');
    if (saveBtn && af) {
      saveBtn.addEventListener('click', async () => {
        const kwInput = document.getElementById('authority-brand-keyword');
        const pidInput = document.getElementById('authority-place-id');
        const kw = (kwInput && kwInput.value || '').trim() || null;
        const pid = (pidInput && pidInput.value || '').trim() || null;
        if (!kw && !pid) {
          setMsg('Enter at least a brand keyword or Google Place ID.', 'error');
          return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        setMsg('');
        try {
          const r = await af('/api/client/authority/configure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brand_keyword: kw, google_place_id: pid }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          setMsg('Saved. First sync runs tonight.', 'success');
          saveBtn.textContent = 'Save changes';
        } catch (err) {
          setMsg('Save failed: ' + String(err && err.message || err), 'error');
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    const disconnectBtn = document.getElementById('btn-authority-disconnect');
    if (disconnectBtn && af) {
      disconnectBtn.addEventListener('click', async () => {
        if (!window.confirm('Disconnect the Authority Kit? Your historical mention data is kept. Future syncs stop until you reconnect.')) return;
        disconnectBtn.disabled = true;
        setMsg('Disconnecting…');
        try {
          await af('/api/client/authority/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          setMsg('Disconnected.', 'success');
          setTimeout(() => window.location.reload(), 1000);
        } catch (err) {
          setMsg('Could not disconnect: ' + String(err && err.message || err), 'error');
          disconnectBtn.disabled = false;
        }
      });
    }
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

    // Wire the GA4 connection card (PR 3, May 6 2026). Safe to call even
    // if the card isn't rendered — wireGa4Card() no-ops on missing buttons.
    wireGa4Card();

    // Wire the GSC connection card (PR 5, May 6 2026). Same no-op safety.
    wireGscCard();

    // Wire the CRM connection card (PR 4, May 6 2026). Same no-op safety.
    wireCrmCard();

    // Wire the Authority Kit card (Phase 6 PR 3). Same no-op safety.
    wireAuthorityCard();

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
      // Reset the button label as soon as the user touches the field
      // again. Without this, a stale "Saved ✓" label could linger from
      // a previous save, making the user wonder whether their fresh
      // edit got persisted. (Apr 28 2026 audit fix.)
      aovInput.addEventListener('input', () => {
        if (aovBtn.textContent !== 'Saving…') {
          aovBtn.textContent = 'Save';
          aovBtn.disabled = false;
        }
      });
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
          // Enable the Copy-secret button now that there's content to
          // copy. The secret is shown ONCE, so giving the user a single
          // click to grab it (vs triple-click select-all on a 64-char
          // input) closes a real friction point.
          const copySecretBtnNow = document.getElementById('btn-copy-rev-secret');
          if (copySecretBtnNow) {
            copySecretBtnNow.disabled = false;
            copySecretBtnNow.style.opacity = '1';
            copySecretBtnNow.removeAttribute('title');
          }
          setRevStatus('Secret shown above — copy it now. We won\'t show it again. Re-rotate if you lose it.', false);
        } catch (_) {
          genBtn.textContent = isRotate ? 'Rotate failed' : 'Generate failed';
          genBtn.disabled = false;
          setRevStatus('Could not generate. Try again or contact max@advocate-mcp.com.', true);
        }
      });
    }

    // Copy secret — single-click grab of the freshly-generated secret.
    // The input is only populated for the lifetime of the page after a
    // generate/rotate (we never re-show it on subsequent loads), so the
    // button stays disabled until then.
    const copySecretBtn = document.getElementById('btn-copy-rev-secret');
    if (copySecretBtn && secretInput) {
      copySecretBtn.addEventListener('click', async () => {
        if (!secretInput.value) return;
        try {
          await navigator.clipboard.writeText(secretInput.value);
          copySecretBtn.textContent = 'Copied!';
          setTimeout(() => { copySecretBtn.textContent = 'Copy secret'; }, 2000);
        } catch (_) {
          copySecretBtn.textContent = 'Copy failed';
          setTimeout(() => { copySecretBtn.textContent = 'Copy secret'; }, 2000);
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

    // ── Team handlers (Apr 27 2026 Enterprise honesty pass) ──────────────
    const teamList = document.getElementById('team-list');
    const teamCapSub = document.getElementById('team-cap-sub');
    const inviteBtn = document.getElementById('btn-invite-member');
    if (teamList && af) {
      let inviting = false;
      let editingRoleFor = null;
      let cachedTeam = null;

      async function loadTeam() {
        try {
          const res = await af('/api/client/team');
          if (!res.ok) throw new Error('fetch failed');
          cachedTeam = await res.json();
          renderTeam();
        } catch (_) {
          teamList.innerHTML = '<div style="padding:18px;color:var(--red);font-size:13.5px">Could not load team. Try refreshing.</div>';
        }
      }

      function roleChip(role) {
        const map = { owner: 'maroon', editor: 'sage', viewer: '' };
        return `<span class="chip ${map[role] || ''}" style="font-size:10.5px;padding:2px 8px">${esc(role)}</span>`;
      }

      function renderTeam() {
        if (!cachedTeam) return;
        const { members, caller_role, plan: tPlan, cap, current_count } = cachedTeam;
        if (teamCapSub) {
          if (cap === null) teamCapSub.textContent = `${current_count} member${current_count === 1 ? '' : 's'} · unlimited on ${tPlan}`;
          else teamCapSub.textContent = `${current_count} of ${cap} member${cap === 1 ? '' : 's'} · ${tPlan} plan`;
        }
        if (inviteBtn) {
          inviteBtn.style.display = (caller_role === 'owner' && (cap === null || current_count < cap)) ? 'inline-flex' : 'none';
        }

        const rows = (members || []).map((m) => {
          const isSelf = false; // we don't have user_id of the caller in the response, but we identify self via cannot_remove_self in API
          const isOwner = m.role === 'owner';
          const isEditingRole = editingRoleFor === m.user_id;
          const showActions = caller_role === 'owner' && !isOwner;
          return `<div class="set-row" data-user-id="${esc(m.user_id)}" style="align-items:center;gap:12px">
            <div class="l" style="flex:1">
              <strong>${esc(m.email)}${m.full_name ? ` <span style="font-weight:400;color:var(--muted)">· ${esc(m.full_name)}</span>` : ''}</strong>
              <div style="font-size:12px;color:var(--muted);margin-top:3px;display:flex;align-items:center;gap:6px">
                ${roleChip(m.role)}
                ${m.pending_invite ? '<span class="chip" style="font-size:10.5px;padding:2px 8px;background:rgba(232,168,56,.15);color:#b07515">Pending invite</span>' : ''}
              </div>
            </div>
            <div class="r" style="display:flex;gap:6px;flex-wrap:wrap">
              ${showActions && isEditingRole ? `
                <select class="key-input" data-act="role-select" data-user-id="${esc(m.user_id)}" style="font-size:13px;padding:6px 8px">
                  <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option>
                  <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option>
                  <option value="owner">Transfer ownership →</option>
                </select>
                <button class="btn btn-ghost btn-sm" data-act="role-cancel">Cancel</button>
              ` : showActions ? `
                <button class="btn btn-ghost btn-sm" data-act="role-edit" data-user-id="${esc(m.user_id)}">Change role</button>
                <button class="btn btn-ghost btn-sm" data-act="remove" data-user-id="${esc(m.user_id)}" style="color:var(--red);border-color:rgba(248,81,73,.35)">Remove</button>
              ` : ''}
            </div>
          </div>`;
        }).join('');

        const inviteForm = inviting && caller_role === 'owner' ? `
          <div class="set-row" style="align-items:flex-end;gap:12px;flex-wrap:wrap;background:var(--paper-2)">
            <div style="flex:1;display:grid;grid-template-columns:1fr auto;gap:8px;min-width:280px">
              <input type="email" id="invite-email" class="key-input" placeholder="teammate@example.com" autocomplete="email">
              <select id="invite-role" class="key-input" style="font-size:13.5px">
                <option value="viewer">Viewer (read-only)</option>
                <option value="editor">Editor (can edit)</option>
              </select>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-primary btn-sm" data-act="invite-send">Send invite</button>
              <button class="btn btn-ghost btn-sm" data-act="invite-cancel">Cancel</button>
            </div>
          </div>` : '';

        teamList.innerHTML = (rows || `<div style="padding:18px;color:var(--muted);font-size:13.5px;text-align:center">No team members yet.</div>`) + inviteForm;
      }

      teamList.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-user-id');

        if (act === 'role-edit') { editingRoleFor = id; renderTeam(); return; }
        if (act === 'role-cancel') { editingRoleFor = null; renderTeam(); return; }
        if (act === 'invite-cancel') { inviting = false; renderTeam(); return; }

        if (act === 'invite-send') {
          const email = (document.getElementById('invite-email') || {}).value || '';
          const roleSel = (document.getElementById('invite-role') || {}).value || 'viewer';
          if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            alert('Enter a valid email.');
            return;
          }
          btn.disabled = true; btn.textContent = 'Sending…';
          try {
            const res = await af('/api/client/team/invite', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: email.trim(), role: roleSel }),
            });
            if (res.status === 402) {
              const j = await res.json().catch(() => ({}));
              alert(j.message || 'You\'ve hit your plan\'s team-member cap. Upgrade to add more.');
              btn.disabled = false; btn.textContent = 'Send invite';
              return;
            }
            if (res.status === 409) {
              alert('That person is already on your team.');
              btn.disabled = false; btn.textContent = 'Send invite';
              return;
            }
            if (!res.ok) throw new Error('failed');
            inviting = false;
            await loadTeam();
            alert('Invite sent — they\'ll receive an email with a magic link.');
          } catch (_) { btn.disabled = false; btn.textContent = 'Send invite'; alert('Could not send invite.'); }
          return;
        }
        if (act === 'remove') {
          if (!confirm('Remove this team member? They\'ll lose access immediately.')) return;
          try {
            const res = await af('/api/client/team/' + encodeURIComponent(id), { method: 'DELETE' });
            if (res.status === 409) {
              const j = await res.json().catch(() => ({}));
              alert(j.error === 'cannot_remove_owner'
                ? 'Demote this owner to editor or viewer first, then remove.'
                : 'Cannot remove yourself.');
              return;
            }
            if (!res.ok) throw new Error('failed');
            await loadTeam();
          } catch (_) { alert('Could not remove.'); }
          return;
        }
      });

      // Delegated change-handler for the role dropdown.
      teamList.addEventListener('change', async (e) => {
        const sel = e.target.closest('select[data-act="role-select"]');
        if (!sel) return;
        const id = sel.getAttribute('data-user-id');
        const role = sel.value;
        if (role === 'owner') {
          if (!confirm('Transfer ownership? You\'ll become an editor and they\'ll have full control over billing and team.')) {
            sel.value = (cachedTeam.members.find(m => m.user_id === id) || {}).role || 'viewer';
            return;
          }
        }
        try {
          const res = await af('/api/client/team/' + encodeURIComponent(id) + '/role', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role }),
          });
          if (!res.ok) throw new Error('failed');
          editingRoleFor = null;
          await loadTeam();
        } catch (_) { alert('Could not change role.'); }
      });

      if (inviteBtn) {
        inviteBtn.addEventListener('click', () => { inviting = true; renderTeam(); });
      }

      loadTeam();
    }

    // ── Locations handlers (Pro/Enterprise feature, Apr 27 2026) ─────────
    //
    // Single-card UX: list locations inline, "Add location" opens an
    // inline form below the list. Edit toggles the row to an editable
    // state. Promote / delete are buttons per row. Plan-cap is read
    // from the server's response (cap, current_count, plan) and used
    // to hide the Add button when capped.
    const locList = document.getElementById('loc-list');
    const locCapSub = document.getElementById('loc-cap-sub');
    const addLocBtn = document.getElementById('btn-add-location');
    if (locList && af) {
      let editingId = null;
      let adding = false;
      let cached = null;        // last server response

      async function loadLocations() {
        try {
          const res = await af('/api/client/locations');
          if (!res.ok) throw new Error('fetch failed');
          cached = await res.json();
          renderLocations();
        } catch (_) {
          locList.innerHTML = '<div style="padding:18px;color:var(--red);font-size:13.5px">Could not load locations. Try refreshing the page.</div>';
        }
      }

      function fmtAddress(loc) {
        const parts = [];
        if (loc.address_line1) parts.push(esc(loc.address_line1));
        if (loc.address_line2) parts.push(esc(loc.address_line2));
        const city = `${esc(loc.city)}, ${esc(loc.state)}${loc.postal_code ? ' ' + esc(loc.postal_code) : ''}`;
        parts.push(city);
        return parts.join('<br>');
      }

      function renderLocations() {
        if (!cached) return;
        const { locations, plan: locPlan, cap, current_count } = cached;
        // Cap subtitle.
        if (locCapSub) {
          if (cap === null) locCapSub.textContent = `${current_count} location${current_count === 1 ? '' : 's'} · unlimited on ${locPlan}`;
          else locCapSub.textContent = `${current_count} of ${cap} location${cap === 1 ? '' : 's'} · ${locPlan} plan`;
        }
        // Add button visibility.
        if (addLocBtn) {
          addLocBtn.style.display = (cap === null || current_count < cap) ? 'inline-flex' : 'none';
        }
        // Render rows.
        const rowHtml = (locations || []).map((l) => {
          if (editingId === l.id) {
            return `<div class="set-row" data-loc-id="${esc(l.id)}" style="align-items:flex-start;gap:12px;flex-wrap:wrap">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;flex:1;min-width:280px">
                <input type="text" class="key-input" data-field="name" placeholder="Location name" value="${esc(l.name)}" style="grid-column:1/-1">
                <input type="text" class="key-input" data-field="address_line1" placeholder="Address line 1" value="${esc(l.address_line1 || '')}">
                <input type="text" class="key-input" data-field="address_line2" placeholder="Address line 2 (opt.)" value="${esc(l.address_line2 || '')}">
                <input type="text" class="key-input" data-field="city" placeholder="City" value="${esc(l.city)}">
                <input type="text" class="key-input" data-field="state" placeholder="State" value="${esc(l.state)}">
                <input type="text" class="key-input" data-field="postal_code" placeholder="ZIP/Postal" value="${esc(l.postal_code || '')}">
                <input type="text" class="key-input" data-field="phone" placeholder="Phone" value="${esc(l.phone || '')}">
              </div>
              <div style="display:flex;gap:6px;flex-direction:column">
                <button class="btn btn-primary btn-sm" data-act="save-edit" data-loc-id="${esc(l.id)}">Save</button>
                <button class="btn btn-ghost btn-sm" data-act="cancel-edit">Cancel</button>
              </div>
            </div>`;
          }
          return `<div class="set-row" data-loc-id="${esc(l.id)}" style="align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div class="l" style="flex:1">
              <strong>${esc(l.name)}${l.is_primary ? ' <span class="chip sage" style="font-size:10px;padding:1px 6px">Primary</span>' : ''}</strong>
              <div style="font-size:12.5px;color:var(--muted);margin-top:4px;line-height:1.5">${fmtAddress(l)}${l.phone ? '<br>' + esc(l.phone) : ''}</div>
            </div>
            <div class="r" style="display:flex;gap:6px;flex-wrap:wrap">
              ${!l.is_primary ? `<button class="btn btn-ghost btn-sm" data-act="promote" data-loc-id="${esc(l.id)}" title="Make this the primary location">Set primary</button>` : ''}
              <button class="btn btn-ghost btn-sm" data-act="edit" data-loc-id="${esc(l.id)}">Edit</button>
              ${!l.is_primary ? `<button class="btn btn-ghost btn-sm" data-act="delete" data-loc-id="${esc(l.id)}" style="color:var(--red);border-color:rgba(248,81,73,.35)">Delete</button>` : ''}
            </div>
          </div>`;
        }).join('');

        // Optional add-form below the list. Prefill state and (optionally)
        // phone from the primary location — most multi-location tenants
        // are expanding within the same state, so we save the user a
        // typing pass while still leaving city/address blank for them
        // to fill (which they have to anyway). City stays blank because
        // assuming a duplicate would be misleading. (Apr 28 2026.)
        const primary = (locations || []).find((l) => l.is_primary) || null;
        const preState = primary ? esc(primary.state || '') : '';
        const prePhone = primary ? esc(primary.phone || '') : '';
        const addFormHtml = adding
          ? `<div class="set-row" data-loc-id="__new" style="align-items:flex-start;gap:12px;flex-wrap:wrap;background:var(--paper-2)">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;flex:1;min-width:280px">
                <input type="text" class="key-input" data-field="name" placeholder="Location name (e.g. Round Rock branch)" style="grid-column:1/-1">
                <input type="text" class="key-input" data-field="address_line1" placeholder="Address line 1">
                <input type="text" class="key-input" data-field="address_line2" placeholder="Address line 2 (opt.)">
                <input type="text" class="key-input" data-field="city" placeholder="City *">
                <input type="text" class="key-input" data-field="state" placeholder="State *" value="${preState}">
                <input type="text" class="key-input" data-field="postal_code" placeholder="ZIP/Postal">
                <input type="text" class="key-input" data-field="phone" placeholder="Phone" value="${prePhone}">
              </div>
              <div style="display:flex;gap:6px;flex-direction:column">
                <button class="btn btn-primary btn-sm" data-act="save-new">Add location</button>
                <button class="btn btn-ghost btn-sm" data-act="cancel-new">Cancel</button>
              </div>
            </div>`
          : '';

        locList.innerHTML = rowHtml + addFormHtml ||
          '<div style="padding:18px;color:var(--muted);font-size:13.5px;text-align:center">No locations yet — click Add location to create your first.</div>';
      }

      function readForm(rowEl) {
        const fields = ['name','address_line1','address_line2','city','state','postal_code','phone'];
        const out = {};
        for (const f of fields) {
          const inp = rowEl.querySelector(`[data-field="${f}"]`);
          out[f] = inp ? inp.value.trim() : '';
        }
        return out;
      }

      // Delegated click handler for the locations card.
      locList.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-loc-id');

        if (act === 'edit') { editingId = id; renderLocations(); return; }
        if (act === 'cancel-edit') { editingId = null; renderLocations(); return; }
        if (act === 'cancel-new') { adding = false; renderLocations(); return; }

        if (act === 'save-edit') {
          const row = locList.querySelector(`[data-loc-id="${id}"]`);
          if (!row) return;
          const fields = readForm(row);
          if (!fields.name || !fields.city || !fields.state) {
            alert('Name, city, and state are required.');
            return;
          }
          btn.disabled = true; btn.textContent = 'Saving…';
          try {
            const res = await af('/api/client/locations/' + encodeURIComponent(id), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(fields),
            });
            if (!res.ok) throw new Error('save failed');
            editingId = null;
            await loadLocations();
          } catch (_) { btn.disabled = false; btn.textContent = 'Save'; alert('Save failed.'); }
          return;
        }
        if (act === 'save-new') {
          const row = locList.querySelector('[data-loc-id="__new"]');
          if (!row) return;
          const fields = readForm(row);
          if (!fields.name || !fields.city || !fields.state) {
            alert('Name, city, and state are required.');
            return;
          }
          btn.disabled = true; btn.textContent = 'Adding…';
          try {
            const res = await af('/api/client/locations', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(fields),
            });
            if (res.status === 402) {
              const j = await res.json().catch(() => ({}));
              alert(j.message || 'You\'ve hit your plan\'s location cap. Upgrade to add more.');
              btn.disabled = false; btn.textContent = 'Add location';
              return;
            }
            if (!res.ok) throw new Error('add failed');
            adding = false;
            await loadLocations();
          } catch (_) { btn.disabled = false; btn.textContent = 'Add location'; alert('Add failed.'); }
          return;
        }
        if (act === 'promote') {
          if (!confirm('Make this the primary location? AI agents will default to this location\'s details when no specific city is mentioned.')) return;
          try {
            const res = await af('/api/client/locations/' + encodeURIComponent(id) + '/promote', { method: 'POST' });
            if (!res.ok) throw new Error('promote failed');
            await loadLocations();
          } catch (_) { alert('Could not promote. Try again.'); }
          return;
        }
        if (act === 'delete') {
          if (!confirm('Delete this location? This cannot be undone.')) return;
          try {
            const res = await af('/api/client/locations/' + encodeURIComponent(id), { method: 'DELETE' });
            if (res.status === 409) { alert('Cannot delete the primary location. Promote another location to primary first.'); return; }
            if (!res.ok) throw new Error('delete failed');
            await loadLocations();
          } catch (_) { alert('Delete failed.'); }
          return;
        }
      });

      if (addLocBtn) {
        addLocBtn.addEventListener('click', () => { adding = true; renderLocations(); });
      }

      // Initial load.
      loadLocations();
    }
  }

  window.AMCP_SETTINGS = { demo: () => DEMO, fetch: fetchReal, render, afterMount };
})();
