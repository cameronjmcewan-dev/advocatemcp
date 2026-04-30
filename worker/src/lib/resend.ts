/**
 * Resend email client — Phase F Part 2.
 *
 * Sends transactional email via the Resend REST API. No SDK dependency
 * — just a single fetch POST with Bearer auth and a JSON body.
 *
 * Currently used only for activation emails sent by the Stripe webhook
 * after successful checkout. The email template is inline as a
 * TypeScript template literal. If more email types are added later,
 * refactor to a template registry — but one template does not justify
 * the abstraction today.
 *
 * Error handling: returns a result type rather than throwing. Callers
 * decide how to handle failures (log + continue, retry, etc). The
 * `retryable` flag distinguishes transient errors (5xx, network) from
 * permanent ones (4xx — bad email, invalid API key, etc).
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface SendResult {
  ok: boolean;
  /** Resend email ID on success. */
  id?: string;
  /** Human-readable error description on failure. */
  error?: string;
  /** true for 5xx / network / timeout errors; false for 4xx (permanent). */
  retryable: boolean;
}

// ── Constants ───────────────────────────────────────────────────────────────

const RESEND_ENDPOINT = "https://api.resend.com/emails";
// SMTP from-address must be on a Resend-verified domain. advocatemcp.com is
// already verified on the free tier; advocate-mcp.com would require a paid
// plan to add as a second sending domain. Replies route to REPLY_TO via the
// reply_to header so customers still reach the real support inbox.
const FROM_ADDRESS    = "AdvocateMCP <support@advocatemcp.com>";
const REPLY_TO        = "max@advocate-mcp.com";
const SEND_TIMEOUT_MS = 10_000;

// ── Email template ──────────────────────────────────────────────────────────
//
// Brand-themed shell — maroon hero, cream body, Instrument-Serif-style
// italic heading, maroon CTA. Locked to light theme via meta + bgcolor
// attrs so Apple Mail / Outlook in dark mode don't auto-invert the
// palette (that's what makes a brand-light email render as muddy
// teal/grey on the recipient's side).
//
// Brand tokens (kept in lockstep with /assets/styles.css on the
// marketing site):
//   --bg-cream      #fbf9f5  page background
//   --card-cream    #ffffff  inner card (lighter than bg for separation)
//   --text-ink      #141210  primary text
//   --text-muted    #766f63  secondary text + footer
//   --border-soft   #e6dfd2  card / divider lines
//   --accent-maroon #7d2550  brand accent — hero band, links, CTA
//   --accent-deeper #5a1a3a  accent darken for hover (unused in email
//                            since most clients ignore :hover anyway)
//
// Heading uses Georgia / Big Caslon as a universal serif fallback —
// Instrument Serif rarely loads in email clients, but Georgia italic
// is the closest pre-installed match across macOS / iOS / Android /
// Windows mail clients and gets us 90% of the brand vibe.

function buildDnsEmailHtml(activateUrl: string): string {
  // DNS tenant template — asks the customer to point their domain.
  return emailShell(
    "You're one step from being recommended by every AI. Activate to point your domain.",
    `
        ${emailHeading("Welcome to Advocate.")}
        <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3833">Thanks for joining. You're one step away from being recommended by every AI agent.</p>
        <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:#3d3833">Click below to set your password, point your domain at our worker, and start showing up in AI-generated recommendations.</p>
        ${emailButton(activateUrl, "Activate your account")}
        ${emailDivider()}
        ${emailFinePrint("This link expires in 7 days. If it's expired when you click it, just reply and I'll send a fresh one.")}
        ${emailSignoff("Cameron")}`,
  );
}

function buildHostedEmailHtml(activateUrl: string, hostedUrl: string): string {
  // Hosted tenant template — no domain setup, just password + dashboard.
  const safeHostedUrl = escAttr(hostedUrl);
  // Strip protocol from the display string so the link reads cleanly
  // ("advocate.hosted.advocatemcp.com" rather than "https://advocate...")
  // while the href stays fully qualified.
  const displayUrl = escAttr(hostedUrl.replace(/^https?:\/\//, ""));
  return emailShell(
    "Your business is live on AI search. Set your password to access the dashboard.",
    `
        ${emailHeading("Welcome to Advocate.")}
        <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#3d3833">Your business is live on AI search at <a href="${safeHostedUrl}" style="color:#7d2550;text-decoration:none;font-weight:600;border-bottom:1px solid #e6c5d4">${displayUrl}</a>.</p>
        <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:#3d3833">Click below to set your password and access your dashboard.</p>
        ${emailButton(activateUrl, "Set your password")}
        ${emailDivider()}
        ${emailFinePrint("This link expires in 7 days. If it's expired when you click it, just reply and I'll send a fresh one.")}
        ${emailSignoff("Cameron")}`,
  );
}

// Shared email shell — inline styles, table-based layout, brand colors.
// Locked to light theme via the color-scheme meta tags + explicit bgcolor
// attrs (some clients trust attrs over CSS in dark mode override paths).
//
// `preheader` is the snippet that shows in the inbox preview line next
// to the subject. Variant-specific (passed in by the caller) so a DNS-
// flow recipient and a hosted-flow recipient see different inbox copy
// matching what's inside.
function emailShell(preheader: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
</head>
<body bgcolor="#fbf9f5" style="margin:0;padding:0;background:#fbf9f5;color-scheme:light;supported-color-schemes:light">
<!-- Preheader (hidden in body, visible in inbox preview only) -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;line-height:0;font-size:0;color:#fbf9f5">${escAttr(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fbf9f5" style="background:#fbf9f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif">
  <tr>
    <td align="center" style="padding:32px 16px">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">
        <!-- Maroon hero band with star + wordmark -->
        <tr>
          <td align="center" bgcolor="#7d2550" style="background:#7d2550;padding:36px 32px;border-radius:12px 12px 0 0">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:14px;font-size:30px;line-height:1;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif">&#10022;</td>
                <td valign="middle" style="font-family:Georgia,'Big Caslon','Hoefler Text',serif;font-size:26px;font-style:italic;color:#ffffff;letter-spacing:-0.01em;line-height:1">Advocate</td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Card body -->
        <tr>
          <td bgcolor="#ffffff" style="background:#ffffff;padding:40px 36px;border-left:1px solid #e6dfd2;border-right:1px solid #e6dfd2;border-bottom:1px solid #e6dfd2;border-radius:0 0 12px 12px">
${bodyContent}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td align="center" style="padding:24px 16px 0">
            <p style="margin:0;font-size:11px;line-height:1.6;color:#766f63;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif">
              &copy; 2026 AdvocateMCP &middot; <a href="mailto:max@advocate-mcp.com" style="color:#766f63;text-decoration:underline">max@advocate-mcp.com</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Italic-serif heading — emulates the marketing site's Instrument Serif
 *  display look using Georgia as a universally available fallback. */
function emailHeading(text: string): string {
  return `<h1 style="margin:0 0 20px;font-family:Georgia,'Big Caslon','Hoefler Text',serif;font-style:italic;font-weight:400;font-size:28px;line-height:1.15;color:#141210;letter-spacing:-0.01em">${escAttr(text)}</h1>`;
}

/** Maroon brand button — bgcolor attr + inline style for clients that
 *  ignore one or the other. The padding sits on the <a> so the entire
 *  pill is clickable, not just the text. */
function emailButton(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 8px"><tr>
          <td align="center" bgcolor="#7d2550" style="background:#7d2550;border-radius:8px">
            <a href="${escAttr(url)}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-weight:600;font-size:15px;text-decoration:none;letter-spacing:0.01em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;border-radius:8px">${escAttr(label)}</a>
          </td>
        </tr></table>`;
}

function emailDivider(): string {
  return `<div style="height:1px;background:#e6dfd2;margin:32px 0 20px;font-size:0;line-height:0">&nbsp;</div>`;
}

function emailFinePrint(text: string): string {
  return `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#766f63">${escAttr(text)}</p>`;
}

function emailSignoff(name: string): string {
  return `<p style="margin:0;font-size:14px;line-height:1.6;color:#3d3833">— ${escAttr(name)}</p>`;
}

/** Escape a string for safe use inside an HTML attribute value. */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Sender ──────────────────────────────────────────────────────────────────

/**
 * Send the activation email via Resend.
 *
 * @param apiKey      Resend API key (env.RESEND_API_KEY).
 * @param to          Recipient email address.
 * @param activateUrl The full activation URL including the signed token.
 * @param tenantType  'hosted' or 'dns' — determines which email template.
 * @param hostedUrl   The hosted tenant URL (e.g. https://slug.hosted.advocatemcp.com).
 *                    Required when tenantType is 'hosted', ignored otherwise.
 * @returns A result object — callers check `ok` and decide what to do.
 */
export async function sendActivationEmail(
  apiKey: string,
  to: string,
  activateUrl: string,
  tenantType: "hosted" | "dns" = "dns",
  hostedUrl?: string,
): Promise<SendResult> {
  const html = tenantType === "hosted" && hostedUrl
    ? buildHostedEmailHtml(activateUrl, hostedUrl)
    : buildDnsEmailHtml(activateUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from:     FROM_ADDRESS,
        to:       [to],
        reply_to: REPLY_TO,
        subject:  "Welcome to AdvocateMCP \u2014 let\u2019s get you live",
        html,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { id?: string };
      return { ok: true, id: data.id, retryable: false };
    }

    // Parse error body for diagnostics
    let errorMsg = `Resend API ${res.status}`;
    try {
      const errBody = (await res.json()) as { message?: string; name?: string };
      if (errBody.message) errorMsg += `: ${errBody.message}`;
    } catch {
      // non-JSON error body — use the status line
    }

    return {
      ok: false,
      error: errorMsg,
      retryable: res.status >= 500,
    };
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      error: isAbort ? "Resend API timed out after 10s" : `Network error: ${String(err)}`,
      retryable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send a contact-form submission from the public marketing site to
 * max@advocate-mcp.com. Used by POST /api/contact (the Contact.html
 * form). Reply-to is set to the visitor's email so replying from the
 * inbox goes straight to them.
 *
 * All fields arrive as plain text — escape before embedding in the
 * HTML body so a hostile submission can't inject markup into our own
 * inbox. Resend accepts `text` alongside `html` for plain-text
 * fallback; we send both.
 */
const CONTACT_INBOX = "max@advocate-mcp.com";
const MAX_MESSAGE_LEN = 4000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendContactEmail(
  apiKey: string,
  visitor: { name: string; email: string; company?: string; message: string },
): Promise<SendResult> {
  const name    = visitor.name.slice(0, 200);
  const email   = visitor.email.slice(0, 200);
  const company = (visitor.company ?? "").slice(0, 200);
  const message = visitor.message.slice(0, MAX_MESSAGE_LEN);

  const subject = `New contact from ${name}${company ? ` (${company})` : ""}`;
  const text = [
    `From: ${name} <${email}>`,
    company ? `Company: ${company}` : null,
    "",
    message,
  ].filter(Boolean).join("\n");
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#141210">
      <p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
      ${company ? `<p><strong>Company:</strong> ${escapeHtml(company)}</p>` : ""}
      <hr style="border:0;border-top:1px solid #e6dfd2;margin:16px 0">
      <div style="white-space:pre-wrap">${escapeHtml(message)}</div>
    </div>
  `;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from:       FROM_ADDRESS,
        to:         [CONTACT_INBOX],
        reply_to:   email,
        subject,
        text,
        html,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { id?: string };
      return { ok: true, id: data.id, retryable: false };
    }

    let errorMsg = `Resend API ${res.status}`;
    try {
      const errBody = (await res.json()) as { message?: string };
      if (errBody.message) errorMsg += `: ${errBody.message}`;
    } catch { /* non-JSON error body */ }

    return { ok: false, error: errorMsg, retryable: res.status >= 500 };
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      error: isAbort ? "Resend API timed out after 10s" : `Network error: ${String(err)}`,
      retryable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}
