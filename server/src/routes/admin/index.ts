import { Router, type Request, type Response, type NextFunction } from "express";
import { agentsRouter } from "./agents.js";
import { adminDigestRouter } from "./digest.js";
import { tenantsRouter } from "./tenants.js";

/**
 * Bearer-token auth gate for /admin/* — keyed on ADMIN_API_KEY env var.
 * Refuses to mount routes when the env var is missing so a deploy that
 * forgets to set it can't accidentally expose internal data.
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    res.status(401).json({ error: "Admin API key not configured" });
    return;
  }
  const auth = req.header("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (token !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export const adminRouter = Router();
adminRouter.use("/admin", requireAdmin, agentsRouter);
adminRouter.use("/admin", requireAdmin, adminDigestRouter);
adminRouter.use("/admin", requireAdmin, tenantsRouter);
