/**
 * GET /activate — Phase 3 self-serve activation page.
 *
 * Customer lands here after receiving an activation link (today: manually
 * generated via POST /admin/activation-token; eventually: via Stripe webhook
 * email). The link carries a signed token in `?t=`.
 *
 * Five rendered states (four visible at any time, plus the missing-token
 * short-circuit for the no-token case):
 *
 *   State 0 — Missing token. Server-rendered when `?t=` is absent. Static
 *             error page, no form. Not reachable via JS transition.
 *   State 1 — Entry form. Domain input + Continue button. Default state
 *             when a token is present.
 *   State 2 — Submitting. Spinner + honest wait message.
 *   State 3 — Instructions. CNAME + TXT records with per-field Copy buttons
 *             and the customer_message framing copy.
 *   State 4 — Pending verification. Acknowledgment of the "I've added the
 *             records" action, with honest "refresh this page" guidance
 *             (we don't send email yet).
 *
 * Design decisions documented in the Phase 3 proposal and the commit
 * message for feat(worker): phase 3 spine:
 *
 *   - No server-side token verification on GET. Verification happens on
 *     POST /api/activate. Rationale: one place for token logic, ~1s delay
 *     on bad-token surfacing is acceptable.
 *
 *   - No-JS fallback: the form has a native action="/api/activate"
 *     method="POST" with the token as a hidden input. Without JS, the
 *     browser submits natively and the customer sees the raw JSON
 *     response. Ugly but functional. No HTML response path on the
 *     backend (out of scope for tonight).
 *
 *   - Support contact uses mailto:max@advocate-mcp.com as a placeholder.
 *     Real support address gets swapped in a follow-up once the support
 *     channel is chosen.
 *
 *   - All copy reviewed against the Phase 3 voice guide in
 *     worker/src/routes/activate.ts: plain English, empathetic,
 *     action-oriented, no jargon, no exclamation marks.
 */

import type { Env } from "../types";
import {
  BASE_TOKENS_CSS,
  BASE_LAYOUT_CSS,
  googleFontsLink,
  renderHeader,
  renderFooter,
  themeToggleScript,
} from "./sharedLayout";
import { base64urlToBytes } from "../lib/activation-token";
import { getTenant } from "./onboard";
import { getUserByEmail } from "../portalDb";

/**
 * Attempt to extract the slug from a signed activation token WITHOUT
 * verifying the signature. This is a lightweight base64url decode of
 * the payload half only — no HMAC, no crypto import. Signature
 * verification still happens on POST /api/activate or
 * POST /api/activate/hosted. The slug is only used here to look up
 * the tenant type for conditional page rendering.
 *
 * Returns null if the token is malformed or the payload doesn't
 * contain a slug — the page falls back to the DNS UI in that case.
 */
function extractSlugFromToken(token: string): string | null {
  try {
    const dotIdx = token.indexOf(".");
    if (dotIdx < 1) return null;
    const payloadB64 = token.slice(0, dotIdx);
    const jsonStr = new TextDecoder().decode(base64urlToBytes(payloadB64));
    const payload = JSON.parse(jsonStr) as { slug?: string };
    return typeof payload.slug === "string" ? payload.slug : null;
  } catch {
    return null;
  }
}

export async function handleActivatePage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tokenParam = url.searchParams.get("t");
  const hasToken = typeof tokenParam === "string" && tokenParam.length > 0;

  // HTML-escape the token for safe embedding in both the hidden form field
  // and the data-token attribute. The token is already HMAC-signed base64url
  // so should only contain safe chars, but escape anyway as defense in depth.
  const escapedToken = hasToken ? escapeHtml(tokenParam!) : "";

  // Detect tenant type for conditional rendering. Cheap: one base64url
  // decode (~0ms) + one KV lookup (~1ms at edge). No signature verification.
  let isHosted = false;
  let hostedUrl = "";
  let tenantEmail = "";
  if (hasToken) {
    const slug = extractSlugFromToken(tokenParam!);
    if (slug) {
      const tenantDomain = `${slug}.hosted.advocatemcp.com`;
      const tenant = await getTenant(env, tenantDomain);
      if (tenant && tenant.skipDns === true) {
        isHosted = true;
        hostedUrl = `https://${tenantDomain}`;
        tenantEmail = tenant.email ?? "";
      }
    }
  }

  let userHasPassword = false;
  if (hasToken && isHosted && tenantEmail) {
    const existingUser = await getUserByEmail(env.DB, tenantEmail.toLowerCase().trim());
    userHasPassword = !!(existingUser && existingUser.password_hash);
  }

  // Hosted tenants stay on the Worker page — they need the password-
  // setup step (POST /api/activate/hosted), which requires inline UI
  // we only render here. Custom-domain tenants get redirected to the
  // Pages-served activate.html where the new per-variant DNS setup
  // flow lives (Phase A/B/C: per-variant cards, real-time polling,
  // provider-specific guides). Pages site URL is the marketing
  // origin (advocatemcp.com) — same Cloudflare Pages project as the
  // homepage, deployed via `wrangler pages deploy site`.
  if (!isHosted) {
    const passthrough = new URLSearchParams();
    if (hasToken) passthrough.set("t", tokenParam!);
    // Use the path without .html so we don't bounce through the
    // Pages site's automatic /activate.html → /activate 308 redirect.
    const target = `https://advocatemcp.com/activate${passthrough.toString() ? `?${passthrough.toString()}` : ""}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: target,
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(
    renderHostedPage(escapedToken, escapeHtml(hostedUrl), escapeHtml(tenantEmail), userHasPassword),
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Hosted page HTML ─────────────────────────────────────────────────────────
//
// @deprecated (May 3 2026). The hosted-tenant activation page now renders on
// the Pages site at advocatemcp.com/activate.html using the brand CSS
// (site/activate.html state-hosted + site/js/dashboard-activate.js
// renderHostedPasswordForm). worker/src/routes/portal.ts now redirects
// /activate to Pages for both hosted AND DNS tenants. This function is
// kept dormant for one release as a quick rollback path; remove in a
// follow-up after the Pages flow proves stable.

function renderHostedPage(escapedToken: string, hostedUrl: string, email: string, userHasPassword: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set your password — AdvocateMCP</title>
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme:dark)">
<meta name="theme-color" content="#f9fafb" media="(prefers-color-scheme:light)">
${googleFontsLink()}
${BASE_TOKENS_CSS}
${BASE_LAYOUT_CSS}
<style>
.wrap{max-width:640px;margin:0 auto;padding:2rem 1.5rem;flex:1;width:100%}
.state{display:none}
.state.active{display:block}
.tag{font-size:.6875rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--green3);margin-bottom:.5rem}
.h1{font-size:1.5rem;font-weight:700;letter-spacing:-.02em;margin-bottom:.75rem;color:var(--text)}
.lede{color:var(--sub);margin-bottom:1.5rem;font-size:.9375rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.5rem;margin-bottom:1rem}
.label{display:block;font-size:.8125rem;font-weight:500;color:var(--text);margin-bottom:.375rem}
.hint{font-size:.75rem;color:var(--sub);margin-top:.375rem}
.input{width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:.625rem .75rem;color:var(--text);font-family:var(--font);font-size:.9375rem;transition:border-color .15s}
.input:focus{outline:none;border-color:var(--green3)}
.input[readonly]{opacity:.7;cursor:not-allowed}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;background:var(--green);color:#fff;border:none;border-radius:6px;padding:.625rem 1.25rem;font-family:var(--font);font-size:.875rem;font-weight:500;cursor:pointer;transition:background .15s;width:100%;margin-top:1rem}
.btn:hover{background:var(--green2)}
.btn:disabled{opacity:.6;cursor:not-allowed}
.err{display:none;background:rgba(248,81,73,.08);border:1px solid rgba(248,81,73,.25);border-radius:6px;padding:.75rem .875rem;color:var(--red);font-size:.8125rem;margin-bottom:1rem;line-height:1.5}
.err.active{display:block}
.spinner{display:inline-block;width:20px;height:20px;border:2px solid var(--border2);border-top-color:var(--green3);border-radius:50%;animation:spin 0.7s linear infinite;vertical-align:middle;margin-right:.5rem}
@keyframes spin{to{transform:rotate(360deg)}}
.submitting-msg{font-size:.9375rem;color:var(--sub);display:flex;align-items:center}
.success-url{font-family:var(--mono);font-size:.875rem;color:var(--green3);word-break:break-all;margin:.75rem 0}
</style>
</head>
<body>

${renderHeader({ subtitle: "Set your password" })}

<main class="wrap" id="activate-root" data-token="${escapedToken}">

<div class="err" id="err-banner" role="alert" aria-live="polite"></div>

<!-- State H1 — Account confirm (post-May-2-2026 signups) OR password setup (legacy) -->
${userHasPassword ? `
<div class="state active" id="state-h1">
  <div class="tag">Almost there</div>
  <h1 class="h1">Confirm your email and continue</h1>
  <p class="lede">We sent this link to <strong>${email}</strong> to confirm it's you. Click below to verify your email and head to your dashboard.</p>

  <div class="card">
    <button type="button" class="btn" id="hosted-submit-btn">Confirm and go to dashboard</button>
  </div>
</div>
` : `
<div class="state active" id="state-h1">
  <div class="tag">Account setup</div>
  <h1 class="h1">Set your password</h1>
  <p class="lede">Choose a password for your AdvocateMCP dashboard. You'll use this email and password to log in.</p>

  <div class="card">
    <label class="label" for="hosted-email">Email</label>
    <input class="input" type="email" id="hosted-email" value="${email}" readonly>
    <div class="hint">This is the email you signed up with. It can't be changed here.</div>

    <label class="label" for="hosted-password" style="margin-top:1rem">Password</label>
    <input class="input" type="password" id="hosted-password" placeholder="At least 8 characters" minlength="8" required autocomplete="new-password">

    <button type="button" class="btn" id="hosted-submit-btn">Set password and continue</button>
  </div>
</div>
`}

<!-- State H2 — Submitting -->
<div class="state" id="state-h2">
  <div class="tag">Working</div>
  <h1 class="h1">Creating your account</h1>
  <div class="card">
    <div class="submitting-msg">
      <span class="spinner" aria-hidden="true"></span>
      <span>Setting up your dashboard access. Just a moment.</span>
    </div>
  </div>
</div>

<!-- State H3 — Success -->
<div class="state" id="state-h3">
  <div class="tag">You're all set</div>
  <h1 class="h1">Your account is ready</h1>
  <p class="lede">Your business is live on AI search at:</p>
  <div class="success-url" id="hosted-url-display">${hostedUrl}</div>
  <p class="lede">AI crawlers can now discover your business and recommend it to searchers. Log in to your dashboard to see traffic, analytics, and recommendations.</p>
  <a href="https://advocatemcp.com/dashboard.html" class="btn" id="go-dashboard-btn">Go to your dashboard</a>
</div>

</main>

${renderFooter()}

${themeToggleScript()}
<script>
(function(){
  var root = document.getElementById("activate-root");
  var token = root ? root.getAttribute("data-token") : "";
  if (!token) return;

  var submitBtn = document.getElementById("hosted-submit-btn");
  var errBanner = document.getElementById("err-banner");
  var passwordInput = document.getElementById("hosted-password");

  function showState(id){
    ["state-h1","state-h2","state-h3"].forEach(function(s){
      var el = document.getElementById(s);
      if (el) el.classList.toggle("active", s === id);
    });
  }

  function showError(msg){
    errBanner.textContent = msg;
    errBanner.classList.add("active");
  }

  function clearError(){
    errBanner.textContent = "";
    errBanner.classList.remove("active");
  }

  submitBtn.addEventListener("click", function(){
    clearError();
    var password = passwordInput ? (passwordInput.value || "") : "";
    // If the password input isn't on the page (post-May-2 confirm-only
    // flow), submit with an empty body — the worker's existing-user
    // branch ignores password and just flips email_verified.
    if (passwordInput && password.length < 8) {
      showError("Password must be at least 8 characters.");
      return;
    }

    submitBtn.disabled = true;
    showState("state-h2");

    fetch("/api/activate/hosted", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Activation-Token": token
      },
      body: JSON.stringify(passwordInput ? { password: password } : {})
    })
    .then(function(resp){ return resp.json().then(function(data){ return { status: resp.status, data: data }; }); })
    .then(function(r){
      submitBtn.disabled = false;
      if (r.data && r.data.ok) {
        showState("state-h3");
      } else {
        var msg = (r.data && r.data.customer_message) || "Something went wrong. Please try again, or contact support.";
        showError(msg);
        showState("state-h1");
      }
    })
    .catch(function(){
      submitBtn.disabled = false;
      showError("We couldn't reach our servers. Please check your internet connection and try again.");
      showState("state-h1");
    });
  });
})();
</script>
</body>
</html>`;
}

// ── DNS page HTML ────────────────────────────────────────────────────────────

function renderPage(hasToken: boolean, escapedToken: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Activate your domain — AdvocateMCP</title>
<meta name="description" content="Activate your domain on AdvocateMCP. Add two DNS records and you're live.">
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme:dark)">
<meta name="theme-color" content="#f9fafb" media="(prefers-color-scheme:light)">
${googleFontsLink()}
${BASE_TOKENS_CSS}
${BASE_LAYOUT_CSS}
<style>
/* ── Page-specific layout (tokens only — no hardcoded hex) ─────────────── */

.wrap{max-width:640px;margin:0 auto;padding:2rem 1.5rem;flex:1;width:100%}

.state{display:none}
.state.active{display:block}

.tag{font-size:.6875rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--green3);margin-bottom:.5rem}
.h1{font-size:1.5rem;font-weight:700;letter-spacing:-.02em;margin-bottom:.75rem;color:var(--text)}
.lede{color:var(--sub);margin-bottom:1.5rem;font-size:.9375rem}

.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.5rem;margin-bottom:1rem}

.label{display:block;font-size:.8125rem;font-weight:500;color:var(--text);margin-bottom:.375rem}
.hint{font-size:.75rem;color:var(--sub);margin-top:.375rem}

.input{width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:.625rem .75rem;color:var(--text);font-family:var(--font);font-size:.9375rem;transition:border-color .15s}
.input:focus{outline:none;border-color:var(--green3)}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;background:var(--green);color:#fff;border:none;border-radius:6px;padding:.625rem 1.25rem;font-family:var(--font);font-size:.875rem;font-weight:500;cursor:pointer;transition:background .15s;width:100%;margin-top:1rem}
.btn:hover{background:var(--green2)}
.btn:disabled{opacity:.6;cursor:not-allowed}
.btn-secondary{background:var(--bg3);color:var(--text);border:1px solid var(--border2)}
.btn-secondary:hover{background:var(--bg2);border-color:var(--sub)}

/* ── Inline error banner ─────────────────────────────────────────────── */
.err{display:none;background:rgba(248,81,73,.08);border:1px solid rgba(248,81,73,.25);border-radius:6px;padding:.75rem .875rem;color:var(--red);font-size:.8125rem;margin-bottom:1rem;line-height:1.5}
.err.active{display:block}

/* ── Submitting spinner ──────────────────────────────────────────────── */
.spinner{display:inline-block;width:20px;height:20px;border:2px solid var(--border2);border-top-color:var(--green3);border-radius:50%;animation:spin 0.7s linear infinite;vertical-align:middle;margin-right:.5rem}
@keyframes spin{to{transform:rotate(360deg)}}
.submitting-msg{font-size:.9375rem;color:var(--sub);display:flex;align-items:center}

/* ── DNS records (State 3) ───────────────────────────────────────────── */
.record{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:1rem;margin-bottom:.75rem}
.record-title{font-size:.875rem;font-weight:600;color:var(--text);margin-bottom:.75rem}
.record-row{display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;font-family:var(--mono);font-size:.8125rem}
.record-row:last-child{margin-bottom:0}
.record-key{color:var(--sub);min-width:85px;flex-shrink:0}
.record-val{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:.375rem .5rem;overflow-x:auto;white-space:nowrap;color:var(--text)}
.copy-btn{background:var(--bg2);border:1px solid var(--border2);border-radius:4px;color:var(--sub);font-family:var(--font);font-size:.6875rem;padding:.25rem .5rem;cursor:pointer;transition:all .15s;flex-shrink:0}
.copy-btn:hover{background:var(--bg3);color:var(--text);border-color:var(--sub)}
.copy-btn.copied{background:var(--green);color:#fff;border-color:var(--green)}

details.help{margin-top:1rem;padding:.75rem 1rem;background:var(--bg3);border:1px solid var(--border);border-radius:6px;font-size:.8125rem}
details.help summary{cursor:pointer;color:var(--sub);font-weight:500}
details.help summary:hover{color:var(--text)}
details.help p{color:var(--sub);margin-top:.5rem;line-height:1.6}

/* ── State 4 (pending verification) ──────────────────────────────────── */
.info-box{background:var(--blue-bg);border:1px solid var(--blue-border);border-radius:6px;padding:.875rem 1rem;color:var(--text);font-size:.8125rem;margin-top:1rem;line-height:1.5}

/* ── Footer spacing ──────────────────────────────────────────────────── */
.footer{padding:1.5rem;text-align:center;color:var(--sub);font-size:.75rem;border-top:1px solid var(--border)}
.footer a{color:var(--sub)}
.footer a:hover{color:var(--text)}
</style>
</head>
<body>

${renderHeader({ subtitle: "Activate your domain" })}

<main class="wrap" id="activate-root" data-token="${escapedToken}">

${hasToken ? renderTokenPresentStates() : renderMissingTokenState()}

</main>

${renderFooter()}

${themeToggleScript()}
${hasToken ? renderClientScript() : ""}
</body>
</html>`;
}

// ── State 0 — Missing token ──────────────────────────────────────────────────

function renderMissingTokenState(): string {
  return `<div class="state active">
  <div class="tag">Activation link required</div>
  <h1 class="h1">This page needs a valid link</h1>
  <p class="lede">This page needs a valid activation link to work. If you paid for AdvocateMCP recently, you should have received an email with your link. If you can't find it, please contact support.</p>
  <a href="mailto:max@advocate-mcp.com" class="btn">Contact support</a>
</div>`;
}

// ── States 1-4 — visible when ?t= is present ────────────────────────────────

function renderTokenPresentStates(): string {
  return `
<!-- Error banner (shown on top of State 1 when a submission fails) -->
<div class="err" id="err-banner" role="alert" aria-live="polite"></div>

<!-- State 1 — Entry form -->
<div class="state active" id="state-1">
  <div class="tag">Step 1 of 2</div>
  <h1 class="h1">Let's activate your domain</h1>
  <p class="lede">Enter the website you want AdvocateMCP to work on. We'll automatically detect where it's hosted and give you the exact DNS records to set up.</p>

  <div class="card">
    <form id="activate-form" action="/api/activate" method="POST">
      <label class="label" for="domain">Your website</label>
      <input
        class="input"
        type="text"
        id="domain"
        name="domain"
        placeholder="yourdomain.com"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        required>
      <div class="hint">You can enter it with or without https://. We'll sort it out.</div>
      <input type="hidden" name="token" value="">
      <button type="submit" class="btn" id="submit-btn">Continue</button>
    </form>
  </div>
</div>

<!-- State 2 — Submitting -->
<div class="state" id="state-2">
  <div class="tag">Working</div>
  <h1 class="h1">Setting up your domain</h1>
  <div class="card">
    <div class="submitting-msg">
      <span class="spinner" aria-hidden="true"></span>
      <span>This usually takes about ten seconds while we find your hosting and talk to Cloudflare. Don't close this tab.</span>
    </div>
  </div>
</div>

<!-- State 3 — Instructions -->
<div class="state" id="state-3">
  <div class="tag">Step 2 of 2</div>
  <h1 class="h1" id="state-3-heading">You're almost there</h1>
  <p class="lede" id="state-3-message"></p>

  <div class="record">
    <div class="record-title">1. CNAME record — routes your site's visitors</div>
    <div class="record-row">
      <div class="record-key">Type</div>
      <div class="record-val" id="cname-type">CNAME</div>
      <button type="button" class="copy-btn" data-copy-target="cname-type">Copy</button>
    </div>
    <div class="record-row">
      <div class="record-key">Host</div>
      <div class="record-val" id="cname-host"></div>
      <button type="button" class="copy-btn" data-copy-target="cname-host">Copy</button>
    </div>
    <div class="record-row">
      <div class="record-key">Points to</div>
      <div class="record-val" id="cname-target"></div>
      <button type="button" class="copy-btn" data-copy-target="cname-target">Copy</button>
    </div>
  </div>

  <div class="record" id="txt-record-wrap">
    <div class="record-title">2. TXT record — proves you own the domain</div>
    <div class="record-row">
      <div class="record-key">Type</div>
      <div class="record-val" id="txt-type">TXT</div>
      <button type="button" class="copy-btn" data-copy-target="txt-type">Copy</button>
    </div>
    <div class="record-row">
      <div class="record-key">Host</div>
      <div class="record-val" id="txt-host"></div>
      <button type="button" class="copy-btn" data-copy-target="txt-host">Copy</button>
    </div>
    <div class="record-row">
      <div class="record-key">Value</div>
      <div class="record-val" id="txt-value"></div>
      <button type="button" class="copy-btn" data-copy-target="txt-value">Copy</button>
    </div>
  </div>

  <details class="help">
    <summary>Where do I add these?</summary>
    <p>These go in your domain registrar — the service you bought your domain from. That's usually GoDaddy, Namecheap, Cloudflare, Squarespace, Google Domains, or similar. Look for a section called "DNS", "DNS Settings", or "DNS Management". Each registrar's interface is a little different, but the fields you need to fill in will be the same.</p>
  </details>

  <button type="button" class="btn" id="done-btn">I've added the records</button>
</div>

<!-- State 4 — Pending verification -->
<div class="state" id="state-4">
  <div class="tag">Records added</div>
  <h1 class="h1">Here's what happens next</h1>
  <p class="lede">DNS changes typically take 5–15 minutes to propagate across the internet. There's nothing else you need to do right now — just give it some time. You can check back on this page and refresh it to see your status.</p>

  <div class="info-box">
    We're working on an automatic email that will let you know the moment your domain is live. Until that lands, please check back here manually.
  </div>

  <button type="button" class="btn btn-secondary" id="refresh-btn">Refresh this page</button>
</div>`;
}

// ── Client script ────────────────────────────────────────────────────────────
// Vanilla JS state machine. Reads token from root element's data attribute
// (populated server-side), wires up the form submission, handles state
// transitions, and renders DNS record values into State 3 on success.

function renderClientScript(): string {
  return `<script>
(function(){
  var root = document.getElementById("activate-root");
  var token = root ? root.getAttribute("data-token") : "";
  if (!token) return;

  // Populate the hidden form field for the no-JS fallback
  var hiddenToken = document.querySelector('input[name="token"]');
  if (hiddenToken) hiddenToken.value = token;

  var form = document.getElementById("activate-form");
  var submitBtn = document.getElementById("submit-btn");
  var errBanner = document.getElementById("err-banner");
  var doneBtn = document.getElementById("done-btn");
  var refreshBtn = document.getElementById("refresh-btn");
  var domainInput = document.getElementById("domain");

  function showState(n){
    for (var i = 1; i <= 4; i++) {
      var el = document.getElementById("state-" + i);
      if (el) el.classList.toggle("active", i === n);
    }
  }

  function showError(msg){
    errBanner.textContent = msg;
    errBanner.classList.add("active");
  }

  function clearError(){
    errBanner.textContent = "";
    errBanner.classList.remove("active");
  }

  function normalizeDomain(s){
    return s.trim().toLowerCase().replace(/^https?:\\/\\//, "").replace(/\\/+$/, "").replace(/\\s+/g, "");
  }

  function isValidDomain(d){
    if (!d || d.length > 253) return false;
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d);
  }

  function renderInstructions(data){
    if (data.customer_message) {
      document.getElementById("state-3-message").textContent = data.customer_message;
    }
    var cname = data.cname_record || {};
    document.getElementById("cname-host").textContent = cname.host || "";
    document.getElementById("cname-target").textContent = cname.target || "";
    var txt = data.txt_record;
    var txtWrap = document.getElementById("txt-record-wrap");
    if (txt && txt.host && txt.value) {
      txtWrap.style.display = "";
      document.getElementById("txt-host").textContent = txt.host;
      document.getElementById("txt-value").textContent = txt.value;
    } else {
      // If TXT isn't present yet (edge case, already-exists without ownership data),
      // hide the block rather than show empty values.
      txtWrap.style.display = "none";
    }
  }

  form.addEventListener("submit", function(e){
    e.preventDefault();
    clearError();

    var raw = domainInput.value || "";
    var domain = normalizeDomain(raw);
    if (!domain) {
      showError("Please enter your website's domain to continue.");
      return;
    }
    if (!isValidDomain(domain)) {
      showError("That doesn't look like a valid domain. Please enter it like 'yourdomain.com' — just the domain, no http:// prefix, no path, no port.");
      return;
    }

    submitBtn.disabled = true;
    showState(2);

    fetch("/api/activate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Activation-Token": token
      },
      body: JSON.stringify({ domain: domain })
    })
    .then(function(resp){ return resp.json().then(function(data){ return { status: resp.status, data: data }; }); })
    .then(function(r){
      submitBtn.disabled = false;
      if (r.data && r.data.ok) {
        renderInstructions(r.data);
        showState(3);
      } else {
        var msg = (r.data && r.data.customer_message) || "Something went wrong. Please try again, or contact support if the problem keeps happening.";
        showError(msg);
        showState(1);
      }
    })
    .catch(function(){
      submitBtn.disabled = false;
      showError("We couldn't reach our servers. Please check your internet connection and try again.");
      showState(1);
    });
  });

  if (doneBtn) doneBtn.addEventListener("click", function(){ showState(4); });
  if (refreshBtn) refreshBtn.addEventListener("click", function(){ window.location.reload(); });

  // Copy-to-clipboard buttons
  document.addEventListener("click", function(e){
    var btn = e.target;
    if (!btn || btn.className.indexOf("copy-btn") < 0) return;
    var targetId = btn.getAttribute("data-copy-target");
    var el = document.getElementById(targetId);
    if (!el) return;
    var text = el.textContent || "";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){
        var original = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(function(){
          btn.textContent = original;
          btn.classList.remove("copied");
        }, 1500);
      });
    }
  });
})();
</script>`;
}
