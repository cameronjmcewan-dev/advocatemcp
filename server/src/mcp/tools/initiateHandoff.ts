import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { initiateHandoffInput } from "../../manifest/tools.js";
import { mintContinuationToken } from "../../lib/continuationToken.js";
import { sendSms, sendEmail } from "../../lib/notify.js";

function apiBase(): string {
  return process.env.API_BASE_URL ?? "https://api.advocatemcp.com";
}

function signingKey(): string {
  const k = process.env.TOKEN_SIGNING_KEY;
  if (k) return k;
  if (process.env.NODE_ENV === "production") throw new Error("TOKEN_SIGNING_KEY must be set in production");
  return "dev-insecure-key";
}

interface LeadRouting {
  preferred?: "sms" | "email";
  sms_to?: string;
  email_to?: string;
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
    let routing: LeadRouting = {};
    if (biz.lead_routing_json) {
      try {
        routing = JSON.parse(biz.lead_routing_json) as LeadRouting;
      } catch {
        /* ignore parse errors */
      }
    }
    const channel: "sms" | "email" = routing.preferred ?? "sms";

    // Guard: business has no recipient configured for the chosen channel. Return
    // a clear, machine-readable reason so the caller (agent) can react, rather
    // than letting the notify adapter fail downstream with an opaque http_* code.
    const recipient = channel === "sms" ? routing.sms_to : routing.email_to;
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
    signingKey()
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

export function registerInitiateHandoff(server: McpServer): void {
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
    async (args) => {
      // Validate and narrow using the strict discriminated union
      const validated = initiateHandoffInput.parse(args);
      return handleInitiateHandoff(validated);
    }
  );
}
