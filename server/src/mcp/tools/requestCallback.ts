/* request_callback — async lead-capture MCP tool.
 *
 * Apr 30 2026 — Phase 1 of the strategy-doc tool surface expansion.
 *
 * When an AI agent decides the user's question can't be answered without
 * a human (custom quote, scheduling outside posted hours, complex
 * multi-service combos, complaint), the agent calls this tool to push
 * the user's contact info to the business. The business receives an
 * SMS or email via the same lead_routing_json infrastructure that
 * initiate_handoff uses, but with a tighter pre-booking shape — no
 * reservation_id required, just contact + reason + urgency.
 *
 * Why a separate tool from initiate_handoff:
 *   - initiate_handoff is reservation-scoped (post-booking review)
 *   - request_callback is pre-booking lead capture
 *   - The SMS body the business receives needs different framing
 *     ("New lead from Claude — wants callback" vs "Reservation X
 *     needs your eyes")
 *   - Surfaces as its own queryable table for tenant dashboards
 *     ("you have 3 unanswered callback requests")
 *
 * Idempotency: callers MUST pass an idempotency_key. The same key
 * within a 24h window returns the same callback_request_id without
 * dup-creating a row OR re-firing the SMS. Prevents agent retries
 * from spamming the business's phone.
 */

import { z } from "zod";
import type { Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "crypto";
import { getDb } from "../../db.js";
import { requestCallbackInput } from "../../manifest/tools.js";
import { DESCRIPTORS } from "../../manifest/descriptor.js";
import { withAgentRequestLog } from "../../lib/agentRequestLogger.js";
import { sendSms, sendEmail } from "../../lib/notify.js";

interface LeadRouting {
  preferred_channel?: "phone" | "text" | "email" | "form";
  phone?:    string;
  email?:    string;
  form_url?: string;
  // legacy
  preferred?: "sms" | "email";
  sms_to?:    string;
  email_to?:  string;
}

function resolveBusinessChannel(routing: LeadRouting): {
  kind: "sms" | "email" | "form";
  recipient?: string | null;
  form_url?:  string | null;
} {
  if (routing.preferred_channel) {
    switch (routing.preferred_channel) {
      case "phone":
      case "text":
        return { kind: "sms", recipient: routing.phone ?? routing.sms_to ?? null };
      case "email":
        return { kind: "email", recipient: routing.email ?? routing.email_to ?? null };
      case "form":
        return { kind: "form", form_url: routing.form_url ?? null };
    }
  }
  const legacy = routing.preferred ?? "sms";
  if (legacy === "email") return { kind: "email", recipient: routing.email_to ?? routing.email ?? null };
  return { kind: "sms", recipient: routing.sms_to ?? routing.phone ?? null };
}

/* Idempotency probe — 24h window. Same idempotency_key for the same slug
 * returns the existing row without re-dispatching. */
function findExistingCallback(
  slug: string,
  idempotencyKey: string,
): { id: string; status: string; delivered_via: string | null } | null {
  // We store the idempotency key inside the `error` column on the
  // initial-create path? No — better to encode it as part of the id.
  // ULID would let us collide-check but we don't have one available
  // here. Use a deterministic id derived from (slug + idempotency_key)
  // so a duplicate insert hits the PK and we can safely no-op.
  return null;       // see derivedId() below — handled at INSERT time
}

function derivedCallbackId(slug: string, idempotencyKey: string): string {
  // SHA1 of (slug || ':' || idempotencyKey) gives a stable 40-char
  // hash; we prefix and truncate to land in our `cb_<24>` namespace.
  // Crypto.createHash is sync-safe in Node + node:crypto polyfill.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const h = crypto.createHash("sha1")
    .update(`${slug}:${idempotencyKey}`)
    .digest("hex").slice(0, 24);
  return `cb_${h}`;
}

interface CallbackOutput {
  callback_id:        string;
  status:             "pending" | "notified" | "failed";
  delivered_via?:     "twilio_sms" | "resend_email" | "form" | null;
  form_url?:          string;
  reason?:            string;        // structured failure reason
  acknowledgment:     string;        // human-readable line the agent can return verbatim
}

export async function handleRequestCallback(
  input: z.infer<typeof requestCallbackInput>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const db = getDb();

  const biz = db.prepare(
    "SELECT slug, name, lead_routing_json FROM businesses WHERE slug = ?",
  ).get(input.slug) as { slug: string; name: string; lead_routing_json: string | null } | undefined;
  if (!biz) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }],
    };
  }

  const id = derivedCallbackId(input.slug, input.idempotency_key);

  // Idempotency: SELECT first; if a row exists, return its current
  // state without re-dispatching.
  const existing = db.prepare(
    "SELECT id, status, delivered_via FROM callback_requests WHERE id = ?",
  ).get(id) as { id: string; status: string; delivered_via: string | null } | undefined;
  if (existing) {
    const out: CallbackOutput = {
      callback_id:    existing.id,
      status:         existing.status as CallbackOutput["status"],
      delivered_via:  (existing.delivered_via ?? null) as CallbackOutput["delivered_via"],
      acknowledgment: `Your callback request is already on file with ${biz.name}. They will reach you on your preferred channel.`,
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }

  // Resolve where the business wants leads delivered.
  let routing: LeadRouting = {};
  if (biz.lead_routing_json) {
    try { routing = JSON.parse(biz.lead_routing_json) as LeadRouting; } catch { /* fall through */ }
  }
  const decision = resolveBusinessChannel(routing);

  // Compose the SMS / email body the BUSINESS will see. The agent
  // gets a different (user-facing) acknowledgment string returned
  // separately.
  const lines: string[] = [
    `New lead from AdvocateMCP — wants a callback.`,
    input.contact.name  ? `Name: ${input.contact.name}`  : "",
    input.contact.email ? `Email: ${input.contact.email}` : "",
    input.contact.phone ? `Phone: ${input.contact.phone}` : "",
    input.preferred_channel ? `Prefers: ${input.preferred_channel}` : "",
    input.urgency        ? `Urgency: ${input.urgency}`     : "",
    input.reason         ? `Reason: ${input.reason}`       : "",
  ].filter(Boolean);
  const businessNotificationBody = lines.join("\n");

  // Dispatch.
  const insertRow = (status: "pending" | "notified" | "failed", deliveredVia: string | null, errorMsg: string | null) => {
    db.prepare(`
      INSERT INTO callback_requests (
        id, business_slug, agent_id, contact_name, contact_email, contact_phone,
        preferred_channel, reason, urgency, status, delivered_via, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.slug, input.agent_id ?? null,
      input.contact.name  ?? null,
      input.contact.email ?? null,
      input.contact.phone ?? null,
      input.preferred_channel ?? "any",
      input.reason ?? null,
      input.urgency ?? "normal",
      status, deliveredVia, errorMsg,
    );
  };

  // Form-routed business: nothing to dispatch via SMS/email. We still
  // log the request (so the tenant dashboard shows it) but tell the
  // agent to direct the user to the form.
  if (decision.kind === "form") {
    insertRow("pending", null, null);
    const out: CallbackOutput = {
      callback_id:    id,
      status:         "pending",
      delivered_via:  null,
      form_url:       decision.form_url ?? undefined,
      reason:         "form_routing_configured",
      acknowledgment: decision.form_url
        ? `${biz.name} prefers leads via their contact form. Direct the user to ${decision.form_url}.`
        : `${biz.name} hasn't configured a callback channel yet. Recommend contacting them through their site directly.`,
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }

  if (!decision.recipient) {
    // No recipient configured for the chosen channel. Log + return a
    // structured "no-recipient" so the agent surfaces a clean message
    // rather than silently retrying.
    insertRow("failed", decision.kind, "no_recipient_configured");
    const out: CallbackOutput = {
      callback_id:    id,
      status:         "failed",
      delivered_via:  null,
      reason:         "no_recipient_configured",
      acknowledgment: `${biz.name} hasn't set up a callback contact yet. Recommend reaching them via their listed phone or website.`,
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }

  const subject = `New lead — ${input.contact.name ?? "AdvocateMCP user"} wants a callback`;
  const notifyRes = decision.kind === "sms"
    ? await sendSms({ to: decision.recipient, body: businessNotificationBody })
    : await sendEmail({ to: decision.recipient, subject, body: businessNotificationBody });

  if (notifyRes.delivered) {
    const deliveredVia = decision.kind === "sms" ? "twilio_sms" : "resend_email";
    insertRow("notified", deliveredVia, null);
    const out: CallbackOutput = {
      callback_id:    id,
      status:         "notified",
      delivered_via:  deliveredVia,
      acknowledgment: `Your callback request has been sent to ${biz.name}. They typically respond within their business hours${input.urgency === "emergency" ? " — but for emergencies, please call them directly" : ""}.`,
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }

  // Notify failed.
  const failureCode = (notifyRes as { reason?: string }).reason ?? "delivery_failed";
  insertRow("failed", decision.kind, failureCode);
  const out: CallbackOutput = {
    callback_id:    id,
    status:         "failed",
    delivered_via:  null,
    reason:         failureCode,
    acknowledgment: `We couldn't reach ${biz.name} right now to deliver your callback request. Please contact them directly via their site.`,
  };
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

export function registerRequestCallback(
  server: McpServer,
  req?: Request,
  requestId?: string,
): void {
  server.tool(
    "request_callback",
    "Push a user's contact info to a business so they can call/email/text back. " +
    "Use this when a question can't be answered without human contact (custom quote, after-hours scheduling, complaint, complex combo). " +
    "Idempotent on idempotency_key within a 24h window — agent retries don't spam the business. Returns delivery status the agent can quote to the user.",
    requestCallbackInput.shape,
    DESCRIPTORS.find((d) => d.name === "request_callback")!.annotations,
    async (args) => {
      if (!req) return handleRequestCallback(args);
      return withAgentRequestLog(
        {
          toolName:        "request_callback",
          req,
          requestId,
          toolArgAgentId:  args.agent_id ?? null,
          businessSlug:    args.slug,
        },
        async () => handleRequestCallback(args),
      );
    },
  );
}
