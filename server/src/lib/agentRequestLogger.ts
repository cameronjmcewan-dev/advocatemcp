import type { Request } from "express";
import { resolveAgentId, AGENT_IDENTITY_HEADER } from "./agentIdentity.js";
import { getDb } from "../db.js";
import {
  insertAgentRequest,
  type AgentIdSource,
  type OutcomeSignal,
} from "../repos/agentRequests.js";

export interface LogContext {
  toolName: string;
  req: Request;
  requestId?: string | null;
  toolArgAgentId?: string | null;
  businessSlug?: string | null;
  /**
   * Optional callback invoked with the inserted row id, so callers can
   * later setOutcome(id, ...) once async outcome data lands (e.g. the
   * reservation_id returned by reserve_slot). Not invoked when skipped.
   */
  onLogged?: (id: string) => void;
}

/**
 * Wrap an MCP tool handler. On success: writes one agent_requests row with
 * outcome_signal='none' and latency_ms measured. On throw: writes outcome
 * 'error' and re-throws. Skips writing entirely when no agent identity is
 * available — anonymous calls would pollute the per-agent rollup.
 *
 * Source ranking mirrors Session 10: header > tool_arg. The 'oauth' and
 * 'inferred' sources are reserved for future use (master plan §11).
 */
export async function withAgentRequestLog<T>(
  ctx: LogContext,
  handler: () => Promise<T>,
): Promise<T> {
  const headerAgent = ctx.req.header(AGENT_IDENTITY_HEADER)?.trim();
  const argAgent = ctx.toolArgAgentId?.trim();
  const agentId = resolveAgentId(ctx.req, ctx.toolArgAgentId ?? undefined);

  // No identity = no audit row. agent_id_source='inferred' is reserved for a
  // future signal (e.g. UA fingerprint) that we do not synthesise today.
  if (!agentId) return handler();

  const source: AgentIdSource = headerAgent
    ? "header"
    : argAgent
      ? "tool_arg"
      : "header"; // unreachable: agentId truthy implies one of the above
  const db = getDb();
  const start = Date.now();

  try {
    const result = await handler();
    const id = insertAgentRequest(db, {
      agentId,
      agentIdSource: source,
      businessSlug: ctx.businessSlug ?? null,
      toolCalled: ctx.toolName,
      requestId: ctx.requestId ?? null,
      latencyMs: Date.now() - start,
      costCents: 0, // v1: cost stamping deferred — manifest static estimate is the proxy
      outcomeSignal: "none",
    });
    if (ctx.onLogged) ctx.onLogged(id);
    return result;
  } catch (err) {
    const outcome: OutcomeSignal = "error";
    const id = insertAgentRequest(db, {
      agentId,
      agentIdSource: source,
      businessSlug: ctx.businessSlug ?? null,
      toolCalled: ctx.toolName,
      requestId: ctx.requestId ?? null,
      latencyMs: Date.now() - start,
      costCents: 0,
      outcomeSignal: outcome,
    });
    if (ctx.onLogged) ctx.onLogged(id);
    throw err;
  }
}
