import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { a2aRouter } from "./a2a.js";
import { insertAgentRequest } from "../repos/agentRequests.js";
import {
  mintContinuationToken,
  getSigningKey,
} from "../lib/continuationToken.js";

const KEY = "test-key-a2a-outcome";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(a2aRouter);
  return app;
}

describe("/a2a/confirm backfills agent_requests.outcome_signal", () => {
  let db: Database.Database;
  let app: express.Express;
  beforeEach(() => {
    process.env.TOKEN_SIGNING_KEY = KEY;
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
    app = makeApp();
  });
  afterEach(() => {
    _setDbForTesting(null);
    db.close();
  });

  it("flips matching agent_requests row to reservation_confirmed", async () => {
    db.prepare(
      `INSERT INTO reservations (id, business_slug, agent_id, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
       VALUES ('res_zzz', 'acme', 'cursor', 1, 0, 0, 'held', 'tok_test', '{}', 'idem_1', 9999999999)`,
    ).run();
    const arId = insertAgentRequest(db, {
      agentId: "cursor",
      agentIdSource: "header",
      toolCalled: "reserve_slot",
      requestId: "rid-9",
      latencyMs: 1,
      costCents: 0,
      relatedId: "res_zzz",
      outcomeSignal: "reservation_held",
    });
    const tok = mintContinuationToken(
      { ticket: "res_zzz", business_slug: "acme", scope: "confirm" },
      getSigningKey(),
    );
    const res = await request(app)
      .post("/a2a/confirm")
      .send({ confirmation_token: tok });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT outcome_signal FROM agent_requests WHERE id = ?")
      .get(arId) as { outcome_signal: string };
    expect(row.outcome_signal).toBe("reservation_confirmed");
  });

  it("does not throw when no matching agent_requests row exists", async () => {
    db.prepare(
      `INSERT INTO reservations (id, business_slug, agent_id, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
       VALUES ('res_orphan', 'acme', null, 1, 0, 0, 'held', 'tok_test', '{}', 'idem_2', 9999999999)`,
    ).run();
    const tok = mintContinuationToken(
      { ticket: "res_orphan", business_slug: "acme", scope: "confirm" },
      getSigningKey(),
    );
    const res = await request(app)
      .post("/a2a/confirm")
      .send({ confirmation_token: tok });
    expect(res.status).toBe(200);
  });
});

describe("/a2a/continue/:token backfills handoff_completed", () => {
  let db: Database.Database;
  let app: express.Express;
  beforeEach(() => {
    process.env.TOKEN_SIGNING_KEY = KEY;
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
    app = makeApp();
  });
  afterEach(() => {
    _setDbForTesting(null);
    db.close();
  });

  it("stamps handoff_completed on the matching agent_requests row", async () => {
    const handoffId = "h_abc12345";
    const arId = insertAgentRequest(db, {
      agentId: "cursor",
      agentIdSource: "header",
      toolCalled: "initiate_handoff",
      requestId: "rid-h1",
      latencyMs: 1,
      costCents: 0,
      relatedId: handoffId,
      outcomeSignal: "none",
    });
    const tok = mintContinuationToken(
      { ticket: handoffId, business_slug: "acme", scope: "continue" },
      getSigningKey(),
    );
    const res = await request(app).post(`/a2a/continue/${tok}`);
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT outcome_signal FROM agent_requests WHERE id = ?")
      .get(arId) as { outcome_signal: string };
    expect(row.outcome_signal).toBe("handoff_completed");
  });
});
