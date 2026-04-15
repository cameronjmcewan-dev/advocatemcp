import { describe, it, expect } from "vitest";
import { cursorBlock } from "./cursor.js";

describe("cursorBlock", () => {
  it("has the right name", () => {
    expect(cursorBlock.name).toBe("cursor");
  });

  it("emphasizes structured/code-friendly output", () => {
    const e = cursorBlock.emphasis.toLowerCase();
    expect(e).toMatch(/structur|code|developer|ide/);
  });

  it("mentions JSON or list-friendly format", () => {
    expect(cursorBlock.emphasis.toLowerCase()).toMatch(/json|list|bullet/);
  });
});
