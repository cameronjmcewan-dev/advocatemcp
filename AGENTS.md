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

## Hard design decisions locked in for Session 8

| Question | Decision | Rationale |
|---|---|---|
| Where do tool schemas live? | `server/src/manifest/tools.ts` | Single source of truth; both MCP server and manifest descriptor import. |
| zod → JSON Schema conversion | Hand-rolled minimal converter | Avoids unapproved npm dep; covers our 4 fields; throws on unsupported types so drift is loud. |
| Manifest caching | Built once at module load; served from in-memory `MANIFEST` const | Static JSON; zero per-request cost. |
| `estimated_latency_ms` / `estimated_cost_cents` | Static per-tool constants in descriptor | v1 is advisory, not SLO; runtime-measured version is post-Session-8. |
| Protocol version shape | `protocol_versions: string[]` | MCP spec is still moving; array future-proofs negotiation. |
