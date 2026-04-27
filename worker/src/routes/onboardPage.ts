// Self-serve onboarding page — GET /onboard
// 4-step wizard: Info → Payment → DNS Setup → Live.
//
// Design system: shares tokens + header chrome with /demo via ./sharedLayout.ts.
// Do NOT add hardcoded hex colors to styles in this file — use var(--bg),
// var(--text), var(--green), etc. See sharedLayout.ts for the full palette.

import type { Env } from "../types";
import {
  BASE_TOKENS_CSS,
  BASE_LAYOUT_CSS,
  renderHeader,
  renderFooter,
  themeToggleScript,
} from "./sharedLayout";

export async function handleOnboardPage(_request: Request, _env: Env): Promise<Response> {
  return new Response(PAGE_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Get Started — AdvocateMCP</title>
<meta name="description" content="Connect your domain to AdvocateMCP in minutes. One DNS change, live AI visibility.">
<link rel="manifest" href="data:application/json,${encodeURIComponent(JSON.stringify({name:"AdvocateMCP",short_name:"Advocate",start_url:"/onboard",display:"standalone",background_color:"#0d1117",theme_color:"#238636"}))}">
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme:dark)">
<meta name="theme-color" content="#f9fafb" media="(prefers-color-scheme:light)">
${BASE_TOKENS_CSS}
${BASE_LAYOUT_CSS}
<style>
/* Progress bar — 4 steps */
.progress{padding:1rem 1.5rem;border-bottom:1px solid var(--border);background:var(--bg2)}
.progress-inner{max-width:680px;margin:0 auto;display:flex;align-items:center;gap:.5rem}
.prog-step{display:flex;align-items:center;gap:.375rem;font-size:.75rem;font-weight:500;color:var(--muted);transition:color .3s}
.prog-step.active{color:var(--green3)}
.prog-step.done{color:var(--green3)}
.prog-num{width:22px;height:22px;border-radius:50%;border:2px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:.6875rem;font-weight:700;transition:all .3s}
.prog-step.active .prog-num{border-color:var(--green3);background:var(--green);color:#fff}
.prog-step.done .prog-num{border-color:var(--green3);background:var(--green3);color:#fff}
.prog-line{flex:1;height:2px;background:var(--border2);border-radius:1px;transition:background .3s}
.prog-line.done{background:var(--green3)}

/* Wrap */
.wrap{max-width:640px;margin:0 auto;padding:2rem 1.5rem;flex:1;width:100%}

/* Step panels */
.step{display:none}
.step.active{display:block}

/* Step header */
.step-tag{font-size:.6875rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--green3);margin-bottom:.5rem}
.step-title{font-size:1.5rem;font-weight:700;letter-spacing:-.02em;margin-bottom:.25rem}
.step-sub{color:var(--sub);font-size:.9375rem;margin-bottom:1.5rem;line-height:1.6}

/* Form */
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
@media(max-width:520px){.form-grid{grid-template-columns:1fr}}
.form-full{grid-column:1/-1}
.field{display:flex;flex-direction:column;gap:.25rem}
.field label{font-size:.75rem;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.04em}
.field input,.field select{background:var(--bg);border:1px solid var(--border2);border-radius:8px;padding:.625rem .75rem;font-size:.875rem;color:var(--text);outline:none;transition:border-color .15s;font-family:var(--font)}
.field input::placeholder{color:var(--muted)}
.field input:focus,.field select:focus{border-color:var(--blue)}
.field .hint{font-size:.6875rem;color:var(--muted);margin-top:.125rem}
.field .err-msg{font-size:.6875rem;color:var(--red);margin-top:.125rem;display:none}
.field.invalid input{border-color:var(--red)}
.field.invalid .err-msg{display:block}
.field.valid input{border-color:var(--green3)}

/* Domain field with live check */
.domain-wrap{position:relative}
.domain-wrap input{padding-right:2.5rem}
.domain-status{position:absolute;right:.75rem;top:50%;transform:translateY(-50%);font-size:.875rem;opacity:0;transition:opacity .2s}
.domain-status.show{opacity:1}

/* Plan selector */
.plan-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.75rem;margin-bottom:1rem}
@media(max-width:520px){.plan-grid{grid-template-columns:1fr}}
.plan-card{background:var(--bg2);border:2px solid var(--border2);border-radius:10px;padding:1rem;cursor:pointer;transition:all .15s;text-align:center;position:relative}
.plan-card:hover{border-color:var(--blue)}
.plan-card.selected{border-color:var(--green3);background:rgba(63,185,80,.06)}
.plan-badge{position:absolute;top:-.5rem;right:.75rem;background:var(--green);color:#fff;font-size:.6rem;font-weight:700;padding:.15rem .5rem;border-radius:3px;text-transform:uppercase;letter-spacing:.06em}
.plan-price{font-size:1.375rem;font-weight:700;color:var(--text);margin-bottom:.125rem}
.plan-price span{font-size:.8125rem;font-weight:400;color:var(--sub)}
.plan-name{font-size:.875rem;font-weight:600;margin-bottom:.375rem}
.plan-desc{font-size:.6875rem;color:var(--sub);line-height:1.4}

/* Primary button */
.btn{background:var(--green);color:#fff;border:none;border-radius:8px;padding:.75rem 1.5rem;font-size:.9375rem;font-weight:500;cursor:pointer;width:100%;margin-top:1rem;transition:background .15s;font-family:var(--font)}
.btn:hover{background:var(--green2)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-loading{position:relative;color:transparent}
.btn-loading::after{content:'';position:absolute;width:18px;height:18px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;top:50%;left:50%;margin:-9px 0 0 -9px}
@keyframes spin{to{transform:rotate(360deg)}}
.btn-outline{background:transparent;border:2px solid var(--border2);color:var(--text)}
.btn-outline:hover{border-color:var(--sub)}

/* Error/success banner */
.banner{padding:.625rem 1rem;border-radius:8px;font-size:.8125rem;margin-bottom:1rem;display:none;line-height:1.5}
.banner.err{background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.3);color:var(--red)}
.banner.ok{background:rgba(63,185,80,.1);border:1px solid rgba(63,185,80,.3);color:var(--green3)}
.banner.warn{background:rgba(210,153,34,.1);border:1px solid rgba(210,153,34,.3);color:var(--yellow)}
.banner.show{display:block}

/* DNS records table */
.dns-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:1rem}
.dns-hd{padding:.75rem 1rem;border-bottom:1px solid var(--border);font-weight:600;font-size:.8125rem;display:flex;align-items:center;gap:.5rem}
.dns-row{display:grid;grid-template-columns:auto 1fr auto;gap:.75rem;padding:.75rem 1rem;border-bottom:1px solid var(--border);align-items:start}
.dns-row:last-child{border-bottom:none}
.dns-type{background:var(--blue-bg);border:1px solid var(--blue-border);color:var(--blue);border-radius:4px;padding:.1rem .4rem;font-size:.6875rem;font-weight:700;letter-spacing:.04em;white-space:nowrap}
.dns-detail{min-width:0}
.dns-label{font-size:.6875rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.125rem}
.dns-val{font-family:var(--mono);font-size:.75rem;color:var(--text);word-break:break-all;line-height:1.5}
.copy-btn{background:transparent;border:1px solid var(--border2);border-radius:5px;color:var(--sub);font-size:.6875rem;padding:.2rem .5rem;cursor:pointer;transition:all .15s;white-space:nowrap;align-self:center}
.copy-btn:hover{border-color:var(--sub);color:var(--text)}
.copy-btn.copied{border-color:var(--green3);color:var(--green3)}

/* Confidence meter */
.confidence{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:1rem;margin-bottom:1rem}
.conf-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem}
.conf-label{font-size:.8125rem;font-weight:500}
.conf-val{font-size:.875rem;font-weight:700;color:var(--green3)}
.conf-bar{height:6px;background:var(--border);border-radius:3px;overflow:hidden}
.conf-fill{height:100%;background:var(--green3);border-radius:3px;transition:width .6s ease}
.conf-hint{font-size:.6875rem;color:var(--muted);margin-top:.375rem}

/* Polling status */
.poll-status{text-align:center;padding:1rem;color:var(--sub);font-size:.8125rem}
.poll-status .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border2);border-top-color:var(--green3);border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:.375rem}

/* Step 2 — payment waiting */
.payment-wait{text-align:center;padding:2rem 1rem}
.payment-wait .spinner-lg{display:inline-block;width:36px;height:36px;border:3px solid var(--border2);border-top-color:var(--green3);border-radius:50%;animation:spin .8s linear infinite;margin-bottom:1rem}
.payment-wait p{color:var(--sub);font-size:.875rem;margin-bottom:.5rem}

/* Step 4 — success */
.success-icon{font-size:3rem;text-align:center;margin-bottom:1rem}
.live-card{background:linear-gradient(135deg,var(--bg2) 0%,var(--bg3) 100%);border:1px solid var(--border2);border-radius:10px;padding:1.25rem;margin-bottom:1rem}
.live-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem}
.live-row:last-child{margin-bottom:0}
.live-label{font-size:.8125rem;color:var(--sub)}
.live-val{font-size:.8125rem;font-weight:600;color:var(--text);font-family:var(--mono)}
.badge-live{display:inline-block;background:rgba(63,185,80,.15);color:var(--green3);border:1px solid rgba(63,185,80,.3);border-radius:4px;padding:.1rem .4rem;font-size:.625rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
.badge-plan{display:inline-block;border-radius:4px;padding:.1rem .5rem;font-size:.625rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.badge-base{background:rgba(56,139,253,.12);border:1px solid rgba(56,139,253,.25);color:var(--blue)}
.badge-pro{background:rgba(210,153,34,.12);border:1px solid rgba(210,153,34,.3);color:var(--yellow)}
.badge-free{background:rgba(139,148,158,.12);border:1px solid rgba(139,148,158,.3);color:var(--sub)}
.actions-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:1rem}
@media(max-width:520px){.actions-grid{grid-template-columns:1fr}}
.action-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:1rem;text-align:center;transition:border-color .15s;cursor:pointer;display:block}
.action-card:hover{border-color:var(--blue)}
.action-icon{font-size:1.5rem;margin-bottom:.375rem}
.action-title{font-size:.875rem;font-weight:600;margin-bottom:.125rem}
.action-desc{font-size:.75rem;color:var(--sub)}
.upgrade-card{border-color:var(--green3);background:linear-gradient(135deg,rgba(35,134,54,.08),rgba(35,134,54,.02))}
.upgrade-card:hover{border-color:var(--green)}
.upgrade-price{font-size:1.125rem;font-weight:700;color:var(--green3);margin-bottom:.125rem}

/* Support bubble */
.support-bubble{position:fixed;bottom:1.25rem;right:1.25rem;width:48px;height:48px;background:var(--green);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.25rem;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3);z-index:100;transition:transform .15s,box-shadow .15s}
.support-bubble:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(0,0,0,.4)}

/* Support modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;display:none;align-items:flex-end;justify-content:flex-end;padding:1.25rem}
.modal-overlay.show{display:flex}
.modal{background:var(--bg2);border:1px solid var(--border);border-radius:12px;width:100%;max-width:380px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.4)}
.modal-hd{padding:1rem;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.modal-title{font-weight:600;font-size:.9375rem}
.modal-close{background:none;border:none;color:var(--sub);font-size:1.25rem;cursor:pointer;padding:.25rem}
.modal-close:hover{color:var(--text)}
.modal-bd{padding:1rem}
.support-item{display:flex;align-items:center;gap:.75rem;padding:.75rem;border:1px solid var(--border);border-radius:8px;margin-bottom:.5rem;cursor:pointer;transition:all .15s}
.support-item:hover{border-color:var(--blue);background:var(--blue-bg)}
.support-item:last-child{margin-bottom:0}
.si-icon{font-size:1.25rem;flex-shrink:0;width:2rem;text-align:center}
.si-body{flex:1;min-width:0}
.si-title{font-size:.8125rem;font-weight:600}
.si-desc{font-size:.6875rem;color:var(--sub)}

/* DNS help panel inside modal */
.dns-help{display:none;padding:1rem}
.dns-help.show{display:block}
.dns-help h3{font-size:.875rem;font-weight:600;margin-bottom:.75rem}
.dns-help p{font-size:.8125rem;color:var(--sub);line-height:1.6;margin-bottom:.75rem}
.dns-help code{background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:.1em .3em;font-size:.8125rem;font-family:var(--mono);color:var(--text)}
.dns-help .tip{background:rgba(56,139,253,.08);border:1px solid rgba(56,139,253,.2);border-radius:8px;padding:.75rem;margin-bottom:.75rem}
.dns-help .tip-title{font-size:.75rem;font-weight:600;color:var(--blue);margin-bottom:.25rem}
.back-link{font-size:.8125rem;color:var(--blue);cursor:pointer;display:inline-block;margin-bottom:.75rem}
.back-link:hover{text-decoration:underline}

/* Footer spacing tweak (.footer itself lives in BASE_LAYOUT_CSS) */
</style>
</head>
<body>

${renderHeader({ subtitle: "Self-Serve Onboarding", showCta: false, activeNav: null })}

<!-- Progress — 4 steps -->
<div class="progress">
  <div class="progress-inner">
    <div class="prog-step active" id="ps1"><span class="prog-num">1</span>Info</div>
    <div class="prog-line" id="pl1"></div>
    <div class="prog-step" id="ps2"><span class="prog-num">2</span>Payment</div>
    <div class="prog-line" id="pl2"></div>
    <div class="prog-step" id="ps3"><span class="prog-num">3</span>DNS</div>
    <div class="prog-line" id="pl3"></div>
    <div class="prog-step" id="ps4"><span class="prog-num">4</span>Live</div>
  </div>
</div>

<div class="wrap">

  <!-- STEP 1: Business Info + Plan -->
  <div class="step active" id="step1">
    <div class="step-tag">Step 1 of 4</div>
    <div class="step-title">Tell us about your business</div>
    <div class="step-sub">We'll set up your AI visibility profile and get you connected.</div>

    <div id="banner1" class="banner err"></div>

    <form id="onboardForm" autocomplete="on">
      <div class="form-grid">
        <div class="field form-full">
          <label for="f-name">Business Name *</label>
          <input type="text" id="f-name" name="name" required placeholder="Acme Plumbing Co." autocomplete="organization">
        </div>

        <div class="field form-full">
          <label for="f-domain">Domain *</label>
          <div class="domain-wrap">
            <input type="text" id="f-domain" name="domain" required placeholder="www.example.com" autocomplete="url" spellcheck="false">
            <span class="domain-status" id="domainStatus"></span>
          </div>
          <div class="hint" id="domainHint">The domain AI crawlers will resolve to your agent</div>
          <div class="err-msg" id="domainErr">Invalid domain format</div>
        </div>

        <div class="field">
          <label for="f-phone">Phone *</label>
          <input type="tel" id="f-phone" name="phone" required placeholder="+1 (512) 555-0123" autocomplete="tel">
        </div>
        <div class="field">
          <label for="f-email">Email *</label>
          <input type="email" id="f-email" name="email" required placeholder="hello@example.com" autocomplete="email">
        </div>
      </div>

      <!-- Plan selector -->
      <div style="margin-top:1.5rem">
        <label style="font-size:.75rem;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:.625rem">Choose your plan</label>
        <div class="plan-grid">
          <div class="plan-card selected" data-plan="base" onclick="selectPlan('base')">
            <div class="plan-price">$100<span>/mo</span></div>
            <div class="plan-name">Base</div>
            <div class="plan-desc">AI visibility, DNS routing, basic analytics, email support</div>
          </div>
          <div class="plan-card" data-plan="pro" onclick="selectPlan('pro')">
            <div class="plan-badge">Best Value</div>
            <div class="plan-price">$250<span>/mo</span></div>
            <div class="plan-name">Pro</div>
            <div class="plan-desc">Everything in Base + priority support, custom agent tone, advanced analytics</div>
          </div>
          <div class="plan-card" data-plan="free" onclick="selectPlan('free')">
            <div class="plan-price">$0<span>/mo</span></div>
            <div class="plan-name">Free</div>
            <div class="plan-desc">Basic AI visibility. Upgrade anytime.</div>
          </div>
        </div>
      </div>

      <button type="submit" class="btn" id="submitBtn">Continue to Payment</button>
    </form>
  </div>

  <!-- STEP 2: Payment Confirmation -->
  <div class="step" id="step2">
    <div class="step-tag">Step 2 of 4</div>
    <div class="step-title">Confirming payment</div>
    <div class="step-sub">We're verifying your payment with Stripe. This usually takes a few seconds.</div>

    <div id="banner2" class="banner"></div>

    <div class="payment-wait" id="paymentWait">
      <div class="spinner-lg"></div>
      <p id="paymentText">Waiting for payment confirmation...</p>
      <p style="font-size:.75rem;color:var(--muted)">You'll be advanced automatically once confirmed.</p>
    </div>
  </div>

  <!-- STEP 3: DNS Setup -->
  <div class="step" id="step3">
    <div class="step-tag">Step 3 of 4</div>
    <div class="step-title">Configure your DNS</div>
    <div class="step-sub">Add these records at your domain registrar. Verification usually completes in 5-15 minutes.</div>

    <div id="banner3" class="banner"></div>

    <div id="dnsRecords"></div>

    <div class="confidence" id="confMeter" style="display:none">
      <div class="conf-row">
        <span class="conf-label">DNS Detection</span>
        <span class="conf-val" id="confVal">Checking...</span>
      </div>
      <div class="conf-bar"><div class="conf-fill" id="confFill" style="width:0%"></div></div>
      <div class="conf-hint" id="confHint">We'll automatically detect when your DNS records propagate</div>
    </div>

    <div class="poll-status" id="pollStatus" style="display:none">
      <span class="spinner"></span>
      <span id="pollText">Checking verification status...</span>
    </div>

    <button class="btn" id="verifyBtn" onclick="verifyDns()">Verify DNS</button>
  </div>

  <!-- STEP 4: Live -->
  <div class="step" id="step4">
    <div class="success-icon" aria-hidden="true">&#x1F680;</div>
    <div class="step-tag">Step 4 of 4</div>
    <div class="step-title">You're live!</div>
    <div class="step-sub">AI crawlers are now receiving structured responses for your domain.</div>

    <div class="live-card">
      <div class="live-row">
        <span class="live-label">Domain</span>
        <span class="live-val" id="liveDomain">&mdash;</span>
      </div>
      <div class="live-row">
        <span class="live-label">Status</span>
        <span class="badge-live">LIVE</span>
      </div>
      <div class="live-row">
        <span class="live-label">Slug</span>
        <span class="live-val" id="liveSlug">&mdash;</span>
      </div>
      <div class="live-row">
        <span class="live-label">Plan</span>
        <span class="badge-plan" id="livePlan">&mdash;</span>
      </div>
    </div>

    <div class="actions-grid" id="liveActions"></div>
  </div>

</div>

${renderFooter()}

<!-- Support Bubble -->
<div class="support-bubble" onclick="toggleSupport()" id="supportBubble" aria-label="Need help?">?</div>

<!-- Support Modal -->
<div class="modal-overlay" id="supportModal">
  <div class="modal">
    <div class="modal-hd">
      <span class="modal-title">Need Help?</span>
      <button class="modal-close" onclick="toggleSupport()">&times;</button>
    </div>
    <div class="modal-bd" id="supportMain">
      <div class="support-item" onclick="showDnsHelp()">
        <span class="si-icon">&#x1F310;</span>
        <div class="si-body">
          <div class="si-title">DNS Help</div>
          <div class="si-desc">Common issues, record types, propagation</div>
        </div>
      </div>
      <div class="support-item" onclick="checkApiStatus()">
        <span class="si-icon">&#x1F4E1;</span>
        <div class="si-body">
          <div class="si-title">Status Checker</div>
          <div class="si-desc">Check API and domain verification status</div>
        </div>
      </div>
      <div class="support-item" onclick="openEmail()">
        <span class="si-icon">&#x2709;&#xFE0F;</span>
        <div class="si-body">
          <div class="si-title">Email Us</div>
          <div class="si-desc">max@advocate-mcp.com</div>
        </div>
      </div>
      <div class="support-item" onclick="openChat()">
        <span class="si-icon">&#x1F4AC;</span>
        <div class="si-body">
          <div class="si-title">Live Chat</div>
          <div class="si-desc">Talk to our team on Telegram</div>
        </div>
      </div>
      <div class="support-item" onclick="openVideo()">
        <span class="si-icon">&#x25B6;&#xFE0F;</span>
        <div class="si-body">
          <div class="si-title">Video Guide</div>
          <div class="si-desc">How to add DNS records (2 min)</div>
        </div>
      </div>
    </div>
    <div class="dns-help" id="dnsHelpPanel">
      <span class="back-link" onclick="hideDnsHelp()">&#8592; Back</span>
      <h3>DNS Troubleshooting</h3>
      <div class="tip">
        <div class="tip-title">TTL Too High</div>
        <p>If your DNS provider has a high TTL (e.g. 86400), records may take up to 24 hours to propagate. Lower TTL to 300 (5 min) before making changes, then restore it after verification.</p>
      </div>
      <div class="tip">
        <div class="tip-title">Wrong Record Type</div>
        <p>Ensure you add a <code>CNAME</code>, not an <code>A</code> record. Some providers (GoDaddy, Namecheap) call this an "Alias." The target must be exactly <code>customers.advocatemcp.com</code></p>
      </div>
      <div class="tip">
        <div class="tip-title">Propagation Delay</div>
        <p>DNS changes take 5-15 minutes on average, but can take up to 48 hours in rare cases. Use <code>dig CNAME yourdomain.com</code> to check propagation status.</p>
      </div>
      <div class="tip">
        <div class="tip-title">Apex Domain (no www)</div>
        <p>Some registrars don't support CNAME on the root domain (e.g. <code>example.com</code>). Use <code>www.example.com</code> instead, or use a provider that supports CNAME flattening (Cloudflare, Route53).</p>
      </div>
      <div class="tip">
        <div class="tip-title">Existing Records Conflict</div>
        <p>If the domain already has an A record, you must delete it before adding the CNAME. Two records of different types on the same host will conflict.</p>
      </div>
    </div>
    <div class="dns-help" id="statusPanel">
      <span class="back-link" onclick="hideStatusPanel()">&#8592; Back</span>
      <h3>System Status</h3>
      <div id="statusContent"><p>Checking...</p></div>
    </div>
  </div>
</div>

<script>
(function(){
'use strict';

/* ── State ───────────────────────────────────────────────────────────── */
var state = {
  step: 1,
  domain: '',
  slug: '',
  plan: 'base',
  sessionId: null,
  tenant: null,
  dnsRecords: [],
  pollTimer: null,
  pollCount: 0,
  paymentPollTimer: null
};

var STORAGE_KEY = 'amcp_onboard';
var API_BASE = '';
var TOTAL_STEPS = 4;

/* Theme toggle is handled by the shared themeToggleScript() — see sharedLayout.ts */

/* ── LocalStorage resume ─────────────────────────────────────────────── */
function saveState(){
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({
    step: state.step, domain: state.domain, slug: state.slug,
    plan: state.plan, sessionId: state.sessionId,
    tenant: state.tenant, dnsRecords: state.dnsRecords
  })); } catch(e){}
}
function loadState(){
  try {
    var s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!s) return;
    state.domain = s.domain || '';
    state.slug = s.slug || '';
    state.plan = s.plan || 'base';
    state.sessionId = s.sessionId || null;
    state.tenant = s.tenant || null;
    state.dnsRecords = s.dnsRecords || [];
    // Select saved plan
    selectPlan(state.plan, true);
    if (s.step === 2 && state.sessionId) { goStep(2); startPaymentPolling(); }
    else if (s.step === 3 && state.dnsRecords.length) { goStep(3); renderDns(); }
    else if (s.step === 4) { goStep(4); renderLive(); }
    else { restoreForm(s); }
  } catch(e){}
}
function restoreForm(s){
  if (!s || !s.tenant) return;
  var t = s.tenant;
  var fields = {name:'f-name',phone:'f-phone',email:'f-email'};
  for (var k in fields) {
    var el = document.getElementById(fields[k]);
    if (el && t[k]) el.value = t[k];
  }
  if (t.domain) document.getElementById('f-domain').value = t.domain;
}
function clearState(){ try { localStorage.removeItem(STORAGE_KEY); } catch(e){} }

/* ── Step navigation ─────────────────────────────────────────────────── */
function goStep(n){
  state.step = n;
  for (var i = 1; i <= TOTAL_STEPS; i++){
    var panel = document.getElementById('step'+i);
    var ps = document.getElementById('ps'+i);
    panel.classList.toggle('active', i === n);
    ps.classList.toggle('active', i === n);
    ps.classList.toggle('done', i < n);
    if (i < n) ps.querySelector('.prog-num').innerHTML = '&#10003;';
  }
  for (var j = 1; j < TOTAL_STEPS; j++){
    document.getElementById('pl'+j).classList.toggle('done', n > j);
  }
  window.scrollTo({top:0,behavior:'smooth'});
  saveState();
  ga4('step_view', {step:n});
}

/* ── Plan selector ──────────────────────────────────────────────────── */
window.selectPlan = function(plan, silent){
  state.plan = plan;
  var cards = document.querySelectorAll('.plan-card');
  cards.forEach(function(c){ c.classList.toggle('selected', c.dataset.plan === plan); });
  var btn = document.getElementById('submitBtn');
  if (plan === 'free') {
    btn.textContent = 'Start Free';
  } else {
    btn.textContent = 'Continue to Payment';
  }
  if (!silent) saveState();
};

/* ── Slug generator ──────────────────────────────────────────────────── */
function toSlug(name){
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9\\s-]/g,'')
    .replace(/\\s+/g,'-')
    .replace(/-+/g,'-')
    .replace(/^-|-$/g,'')
    .slice(0,60);
}

/* ── Domain validation ───────────────────────────────────────────────── */
var domainTimer = null;
var domainInput = document.getElementById('f-domain');
var domainStatus = document.getElementById('domainStatus');
var domainField = domainInput.closest('.field');

domainInput.addEventListener('input', function(){
  clearTimeout(domainTimer);
  var v = this.value.trim().toLowerCase()
    .replace(/^https?:\\/\\//, '').split('/')[0].split(':')[0];
  domainStatus.className = 'domain-status';
  domainStatus.textContent = '';
  domainField.classList.remove('valid','invalid');
  document.getElementById('domainHint').style.display = '';
  document.getElementById('domainErr').style.display = 'none';

  if (!v || v.length < 4) return;
  domainTimer = setTimeout(function(){ validateDomain(v); }, 400);
});

function validateDomain(d){
  if (d.endsWith('.advocatemcp.com') || d === 'advocatemcp.com'){
    showDomainErr('Cannot use advocatemcp.com subdomains'); return;
  }
  if (d.endsWith('.workers.dev')){
    showDomainErr('Cannot use workers.dev domains'); return;
  }
  var parts = d.split('.');
  if (parts.length < 2){ showDomainErr('Must include a TLD (e.g. .com)'); return; }
  for (var i=0;i<parts.length;i++){
    if (!parts[i] || parts[i].length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(parts[i])){
      showDomainErr('Invalid domain format'); return;
    }
  }
  domainField.classList.remove('invalid');
  domainField.classList.add('valid');
  domainStatus.textContent = '\\u2713';
  domainStatus.className = 'domain-status show';
  domainStatus.style.color = 'var(--green3)';
  document.getElementById('domainHint').textContent = d + ' \\u2192 customers.advocatemcp.com';
}

function showDomainErr(msg){
  domainField.classList.remove('valid');
  domainField.classList.add('invalid');
  domainStatus.textContent = '\\u2717';
  domainStatus.className = 'domain-status show';
  domainStatus.style.color = 'var(--red)';
  document.getElementById('domainErr').textContent = msg;
  document.getElementById('domainErr').style.display = 'block';
  document.getElementById('domainHint').style.display = 'none';
}

/* ── Form submit ─────────────────────────────────────────────────────── */
document.getElementById('onboardForm').addEventListener('submit', function(e){
  e.preventDefault();
  var btn = document.getElementById('submitBtn');
  if (btn.disabled) return;

  var name = document.getElementById('f-name').value.trim();
  var domain = document.getElementById('f-domain').value.trim().toLowerCase()
    .replace(/^https?:\\/\\//, '').split('/')[0].split(':')[0];
  var phone = document.getElementById('f-phone').value.trim();
  var email = document.getElementById('f-email').value.trim();

  if (!name || !domain || !phone || !email){
    showBanner('banner1','err','Please fill in all required fields.'); return;
  }
  if (domainField.classList.contains('invalid')){
    showBanner('banner1','err','Please fix the domain before continuing.'); return;
  }

  var payload = {
    domain: domain,
    name: name,
    slug: toSlug(name),
    phone: phone,
    email: email,
    plan: state.plan
  };

  state.domain = domain;
  state.slug = payload.slug;
  state.tenant = payload;

  btn.disabled = true;
  btn.classList.add('btn-loading');
  btn.textContent = '';
  hideBanner('banner1');

  apiFetch('/api/onboard/basic', {method:'POST', body:JSON.stringify(payload)})
    .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, status:r.status, data:d}; }); })
    .then(function(res){
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      btn.textContent = state.plan === 'free' ? 'Start Free' : 'Continue to Payment';

      if (!res.ok){
        var msg = res.data.message || res.data.error || 'Something went wrong.';
        showBanner('banner1','err', msg);
        return;
      }

      // Free path — skip to DNS
      if (state.plan === 'free'){
        state.dnsRecords = (res.data.dns && res.data.dns.records) || [];
        if (res.data.status === 'active'){
          goStep(4); renderLive();
        } else {
          goStep(3); renderDns();
        }
        return;
      }

      // Paid path — redirect to Stripe Checkout
      if (res.data.checkoutUrl){
        state.sessionId = null; // will be set from URL on return
        saveState();
        window.location.href = res.data.checkoutUrl;
      } else {
        showBanner('banner1','err','No checkout URL returned. Please try again.');
      }
    })
    .catch(function(err){
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      btn.textContent = state.plan === 'free' ? 'Start Free' : 'Continue to Payment';
      showBanner('banner1','err','Network error. Your form has been saved \\u2014 try again when online.');
      saveState();
    });
});

/* ── Payment polling (Step 2) ────────────────────────────────────────── */
function startPaymentPolling(){
  if (!state.sessionId) return;

  var count = 0;
  document.getElementById('paymentText').textContent = 'Waiting for payment confirmation...';

  state.paymentPollTimer = setInterval(function(){
    count++;
    if (count > 60){ // ~3 minutes
      clearInterval(state.paymentPollTimer);
      state.paymentPollTimer = null;
      document.getElementById('paymentText').textContent = 'Timed out. Refresh the page to try again.';
      return;
    }

    apiFetch('/api/onboard/session/' + encodeURIComponent(state.sessionId))
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, data:d}; }); })
      .then(function(res){
        if (!res.ok) return;

        var st = res.data.status;
        if (st === 'paid_pending_dns' || st === 'free_pending_dns' || st === 'pending_verification'){
          clearInterval(state.paymentPollTimer);
          state.paymentPollTimer = null;
          state.domain = res.data.domain || state.domain;
          state.slug = res.data.slug || state.slug;
          state.plan = res.data.plan || state.plan;
          state.dnsRecords = (res.data.dns && res.data.dns.records) || [];
          goStep(3);
          renderDns();
        } else if (st === 'active'){
          clearInterval(state.paymentPollTimer);
          state.paymentPollTimer = null;
          state.domain = res.data.domain || state.domain;
          state.slug = res.data.slug || state.slug;
          state.plan = res.data.plan || state.plan;
          goStep(4);
          renderLive();
        }
      })
      .catch(function(){
        document.getElementById('paymentText').textContent = 'Checking... (attempt '+count+')';
      });
  }, 3000);
}

/* ── Render DNS records ──────────────────────────────────────────────── */
function renderDns(){
  var c = document.getElementById('dnsRecords');
  if (!state.dnsRecords.length){
    c.innerHTML = '<div class="dns-card"><div class="dns-hd">No DNS records returned</div></div>';
    return;
  }
  var html = '<div class="dns-card"><div class="dns-hd">Required DNS Records</div>';
  state.dnsRecords.forEach(function(r){
    html += '<div class="dns-row">' +
      '<span class="dns-type">' + esc(r.type) + '</span>' +
      '<div class="dns-detail">' +
        '<div class="dns-label">Host</div>' +
        '<div class="dns-val">' + esc(r.host || r.value) + '</div>' +
        (r.type === 'CNAME'
          ? '<div class="dns-label" style="margin-top:.375rem">Points to</div><div class="dns-val">' + esc(r.value) + '</div>'
          : '<div class="dns-label" style="margin-top:.375rem">Value</div><div class="dns-val">' + esc(r.value) + '</div>') +
        '<div class="dns-label" style="margin-top:.25rem;color:var(--muted)">' + esc(r.purpose || '') + '</div>' +
      '</div>' +
      '<button class="copy-btn" onclick="copyVal(this,\\''+esc(r.type === 'CNAME' ? r.value : r.value)+'\\')">Copy</button>' +
    '</div>';
  });
  html += '</div>';
  c.innerHTML = html;
  saveState();
}

/* ── Copy ─────────────────────────────────────────────────────────────── */
window.copyVal = function(btn, val){
  navigator.clipboard.writeText(val).then(function(){
    btn.textContent = '\\u2713 Copied';
    btn.classList.add('copied');
    setTimeout(function(){ btn.textContent='Copy'; btn.classList.remove('copied'); }, 2000);
  }).catch(function(){
    var ta = document.createElement('textarea');
    ta.value = val; ta.style.position='fixed'; ta.style.left='-9999px';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '\\u2713 Copied';
    btn.classList.add('copied');
    setTimeout(function(){ btn.textContent='Copy'; btn.classList.remove('copied'); }, 2000);
  });
};

/* ── Verify DNS ──────────────────────────────────────────────────────── */
window.verifyDns = function(){
  if (!state.domain) return;
  var btn = document.getElementById('verifyBtn');
  btn.disabled = true;
  btn.classList.add('btn-loading');
  btn.textContent = '';

  document.getElementById('confMeter').style.display = 'block';
  document.getElementById('pollStatus').style.display = 'block';
  document.getElementById('pollText').textContent = 'Checking verification with Cloudflare...';
  updateConfidence(15, 'Contacting Cloudflare...');

  apiFetch('/api/onboard/' + encodeURIComponent(state.domain) + '/verify', {method:'POST'})
    .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, data:d}; }); })
    .then(function(res){
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      btn.textContent = 'Verify DNS';

      if (res.data.currentStatus === 'active'){
        updateConfidence(100, 'Verified!');
        showBanner('banner3','ok','Domain verified and live!');
        setTimeout(function(){ goStep(4); renderLive(); }, 1200);
        ga4('verify_success', {domain:state.domain});
        return;
      }

      var sslOk = res.data.cloudflare && res.data.cloudflare.ssl_status === 'active';
      var ownerOk = res.data.cloudflare && res.data.cloudflare.ownership_verified;
      var pct = 15 + (sslOk ? 35 : 0) + (ownerOk ? 35 : 0);
      updateConfidence(pct, sslOk && ownerOk ? 'Almost there...' : 'DNS records not yet detected. Polling...');

      if (!state.pollTimer) startPolling();
    })
    .catch(function(){
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      btn.textContent = 'Verify DNS';
      showBanner('banner3','err','Network error \\u2014 check your connection and try again.');
    });
};

function startPolling(){
  state.pollCount = 0;
  state.pollTimer = setInterval(function(){
    state.pollCount++;
    if (state.pollCount > 40){
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      document.getElementById('pollText').textContent = 'Timed out. Click Verify DNS to try again.';
      return;
    }
    document.getElementById('pollText').textContent = 'Poll #' + state.pollCount + ' \\u2014 checking...';

    apiFetch('/api/onboard/' + encodeURIComponent(state.domain) + '/verify', {method:'POST'})
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.currentStatus === 'active'){
          clearInterval(state.pollTimer);
          state.pollTimer = null;
          updateConfidence(100, 'Verified!');
          showBanner('banner3','ok','Domain verified and live!');
          setTimeout(function(){ goStep(4); renderLive(); }, 1200);
          ga4('verify_success', {domain:state.domain, polls:state.pollCount});
          return;
        }
        var sslOk = d.cloudflare && d.cloudflare.ssl_status === 'active';
        var ownerOk = d.cloudflare && d.cloudflare.ownership_verified;
        var pct = 15 + (sslOk?35:0) + (ownerOk?35:0) + Math.min(state.pollCount, 15);
        updateConfidence(Math.min(pct,95), sslOk&&ownerOk?'Almost there...':'Waiting for DNS propagation...');
      })
      .catch(function(){
        document.getElementById('pollText').textContent = 'Poll #'+state.pollCount+' \\u2014 network error, retrying...';
      });
  }, 30000);
}

function updateConfidence(pct, hint){
  document.getElementById('confVal').textContent = pct + '%';
  document.getElementById('confFill').style.width = pct + '%';
  document.getElementById('confHint').textContent = hint;
  if (pct >= 100){
    document.getElementById('confFill').style.background = 'var(--green3)';
    document.getElementById('confVal').style.color = 'var(--green3)';
  }
}

/* ── Render live step ────────────────────────────────────────────────── */
function renderLive(){
  document.getElementById('liveDomain').textContent = state.domain;
  document.getElementById('liveSlug').textContent = state.slug;

  // Plan badge
  var planEl = document.getElementById('livePlan');
  var plan = state.plan || 'free';
  var planLabels = {free:'Free Plan', base:'Base Plan', pro:'Pro Plan'};
  planEl.textContent = planLabels[plan] || plan;
  planEl.className = 'badge-plan badge-' + plan;

  // Dynamic actions
  var actions = '';
  actions += '<a class="action-card" href="/dashboard"><div class="action-icon">&#x1F4CA;</div><div class="action-title">Analytics Dashboard</div><div class="action-desc">Track AI crawler hits and referral clicks</div></a>';
  actions += '<a class="action-card" id="demoLink" href="/demo/' + esc(state.slug) + '"><div class="action-icon">&#x1F50D;</div><div class="action-title">Live Preview</div><div class="action-desc">See what AI crawlers receive for your domain</div></a>';

  if (plan === 'free'){
    actions += '<div class="action-card upgrade-card" onclick="goUpgrade(\\'base\\')"><div class="upgrade-price">$100/mo</div><div class="action-title">Upgrade to Base</div><div class="action-desc">Full AI visibility, analytics, email support</div></div>';
    actions += '<div class="action-card upgrade-card" onclick="goUpgrade(\\'pro\\')"><div class="upgrade-price">$250/mo</div><div class="action-title">Upgrade to Pro</div><div class="action-desc">Priority support, custom agent tone, advanced analytics</div></div>';
  } else if (plan === 'base'){
    actions += '<div class="action-card upgrade-card" onclick="goUpgrade(\\'pro\\')"><div class="upgrade-price">$250/mo</div><div class="action-title">Upgrade to Pro</div><div class="action-desc">Priority support, custom agent tone, advanced analytics</div></div>';
    actions += '<a class="action-card" href="mailto:max@advocate-mcp.com"><div class="action-icon">&#x1F4E7;</div><div class="action-title">Contact Support</div><div class="action-desc">We\\u2019re here to help</div></a>';
  } else {
    actions += '<a class="action-card" href="mailto:max@advocate-mcp.com"><div class="action-icon">&#x1F4E7;</div><div class="action-title">Contact Support</div><div class="action-desc">We\\u2019re here to help</div></a>';
    actions += '<a class="action-card" href="mailto:max@advocate-mcp.com"><div class="action-icon">&#x2B50;</div><div class="action-title">Pro Plan Active</div><div class="action-desc">You\\u2019re on the highest tier</div></a>';
  }

  document.getElementById('liveActions').innerHTML = actions;
  clearState();
}

/* ── Upgrade placeholder ─────────────────────────────────────────────── */
window.goUpgrade = function(plan){
  // Future: call an upgrade endpoint that creates a new Stripe Checkout Session
  // for changing the subscription. For now, direct to email.
  window.location.href = 'mailto:max@advocate-mcp.com?subject=' +
    encodeURIComponent('Upgrade to ' + plan.charAt(0).toUpperCase() + plan.slice(1) + ' plan') +
    '&body=' + encodeURIComponent('Domain: ' + state.domain + '\\nCurrent plan: ' + (state.plan || 'free') + '\\nRequested plan: ' + plan);
};

/* ── API helper ──────────────────────────────────────────────────────── */
function apiFetch(path, opts){
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers['Content-Type'] = 'application/json';
  opts.headers['X-Admin-Secret'] = 'N7r4Kq2vX9mP3tLs8Yw6Bc1Hd5Zj0FaQ';
  return fetch(API_BASE + path, opts);
}

/* ── Banner helpers ──────────────────────────────────────────────────── */
function showBanner(id, type, msg){
  var el = document.getElementById(id);
  el.className = 'banner ' + type + ' show';
  el.textContent = msg;
}
function hideBanner(id){
  document.getElementById(id).classList.remove('show');
}

/* ── Support modal ───────────────────────────────────────────────────── */
window.toggleSupport = function(){
  var m = document.getElementById('supportModal');
  m.classList.toggle('show');
  hideDnsHelp(); hideStatusPanel();
  ga4('support_open', {step:state.step});
};
window.showDnsHelp = function(){
  document.getElementById('supportMain').style.display = 'none';
  document.getElementById('dnsHelpPanel').classList.add('show');
};
window.hideDnsHelp = function(){
  document.getElementById('supportMain').style.display = '';
  document.getElementById('dnsHelpPanel').classList.remove('show');
};
window.hideStatusPanel = function(){
  document.getElementById('supportMain').style.display = '';
  document.getElementById('statusPanel').classList.remove('show');
};
window.checkApiStatus = function(){
  document.getElementById('supportMain').style.display = 'none';
  document.getElementById('statusPanel').classList.add('show');
  var c = document.getElementById('statusContent');
  c.innerHTML = '<p>Checking...</p>';

  var checks = [];
  checks.push(
    fetch(API_BASE + '/status').then(function(r){
      return {name:'Platform API', ok:r.ok, detail:r.ok?'Operational':'HTTP '+r.status};
    }).catch(function(){ return {name:'Platform API', ok:false, detail:'Unreachable'}; })
  );

  if (state.domain){
    checks.push(
      apiFetch('/api/onboard/'+encodeURIComponent(state.domain)+'/status')
        .then(function(r){ return r.json().then(function(d){ return {name:'Domain: '+state.domain, ok:d.status==='active', detail:'Status: '+(d.status||'unknown')}; }); })
        .catch(function(){ return {name:'Domain: '+state.domain, ok:false, detail:'Could not check'}; })
    );
  }

  Promise.all(checks).then(function(results){
    var html = '';
    results.forEach(function(r){
      html += '<div style="display:flex;align-items:center;gap:.5rem;padding:.5rem 0;border-bottom:1px solid var(--border)">' +
        '<span style="color:'+(r.ok?'var(--green3)':'var(--red)')+';font-size:1rem">\\u25CF</span>' +
        '<div><div style="font-size:.8125rem;font-weight:500">'+esc(r.name)+'</div>' +
        '<div style="font-size:.6875rem;color:var(--sub)">'+esc(r.detail)+'</div></div></div>';
    });
    c.innerHTML = html || '<p>All systems operational</p>';
  });
};
window.openEmail = function(){
  var subj = state.domain ? '['+state.domain+'] Onboarding Issue' : 'Onboarding Help';
  window.location.href = 'mailto:max@advocate-mcp.com?subject='+encodeURIComponent(subj)+
    '&body='+encodeURIComponent('Domain: '+(state.domain||'N/A')+'\\nStep: '+state.step+'\\nPlan: '+state.plan+'\\n\\nDescribe your issue:\\n');
};
window.openChat = function(){
  window.open('https://t.me/advocatemcp','_blank');
};
window.openVideo = function(){
  window.open('https://www.youtube.com/results?search_query=how+to+add+dns+cname+record','_blank');
};

/* ── Escape ──────────────────────────────────────────────────────────── */
function esc(s){
  if(!s)return'';
  var d=document.createElement('div');
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}

/* ── GA4 stub ────────────────────────────────────────────────────────── */
function ga4(event, params){
  if(window.gtag) try{gtag('event',event,params||{});}catch(e){}
}

/* ── Offline resilience ──────────────────────────────────────────────── */
window.addEventListener('online', function(){
  hideBanner('banner1'); hideBanner('banner2'); hideBanner('banner3');
});

/* ── PWA install prompt ──────────────────────────────────────────────── */
var deferredPrompt;
window.addEventListener('beforeinstallprompt', function(e){
  e.preventDefault();
  deferredPrompt = e;
});

/* ── Handle Stripe return URL ────────────────────────────────────────── */
(function handleReturn(){
  var params = new URLSearchParams(window.location.search);

  // Cancelled
  if (params.get('cancelled') === 'true'){
    showBanner('banner1','warn','Payment was cancelled. You can try again or start with the free plan.');
    // Clean URL
    window.history.replaceState({}, '', '/onboard');
    return;
  }

  // Returning from Stripe with session_id
  var sessionId = params.get('session_id');
  if (sessionId){
    state.sessionId = sessionId;
    // Clean URL
    window.history.replaceState({}, '', '/onboard');
    goStep(2);
    startPaymentPolling();
    return;
  }
})();

/* ── Init ────────────────────────────────────────────────────────────── */
loadState();

})();
</script>
${themeToggleScript()}
</body>
</html>`;
