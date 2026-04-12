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
const FROM_ADDRESS    = "AdvocateMCP <support@advocatemcp.com>";
const SEND_TIMEOUT_MS = 10_000;

// ── Email template ──────────────────────────────────────────────────────────

function buildActivationEmailHtml(activateUrl: string): string {
  // Inline styles only — no CSS classes, no external images, no JS.
  // Table-based button for email client compatibility (Gmail, Outlook,
  // Apple Mail, mobile). Brand colors: #4f98a3 accent teal, #171614
  // dark, #e8e6e3 warm off-white text.
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:40px 0">
  <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;padding:40px 36px">
      <tr><td style="font-size:14px;color:#374151;line-height:1.7">
        <div style="font-weight:700;font-size:16px;color:#111827;margin-bottom:20px">AdvocateMCP</div>
        <p style="margin:0 0 16px">Thanks for joining AdvocateMCP.</p>
        <p style="margin:0 0 24px">You're one step away from being recommended by every AI. Click below to set your password, point your domain at our worker, and start showing up in AI-generated recommendations.</p>
        <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px"><tr><td align="center" style="background:#4f98a3;border-radius:6px">
          <a href="${escAttr(activateUrl)}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none;border-radius:6px">Activate your account</a>
        </td></tr></table>
        <p style="margin:0 0 16px;font-size:13px;color:#6b7280">This link expires in 7 days. If it's expired when you click it, reply to this email and we'll send a fresh one.</p>
        <p style="margin:0;font-size:13px;color:#6b7280">Reply to this email if you need help — Cameron.</p>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#9ca3af;margin-top:16px;text-align:center">&copy; 2026 AdvocateMCP. All rights reserved.</p>
  </td></tr>
</table>
</body>
</html>`;
}

/** Escape a string for safe use inside an HTML attribute value. */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Sender ──────────────────────────────────────────────────────────────────

/**
 * Send the activation email via Resend.
 *
 * @param apiKey  Resend API key (env.RESEND_API_KEY).
 * @param to      Recipient email address.
 * @param activateUrl  The full activation URL including the signed token.
 * @returns A result object — callers check `ok` and decide what to do.
 */
export async function sendActivationEmail(
  apiKey: string,
  to: string,
  activateUrl: string,
): Promise<SendResult> {
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
        from:    FROM_ADDRESS,
        to:      [to],
        subject: "Welcome to AdvocateMCP \u2014 let\u2019s get you live",
        html:    buildActivationEmailHtml(activateUrl),
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
