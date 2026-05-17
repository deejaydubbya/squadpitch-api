// Industry registry contract — spinstr421.
//
// Pins:
//   - The 17 niches the onboarding selector renders.
//   - Only real_estate + car_sales are selectable.
//   - normalizeIndustryKey collapses legacy labels + alias ids
//     to the canonical key.
//   - Compliance flag set on the right profiles.

import { describe, it, expect } from "vitest";

import {
  listIndustryProfiles,
  getIndustryOptionsForUI,
  isIndustryKeySelectable,
  isValidIndustryKey,
  normalizeIndustryKey,
} from "../domains/industry/registry.js";

describe("industry registry — list + status", () => {
  it("returns the 17 niches spec'd by spinstr421", () => {
    const keys = listIndustryProfiles().map((p) => p.key);
    expect(keys).toEqual([
      "real_estate",
      "car_sales",
      "property_management",
      "ecommerce",
      "mortgage",
      "insurance",
      "legal",
      "finance",
      "home_services",
      "medical_dental_wellness",
      "fitness",
      "restaurant",
      "beauty",
      "events_entertainment",
      "creator",
      "small_business",
      "other",
    ]);
  });

  it("only real_estate and car_sales are selectable today", () => {
    const ui = getIndustryOptionsForUI();
    const selectable = ui.filter((o) => o.isSelectable).map((o) => o.key);
    expect(selectable).toEqual(["real_estate", "car_sales"]);
  });

  it("isIndustryKeySelectable returns true for active niches, false for coming-soon", () => {
    expect(isIndustryKeySelectable("real_estate")).toBe(true);
    expect(isIndustryKeySelectable("car_sales")).toBe(true);
    expect(isIndustryKeySelectable("mortgage")).toBe(false);
    expect(isIndustryKeySelectable("medical_dental_wellness")).toBe(false);
    expect(isIndustryKeySelectable("nonexistent")).toBe(false);
  });

  it("flags compliance-sensitive niches (legal / finance / mortgage / insurance / medical)", () => {
    const ui = getIndustryOptionsForUI();
    const compliance = ui.filter((o) => o.isComplianceSensitive).map((o) => o.key).sort();
    expect(compliance).toEqual(
      ["finance", "insurance", "legal", "medical_dental_wellness", "mortgage"],
    );
  });
});

describe("normalizeIndustryKey — legacy label + alias support", () => {
  it("returns the input verbatim when it's already a valid canonical key", () => {
    expect(normalizeIndustryKey("real_estate")).toBe("real_estate");
    expect(normalizeIndustryKey("car_sales")).toBe("car_sales");
  });

  it("maps human-readable display labels back to canonical keys", () => {
    expect(normalizeIndustryKey("Real Estate")).toBe("real_estate");
    expect(normalizeIndustryKey("Mortgage & Loans")).toBe("mortgage");
    expect(normalizeIndustryKey("E-Commerce")).toBe("ecommerce");
    expect(normalizeIndustryKey("Fitness & Training")).toBe("fitness");
    expect(normalizeIndustryKey("Creator & Brand")).toBe("creator");
    expect(normalizeIndustryKey("Small Business")).toBe("small_business");
    expect(normalizeIndustryKey("Something Else")).toBe("other");
  });

  it("maps the prompt's longer canonical ids back to our snake_case keys", () => {
    expect(normalizeIndustryKey("property_management_rentals")).toBe(
      "property_management",
    );
    expect(normalizeIndustryKey("ecommerce_online_store")).toBe("ecommerce");
    expect(normalizeIndustryKey("mortgage_loan_officer")).toBe("mortgage");
    expect(normalizeIndustryKey("fitness_gym_personal_training")).toBe("fitness");
    expect(normalizeIndustryKey("something_else")).toBe("other");
  });

  it("is case-insensitive on label inputs", () => {
    expect(normalizeIndustryKey("REAL ESTATE")).toBe("real_estate");
    expect(normalizeIndustryKey("creator & brand")).toBe("creator");
  });

  it("falls back to 'other' for unknown / null / empty inputs", () => {
    expect(normalizeIndustryKey(null)).toBe("other");
    expect(normalizeIndustryKey(undefined)).toBe("other");
    expect(normalizeIndustryKey("")).toBe("other");
    expect(normalizeIndustryKey("nope")).toBe("other");
  });
});

describe("backward compat — existing workspaces", () => {
  it("preserves real_estate as a valid live key (no breaking rename)", () => {
    expect(isValidIndustryKey("real_estate")).toBe(true);
    expect(isIndustryKeySelectable("real_estate")).toBe(true);
  });

  it("preserves every existing snake_case key from the pre-spinstr421 registry", () => {
    for (const key of [
      "real_estate",
      "car_sales",
      "property_management",
      "ecommerce",
      "mortgage",
      "insurance",
      "legal",
      "finance",
      "home_services",
      "fitness",
      "restaurant",
      "beauty",
      "creator",
      "small_business",
      "other",
    ]) {
      expect(isValidIndustryKey(key)).toBe(true);
    }
  });
});
