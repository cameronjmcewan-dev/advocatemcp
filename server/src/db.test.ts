import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("db schema migrations", () => {
  const tmp = path.join(os.tmpdir(), `advocate-db-test-${Date.now()}.db`);

  beforeAll(() => {
    process.env.DATABASE_PATH = tmp;
  });

  it("adds the new onboarding profile columns to businesses", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info(businesses)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const col of [
      "hours_json",
      "services_json_v2",
      "pricing_json_v2",
      "credentials_json",
      "ratings_json",
      "differentiators_text",
      "customer_quotes_json",
      "guarantee_text",
      "case_stories_json",
      "lead_routing_json",
    ]) {
      expect(names).toContain(col);
    }
    fs.rmSync(tmp, { force: true });
  });
});
