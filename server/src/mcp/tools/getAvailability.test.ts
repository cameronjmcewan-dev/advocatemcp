import { describe, it, expect } from "vitest";
import { synthSlots, type HoursJson } from "./getAvailability.js";

// Use a fixed Monday at midnight UTC. 2026-04-13 00:00 UTC is a Monday.
const MON_0000 = 1776038400;
const TUE_0000 = MON_0000 + 86400;

describe("synthSlots — pure function (UTC interpretation)", () => {
  it("returns zero slots when the window intersects only closed days", () => {
    const hours: HoursJson = {};
    const out = synthSlots({ hours, window_start: MON_0000, window_end: MON_0000 + 86400, timezone: "UTC" });
    expect(out).toEqual([]);
  });

  it("returns 2 half-hour slots for a 09:00–10:00 Monday (UTC hours)", () => {
    const hours: HoursJson = { mon: { open: "09:00", close: "10:00" } };
    const out = synthSlots({ hours, window_start: MON_0000, window_end: TUE_0000, timezone: "UTC" });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ start: MON_0000 + 9 * 3600, end: MON_0000 + 9 * 3600 + 1800, capacity: 1 });
    expect(out[1]).toEqual({ start: MON_0000 + 9 * 3600 + 1800, end: MON_0000 + 10 * 3600, capacity: 1 });
  });

  it("caps output at 48 slots even if the window is wider", () => {
    const hours: HoursJson = {
      mon: { open: "00:00", close: "23:59" },
      tue: { open: "00:00", close: "23:59" },
    };
    const out = synthSlots({ hours, window_start: MON_0000, window_end: MON_0000 + 3 * 86400, timezone: "UTC" });
    expect(out.length).toBe(48);
  });

  it("drops a partial first slot when window_start lands mid-slot", () => {
    const hours: HoursJson = { mon: { open: "09:00", close: "10:00" } };
    const out = synthSlots({ hours, window_start: MON_0000 + 9 * 3600 + 600, window_end: TUE_0000, timezone: "UTC" });
    // 09:10 UTC is inside the 09:00 slot, so the slotter must drop that slot and start at 09:30
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(MON_0000 + 9 * 3600 + 1800);
  });
});

describe("synthSlots — TZ-aware (hours_json interpreted in local wall-clock)", () => {
  // 2026-04-13 is a Monday and falls inside PDT (UTC-7) in America/Los_Angeles.
  // A business open 08:00–18:00 local means 15:00–01:00 UTC (next day) in PDT.
  // Caller asks for a window 17:00–19:00 UTC on MON, i.e. 10:00–12:00 LOCAL.
  it("returns 4 slots for a PDT business 08:00–18:00 queried 10:00–12:00 local", () => {
    const hours: HoursJson = { mon: { open: "08:00", close: "18:00" } };
    const winStart = MON_0000 + 17 * 3600; // 17:00 UTC MON = 10:00 PDT MON
    const winEnd = MON_0000 + 19 * 3600;   // 19:00 UTC MON = 12:00 PDT MON
    const out = synthSlots({
      hours,
      window_start: winStart,
      window_end: winEnd,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(4);
    expect(out[0]!.start).toBe(winStart);
    expect(out[3]!.end).toBe(winEnd);
  });

  it("returns zero slots for a PDT business asked about 1am local (before open)", () => {
    const hours: HoursJson = { mon: { open: "08:00", close: "18:00" } };
    // 08:00 UTC MON = 01:00 PDT MON — business closed
    const winStart = MON_0000 + 8 * 3600;
    const winEnd = MON_0000 + 9 * 3600;
    const out = synthSlots({
      hours,
      window_start: winStart,
      window_end: winEnd,
      timezone: "America/Los_Angeles",
    });
    expect(out).toEqual([]);
  });

  it("does not emit slots whose local-end exceeds close (tail boundary)", () => {
    // 17:30–18:00 local is a valid slot; 17:45–18:15 would not be (end > close).
    // We only enumerate :00 / :30 candidates, so this tests the <= close check.
    const hours: HoursJson = { mon: { open: "17:00", close: "18:00" } };
    // Window covering 17:00–18:30 local => 00:00–01:30 UTC TUE in PDT.
    const winStart = MON_0000 + 24 * 3600;       // 00:00 UTC TUE = 17:00 PDT MON
    const winEnd = MON_0000 + 24 * 3600 + 5400;  // 01:30 UTC TUE = 18:30 PDT MON
    const out = synthSlots({
      hours,
      window_start: winStart,
      window_end: winEnd,
      timezone: "America/Los_Angeles",
    });
    // Expect 2 slots: 17:00–17:30 and 17:30–18:00 local. 18:00–18:30 local is
    // OUT because 18:30 > close=18:00.
    expect(out).toHaveLength(2);
  });

  it("defaults to America/Los_Angeles when no timezone is passed", () => {
    const hours: HoursJson = { mon: { open: "08:00", close: "18:00" } };
    // 17:00 UTC MON = 10:00 PDT MON
    const winStart = MON_0000 + 17 * 3600;
    const winEnd = MON_0000 + 18 * 3600;
    const explicit = synthSlots({
      hours,
      window_start: winStart,
      window_end: winEnd,
      timezone: "America/Los_Angeles",
    });
    const defaulted = synthSlots({
      hours,
      window_start: winStart,
      window_end: winEnd,
    });
    expect(defaulted).toEqual(explicit);
  });
});

describe("get_availability — tool registration", () => {
  it("is registered on createMcpServer", async () => {
    process.env.DATABASE_PATH ??= ":memory:";
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { createMcpServer } = await import("../../routes/mcp.js");
    const s = createMcpServer();
    const names = Object.keys((s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(names).toContain("get_availability");
  });
});
