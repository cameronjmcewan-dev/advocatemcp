import {
  queryBusinessAgentInput,
  searchBusinessesInput,
  getAvailabilityInput,
  getQuoteInput,
  reserveSlotInput,
  initiateHandoffInput,
} from "./tools.js";
import {
  zodToJsonSchema,
  ManifestSchema,
  type JsonSchemaNode,
  type Manifest,
} from "./schema.js";
import { getApiBaseUrl } from "../lib/baseUrl.js";
import {
  PER_IP_LIMIT_PER_MINUTE,
  PER_API_KEY_LIMIT_PER_HOUR,
} from "../middleware/rateLimit.js";
import { TIER_LIMITS } from "../lib/agentTier.js";

/**
 * Typed descriptor for a single tool. This is the registry row; the MCP
 * server and the A2A manifest both read from the same list.
 *
 * `estimated_latency_ms` and `estimated_cost_cents` are advisory static
 * numbers for v1 — they guide clients' scheduling/budgeting decisions but
 * are not SLOs. A runtime-measured version is Session 11+ work.
 *
 * `annotations` carry the MCP spec's behavioral hints (readOnlyHint,
 * destructiveHint, openWorldHint) so both the A2A manifest and the
 * `tools/list` RPC response expose the same signal. Per OpenAI's Apps
 * SDK submission guidance these are a hard requirement.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputZod: typeof queryBusinessAgentInput | typeof searchBusinessesInput | typeof getAvailabilityInput | typeof getQuoteInput | typeof reserveSlotInput | typeof initiateHandoffInput;
  outputSchema: JsonSchemaNode;
  idempotent: boolean;
  estimated_latency_ms: number;
  estimated_cost_cents: number;
  annotations: ToolAnnotations;
}

export const DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "query_business_agent",
    description:
      "Query a registered business's AI advocate agent. " +
      "Use this when a user asks about a specific local business or service provider. " +
      "Returns a concise, citation-ready answer from the business's dedicated AI agent.",
    inputZod: queryBusinessAgentInput,
    outputSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "Citation-ready answer text" },
        referral_url: {
          type: "string",
          description: "Tracked URL to the business's site",
        },
      },
      required: ["answer"],
      additionalProperties: false,
    },
    idempotent: false, // each call logs to queries table + consumes Claude tokens
    estimated_latency_ms: 1500,
    estimated_cost_cents: 2,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "search_businesses",
    description:
      "Search for registered businesses by category, name, or location. " +
      "Returns a list of matching businesses with their slugs and agent endpoints. " +
      "Use this to discover which businesses are available before querying one.",
    inputZod: searchBusinessesInput,
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "string",
          description: "JSON-encoded array of business records",
        },
      },
      required: ["results"],
      additionalProperties: false,
    },
    idempotent: true, // read-only SQL over businesses table
    estimated_latency_ms: 50,
    estimated_cost_cents: 0,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "get_availability",
    description: "30-minute slot windows derived from business hours_json (v1 synthetic).",
    inputZod: getAvailabilityInput,
    outputSchema: {
      type: "object",
      properties: {
        slots: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: { type: "number" },
              end: { type: "number" },
              capacity: { type: "number" },
            },
          },
        },
        source: { type: "string" },
        generated_at: { type: "number" },
      },
    },
    idempotent: true,
    estimated_latency_ms: 150,
    estimated_cost_cents: 0,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "get_quote",
    description: "Quote a service price from pricing_json_v2; exact|range|estimate labelled.",
    inputZod: getQuoteInput,
    outputSchema: {
      type: "object",
      properties: {
        quote: {
          type: "object",
          properties: {
            low: { type: "number" },
            high: { type: "number" },
            currency: { type: "string" },
            confidence: { type: "string" },
            basis: { type: "string" },
            disclaimer: { type: "string" },
          },
        },
      },
    },
    idempotent: true,
    estimated_latency_ms: 200,
    estimated_cost_cents: 0, // deterministic=0; LLM fallback ~1–2¢ per call; averaged assumes ≥70% deterministic hit
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      // openWorld: true because the LLM fallback path calls Anthropic's API
      // which is an external service outside the manifest's closed world.
      openWorldHint: true,
    },
  },
  {
    name: "initiate_handoff",
    description: "Start a handoff to a human (SMS/email via tenant routing) or another agent (signed continuation URL).",
    inputZod: initiateHandoffInput,
    outputSchema: {
      oneOf: [
        {
          type: "object",
          properties: {
            mode: { const: "human" },
            delivered_via: { type: "string" },
            ticket_id: { type: "string" },
          },
        },
        {
          type: "object",
          properties: {
            mode: { const: "agent" },
            continuation_url: { type: "string" },
            expires_at: { type: "number" },
            handshake_token: { type: "string" },
          },
        },
      ],
    },
    idempotent: false,
    estimated_latency_ms: 300,
    estimated_cost_cents: 1,
    annotations: {
      readOnlyHint: false,
      // destructive: true — triggers outbound SMS/email to the tenant or mints
      // a signed continuation URL; either way there's a real-world side effect
      // that cannot be rolled back by a subsequent tool call.
      destructiveHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "reserve_slot",
    description: "Create a 15-min HELD reservation; returns a signed confirmation_token for the agent to post back to /a2a/confirm.",
    inputZod: reserveSlotInput,
    outputSchema: {
      type: "object",
      properties: {
        reservation_id: { type: "string" },
        status: { type: "string" },
        confirmation_token: { type: "string" },
        expires_at: { type: "number" },
      },
    },
    idempotent: true,
    estimated_latency_ms: 100,
    estimated_cost_cents: 0,
    annotations: {
      readOnlyHint: false,
      // destructive: true — writes a row to `reservations` that blocks a slot
      // for 15 minutes. Even though it's idempotent on replay, the first call
      // has a real side effect that tenants can see on their calendar.
      destructiveHint: true,
      openWorldHint: true,
    },
  },
];

export interface BuildManifestOptions {
  apiBase: string; // e.g. https://api.advocatemcp.com
  trackBase: string; // e.g. https://customers.advocatemcp.com
}

export function buildManifest(opts: BuildManifestOptions): Manifest {
  const m: Manifest = {
    spec_version: "2026-04-14",
    agent_id: "advocatemcp-central",
    protocol_versions: ["2025-03-26"], // current MCP spec version; array per Session 8 risk callout
    transports: [
      // HTTP only. SSE was advertised pre-Apr-15 but Cloudflare/Railway closes
      // idle SSE channels around 30s and we never push server-initiated events
      // (all tools are request/response). The /mcp GET route still SERVES SSE
      // on request for backward-compat with Inspector-class clients that
      // default to SSE — we just don't advertise it so spec-compliant agents
      // pick the transport that actually works.
      { kind: "http", url: `${opts.apiBase}/mcp` },
    ],
    tools: DESCRIPTORS.map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: zodToJsonSchema(d.inputZod),
      output_schema: d.outputSchema,
      idempotent: d.idempotent,
      estimated_latency_ms: d.estimated_latency_ms,
      estimated_cost_cents: d.estimated_cost_cents,
      annotations: d.annotations,
    })),
    rate_limits: {
      // Sourced from `server/src/middleware/rateLimit.ts` so the published
      // manifest stays in lockstep with real per-IP / per-agent enforcement.
      // per_agent_per_minute derives from the hourly per-api-key limit.
      per_ip_per_minute: PER_IP_LIMIT_PER_MINUTE,
      per_agent_per_minute: Math.floor(PER_API_KEY_LIMIT_PER_HOUR / 60),
      // Session 11: per-tier ceilings actually enforced by the middleware.
      tiers: TIER_LIMITS,
    },
    auth_model: {
      modes: ["open", "api_key"],
    },
    attribution_endpoint: `${opts.trackBase}/track`,
    // Required by the ChatGPT Apps SDK review. Hardcoded to the
    // advocatemcp.com canonical URLs — tenant-specific manifests live at
    // the Worker /.well-known/ai-agent.json mirror, not here.
    support_contact: "mailto:max@advocate-mcp.com",
    privacy_url: "https://advocatemcp.com/privacy",
    terms_url: "https://advocatemcp.com/terms",
  };
  // Belt-and-suspenders: throw loudly at module load if the manifest is malformed.
  return m;
}

const API_BASE = getApiBaseUrl();
const TRACK_BASE =
  process.env.WORKER_BASE_URL ?? "https://customers.advocatemcp.com";

/**
 * Cached, module-scoped manifest built once at boot from env. The well-known
 * route and the MCP `initialize` hook both read this constant — the handler
 * never rebuilds per-request. rate_limits are sourced from
 * `server/src/middleware/rateLimit.ts` so enforcement and advertisement stay
 * in lockstep.
 */
export const MANIFEST: Manifest = ManifestSchema.parse(
  buildManifest({ apiBase: API_BASE, trackBase: TRACK_BASE })
);
