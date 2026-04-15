import type { Request } from "express";

/**
 * The HTTP header MCP-aware clients send to identify themselves to the
 * server. Lower-case canonical form (Express normalizes inbound).
 *
 * Trust note: this is a *self-assertion*. v1 uses it for prompt tuning
 * only — never for auth or rate-limit weighting. Session 11 will rank
 * trust as: OAuth client_id > header > tool arg, and weight reputation
 * accordingly. Today (Session 10) we only differentiate header (more
 * intentional) from tool arg (could be set by anyone constructing a
 * malformed payload).
 */
export const AGENT_IDENTITY_HEADER = "x-agent-identity";

/**
 * Resolve agent_id from the request, preferring the HTTP header over the
 * MCP tool argument. Whitespace-trimmed; empty strings treated as absent.
 *
 * Returns `undefined` if neither source supplies a value — callers should
 * treat undefined as "no agent identity known" and pass through to the
 * default prompt block (empty emphasis, full back-compat).
 */
export function resolveAgentId(
  req: Request,
  toolArg: string | null | undefined,
): string | undefined {
  const headerRaw = req.header(AGENT_IDENTITY_HEADER);
  const header = headerRaw?.trim();
  if (header) return header;
  const arg = toolArg?.trim();
  if (arg) return arg;
  return undefined;
}
