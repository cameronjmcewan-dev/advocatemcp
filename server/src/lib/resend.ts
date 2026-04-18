/**
 * Resend email client for tenant-facing messages (weekly radar digest).
 *
 * Distinct from `alert.ts` — that module sends plain-text ops alerts to a
 * single operator address and never throws. This one:
 *   - accepts per-tenant `to`
 *   - supports HTML + text body
 *   - returns the Resend message id on success so callers can store it for
 *     deliverability debugging
 *   - throws typed errors so the caller can record them in the idempotency
 *     table (vs. the alert pattern which swallows everything)
 *
 * Cost: negligible at the scale we're at. Resend bills ~$0 for the first
 * 3k emails/month on the free tier.
 */

const RESEND_URL = "https://api.resend.com/emails";

export interface SendEmailInput {
  from:    string;
  to:      string;
  subject: string;
  html:    string;
  text:    string;
  replyTo?: string;
}

export interface SendEmailResult {
  id: string;
}

export class ResendError extends Error {
  public readonly status: number;
  public readonly body:   string;
  constructor(status: number, body: string) {
    super(`resend ${status}: ${body.slice(0, 200)}`);
    this.name   = "ResendError";
    this.status = status;
    this.body   = body;
  }
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from:     input.from,
      to:       [input.to],
      subject:  input.subject,
      html:     input.html,
      text:     input.text,
      reply_to: input.replyTo,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const rawBody = await res.text();
  if (!res.ok) throw new ResendError(res.status, rawBody);

  let parsed: { id?: unknown };
  try {
    parsed = JSON.parse(rawBody) as { id?: unknown };
  } catch {
    throw new Error(`resend json parse failed (status ${res.status}): ${rawBody.slice(0, 200)}`);
  }
  if (typeof parsed.id !== "string" || !parsed.id) {
    throw new Error(`resend response missing id: ${rawBody.slice(0, 200)}`);
  }
  return { id: parsed.id };
}
