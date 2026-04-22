import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { initiateHandoffInput } from "../../manifest/tools.js";
import { DESCRIPTORS } from "../../manifest/descriptor.js";
import { mintContinuationToken, getSigningKey } from "../../lib/continuationToken.js";
import { sendSms, sendEmail } from "../../lib/notify.js";
import { withAgentRequestLog } from "../../lib/agentRequestLogger.js";
import { getApiBaseUrl } from "../../lib/baseUrl.js";

function apiBase(): string {
  return getApiBaseUrl();
}

/**
 * Two shapes exist on-disk:
 *
 *   Wizard / onboarding (canonical, written by /register):
 *     { preferred_channel: "phone"|"text"|"email"|"form",
 *       phone?, email?, form_url? }
 *
 *   Legacy (early prototypes, plus a handful of hand-written rows):
 *     { preferred: "sms"|"email", sms_to?, email_to? }
 *
 * resolveRouting() normalises either into a dispatch decision. "phone" and
 * "text" both map to SMS-to-phone because we can't place an automated voice
 * call — the onboarding distinction between "prefers a call" vs "prefers a
 * text" collapses at delivery time. "form" is a non-deliverable routing
 * preference — we surface the form_url so the agent can redirect the user
 * there rather than silently falling through to email or SMS.
 */
interface LeadRoutingNew {
  preferred_channel?: "phone" | "text" | "email" | "form";
  phone?: string;
  email?: string;
  form_url?: string;
}
interface LeadRoutingLegacy {
  preferred?: "sms" | "email";
  sms_to?: string;
  email_to?: string;
}
type LeadRoutingAny = LeadRoutingNew & LeadRoutingLegacy;

type RoutingDecision =
  | { kind: "sms";   recipient: string | null }
  | { kind: "email"; recipient: string | null }
  | { kind: "form";  form_url: string | null };

function resolveRouting(routing: LeadRoutingAny): RoutingDecision {
  // New-shape takes precedence when present.
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
  // Legacy fallback. Default channel was "sms" when unspecified.
  const legacyChannel = routing.preferred ?? "sms";
  if (legacyChannel === "email") {
    return { kind: "email", recipient: routing.email_to ?? routing.email ?? null };
  }
  return { kind: "sms", recipient: routing.sms_to ?? routing.phone ?? null };
}

export async function handleInitiateHandoff(
  input: z.infer<typeof initiateHandoffInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const db = getDb();
  const biz = db
    .prepare(`SELECT slug, lead_routing_json FROM businesses WHERE slug = ?`)
    .get(input.slug) as { slug: string; lead_routing_json: string | null } | undefined;
  if (!biz) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "business_not_found" }) }] };
  }

  const handoff_id = `h_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

  if (input.mode === "human") {
    let routing: LeadRoutingAny = {};
    if (biz.lead_routing_json) {
      try {
        routing = JSON.parse(biz.lead_routing_json) as LeadRoutingAny;
      } catch {
        /* ignore parse errors */
      }
    }
    const decision = resolveRouting(routing);

    // Form-preferred routing: non-deliverable via SMS/email. Return the form
    // URL so the agent can redirect the user rather than silently retrying a
    // channel the tenant didn't opt into.
    if (decision.kind === "form") {
      // delivered_via is CHECK-constrained to sms|email|NULL. Form routing
      // isn't a delivery channel, so we write NULL — the audit row still
      // captures the attempt for observability.
      db.prepare(`
        INSERT INTO handoffs (id, business_slug, reservation_id, mode, delivered_via, ticket_id, agent_id)
        VALUES (?, ?, ?, 'human', NULL, ?, ?)
      `).run(handoff_id, input.slug, input.reservation_id ?? null, handoff_id, null);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mode: "human",
              delivered: false,
              reason: "form_routing_configured",
              channel: "form",
              form_url: decision.form_url,
              handoff_id,
            }),
          },
        ],
      };
    }

    const channel: "sms" | "email" = decision.kind;
    const recipient = decision.recipient;

    // Guard: business has no recipient configured for the chosen channel. Return
    // a clear, machine-readable reason so the caller (agent) can react, rather
    // than letting the notify adapter fail downstream with an opaque http_* code.
    if (!recipient) {
      db.prepare(`
        INSERT INTO handoffs (id, business_slug, reservation_id, mode, delivered_via, ticket_id, agent_id)
        VALUES (?, ?, ?, 'human', ?, ?, ?)
      `).run(handoff_id, input.slug, input.reservation_id ?? null, channel, handoff_id, null);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mode: "human",
              delivered: false,
              reason: "no_recipient_configured",
              channel,
              handoff_id,
            }),
          },
        ],
      };
    }

    const notifyRes = channel === "sms"
      ? await sendSms({ to: recipient, body: input.payload.message })
      : await sendEmail({ to: recipient, subject: "New lead", body: input.payload.message });

    db.prepare(`
      INSERT INTO handoffs (id, business_slug, reservation_id, mode, delivered_via, ticket_id, agent_id)
      VALUES (?, ?, ?, 'human', ?, ?, ?)
    `).run(handoff_id, input.slug, input.reservation_id ?? null, channel, notifyRes.ticket_id ?? handoff_id, null);

    if (notifyRes.delivered) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mode: "human",
              delivered_via: channel,
              ticket_id: notifyRes.ticket_id ?? handoff_id,
            }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "human",
            delivered: false,
            reason: notifyRes.reason,
            handoff_id,
          }),
        },
      ],
    };
  }

  // agent mode
  const token = mintContinuationToken(
    { ticket: handoff_id, business_slug: input.slug, scope: "continue" },
    getSigningKey()
  );
  const continuation_url = `${apiBase()}/a2a/continue/${token}`;
  const expires_at = Math.floor(Date.now() / 1000) + 3600;

  db.prepare(`
    INSERT INTO handoffs (id, business_slug, reservation_id, mode, continuation_url, handshake_token, agent_id)
    VALUES (?, ?, ?, 'agent', ?, ?, ?)
  `).run(handoff_id, input.slug, input.reservation_id ?? null, continuation_url, token, null);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          mode: "agent",
          continuation_url,
          expires_at,
          handshake_token: token,
        }),
      },
    ],
  };
}

export function registerInitiateHandoff(
  server: McpServer,
  req?: Request,
  requestId?: string,
): void {
  // The discriminated union doesn't have a .shape property, so we wrap it in a
  // z.object() schema that the MCP SDK can understand, but parse internally
  // with the stricter discriminated union for validation.
  const wrapper = z.object({
    slug: z.string().min(1),
    reservation_id: z.string().optional(),
    mode: z.enum(["human", "agent"]),
    payload: z.record(z.unknown()),
  });

  server.tool(
    "initiate_handoff",
    "Begin a handoff from the agent to either a human operator (SMS/email via lead_routing_json) or another agent (signed continuation URL).",
    wrapper.shape,
    DESCRIPTORS.find((d) => d.name === "initiate_handoff")!.annotations,
    async (args) => {
      const run = async () => {
        // Validate and narrow using the strict discriminated union
        const validated = initiateHandoffInput.parse(args);
        return handleInitiateHandoff(validated);
      };
      if (!req) return run();
      const slug =
        typeof (args as { slug?: unknown }).slug === "string"
          ? ((args as { slug: string }).slug)
          : null;
      return withAgentRequestLog(
        {
          toolName: "initiate_handoff",
          req,
          requestId,
          toolArgAgentId: null,
          businessSlug: slug,
        },
        run,
      );
    }
  );
}
