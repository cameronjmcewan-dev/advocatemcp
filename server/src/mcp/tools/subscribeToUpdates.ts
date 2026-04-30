/* subscribe_to_updates — opt-in MCP tool for "let me know when X happens".
 *
 * Apr 30 2026 — Phase 1 of the strategy-doc tool surface expansion.
 *
 * v1 scope (this PR):
 *   - Persist a subscriptions row with status='pending'
 *   - Mint an HMAC-signed confirmation_token (slug + sub_id + exp)
 *   - Return the confirmation_token + a confirm URL
 *   - Email dispatch (the "click here to confirm your subscription"
 *     message) is NOT shipped here — it's queued by writing the row
 *     and the v2 follow-up will add the cron-driven send + the
 *     /confirm-subscription endpoint.
 *
 * Why this is still useful at v1:
 *   - The agent can return the confirmation URL inline — most
 *     responsible AI agents will surface it as "we've set up your
 *     subscription, click here to confirm" rather than auto-confirm.
 *   - Tenant dashboards can already render the pending list, so the
 *     surface is observable from day one.
 *   - The audit-log row is created so downstream attribution sees
 *     the agent_id that captured the lead.
 *
 * Compliance posture: opt-in confirmation is the explicit design
 * (CAN-SPAM + GDPR). No auto-activation. The token expires after
 * 7 days; unconfirmed subscriptions are pruned by a separate cron
 * (also v2 follow-up).
 */

import { z } from "zod";
import type { Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID, createHmac } from "crypto";
import { getDb } from "../../db.js";
import { subscribeToUpdatesInput } from "../../manifest/tools.js";
import { DESCRIPTORS } from "../../manifest/descriptor.js";
import { withAgentRequestLog } from "../../lib/agentRequestLogger.js";
import { getApiBaseUrl } from "../../lib/baseUrl.js";

const TOKEN_TTL_SECONDS = 7 * 24 * 3600;

interface SubscribeOutput {
  subscription_id:    string;
  status:             "pending" | "already_subscribed";
  confirmation_token: string;
  confirmation_url:   string;
  expires_at:         number;          // Unix seconds
  topics:             string[];
  acknowledgment:     string;          // human-readable line for the agent to quote
}

/* HMAC-signed confirmation token — same shape as
 * worker/src/lib/activation-token.ts but keyed off TOKEN_SIGNING_KEY
 * (which the worker also has, via env.TOKEN_SIGNING_KEY) so the
 * confirmation endpoint can verify without a Railway round-trip when
 * the worker handles /confirm-subscription in the v2 follow-up.
 *
 * For v1 the token is opaque — the agent gets it back, the user
 * clicks the URL, the (future) endpoint validates HMAC + flips
 * status. Shape: base64url(JSON({sub_id, slug, email, exp})) +
 * '.' + base64url(HMAC-SHA256(payload)).
 */
function signConfirmationToken(args: {
  sub_id: string;
  slug:   string;
  email:  string;
}): { token: string; expiresAt: number } {
  const secret = process.env.TOKEN_SIGNING_KEY;
  if (!secret) {
    // Without the signing key we can't mint a verifiable token. Return
    // a placeholder + log; the row is still useful for tenant audit but
    // the user won't be able to confirm until the secret is set.
    console.warn(JSON.stringify({
      subscribe_to_updates: true,
      event: "no_token_signing_key",
      slug: args.slug,
    }));
    const now = Math.floor(Date.now() / 1000);
    return { token: `unsigned-${args.sub_id}`, expiresAt: now + TOKEN_TTL_SECONDS };
  }
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = Buffer.from(
    JSON.stringify({ sub_id: args.sub_id, slug: args.slug, email: args.email, exp }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, expiresAt: exp };
}

function normalizedTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of topics) {
    const norm = t.trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

export function handleSubscribeToUpdates(
  input: z.infer<typeof subscribeToUpdatesInput>,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const db = getDb();

  const biz = db.prepare(
    "SELECT slug, name FROM businesses WHERE slug = ?",
  ).get(input.slug) as { slug: string; name: string } | undefined;
  if (!biz) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }],
    };
  }

  const topics = normalizedTopics(input.topics);
  if (topics.length === 0) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "no_valid_topics" }) }],
    };
  }

  const email = input.contact_email.trim().toLowerCase();

  // Look up an existing subscription for this (slug, email). UNIQUE
  // constraint at the table level means we only ever have one, but
  // we read first so we can return idempotency-friendly output.
  const existing = db.prepare(
    "SELECT id, status, topics, confirmation_token FROM subscriptions WHERE business_slug = ? AND contact_email = ?",
  ).get(input.slug, email) as { id: string; status: string; topics: string; confirmation_token: string } | undefined;

  if (existing && existing.status === "confirmed") {
    // Already opted-in. Re-subscribe = topic merge with no token re-mint
    // (token only matters during the pending → confirmed flip).
    const merged = Array.from(new Set([
      ...(existing.topics?.split(",").map((t) => t.trim()).filter(Boolean) ?? []),
      ...topics,
    ]));
    db.prepare("UPDATE subscriptions SET topics = ? WHERE id = ?").run(merged.join(","), existing.id);
    const out: SubscribeOutput = {
      subscription_id:    existing.id,
      status:             "already_subscribed",
      confirmation_token: existing.confirmation_token,
      confirmation_url:   "",
      expires_at:         0,
      topics:             merged,
      acknowledgment:     `${email} is already subscribed to updates from ${biz.name}. Topics updated to: ${merged.join(", ")}.`,
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }

  // Pending OR new. Mint a fresh token + UPSERT the row.
  const sub_id = `sub_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const { token, expiresAt } = signConfirmationToken({
    sub_id,
    slug: input.slug,
    email,
  });

  if (existing) {
    // Existing pending row — refresh the token + topics; status stays
    // pending until the user clicks confirm.
    db.prepare(`
      UPDATE subscriptions
         SET topics = ?, confirmation_token = ?, agent_id = COALESCE(?, agent_id)
       WHERE id = ?
    `).run(topics.join(","), token, input.agent_id ?? null, existing.id);
    var resolvedSubId = existing.id;
  } else {
    db.prepare(`
      INSERT INTO subscriptions (
        id, business_slug, agent_id, contact_email, topics,
        status, confirmation_token
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(sub_id, input.slug, input.agent_id ?? null, email, topics.join(","), token);
    var resolvedSubId = sub_id;
  }

  // Build the confirmation URL pointing at the worker's (future)
  // /confirm-subscription endpoint. v1: the URL is recorded; agent
  // surfaces it; user click is a no-op until v2 wires the handler.
  // Worker + server share API_BASE_URL via env so the URL is
  // consistent.
  const base = getApiBaseUrl();
  const confirmationUrl = `${base.replace(/\/$/, "")}/api/subscribe/confirm?t=${encodeURIComponent(token)}`;

  const out: SubscribeOutput = {
    subscription_id:    resolvedSubId,
    status:             "pending",
    confirmation_token: token,
    confirmation_url:   confirmationUrl,
    expires_at:         expiresAt,
    topics,
    acknowledgment:     `Subscription pending confirmation. Direct the user to click ${confirmationUrl} within 7 days to start receiving updates from ${biz.name} on: ${topics.join(", ")}.`,
  };
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

export function registerSubscribeToUpdates(
  server: McpServer,
  req?: Request,
  requestId?: string,
): void {
  server.tool(
    "subscribe_to_updates",
    "Subscribe an end-user's email to topical updates from a business (deals, schedule changes, new services). " +
    "Returns a confirmation_token + confirmation_url; the user MUST click the URL within 7 days to activate. " +
    "Re-subscribing an already-confirmed email merges topics without re-confirming.",
    subscribeToUpdatesInput.shape,
    DESCRIPTORS.find((d) => d.name === "subscribe_to_updates")!.annotations,
    async (args) => {
      if (!req) return handleSubscribeToUpdates(args);
      return withAgentRequestLog(
        {
          toolName:        "subscribe_to_updates",
          req,
          requestId,
          toolArgAgentId:  args.agent_id ?? null,
          businessSlug:    args.slug,
        },
        async () => handleSubscribeToUpdates(args),
      );
    },
  );
}
