/* v2 Billing page — current plan + upgrade/downgrade routes.
 *
 * Plan tier comes from AMCP_DATA.plan (populated by shell via
 * /api/client/metrics.plan). No Stripe Customer Portal endpoint wired
 * yet, so upgrade/downgrade/cancel all route through a mailto that
 * lands in hello@advocatemcp.com with context prefilled. */
(function () {
  'use strict';

  const DEMO = {
    business_name: 'Preview Business',
    plan: 'base',
  };

  async function fetchReal() {
    // Billing info rides on /api/client/metrics today — no dedicated
    // /api/client/billing endpoint exists yet.
    const af = window.AMCP && window.AMCP.authedFetch;
    const r = await af('/api/client/metrics');
    return (r.ok ? await r.json() : {}) || {};
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function mailtoLink(subject, body) {
    return `mailto:hello@advocatemcp.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  const PLANS = [
    {
      id: 'base', name: 'Base', price: 149,
      blurb: 'For single-location businesses getting started with AI.',
      features: [
        'Accurate answers across every major AI tool',
        'Plain-English analytics dashboard',
        'Tracked click-back links',
        'Email support',
      ],
    },
    {
      id: 'pro', name: 'Pro', price: 349,
      featured: true,
      blurb: 'For shops that want to win head-to-head against local competitors.',
      features: [
        'Everything in Base',
        'Competitor Radar — weekly polls + loss analysis',
        'Multiple locations',
        'Weekly digest email',
        'Priority support',
      ],
    },
    {
      id: 'enterprise', name: 'Enterprise', price: null,
      blurb: 'For franchises and multi-location brands.',
      features: [
        'Everything in Pro',
        'Dedicated success manager',
        'Custom integrations',
        'Team accounts & roles',
      ],
    },
  ];

  function render(metrics) {
    const m = metrics || {};
    const currentPlan = (m.plan || 'free').toLowerCase();
    const bizName = m.business_name || 'your business';
    const slug    = m.slug || (window.AMCP_DATA && window.AMCP_DATA.slug) || '';

    const planCards = PLANS.map(p => {
      const isCurrent = p.id === currentPlan;
      const priceBlock = p.price != null
        ? `<div class="price-num">$${p.price}<small>/mo</small></div>`
        : `<div class="price-num" style="font-family:var(--serif);font-size:32px;font-style:italic">Let's talk</div>`;

      let cta;
      if (isCurrent) {
        cta = `<button class="btn btn-ghost" disabled style="width:100%;opacity:.6;cursor:default">Current plan</button>`;
      } else if (p.id === 'enterprise') {
        cta = `<a class="btn btn-ghost" style="width:100%" href="${mailtoLink('Enterprise plan inquiry', `Hi Advocate team,\n\nI'd like to talk about Enterprise for ${bizName} (${slug}).\n\nThanks!`)}">Book a call</a>`;
      } else {
        const verb = (p.id === 'pro' && currentPlan === 'base') ? 'Upgrade to Pro'
                   : (p.id === 'pro')  ? 'Switch to Pro'
                   : (p.id === 'base') ? 'Switch to Base'
                   : `Switch to ${p.name}`;
        const subj = (p.id === 'pro' && currentPlan === 'base') ? 'Upgrade to Pro' : `Change plan: ${p.name}`;
        const body = `Hi Advocate team,\n\nI'd like to switch ${bizName} (${slug}) to the ${p.name} plan.\n\nThanks!`;
        cta = `<a class="btn ${p.featured ? 'btn-primary' : 'btn-ghost'}" style="width:100%" href="${mailtoLink(subj, body)}">${esc(verb)} →</a>`;
      }

      return `<div class="price-card ${p.featured ? 'featured' : ''} ${isCurrent ? 'current' : ''}">
        ${p.featured ? `<span class="chip maroon" style="position:absolute;top:16px;right:16px">RECOMMENDED</span>` : ''}
        ${isCurrent ? `<span class="chip sage" style="position:absolute;top:16px;right:16px">CURRENT</span>` : ''}
        <h3>${esc(p.name)}</h3>
        <p class="blurb">${esc(p.blurb)}</p>
        ${priceBlock}
        <ul>${p.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
        ${cta}
      </div>`;
    }).join('');

    const planLabel = PLANS.find(p => p.id === currentPlan);
    const currentName = planLabel ? planLabel.name : (currentPlan === 'free' ? 'Free trial' : currentPlan);

    return `
      <div class="plain-banner">
        <strong>In plain English:</strong>
        You're on the <strong>${esc(currentName)}</strong> plan. Upgrade, downgrade, or cancel at any time ${currentPlan === 'base' ? ' — Pro unlocks Competitor Radar and multi-location support.' : '.'}
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>Current plan</h3><div class="sub">Billed monthly · cancel any time</div></div></div>
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:14px;padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
            <div>
              <div style="font-family:var(--serif);font-size:28px;color:var(--ink);line-height:1;">${esc(currentName)}</div>
              <div style="color:var(--muted);font-size:13px;margin-top:4px">${esc(bizName)}${slug ? ` · <span style="font-family:var(--mono)">${esc(slug)}</span>` : ''}</div>
            </div>
            ${currentPlan === 'base' ? `<a class="btn btn-primary btn-sm" href="${mailtoLink('Upgrade to Pro', `Hi Advocate team,\n\nI'd like to upgrade ${bizName} (${slug}) to Pro.\n\nThanks!`)}">Upgrade to Pro →</a>` : ''}
          </div>
          <div style="margin-top:16px;font-size:12.5px;color:var(--muted);line-height:1.6">
            Until the self-serve Stripe portal ships, plan changes and cancellations go through
            <a href="${mailtoLink('Billing change', `Hi Advocate team,\n\nI'd like to change my plan for ${bizName} (${slug}).\n\nThanks!`)}" style="color:var(--maroon);font-weight:500">hello@advocatemcp.com</a>.
            We usually reply within one business day.
          </div>
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>Invoices</h3><div class="sub">Receipts for past billing cycles</div></div></div>
          <p style="font-size:13.5px;line-height:1.65;color:var(--ink-2);margin-top:12px">Invoice history isn't exposed in-app yet. Email
            <a href="${mailtoLink('Invoice request', `Hi Advocate team,\n\nPlease send recent invoices for ${bizName} (${slug}).\n\nThanks!`)}" style="color:var(--maroon);font-weight:500">hello@advocatemcp.com</a>
            and we'll send the last 12 months.</p>
        </div>
      </div>

      <div class="row single">
        <div class="card-dash" style="padding-bottom:32px">
          <div class="card-head"><div><h3>All plans</h3><div class="sub">Compare side by side</div></div></div>
          <div class="price-grid">${planCards}</div>
        </div>
      </div>

      <div class="row single">
        <div class="card-dash" style="background:var(--paper-2)">
          <div class="card-head"><div><h3>Cancelling?</h3><div class="sub">We're sorry to see you go</div></div></div>
          <p style="font-size:13.5px;line-height:1.65;color:var(--ink-2);margin-top:8px">If Advocate isn't working for you, we'd rather fix it than lose you. Reply with what's missing and we'll either fix it or help you cancel cleanly.</p>
          <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
            <a class="btn btn-ghost btn-sm" href="${mailtoLink('Cancel Advocate', `Hi Advocate team,\n\nI want to cancel ${bizName} (${slug}). Reason:\n\n[your feedback here]\n\nThanks!`)}">Request cancellation</a>
            <a class="btn btn-ghost btn-sm" href="/Contact.html">Talk to us instead</a>
          </div>
        </div>
      </div>

      <style>
        .price-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 18px; }
        @media (max-width: 900px) { .price-grid { grid-template-columns: 1fr; } }
        .price-card {
          position: relative;
          background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-lg);
          padding: 28px 24px; display: flex; flex-direction: column; gap: 14px;
        }
        .price-card.featured { border-color: var(--maroon); box-shadow: 0 0 0 3px var(--maroon-tint); }
        .price-card.current  { background: var(--sage-tint); border-color: var(--sage); }
        .price-card h3 { font-family: var(--serif); font-weight: 400; font-size: 28px; color: var(--ink); margin: 0; }
        .price-card .blurb { font-size: 13.5px; color: var(--ink-2); line-height: 1.5; min-height: 38px; }
        .price-card .price-num { font-family: var(--serif); font-size: 42px; color: var(--maroon); line-height: 1; }
        .price-card .price-num small { font-size: 14px; color: var(--muted); font-family: var(--sans); margin-left: 4px; }
        .price-card ul { list-style: none; padding: 0; margin: 6px 0; display: flex; flex-direction: column; gap: 8px; }
        .price-card li { font-size: 13.5px; color: var(--ink-2); padding-left: 22px; position: relative; line-height: 1.45; }
        .price-card li::before { content: '✓'; position: absolute; left: 0; color: var(--maroon); font-weight: 600; }
        .price-card.current li::before { color: var(--sage); }
      </style>
    `;
  }

  window.AMCP_BILLING = { demo: () => DEMO, fetch: fetchReal, render };
})();
