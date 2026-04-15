import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { reserveSlotInput } from "../../manifest/tools.js";
import { mintContinuationToken, getSigningKey } from "../../lib/continuationToken.js";
import { sweepExpiredReservations, redactStalePii } from "../../jobs/expirySweeper.js";
import type { ReservationRow } from "../../db.js";
import { withAgentRequestLog } from "../../lib/agentRequestLogger.js";
import { setOutcomeAndRelated } from "../../repos/agentRequests.js";

const HOLD_SECONDS = 900; // 15 min

export async function handleReserveSlot(
  input: z.infer<typeof reserveSlotInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const db = getDb();
  sweepExpiredReservations(db);
  // Passive PII decay — runs alongside the expirer on every reserve_slot call
  // so retention policy fires without a cron. See expirySweeper.ts for policy.
  redactStalePii(db);

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
      getSigningKey()
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
    getSigningKey()
  );

  // Race guard: two concurrent callers with the same idempotency_key can both
  // pass the SELECT above and race to INSERT. The UNIQUE constraint will throw
  // SQLITE_CONSTRAINT_UNIQUE on the loser. Catch it and re-SELECT — the winner's
  // row is now visible, so we return the idempotent replay shape rather than
  // surfacing a 500 to the caller.
  try {
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
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "SQLITE_CONSTRAINT_UNIQUE") {
      const won = db
        .prepare(`SELECT * FROM reservations WHERE idempotency_key = ?`)
        .get(input.idempotency_key) as ReservationRow | undefined;
      if (won) {
        const replayToken = mintContinuationToken(
          {
            ticket: won.id,
            business_slug: won.business_slug,
            agent_id: won.agent_id ?? undefined,
            scope: "confirm",
          },
          getSigningKey()
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                reservation_id: won.id,
                status: won.status,
                confirmation_token: replayToken,
                expires_at: won.expires_at,
                idempotent_replay: true,
              }),
            },
          ],
        };
      }
    }
    throw err;
  }

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

/**
 * Pull reservation_id out of the JSON-stringified MCP tool response so the
 * logger wrapper can stamp `related_id` and `outcome_signal='reservation_held'`
 * on the matching agent_requests row in one UPDATE.
 *
 * Returns null when the response shape changed (defensive — keep the row even
 * without back-link rather than throw).
 */
function extractReservationId(
  res: Awaited<ReturnType<typeof handleReserveSlot>>,
): string | null {
  try {
    const raw = res.content?.[0]?.text;
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw) as { reservation_id?: unknown };
    return typeof parsed.reservation_id === "string" ? parsed.reservation_id : null;
  } catch {
    return null;
  }
}

export function registerReserveSlot(
  server: McpServer,
  req?: Request,
  requestId?: string,
): void {
  server.tool(
    "reserve_slot",
    "Create a 15-minute HELD reservation. Return a confirmation_token the agent posts to /a2a/confirm to flip to CONFIRMED.",
    reserveSlotInput.shape,
    async (args) => {
      if (!req) return handleReserveSlot(args);
      let logId: string | null = null;
      const result = await withAgentRequestLog(
        {
          toolName: "reserve_slot",
          req,
          requestId,
          toolArgAgentId: args.agent_id ?? null,
          businessSlug: args.slug,
          onLogged: (id) => {
            logId = id;
          },
        },
        () => handleReserveSlot(args),
      );
      // Backfill outcome + related_id in one UPDATE so the rollup job sees
      // reservation_held outcomes attributed to the originating audit row.
      // Skipped on isError so a business_not_found row stays as 'none'.
      if (logId && !result.isError) {
        const reservationId = extractReservationId(result);
        if (reservationId) {
          setOutcomeAndRelated(getDb(), {
            id: logId,
            outcomeSignal: "reservation_held",
            relatedId: reservationId,
          });
        }
      }
      return result;
    }
  );
}
