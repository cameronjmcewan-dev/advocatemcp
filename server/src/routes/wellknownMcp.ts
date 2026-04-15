import { Router } from "express";
import type { Request, Response } from "express";
import { MANIFEST } from "../manifest/descriptor.js";

export const wellknownMcpRouter = Router();

/**
 * GET /.well-known/mcp.json
 *
 * Canonical A2A discovery manifest. An agent framework that hits this URL
 * learns every tool, input schema, transport, rate limit, and auth mode
 * with zero custom configuration.
 *
 * The response is built once at module load (see `MANIFEST` in
 * `manifest/descriptor.ts`) and served from an in-memory constant — no
 * per-request work.
 */
wellknownMcpRouter.get(
  "/.well-known/mcp.json",
  (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json(MANIFEST);
  }
);
