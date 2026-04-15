import { z } from "zod";
import type { Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { getAvailabilityInput } from "../../manifest/tools.js";
import { withAgentRequestLog } from "../../lib/agentRequestLogger.js";

export interface DaySpec { open: string; close: string }
export type HoursJson = Partial<Record<
  "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday",
  DaySpec
>>;

const DAY_NAMES = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
] as const;
const SLOT_SECONDS = 1800;
const MAX_SLOTS = 48;

/**
 * Pure function: given hours_json and a [window_start, window_end) in Unix seconds,
 * return up to MAX_SLOTS 30-minute slots on days with matching hours.
 * Slots whose [start, end) isn't fully inside an open interval are dropped.
 */
export function synthSlots(args: {
  hours: HoursJson;
  window_start: number;
  window_end: number;
}): Array<{ start: number; end: number; capacity: 1 }> {
  const out: Array<{ start: number; end: number; capacity: 1 }> = [];
  const dayStart = Math.floor(args.window_start / 86400) * 86400;
  for (let d = dayStart; d < args.window_end && out.length < MAX_SLOTS; d += 86400) {
    const dow = DAY_NAMES[new Date(d * 1000).getUTCDay()]!;
    const spec = args.hours[dow];
    if (!spec) continue;
    const open = parseHHMM(spec.open);
    const close = parseHHMM(spec.close);
    if (open == null || close == null || close <= open) continue;
    for (let t = d + open; t + SLOT_SECONDS <= d + close && out.length < MAX_SLOTS; t += SLOT_SECONDS) {
      if (t + SLOT_SECONDS <= args.window_start) continue;
      if (t >= args.window_end) break;
      if (t < args.window_start) continue;
      out.push({ start: t, end: t + SLOT_SECONDS, capacity: 1 });
    }
  }
  return out;
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 3600 + mm * 60;
}

export async function handleGetAvailability(
  input: z.infer<typeof getAvailabilityInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const row = getDb().prepare(`
    SELECT slug, hours_json, availability_webhook_url
    FROM businesses WHERE slug = ?
  `).get(input.slug) as { slug: string; hours_json: string | null; availability_webhook_url: string | null } | undefined;

  if (!row) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }] };
  }
  const now = Math.floor(Date.now() / 1000);
  const window_start = input.window_start ?? now;
  const window_end = input.window_end ?? now + 7 * 86400;
  let hours: HoursJson = {};
  if (row.hours_json) {
    try { hours = JSON.parse(row.hours_json) as HoursJson; } catch { hours = {}; }
  }
  const slots = synthSlots({ hours, window_start, window_end });
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        slots,
        source: "hours_json",
        generated_at: now,
      }),
    }],
  };
}

export function registerGetAvailability(
  server: McpServer,
  req?: Request,
  requestId?: string,
): void {
  server.tool(
    "get_availability",
    "Return 30-minute availability windows for a business from its hours_json. v1 is synthetic; v2 will consult availability_webhook_url when set.",
    getAvailabilityInput.shape,
    async (args) => {
      if (!req) return handleGetAvailability(args);
      return withAgentRequestLog(
        {
          toolName: "get_availability",
          req,
          requestId,
          toolArgAgentId: null,
          businessSlug: args.slug,
        },
        () => handleGetAvailability(args),
      );
    }
  );
}
