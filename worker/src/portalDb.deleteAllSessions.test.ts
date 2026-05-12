/**
 * Tests for the SOC 2 H6 deleteAllSessionsForUser helper added to
 * worker/src/portalDb.ts.
 *
 * Verifies:
 *   - Deletes only sessions for the supplied user (no cross-user blast).
 *   - Returns the count of rows deleted.
 *   - Idempotent: a second call with the same user_id returns 0.
 *   - Wrapped in standard D1 .prepare(...).bind(...).run() pattern (the
 *     "real" check is at the call sites in activate.ts + portal.ts; this
 *     unit test catches the SQL shape).
 */

import { describe, it, expect } from "vitest";
import { deleteAllSessionsForUser } from "./portalDb";

interface FakeSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
}

function makeDb(rows: FakeSessionRow[]): { db: D1Database; rows: FakeSessionRow[] } {
  return {
    rows,
    db: {
      prepare(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim();
        return {
          bind(...params: unknown[]) {
            return {
              async run() {
                if (norm === "DELETE FROM sessions WHERE user_id = ?") {
                  const userId = params[0] as string;
                  const before = rows.length;
                  for (let i = rows.length - 1; i >= 0; i--) {
                    if (rows[i].user_id === userId) rows.splice(i, 1);
                  }
                  return { meta: { changes: before - rows.length } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  };
}

describe("deleteAllSessionsForUser (SOC 2 H6)", () => {
  it("deletes only the target user's sessions, returns the count", async () => {
    const { db, rows } = makeDb([
      { id: "s1", user_id: "u1", token_hash: "h1" },
      { id: "s2", user_id: "u1", token_hash: "h2" },
      { id: "s3", user_id: "u2", token_hash: "h3" },
    ]);
    const n = await deleteAllSessionsForUser(db, "u1");
    expect(n).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe("u2");
  });

  it("returns 0 when the user has no sessions", async () => {
    const { db } = makeDb([{ id: "s1", user_id: "u1", token_hash: "h" }]);
    const n = await deleteAllSessionsForUser(db, "u-nobody");
    expect(n).toBe(0);
  });

  it("idempotent: second call returns 0", async () => {
    const { db, rows } = makeDb([
      { id: "s1", user_id: "u1", token_hash: "h1" },
      { id: "s2", user_id: "u1", token_hash: "h2" },
    ]);
    expect(await deleteAllSessionsForUser(db, "u1")).toBe(2);
    expect(await deleteAllSessionsForUser(db, "u1")).toBe(0);
    expect(rows).toHaveLength(0);
  });
});
