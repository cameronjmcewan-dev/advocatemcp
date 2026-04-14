import { describe, it, expect } from "vitest";
import { validateOnboardingPayload } from "./validateOnboarding.js";

describe("validateOnboardingPayload", () => {
  it("accepts minimal payload", () => {
    const r = validateOnboardingPayload({
      name: "A", description: "B", category: "c", location: "l",
      services: ["s"], star_rating: 4.5, review_count: 10,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects missing name", () => {
    const r = validateOnboardingPayload({ description: "B" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(",")).toContain("name");
  });

  it("rejects star_rating > 5", () => {
    const r = validateOnboardingPayload({
      name: "A", description: "B", category: "c", location: "l",
      services: ["s"], star_rating: 6, review_count: 0,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts nested hours_json and credentials_json", () => {
    const r = validateOnboardingPayload({
      name: "A", description: "B", category: "c", location: "l",
      services: ["s"], star_rating: 4.5, review_count: 10,
      hours_json: {
        mon: { open: "08:00", close: "17:00" },
        tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
        emergency_24_7: true,
      },
      credentials_json: {
        licenses: [{ name: "X", number: "1" }],
        insured: true, bonded: false, certifications: [],
      },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects invalid email in lead_routing_json", () => {
    const r = validateOnboardingPayload({
      name: "A", description: "B", category: "c", location: "l",
      services: ["s"], star_rating: 4.5, review_count: 10,
      lead_routing_json: { preferred_channel: "email", email: "not-an-email" },
    });
    expect(r.ok).toBe(false);
  });
});
