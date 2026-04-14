import { describe, it, expect } from "vitest";
import {
  OnboardingPayloadSchema,
  HoursSchema,
  ServicesV2Schema,
  PricingV2Schema,
  CredentialsSchema,
  RatingsSchema,
} from "./business.js";

describe("OnboardingPayloadSchema", () => {
  it("accepts a minimal valid payload", () => {
    const parsed = OnboardingPayloadSchema.parse({
      name: "Acme Plumbing",
      description: "Residential plumbing in Boise, ID",
      category: "plumber",
      location: "Boise, ID",
      services: ["drain cleaning", "water heater repair"],
      star_rating: 4.8,
      review_count: 120,
    });
    expect(parsed.name).toBe("Acme Plumbing");
    expect(parsed.services).toEqual(["drain cleaning", "water heater repair"]);
  });

  it("rejects star_rating outside 0–5", () => {
    expect(() =>
      OnboardingPayloadSchema.parse({
        name: "X",
        description: "Y",
        category: "plumber",
        location: "Z",
        services: ["a"],
        star_rating: 6,
        review_count: 0,
      })
    ).toThrow();
  });

  it("accepts full nested payload with hours, pricing, credentials", () => {
    const payload = {
      name: "Acme Plumbing",
      description: "24/7 plumbing",
      category: "plumber",
      location: "Boise, ID",
      services: ["drain"],
      star_rating: 4.9,
      review_count: 200,
      hours_json: {
        mon: { open: "08:00", close: "17:00" },
        tue: { open: "08:00", close: "17:00" },
        wed: { open: "08:00", close: "17:00" },
        thu: { open: "08:00", close: "17:00" },
        fri: { open: "08:00", close: "17:00" },
        sat: null,
        sun: null,
        emergency_24_7: true,
      },
      services_json_v2: {
        inclusions: ["licensed", "bonded"],
        exclusions: ["new construction"],
        specialties: ["tankless"],
        not_offered: ["septic"],
      },
      pricing_json_v2: {
        ranges: [{ service: "drain", min: 150, max: 400, unit: "job" }],
        call_for_quote: false,
        free_estimates: true,
      },
      credentials_json: {
        licenses: [{ name: "ID Master Plumber", number: "P-12345" }],
        insured: true,
        bonded: true,
        certifications: ["NATE"],
      },
      ratings_json: {
        google: { rating: 4.9, count: 180 },
        yelp: { rating: 4.7, count: 20 },
      },
      differentiators_text: "Only shop in Ada County with same-day service",
      customer_quotes_json: [
        { quote: "Saved my basement", author: "Jane D.", source: "google" },
      ],
      guarantee_text: "100% satisfaction or your money back",
      case_stories_json: [
        { title: "Emergency burst pipe", summary: "Arrived in 45 min" },
      ],
      lead_routing_json: {
        preferred_channel: "phone",
        phone: "208-555-0100",
        email: "leads@acme.example",
        form_url: "https://acme.example/contact",
      },
    };
    const parsed = OnboardingPayloadSchema.parse(payload);
    expect(parsed.hours_json?.emergency_24_7).toBe(true);
    expect(parsed.credentials_json?.licenses?.[0].number).toBe("P-12345");
  });

  it("rejects pricing range with min > max", () => {
    expect(() =>
      PricingV2Schema.parse({
        ranges: [{ service: "x", min: 500, max: 100, unit: "job" }],
        call_for_quote: false,
        free_estimates: false,
      })
    ).toThrow();
  });

  it("rejects hours with invalid time format", () => {
    expect(() =>
      HoursSchema.parse({
        mon: { open: "8am", close: "5pm" },
        tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
        emergency_24_7: false,
      })
    ).toThrow();
  });
});
