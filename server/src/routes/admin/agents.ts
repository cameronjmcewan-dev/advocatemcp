import { Router } from "express";
import { getDb } from "../../db.js";
import { listReputation } from "../../repos/agentReputation.js";

export const agentsRouter = Router();

/**
 * Internal-only read endpoint over the agent_reputation rollup.
 * Mounted under /admin behind the bearer-auth middleware in ./index.ts.
 * Never advertised in the manifest.
 */
agentsRouter.get("/agents", (_req, res) => {
  const db = getDb();
  res.json({ agents: listReputation(db) });
});
