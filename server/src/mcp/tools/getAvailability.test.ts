import { describe, it, expect } from "vitest";
import { synthSlots, type HoursJson } from "./getAvailability.js";

// Use a fixed Monday at midnight UTC. 2026-04-13 00:00 UTC is a Monday.
const MON_0000 = 1776038400;
const TUE_0000 = MON_0000 + 86400;

describe("synthSlots — pure function", () => {
  it("returns zero slots when the window intersects only closed days", () => {
    const hours: HoursJson = {};
    const out = synthSlots({ hours, window_start: MON_0000, window_end: MON_0000 + 86400 });
    expect(out).toEqual([]);
  });

  it("returns 2 half-hour slots for a 09:00–10:00 Monday", () => {
    const hours: HoursJson = { monday: { open: "09:00", close: "10:00" } };
    const out = synthSlots({ hours, window_start: MON_0000, window_end: TUE_0000 });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ start: MON_0000 + 9 * 3600, end: MON_0000 + 9 * 3600 + 1800, capacity: 1 });
    expect(out[1]).toEqual({ start: MON_0000 + 9 * 3600 + 1800, end: MON_0000 + 10 * 3600, capacity: 1 });
  });

  it("caps output at 48 slots even if the window is wider", () => {
    const hours: HoursJson = {
      monday: { open: "00:00", close: "23:59" },
      tuesday: { open: "00:00", close: "23:59" },
    };
    const out = synthSlots({ hours, window_start: MON_0000, window_end: MON_0000 + 3 * 86400 });
    expect(out.length).toBe(48);
  });

  it("drops a partial first slot when window_start lands mid-slot", () => {
    const hours: HoursJson = { monday: { open: "09:00", close: "10:00" } };
    const out = synthSlots({ hours, window_start: MON_0000 + 9 * 3600 + 600, window_end: TUE_0000 });
    // 09:10 UTC is inside the 09:00 slot, so the slotter must drop that slot and start at 09:30
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(MON_0000 + 9 * 3600 + 1800);
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
