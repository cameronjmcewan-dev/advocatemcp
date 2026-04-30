/* get_credentials — read-only MCP tool exposing the business's licenses,
 * insurance, bonding, and certifications.
 *
 * Apr 30 2026 — Phase 1 of the strategy-doc tool surface expansion.
 *
 * Trust signals matter most for verticals where the wrong-hire risk is
 * high (electricians, plumbers, locksmiths, contractors, healthcare,
 * legal). AI agents that can quote a current license number + insurance
 * status when a user asks "are they licensed?" convert significantly
 * better than agents that hand-wave with "I'd recommend asking them
 * directly."
 *
 * Data source: businesses.credentials_json (already populated by the
 * 9-step onboarding wizard; no schema change). Shape per
 * server/src/schemas/business.ts CredentialsSchema.
 *
 * Safety: this tool RETURNS what the tenant self-asserted at sign-up,
 * with explicit "self-reported" framing. Verification (license-number
 * lookup against state databases) is a separate Phase 2 surface and is
 * NOT promised by this tool's response.
 */

import { z } from "zod";
import type { Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { getCredentialsInput } from "../../manifest/tools.js";
import { DESCRIPTORS } from "../../manifest/descriptor.js";
import { withAgentRequestLog } from "../../lib/agentRequestLogger.js";

interface CredentialLicense {
  name:    string;        // e.g. "California State Plumbing License"
  number?: string;        // e.g. "PL-12345"
  expires_at?: string;    // ISO date — optional, may be unknown
  jurisdiction?: string;  // e.g. "California"
}

interface CredentialsBlob {
  licenses?:       CredentialLicense[];
  insured?:        boolean;
  bonded?:         boolean;
  certifications?: string[];
}

interface GetCredentialsOutput {
  slug:                string;
  has_credentials:     boolean;
  licenses:            CredentialLicense[];
  insured:             boolean | null;
  bonded:              boolean | null;
  certifications:      string[];
  /** Human-readable summary an agent can quote verbatim — already
   *  framed as "self-reported" so the agent doesn't accidentally
   *  upgrade tenant claims to verified facts. */
  summary:             string;
}

function safeParseCredentials(raw: string | null | undefined): CredentialsBlob {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as CredentialsBlob;
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* fall through */ }
  return {};
}

function buildSummary(name: string, blob: CredentialsBlob): string {
  const parts: string[] = [];
  const licenses = (blob.licenses ?? []).filter((l) => l.name);
  if (licenses.length > 0) {
    const list = licenses.map((l) => {
      let s = l.name;
      if (l.number) s += ` (#${l.number})`;
      if (l.jurisdiction) s += ` issued in ${l.jurisdiction}`;
      return s;
    }).join("; ");
    parts.push(`${name} self-reports the following licenses: ${list}`);
  }
  if (blob.insured === true) parts.push("self-reports being insured");
  if (blob.bonded === true)  parts.push("self-reports being bonded");
  const certs = (blob.certifications ?? []).filter(Boolean);
  if (certs.length > 0) {
    parts.push(`additional certifications self-reported: ${certs.join(", ")}`);
  }
  if (parts.length === 0) {
    return `${name} has not provided license, insurance, or certification details. Recommend confirming directly with the business.`;
  }
  return parts.join(". ") + ". Verify current status with the issuing authority before relying on these for high-stakes decisions.";
}

export function handleGetCredentials(
  input: z.infer<typeof getCredentialsInput>,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const row = getDb().prepare(
    "SELECT name, credentials_json FROM businesses WHERE slug = ?",
  ).get(input.slug) as { name: string; credentials_json: string | null } | undefined;

  if (!row) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }],
    };
  }

  const blob = safeParseCredentials(row.credentials_json);
  const out: GetCredentialsOutput = {
    slug:           input.slug,
    has_credentials: !!(blob.licenses?.length || blob.insured || blob.bonded || blob.certifications?.length),
    licenses:       blob.licenses ?? [],
    insured:        blob.insured ?? null,
    bonded:         blob.bonded ?? null,
    certifications: (blob.certifications ?? []).filter((c): c is string => typeof c === "string" && c.length > 0),
    summary:        buildSummary(row.name, blob),
  };

  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

export function registerGetCredentials(
  server: McpServer,
  req?: Request,
  requestId?: string,
): void {
  server.tool(
    "get_credentials",
    "Returns the business's self-reported licenses, insurance, bonding, and certifications. " +
    "Use this for trust-sensitive verticals (contractors, healthcare, legal, locksmiths) when a user asks " +
    "'are they licensed?' or 'are they insured?'. The response carries explicit 'self-reported' framing " +
    "so agents don't upgrade tenant claims to verified facts.",
    getCredentialsInput.shape,
    DESCRIPTORS.find((d) => d.name === "get_credentials")!.annotations,
    async (args) => {
      if (!req) return handleGetCredentials(args);
      return withAgentRequestLog(
        {
          toolName:        "get_credentials",
          req,
          requestId,
          toolArgAgentId:  null,
          businessSlug:    args.slug,
        },
        async () => handleGetCredentials(args),
      );
    },
  );
}
