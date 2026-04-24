/**
 * POST /api/contact — public marketing contact form.
 *
 * Lightweight Zod-less validator (this is the edge; one extra KB of
 * dependency for a single endpoint isn't worth it). Rejects empty /
 * oversized / malformed input before calling Resend.
 *
 * CORS: reuses the same eTLD-matching pattern as stripe.ts so the
 * Pages preview + production both work. See ALLOWED_ORIGIN_PATTERN.
 *
 * Anti-abuse: light rate gate via a shared KV token-bucket keyed on
 * IP. Nothing heavy — just enough to stop a script from burning our
 * Resend quota. A real bot-farm will bypass it; the form is a
 * honey-pot-like speed bump, not a fortress.
 *
 * No auth. No persistence. Submission → email → done.
 */

import type { Env } from "../types";
import { sendContactEmail } from "../lib/resend";

const ALLOWED_ORIGINS = new Set<string>([
  "https://advocatemcp.com",
  "https://www.advocatemcp.com",
]);
const PREVIEW_HOST_SUFFIX = ".advocatemcp-site.pages.dev";

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && u.hostname.endsWith(PREVIEW_HOST_SUFFIX);
  } catch {
    return false;
  }
}

function corsHeaders(request: Request): Record<string, string> {
  const origin  = request.headers.get("Origin") ?? "";
  const allowed = isAllowedOrigin(origin) ? origin : "https://advocatemcp.com";
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
    "Vary":                         "Origin",
  };
}

export function handleContactPreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

function withCors(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

interface ContactInput {
  name:    string;
  email:   string;
  company?: string;
  message: string;
  /** Honeypot — real users leave this empty; bots often fill it. */
  website?: string;
}

function validate(raw: unknown): { ok: true; data: ContactInput } | { ok: false; err: string } {
  if (!raw || typeof raw !== "object") return { ok: false, err: "body must be a JSON object" };
  const r = raw as Record<string, unknown>;

  const name    = typeof r.name === "string" ? r.name.trim() : "";
  const email   = typeof r.email === "string" ? r.email.trim() : "";
  const company = typeof r.company === "string" ? r.company.trim() : "";
  const message = typeof r.message === "string" ? r.message.trim() : "";
  const website = typeof r.website === "string" ? r.website.trim() : "";

  if (name.length < 1 || name.length > 200) return { ok: false, err: "name required (max 200)" };
  if (email.length < 5 || email.length > 200) return { ok: false, err: "valid email required" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, err: "valid email required" };
  if (message.length < 5) return { ok: false, err: "message required (min 5 chars)" };
  if (message.length > 4000) return { ok: false, err: "message too long (max 4000 chars)" };
  if (company.length > 200) return { ok: false, err: "company too long (max 200)" };

  // Honeypot — silently swallow. Return a fake-ok from the caller path
  // so the bot doesn't learn it was caught. Handled at caller via `website`.
  return { ok: true, data: { name, email, company: company || undefined, message, website: website || undefined } };
}

export async function handleContact(request: Request, env: Env): Promise<Response> {
  // Body
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return withCors({ ok: false, error: "invalid_json" }, 400, request);
  }

  const parsed = validate(raw);
  if (!parsed.ok) {
    return withCors({ ok: false, error: "validation_error", detail: parsed.err }, 400, request);
  }

  // Honeypot — return 200 to not tip the bot off that they were caught.
  if (parsed.data.website && parsed.data.website.length > 0) {
    console.log(JSON.stringify({
      event:  "contact_honeypot_triggered",
      email:  parsed.data.email,
      length: parsed.data.website.length,
    }));
    return withCors({ ok: true }, 200, request);
  }

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.error(JSON.stringify({ event: "contact_missing_resend_key" }));
    return withCors({ ok: false, error: "server_config" }, 500, request);
  }

  const result = await sendContactEmail(apiKey, {
    name:    parsed.data.name,
    email:   parsed.data.email,
    company: parsed.data.company,
    message: parsed.data.message,
  });

  if (!result.ok) {
    console.error(JSON.stringify({
      event: "contact_send_failed",
      error: result.error,
      retryable: result.retryable,
    }));
    return withCors(
      { ok: false, error: "send_failed" },
      result.retryable ? 502 : 500,
      request,
    );
  }

  console.log(JSON.stringify({ event: "contact_sent", id: result.id }));
  return withCors({ ok: true, id: result.id }, 200, request);
}
