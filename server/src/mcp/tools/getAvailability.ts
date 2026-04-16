import { z } from "zod";
import type { Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { getAvailabilityInput } from "../../manifest/tools.js";
import { DESCRIPTORS } from "../../manifest/descriptor.js";
import { withAgentRequestLog } from "../../lib/agentRequestLogger.js";

export interface DaySpec { open: string; close: string }
export interface HoursJson {
  mon?: DaySpec | null;
  tue?: DaySpec | null;
  wed?: DaySpec | null;
  thu?: DaySpec | null;
  fri?: DaySpec | null;
  sat?: DaySpec | null;
  sun?: DaySpec | null;
  emergency_24_7?: boolean;
}

type DowKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
const SLOT_SECONDS = 1800;
const MAX_SLOTS = 48;
export const DEFAULT_TIMEZONE = "America/Los_Angeles";

/**
 * Resolve a unix-seconds instant's local day-of-week key and minutes-into-day
 * in the given IANA timezone. Used to match hours_json entries against a
 * candidate slot-start when the business's hours are expressed in local
 * wall-clock time (not UTC).
 *
 * weekday:"short" returns "Mon","Tue",... which we lowercase to the short
 * keys used in HoursSchema.
 */
function localDowAndMinutes(unixSec: number, tz: string): { dow: DowKey; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(unixSec * 1000));
  const wd = (parts.find((p) => p.type === "weekday")?.value ?? "").toLowerCase() as DowKey;
  // Intl returns "24" for the hour of midnight in some locales/zones under
  // hour12:false — normalize to "00".
  const hRaw = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hh = (hRaw === "24" ? 0 : parseInt(hRaw, 10));
  const mm = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { dow: wd, minutes: hh * 60 + mm };
}

/**
 * Pure function: given hours_json, an IANA timezone, and a
 * [window_start, window_end) in Unix seconds, return up to MAX_SLOTS 30-minute
 * slots whose local wall-clock time (resolved in `tz`) fully fits inside the
 * day's open/close range. Slot timestamps themselves are always UTC unix
 * seconds — the timezone is only used to reinterpret hours_json.
 */
export function synthSlots(args: {
  hours: HoursJson;
  window_start: number;
  window_end: number;
  timezone?: string;
}): Array<{ start: number; end: number; capacity: 1 }> {
  const tz = args.timezone ?? DEFAULT_TIMEZONE;
  const out: Array<{ start: number; end: number; capacity: 1 }> = [];

  // Align candidate slot-starts to 30-min boundaries of the UTC timeline. This
  // doesn't guarantee alignment to LOCAL 30-min marks in zones with fractional
  // UTC offsets (e.g. India, Newfoundland), but every SMB zone we care about
  // today is on a whole-hour offset, and hours_json is authored in :00/:30
  // marks anyway — so the slot grid aligns naturally for the target use case.
  const start = Math.ceil(args.window_start / SLOT_SECONDS) * SLOT_SECONDS;

  for (
    let t = start;
    t + SLOT_SECONDS <= args.window_end && out.length < MAX_SLOTS;
    t += SLOT_SECONDS
  ) {
    const { dow, minutes: localMin } = localDowAndMinutes(t, tz);
    const spec = args.hours[dow];
    if (!spec) continue;
    const openMin = parseHHMM(spec.open);
    const closeMin = parseHHMM(spec.close);
    if (openMin == null || closeMin == null || closeMin <= openMin) continue;

    // Slot start must be >= open, and slot end (30 min later) must be <= close.
    // Compare in local minutes. Because the slot is 30 minutes and hours are
    // authored within a single local day, if both slot-start and
    // slot-start+30 are inside [open, close], the whole slot stays on one
    // local date — no midnight-crossing to worry about.
    const openSec = openMin * 60;
    const closeSec = closeMin * 60;
    const localSec = localMin * 60;
    if (localSec < openSec) continue;
    if (localSec + SLOT_SECONDS > closeSec) continue;

    out.push({ start: t, end: t + SLOT_SECONDS, capacity: 1 });
  }
  return out;
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

export async function handleGetAvailability(
  input: z.infer<typeof getAvailabilityInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const row = getDb().prepare(`
    SELECT slug, hours_json, availability_webhook_url, timezone
    FROM businesses WHERE slug = ?
  `).get(input.slug) as { slug: string; hours_json: string | null; availability_webhook_url: string | null; timezone: string | null } | undefined;

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
  const timezone = row.timezone ?? DEFAULT_TIMEZONE;
  const slots = synthSlots({ hours, window_start, window_end, timezone });
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        slots,
        source: "hours_json",
        timezone,
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
    DESCRIPTORS.find((d) => d.name === "get_availability")!.annotations,
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
