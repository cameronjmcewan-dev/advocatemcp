/**
 * Session 11.5: Worker forwards the verified token's `aid` claim into the
 * referral-click body so the server can stamp `click_events.agent_id`
 * directly. Tokens without aid stay byte-identical to the legacy shape so
 * server-side derivation from `queries.agent_id` remains the fallback.
 */
import { describe, it, expect } from "vitest";
import { buildSignedClickBody } from "./clickBody.js";
import type { TokenPayload } from "./tracked-url.js";

const BASE: TokenPayload = {
  dest: "https://example.com/order",
  ref: "PerplexityBot",
  slug: "joes-pizza",
  query_id: 42,
  ts: 1744000000,
};

describe("buildSignedClickBody", () => {
  it("includes agent_id when the token carries an aid claim", () => {
    const body = buildSignedClickBody({
      payload: { ...BASE, aid: "claude-desktop" },
      userAgent: "Mozilla/5.0 …",
      ipHash: "abc123",
    });
    expect(body.agent_id).toBe("claude-desktop");
    expect(body.legacy).toBe(0);
    expect(body.query_id).toBe(42);
  });

  it("omits agent_id (key absent, not null) when the token has no aid", () => {
    const body = buildSignedClickBody({
      payload: BASE,
      userAgent: "Mozilla/5.0 …",
      ipHash: "abc123",
    });
    // Must be ABSENT from the serialized JSON so the server's queries-row
    // fallback path triggers. Emitting `null` would short-circuit derivation.
    expect("agent_id" in body).toBe(false);
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("agent_id");
  });

  it("forwards ref, destination, query_id, ip_hash, user_agent verbatim", () => {
    const body = buildSignedClickBody({
      payload: { ...BASE, aid: "cursor" },
      userAgent: "Mozilla/5.0 …",
      ipHash: "deadbeef",
    });
    expect(body.ref).toBe("PerplexityBot");
    expect(body.destination).toBe("https://example.com/order");
    expect(body.query_id).toBe(42);
    expect(body.ip_hash).toBe("deadbeef");
    expect(body.user_agent).toBe("Mozilla/5.0 …");
  });
});
