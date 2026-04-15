import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { reserveSlotInput } from "../../manifest/tools.js";
import { mintContinuationToken } from "../../lib/continuationToken.js";
import { sweepExpiredReservations } from "../../jobs/expirySweeper.js";
import type { ReservationRow } from "../../db.js";

const HOLD_SECONDS = 900; // 15 min

function signingKey(): string {
  const k = process.env.TOKEN_SIGNING_KEY;
  if (k) return k;
  if (process.env.NODE_ENV === "production") {
    throw new Error("TOKEN_SIGNING_KEY must be set in production");
  }
  return "dev-insecure-key";
}

export async function handleReserveSlot(
  input: z.infer<typeof reserveSlotInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const db = getDb();
  sweepExpiredReservations(db);

  const biz = db.prepare(`SELECT slug FROM businesses WHERE slug = ?`).get(input.slug);
  if (!biz) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }],
    };
  }

  const existing = db
    .prepare(`SELECT * FROM reservations WHERE idempotency_key = ?`)
    .get(input.idempotency_key) as ReservationRow | undefined;

  if (existing) {
    const confirmation_token = mintContinuationToken(
      {
        ticket: existing.id,
        business_slug: existing.business_slug,
        agent_id: existing.agent_id ?? undefined,
        scope: "confirm",
      },
      signingKey()
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            reservation_id: existing.id,
            status: existing.status,
            confirmation_token,
            expires_at: existing.expires_at,
            idempotent_replay: true,
          }),
        },
      ],
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const reservation_id = `r_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const expires_at = now + HOLD_SECONDS;
  const confirmation_token = mintContinuationToken(
    {
      ticket: reservation_id,
      business_slug: input.slug,
      agent_id: input.agent_id,
      scope: "confirm",
    },
    signingKey()
  );

  db.prepare(`
    INSERT INTO reservations (id, business_slug, agent_id, requested_at, window_start, window_end,
      status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)
  `).run(
    reservation_id,
    input.slug,
    input.agent_id ?? null,
    now,
    input.window_start,
    input.window_end,
    confirmation_token,
    JSON.stringify(input.customer_contact),
    input.idempotency_key,
    expires_at
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          reservation_id,
          status: "held",
          confirmation_token,
          expires_at,
        }),
      },
    ],
  };
}

export function registerReserveSlot(server: McpServer): void {
  server.tool(
    "reserve_slot",
    "Create a 15-minute HELD reservation. Return a confirmation_token the agent posts to /a2a/confirm to flip to CONFIRMED.",
    reserveSlotInput.shape,
    async (args) => handleReserveSlot(args)
  );
}
