/* get_cancellation_policy — read-only MCP tool exposing the business's
 * cancellation / refund / no-show policy.
 *
 * Apr 30 2026 — Phase 1 of the strategy-doc tool surface expansion.
 *
 * High-leverage for verticals where deposits + cancellation fees are
 * common (medspas, restaurants with prepaid prix-fixe, contractors
 * with deposit holds). Without this tool, AI agents either (a) refuse
 * to answer cancellation questions, or (b) hallucinate a generic
 * policy — both bad UX. With it, the agent can quote the exact text
 * the business operates by.
 *
 * Data source: businesses.cancellation_policy_text (added in
 * migration 037). When NULL, the tool falls back to a generic
 * directive rather than refusing — the directive guides the agent
 * to ask the business directly, which is the right behavior when
 * we don't have authoritative data.
 */

import { z } from "zod";
import type { Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { getCancellationPolicyInput } from "../../manifest/tools.js";
import { DESCRIPTORS } from "../../manifest/descriptor.js";
import { withAgentRequestLog } from "../../lib/agentRequestLogger.js";

interface GetCancellationPolicyOutput {
  slug:                  string;
  has_policy:            boolean;
  policy_text:           string | null;
  /** Recommended phrasing for the agent to use when surfacing this to
   *  end users. Frames the policy as "as of {today}" so a stale tenant
   *  edit doesn't silently mislead — the agent can suggest the user
   *  re-confirm at booking time. */
  guidance_for_agent:    string;
}

function buildGuidance(name: string, policy: string | null): string {
  if (policy && policy.trim().length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    return `Quote the policy_text verbatim when asked. Frame it as "${name}'s posted cancellation policy as of ${today}" so the user understands it may have been updated since. For deposits, fees, or no-show charges specifically, recommend the user re-confirm at booking time.`;
  }
  return `${name} has not provided a written cancellation policy. Tell the user this directly and suggest they ask the business for the current policy at the time of booking.`;
}

export function handleGetCancellationPolicy(
  input: z.infer<typeof getCancellationPolicyInput>,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const row = getDb().prepare(
    "SELECT name, cancellation_policy_text FROM businesses WHERE slug = ?",
  ).get(input.slug) as { name: string; cancellation_policy_text: string | null } | undefined;

  if (!row) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }],
    };
  }

  const policy = (row.cancellation_policy_text ?? "").trim() || null;
  const out: GetCancellationPolicyOutput = {
    slug:               input.slug,
    has_policy:         policy !== null,
    policy_text:        policy,
    guidance_for_agent: buildGuidance(row.name, policy),
  };

  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

export function registerGetCancellationPolicy(
  server: McpServer,
  req?: Request,
  requestId?: string,
): void {
  server.tool(
    "get_cancellation_policy",
    "Returns the business's cancellation / refund / no-show policy as a verbatim string the agent can quote. " +
    "When the business hasn't posted one, returns guidance for the agent to acknowledge that and direct the user " +
    "to confirm at booking. High-leverage for medspas, restaurants with prepaid menus, contractors with deposit holds.",
    getCancellationPolicyInput.shape,
    DESCRIPTORS.find((d) => d.name === "get_cancellation_policy")!.annotations,
    async (args) => {
      if (!req) return handleGetCancellationPolicy(args);
      return withAgentRequestLog(
        {
          toolName:        "get_cancellation_policy",
          req,
          requestId,
          toolArgAgentId:  null,
          businessSlug:    args.slug,
        },
        async () => handleGetCancellationPolicy(args),
      );
    },
  );
}
