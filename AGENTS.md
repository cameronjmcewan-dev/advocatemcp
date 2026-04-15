# AGENTS.md — AdvocateMCP discovery for agent frameworks

AdvocateMCP publishes an A2A-native discovery manifest so any agent framework
can introspect the full capability surface — tools, input schemas, transports,
rate limits, auth modes, and attribution endpoint — from a single HTTP GET.

## The two discovery surfaces

1. **Canonical manifest** — `GET https://api.advocatemcp.com/.well-known/mcp.json`

   Static JSON built at boot from a typed descriptor registry. Contains:
   - `spec_version` — date-versioned schema revision.
   - `agent_id` — always `advocatemcp-central` for the main MCP server.
   - `protocol_versions[]` — array (not string) because the MCP spec is
     still moving; clients should pick the highest one they support.
   - `transports[]` — `{kind: "http" | "sse", url}`. Both kinds point at
     the same `/mcp` URL; Streamable HTTP handles both.
   - `tools[]` — each has `name`, `description`, `input_schema` (JSON
     Schema), `output_schema`, `idempotent`, `estimated_latency_ms`,
     `estimated_cost_cents`.
   - `rate_limits` — sourced live from the rate-limit middleware config
     (`server/src/middleware/rateLimit.ts`). Never hardcoded.
   - `auth_model.modes[]` — currently `["open", "api_key"]`.
   - `attribution_endpoint` — `/track` on the worker; every referral flows
     through this signed-token redirect.

2. **MCP `initialize` response** — embedded at `result._meta.advocatemcp`

   Clients that never make a second HTTP hop still get the manifest summary
   on the very first `initialize` round-trip. Safe: clients that don't
   understand `_meta` ignore it.

## The tenant mirror

Each registered tenant's `/.well-known/ai-agent.json` (served by the
Cloudflare Worker) now carries two discovery-pointer fields:

- `agent_id` — the tenant's business slug (or `null` for an unknown domain).
- `manifest_url` — points at the central `/.well-known/mcp.json`.

This lets a crawler on a tenant domain follow one hop to the full capability
manifest without us having to replicate the manifest per tenant.

## For contributors adding a tool (Session 9+)

1. Add the tool's zod input shape to `server/src/manifest/tools.ts`.
2. Register it with `server.tool(...)` in `server/src/routes/mcp.ts`,
   passing `<yourShape>.shape` — don't declare inline.
3. Add a `ToolDescriptor` entry to `DESCRIPTORS` in
   `server/src/manifest/descriptor.ts` with an `outputSchema`,
   `estimated_latency_ms`, `estimated_cost_cents`, and `idempotent` flag.
4. Run `cd server && npx vitest run src/manifest/descriptor.test.ts` —
   the drift test will fail loudly if step 2 or step 3 is missing.

## Testing the manifest by hand

```bash
# Full manifest
curl -s https://api.advocatemcp.com/.well-known/mcp.json | jq

# Just the tool names
curl -s https://api.advocatemcp.com/.well-known/mcp.json | jq '.tools[].name'

# MCP inspector (lists tools + schemas with zero custom config)
npx @modelcontextprotocol/inspector
# URL: https://api.advocatemcp.com/mcp
# Transport: HTTP
```

## Transactional tool surface (Session 9)

Four MCP tools let an agent acting on behalf of a user move from discovery to
commitment without leaving MCP:

| Tool | Shape | Side effect |
|---|---|---|
| `get_availability` | `{slug, window_start?, window_end?}` → `{slots[], source, generated_at}` | None (read-only) |
| `get_quote` | `{slug, service, params?}` → `{quote{low,high,currency,confidence,basis,disclaimer?}}` | None (may call Claude for fallback) |
| `reserve_slot` | `{slug, window_*, agent_id?, customer_contact, idempotency_key}` → `{reservation_id, status:"held", confirmation_token, expires_at}` | Writes `reservations` row; 15-min hold |
| `initiate_handoff` | `{slug, mode:"human"\|"agent", ...}` → human: `{delivered_via, ticket_id}`; agent: `{continuation_url, expires_at, handshake_token}` | Writes `handoffs` row; notify side effect on human mode |

### Two extra endpoints

- `POST /a2a/confirm` — body `{confirmation_token}`. Flips reservation `held`→`confirmed`.
- `POST /a2a/continue/:token` — consumes the agent-mode handoff URL; returns the decoded continuation payload.

### HMAC domain separation

Attribution tokens (`/r/:token` on the worker) and continuation tokens
(confirmation + handoff) share the same `TOKEN_SIGNING_KEY` but are
domain-separated by an HMAC prefix (`"a2a-continuation:v1:"`). A token minted
for one purpose CANNOT verify for the other. This means one env var to rotate,
zero cross-use attack surface.

### Notify adapters

- SMS: Twilio REST via fetch (HTTP Basic auth). Gate:
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`. Absent env →
  `{delivered:false, reason:"not_configured"}`. Twilio response missing `sid`
  → `{delivered:false, reason:"missing_sid"}`.
- Email: deferred to v1.x — SES via AWS SigV4 is >200 lines hand-rolled and the
  project forbids new SDK dependencies without approval.

Human-mode `initiate_handoff` adds one upstream reason: if the business's
`lead_routing_json` does not configure a recipient for the preferred channel
(e.g. `{"preferred":"sms"}` with no `sms_to`), the handoff short-circuits with
`{delivered:false, reason:"no_recipient_configured", channel}` **without**
calling the notify adapter. The audit row is still written to `handoffs` so
the failed attempt is visible in analytics.

### Idempotency

`reserve_slot` is the only tool with mutation-idempotency — repeated calls with
the same `idempotency_key` return the existing reservation. `initiate_handoff`
is NOT idempotent (each call writes a new `handoffs` row + notify side effect);
agents should not retry on timeout without user consent.

## Hard design decisions locked in for Session 8

| Question | Decision | Rationale |
|---|---|---|
| Where do tool schemas live? | `server/src/manifest/tools.ts` | Single source of truth; both MCP server and manifest descriptor import. |
| zod → JSON Schema conversion | Hand-rolled minimal converter | Avoids unapproved npm dep; covers our 4 fields; throws on unsupported types so drift is loud. |
| Manifest caching | Built once at module load; served from in-memory `MANIFEST` const | Static JSON; zero per-request cost. |
| `estimated_latency_ms` / `estimated_cost_cents` | Static per-tool constants in descriptor | v1 is advisory, not SLO; runtime-measured version is post-Session-8. |
| Protocol version shape | `protocol_versions: string[]` | MCP spec is still moving; array future-proofs negotiation. |
