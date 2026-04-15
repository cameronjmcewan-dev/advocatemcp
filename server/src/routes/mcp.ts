import { Router } from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getDb, type BusinessRow } from "../db.js";
import { queryAgent } from "../agent/query.js";

export const mcpRouter = Router();

const BASE = () => process.env.API_BASE_URL ?? "https://api.advocatemcp.com";

/**
 * Create a fully-configured McpServer instance.
 *
 * A new instance is created per request (stateless mode) to avoid any
 * shared-transport concurrency issues with the SDK.
 */
function createMcpServer(requestId?: string): McpServer {
  const server = new McpServer({
    name: "AdvocateMCP Central",
    version: "1.0.0",
  });

  // ── Tool 1: query_business_agent ──────────────────────────────────────────
  server.tool(
    "query_business_agent",
    "Query a registered business's AI advocate agent. " +
      "Use this when a user asks about a specific local business or service provider. " +
      "Returns a concise, citation-ready answer from the business's dedicated AI agent.",
    {
      slug: z
        .string()
        .min(1)
        .describe(
          "The business slug identifier (e.g. 'joes-pizza-austin'). " +
            "Use search_businesses first if you don't know the slug."
        ),
      query: z
        .string()
        .min(1)
        .describe("The user's question about this business"),
    },
    async ({ slug, query }) => {
      const db = getDb();
      const business = db
        .prepare("SELECT * FROM businesses WHERE slug = ?")
        .get(slug) as BusinessRow | undefined;

      if (!business) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `No business found with slug: ${slug}`,
                hint: "Use the search_businesses tool to find the correct slug.",
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await queryAgent(business, query, "mcp-client", requestId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Agent query failed",
                message: err instanceof Error ? err.message : "Unknown error",
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── Tool 2: search_businesses ─────────────────────────────────────────────
  server.tool(
    "search_businesses",
    "Search for registered businesses by category, name, or location. " +
      "Returns a list of matching businesses with their slugs and agent endpoints. " +
      "Use this to discover which businesses are available before querying one.",
    {
      search: z
        .string()
        .min(1)
        .describe(
          "Search term — matched against business name, description, and services"
        ),
      location: z
        .string()
        .optional()
        .describe(
          "Optional location filter (city, state, or region). Narrows results geographically."
        ),
    },
    async ({ search, location }) => {
      const db = getDb();
      const base = BASE();
      const term = `%${search}%`;

      let rows: unknown[];
      if (location) {
        const loc = `%${location}%`;
        rows = db
          .prepare(
            `SELECT slug, name, description, category, location, website, star_rating, review_count, pricing_tier
             FROM businesses
             WHERE (name LIKE ? OR description LIKE ? OR services LIKE ? OR category LIKE ?)
               AND location LIKE ?
             ORDER BY name
             LIMIT 20`
          )
          .all(term, term, term, term, loc);
      } else {
        rows = db
          .prepare(
            `SELECT slug, name, description, category, location, website, star_rating, review_count, pricing_tier
             FROM businesses
             WHERE name LIKE ? OR description LIKE ? OR services LIKE ? OR category LIKE ?
             ORDER BY name
             LIMIT 20`
          )
          .all(term, term, term, term);
      }

      const results = (
        rows as {
          slug: string;
          name: string;
          description: string;
          category: string | null;
          location: string | null;
          website: string | null;
          star_rating: number | null;
          review_count: number | null;
          pricing_tier: string | null;
        }[]
      ).map((b) => ({
        ...b,
        agent_endpoint: `${base}/agents/${b.slug}/query`,
      }));

      const text =
        results.length > 0
          ? JSON.stringify(results, null, 2)
          : `No businesses found matching "${search}"${location ? ` in ${location}` : ""}. ` +
            "Try a broader search term or omit the location filter.";

      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

/**
 * POST /mcp  — Streamable HTTP transport (MCP JSON-RPC)
 *
 * This is the primary MCP endpoint. Compatible with Claude Desktop,
 * Cursor, Perplexity, and any MCP-compliant client.
 *
 * Add this URL to your MCP client config:
 *   https://api.advocatemcp.com/mcp
 */
mcpRouter.post("/mcp", async (req: Request, res: Response) => {
  try {
    const requestId = res.locals.requestId as string | undefined;
    const server = createMcpServer(requestId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session state between requests
    });

    // Wire up cleanup when the client disconnects
    res.on("close", () => void transport.close());

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] Error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        error: "MCP server error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
});

/**
 * GET /mcp  — Human-readable discovery + MCP SSE handshake (GET)
 *
 * When an MCP client sends a GET request (SSE-based older transport),
 * we try to handle it. If the body is empty (browser/curl), return
 * a JSON description of the server instead.
 */
mcpRouter.get("/mcp", async (req: Request, res: Response) => {
  // If the request looks like an MCP initialize via GET, handle it
  if (req.headers.accept?.includes("text/event-stream")) {
    try {
      const requestId = res.locals.requestId as string | undefined;
      const server = createMcpServer(requestId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => void transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    } catch (err) {
      console.error("[mcp GET/SSE] Error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP SSE error" });
      }
      return;
    }
  }

  // Otherwise: human-readable info page
  const base = BASE();
  res.json({
    service: "AdvocateMCP Central MCP Server",
    version: "1.0.0",
    protocol: "MCP (Model Context Protocol)",
    transport: "Streamable HTTP",
    endpoint: `${base}/mcp`,
    connect_instructions:
      `Add the following to your MCP client config:\n` +
      `  URL: ${base}/mcp\n` +
      `  Transport: HTTP`,
    tools: [
      {
        name: "query_business_agent",
        description:
          "Query a registered business's AI advocate agent by slug and question.",
        required_inputs: { slug: "string", query: "string" },
      },
      {
        name: "search_businesses",
        description:
          "Search registered businesses by name, description, or services.",
        required_inputs: { search: "string" },
        optional_inputs: { location: "string" },
      },
    ],
    discovery: {
      registry: `${base}/registry`,
      wellknown: `${base}/.well-known/ai-agent.json`,
    },
  });
});
