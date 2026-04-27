/**
 * POST /api/support-chat — public Claude-powered support assistant for the
 * marketing site. Mounted by site/js/support-chat.js (the floating chat
 * widget on Contact.html).
 *
 * Architecture choice (worker → Anthropic, not worker → Railway → Anthropic):
 * the marketing chat doesn't need the agent helpers (cost logging, prompt
 * caching telemetry, agent_id reputation) that the tenant-facing /agents/:slug
 * stack adds. One fetch call to api.anthropic.com is plenty. Keeps the chat
 * latency budget tight (1 hop instead of 2) and avoids dragging Railway into
 * the request critical path of a public, unauthenticated endpoint.
 *
 * Anti-abuse:
 *  - CORS allowlist (advocatemcp.com + Pages preview suffix)
 *  - per-message length cap (1000 chars) and per-conversation message cap (20)
 *  - rejects empty / unparsable bodies before calling Anthropic
 *  - max_tokens capped at 600 so a runaway prompt can't burn dollars per call
 *  - Anthropic-side temperature kept low so the bot stays close to the
 *    system prompt's product copy
 *
 * Escalation: when the user asks to "talk to a human" or the bot can't
 * confidently answer, the system prompt instructs Claude to surface the
 * support email + phone + Calendly link from the marketing site copy.
 *
 * No auth, no persistence. Conversation state lives in the browser tab —
 * the frontend POSTs the full message history with each turn. v2 may
 * persist transcripts to D1 for analytics + escalation review.
 */

import type { Env } from "../types";
import { SUPPORT_CHAT_SYSTEM_PROMPT } from "../lib/supportChatPrompt";

// ── CORS (mirrors contact.ts) ─────────────────────────────────────────────────

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

function withCors(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

export function handleSupportChatPreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

// ── Validation ────────────────────────────────────────────────────────────────

interface ChatTurn {
  role:    "user" | "assistant";
  content: string;
}

const MAX_TURNS_PER_REQUEST   = 20;
const MAX_CONTENT_PER_MESSAGE = 1000;
const ANTHROPIC_MODEL         = "claude-sonnet-4-6";
const ANTHROPIC_MAX_TOKENS    = 600;
const ANTHROPIC_TEMPERATURE   = 0.4;

function validateMessages(raw: unknown): { ok: true; messages: ChatTurn[] } | { ok: false; err: string } {
  if (!raw || typeof raw !== "object") return { ok: false, err: "body must be a JSON object" };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.messages)) return { ok: false, err: "messages must be an array" };
  if (r.messages.length === 0)    return { ok: false, err: "messages cannot be empty" };
  if (r.messages.length > MAX_TURNS_PER_REQUEST) {
    return { ok: false, err: `too many messages (max ${MAX_TURNS_PER_REQUEST})` };
  }
  const out: ChatTurn[] = [];
  for (let i = 0; i < r.messages.length; i++) {
    const m = r.messages[i];
    if (!m || typeof m !== "object") return { ok: false, err: `messages[${i}] must be an object` };
    const role = (m as Record<string, unknown>).role;
    const content = (m as Record<string, unknown>).content;
    if (role !== "user" && role !== "assistant") {
      return { ok: false, err: `messages[${i}].role must be "user" or "assistant"` };
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      return { ok: false, err: `messages[${i}].content must be a non-empty string` };
    }
    if (content.length > MAX_CONTENT_PER_MESSAGE) {
      return { ok: false, err: `messages[${i}].content exceeds ${MAX_CONTENT_PER_MESSAGE} chars` };
    }
    out.push({ role, content });
  }
  // Last message must be from the user (otherwise there's nothing to respond
  // to — the frontend always appends a user turn before posting).
  const last = out[out.length - 1];
  if (last.role !== "user") return { ok: false, err: "last message must be from user" };
  return { ok: true, messages: out };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handleSupportChat(request: Request, env: Env): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    return withCors(
      { ok: false, error: "support_chat_unavailable", detail: "ANTHROPIC_API_KEY not configured" },
      503,
      request,
    );
  }

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) {
    return withCors({ ok: false, error: "invalid_content_type" }, 415, request);
  }

  let raw: unknown;
  try { raw = await request.json(); }
  catch { return withCors({ ok: false, error: "invalid_json" }, 400, request); }

  const parsed = validateMessages(raw);
  if (!parsed.ok) {
    return withCors({ ok: false, error: "validation_error", detail: parsed.err }, 400, request);
  }

  // Anthropic Messages API call. We send the full conversation each time —
  // stateless on our side, the frontend owns transcript memory.
  // cache_control: ephemeral on the system block tells Anthropic to cache
  // the (large, repeated) system prompt across turns so subsequent messages
  // in the same conversation hit the cache and bill at ~10% of base cost.
  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       ANTHROPIC_MODEL,
        max_tokens:  ANTHROPIC_MAX_TOKENS,
        temperature: ANTHROPIC_TEMPERATURE,
        system: [
          {
            type:          "text",
            text:          SUPPORT_CHAT_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: parsed.messages,
      }),
    });
  } catch (err) {
    console.warn(JSON.stringify({
      event: "support_chat_upstream_error",
      error: String(err),
    }));
    return withCors(
      { ok: false, error: "upstream_unavailable", detail: "couldn't reach the assistant" },
      502,
      request,
    );
  }

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => "<no body>");
    console.warn(JSON.stringify({
      event:        "support_chat_upstream_status",
      status:       upstream.status,
      body_preview: errBody.slice(0, 300),
    }));
    return withCors(
      { ok: false, error: "upstream_error", status: upstream.status },
      502,
      request,
    );
  }

  const data = await upstream.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?:   { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };

  // Extract first text block (Claude returns content[] of typed parts; for
  // a single-message reply we expect one text part. Defensive concat in
  // case Anthropic ever splits a response across multiple text parts).
  const text = (data.content ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();

  if (!text) {
    return withCors(
      { ok: false, error: "empty_response" },
      502,
      request,
    );
  }

  console.log(JSON.stringify({
    event:        "support_chat_ok",
    latency_ms:   Date.now() - startedAt,
    in_tokens:    data.usage?.input_tokens ?? null,
    out_tokens:   data.usage?.output_tokens ?? null,
    cached_in:    data.usage?.cache_read_input_tokens ?? null,
    user_msg_len: parsed.messages[parsed.messages.length - 1].content.length,
    turns:        parsed.messages.length,
  }));

  return withCors({ ok: true, message: text }, 200, request);
}
