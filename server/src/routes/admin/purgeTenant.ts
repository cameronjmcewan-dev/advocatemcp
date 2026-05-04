import { Router, type Request, type Response } from "express";
import { getDb } from "../../db.js";

export const purgeTenantRouter = Router();

// Deletion order matters: child tables first, then businesses last.
// competitor_citations has no slug column — it's FK'd via poll_id.
// synthetic_pages, competitors, comparison_pages use business_id FK with
// ON DELETE CASCADE, but we delete them explicitly here to capture row counts.
// locations also has ON DELETE CASCADE from businesses(slug), but explicit
// deletion gives us the count.
const SLUG_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["queries",                  "business_slug"],
  ["click_events",             "business_slug"],
  ["reservations",             "business_slug"],
  ["handoffs",                 "business_slug"],
  ["agent_requests",           "business_slug"],
  ["competitor_query_baskets", "slug"],
  ["competitor_polls",         "slug"],
  ["radar_digests",            "slug"],
  ["tenant_budget_state",      "slug"],
  ["revenue_events",           "business_slug"],
  ["monthly_review_dispatch",  "slug"],
  ["callback_requests",        "business_slug"],
  ["subscriptions",            "business_slug"],
  ["locations",                "business_slug"],
  // businesses MUST be last — deletes cascade to synthetic_pages, competitors,
  // comparison_pages which are FK'd on businesses.id with ON DELETE CASCADE.
  ["businesses",               "slug"],
] as const;

// competitor_citations has no slug; resolved via competitor_polls FK.
// We delete them before competitor_polls above runs so FK constraints hold.
// They get their own dedicated step below rather than a slug-join subquery
// to keep the loop uniform.

purgeTenantRouter.post("/tenants/:slug/purge", (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug) {
    res.status(400).json({ error: "slug required" });
    return;
  }

  const db = getDb();
  const deleteUsers = String(req.query.delete_users ?? "") === "true";

  const slugStmts = SLUG_TABLES.map(([table, col]) => ({
    table,
    stmt: db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`),
  }));

  // competitor_citations are linked via poll_id; delete before competitor_polls.
  const citationsStmt = db.prepare(
    `DELETE FROM competitor_citations WHERE poll_id IN (
       SELECT id FROM competitor_polls WHERE slug = ?
     )`,
  );

  // synthetic_pages, competitors, comparison_pages are CASCADE'd from
  // businesses.id — we delete them explicitly to capture counts.
  const bizIdSubquery = `(SELECT id FROM businesses WHERE slug = ?)`;
  const businessIdStmts = [
    { table: "comparison_pages", stmt: db.prepare(`DELETE FROM comparison_pages WHERE business_id IN ${bizIdSubquery}`) },
    { table: "competitors",      stmt: db.prepare(`DELETE FROM competitors WHERE business_id IN ${bizIdSubquery}`) },
    { table: "synthetic_pages",  stmt: db.prepare(`DELETE FROM synthetic_pages WHERE business_id IN ${bizIdSubquery}`) },
  ];

  const deleted: Record<string, number> = {};

  try {
    db.transaction(() => {
      // competitor_citations before competitor_polls
      deleted["competitor_citations"] = citationsStmt.run(slug).changes;

      // business_id-keyed tables before businesses row is removed
      for (const { table, stmt } of businessIdStmts) {
        deleted[table] = stmt.run(slug).changes;
      }

      // slug-keyed tables (businesses is last in the list)
      for (const { table, stmt } of slugStmts) {
        deleted[table] = stmt.run(slug).changes;
      }
    })();
  } catch (err) {
    res.status(500).json({
      error: "purge transaction rolled back",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const usersNote = deleteUsers
    ? "user deletion happens on Worker D1, not Railway — call wrangler d1 commands separately"
    : undefined;

  res.status(200).json({
    ok: true,
    slug,
    deleted,
    ...(usersNote !== undefined ? { users_note: usersNote } : {}),
  });
});
