/**
 * Tests for buildPageTitle — the normalized per-page <title> builder used
 * by every per-bot renderer (Claude / OpenAI / Google / Perplexity).
 *
 * Before this helper existed, each renderer hand-built titles with
 * slightly different templates, including "Business" and "the US"
 * filler-word fallbacks that AI extractors clipped into snippets as
 * placeholder-looking text. The helper enforces:
 *
 *   - Always leads with the canonical business name.
 *   - Appends category only when one exists.
 *   - Appends location only when one exists.
 *   - No "Business" or "the US" filler fallbacks.
 */

import { describe, it, expect } from "vitest";
import { buildPageTitle } from "./shared.js";

describe("buildPageTitle", () => {
  it("emits 'name — category | location' when all three are populated", () => {
    expect(buildPageTitle({
      name:     "Advocate",
      category: "ai-marketing-saas",
      location: "Austin, TX",
    })).toBe("Advocate — ai-marketing-saas | Austin, TX");
  });

  it("emits 'name — category' when location is missing", () => {
    expect(buildPageTitle({
      name:     "Advocate",
      category: "ai-marketing-saas",
      location: null,
    })).toBe("Advocate — ai-marketing-saas");
  });

  it("emits 'name | location' when category is missing", () => {
    expect(buildPageTitle({
      name:     "Advocate",
      category: null,
      location: "Austin, TX",
    })).toBe("Advocate | Austin, TX");
  });

  it("emits just 'name' when both category and location are missing", () => {
    expect(buildPageTitle({
      name:     "Advocate",
      category: null,
      location: null,
    })).toBe("Advocate");
  });

  it("never emits 'Business' or 'the US' filler fallbacks (regression catcher)", () => {
    // Pre-helper, claude.ts, openai.ts, google.ts, and perplexity.ts each
    // hand-built titles with `category ?? "Business"` and `location ?? "the US"`
    // fallbacks. Those filler strings made it into the rendered snippet
    // and read as placeholder text to AI extractors. The helper must
    // emit only real data — when a field is absent, its corresponding
    // delimiter+value chunk is omitted entirely.
    const titles = [
      buildPageTitle({ name: "Acme", category: null,             location: null }),
      buildPageTitle({ name: "Acme", category: "widgets",        location: null }),
      buildPageTitle({ name: "Acme", category: null,             location: "Austin, TX" }),
      buildPageTitle({ name: "Acme", category: "widgets",        location: "Austin, TX" }),
      buildPageTitle({ name: "Acme", category: undefined as never, location: undefined as never }),
    ];
    for (const t of titles) {
      expect(t).not.toContain("Business");
      expect(t).not.toContain("the US");
    }
  });

  it("treats empty / whitespace-only fields the same as null (no naked delimiters)", () => {
    // Without the trim guard, an empty-string category emits a dangling
    // " — " in the title — a punctuation orphan with no data behind it.
    // Same for location → naked " | ".
    expect(buildPageTitle({ name: "Acme", category: "", location: "" })).toBe("Acme");
    expect(buildPageTitle({ name: "Acme", category: "   ", location: "\t" })).toBe("Acme");
  });

  it("trims surrounding whitespace from category and location", () => {
    expect(buildPageTitle({
      name:     "Acme",
      category: "  widgets  ",
      location: "  Austin, TX  ",
    })).toBe("Acme — widgets | Austin, TX");
  });
});
