/**
 * Build the JSON body the Worker POSTs to the server's
 * `/analytics/:slug/referral-click` endpoint after a verified signed-token
 * redirect.
 *
 * The body shape is intentionally stable: the server has accepted the same
 * fields since Session 1, with `agent_id` (Session 11) added on the server
 * before the worker started forwarding it. Two back-compat rules:
 *
 *   1. `agent_id` MUST be omitted from the JSON when the verified token has
 *      no `aid` claim. Server-side derivation falls back to `queries.agent_id`
 *      when the field is absent — emitting `null` would defeat that fallback.
 *   2. `legacy: 0` is always set so server-side dashboards can split signed
 *      vs cleartext token traffic until the latter decays to zero.
 */
import type { TokenPayload } from "./tracked-url";

export interface ClickBody {
  ref: string;
  user_agent: string;
  ip_hash: string;
  destination: string;
  query_id: number;
  legacy: 0;
  agent_id?: string;
}

export function buildSignedClickBody(args: {
  payload: TokenPayload;
  userAgent: string;
  ipHash: string;
}): ClickBody {
  const { payload, userAgent, ipHash } = args;
  const body: ClickBody = {
    ref: payload.ref,
    user_agent: userAgent,
    ip_hash: ipHash,
    destination: payload.dest,
    query_id: payload.query_id,
    legacy: 0,
  };
  if (payload.aid !== undefined) body.agent_id = payload.aid;
  return body;
}
