import { describe, it, expect } from "vitest";
import { JudgeParseError, parseJudgeOutput } from "./judges.js";

/* parseJudgeOutput must throw structured errors on malformed model
 * output, not return a silent zero. The silent-zero behavior was the
 * Bug 3 root cause: an unparseable response looked identical to a
 * genuine 1/10 score after the score was clamped, and the audit page
 * happily displayed "your site scored 0/10" to the user. */

describe("parseJudgeOutput — happy path", () => {
  it("parses a clean JSON response and clamps score to [1,10]", () => {
    const raw = `{"citability_score": 8, "would_cite": true, "reasoning": "Solid schema."}`;
    const out = parseJudgeOutput(raw);
    expect(out.citability_score).toBe(8);
    expect(out.would_cite).toBe(true);
    expect(out.reasoning).toBe("Solid schema.");
  });

  it("clamps a score above 10 down to 10", () => {
    const raw = `{"citability_score": 99, "would_cite": true, "reasoning": "x"}`;
    expect(parseJudgeOutput(raw).citability_score).toBe(10);
  });

  it("clamps a score below 1 up to 1", () => {
    const raw = `{"citability_score": -3, "would_cite": false, "reasoning": "x"}`;
    expect(parseJudgeOutput(raw).citability_score).toBe(1);
  });

  it("rounds a fractional score to the nearest integer", () => {
    const raw = `{"citability_score": 7.6, "would_cite": false, "reasoning": "x"}`;
    expect(parseJudgeOutput(raw).citability_score).toBe(8);
  });

  it("coerces would_cite truthy values to true", () => {
    const raw = `{"citability_score": 5, "would_cite": "yes", "reasoning": "x"}`;
    expect(parseJudgeOutput(raw).would_cite).toBe(true);
  });

  it("falls back to empty string when reasoning is missing", () => {
    const raw = `{"citability_score": 5, "would_cite": false}`;
    expect(parseJudgeOutput(raw).reasoning).toBe("");
  });

  it("tolerates leading/trailing prose around the JSON block", () => {
    const raw = `Here is my judgment:\n{"citability_score": 6, "would_cite": false, "reasoning": "ok"}\nDone.`;
    expect(parseJudgeOutput(raw).citability_score).toBe(6);
  });
});

describe("parseJudgeOutput — error paths", () => {
  it("throws no_json_block when response has no curly braces", () => {
    try {
      parseJudgeOutput("the model refused to answer");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeParseError);
      expect((e as JudgeParseError).stage).toBe("no_json_block");
      expect((e as JudgeParseError).rawSnippet).toContain("the model refused");
    }
  });

  it("throws json_syntax when the {...} block is malformed", () => {
    try {
      parseJudgeOutput(`{"citability_score": 5, would_cite: nope}`);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeParseError);
      expect((e as JudgeParseError).stage).toBe("json_syntax");
    }
  });

  it("throws missing_field when citability_score is absent", () => {
    try {
      parseJudgeOutput(`{"would_cite": true, "reasoning": "no score"}`);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeParseError);
      expect((e as JudgeParseError).stage).toBe("missing_field");
    }
  });

  it("throws field_type when citability_score is a string", () => {
    try {
      parseJudgeOutput(`{"citability_score": "high", "would_cite": true, "reasoning": "x"}`);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeParseError);
      expect((e as JudgeParseError).stage).toBe("field_type");
    }
  });

  it("throws field_type when citability_score is null", () => {
    // null is distinct from missing — JSON.parse returns it as the value.
    // null short-circuits the missing_field check (=== null) so we get
    // missing_field, which is the right reason for "the model omitted
    // a real value." Lock that behavior in.
    try {
      parseJudgeOutput(`{"citability_score": null, "would_cite": true, "reasoning": "x"}`);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeParseError);
      expect((e as JudgeParseError).stage).toBe("missing_field");
    }
  });

  it("throws field_type when citability_score is NaN", () => {
    // JSON doesn't have NaN, but a model could emit something we
    // serialize through JSON.parse that becomes non-finite. Guard
    // against it.
    try {
      // Forge a NaN by manually invoking parse on a number-ish string
      // — JSON.parse("NaN") fails, so this will hit json_syntax first.
      // Instead, validate the Number.isFinite branch via a synthetic
      // case where the model returns Infinity (not valid JSON anyway).
      // We still want to confirm the guard exists; smoke-test with a
      // weird-but-parseable case.
      parseJudgeOutput(`{"citability_score": 1e500, "would_cite": true, "reasoning": "x"}`);
      // 1e500 parses to Infinity in JSON.parse → !isFinite → field_type
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeParseError);
      expect((e as JudgeParseError).stage).toBe("field_type");
    }
  });

  it("preserves up to 500 chars of raw response in the error", () => {
    const long = "x".repeat(800) + "{not-json}";
    try {
      parseJudgeOutput(long);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeParseError);
      // The first {...} block IS captured (we hit json_syntax, not
      // no_json_block), but the rawSnippet is the full input clipped
      // to 500 chars, which is what we want for postmortem visibility.
      expect((e as JudgeParseError).rawSnippet.length).toBeLessThanOrEqual(500);
      expect((e as JudgeParseError).rawSnippet.length).toBeGreaterThan(0);
    }
  });
});
