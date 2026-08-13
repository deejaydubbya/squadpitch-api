import { describe, expect, it } from "vitest";
import { buildVerifiedPropertyFallback } from "../domains/prospects/prospect.service.js";

const item = { title: "978 US Rt 52", dataJson: { street: "978 US Rt 52", city: "Lewis Twp", state: "OH", zip: "45121", price: 425000, bedrooms: 3, bathrooms: 3, sqft: 1904, yearBuilt: 1979 } };

describe("prospect verified-facts fallback", () => {
  it.each(["INSTAGRAM", "FACEBOOK", "LINKEDIN"])("creates safe, distinct %s copy from stored facts", (channel) => {
    const body = buildVerifiedPropertyFallback(item, channel, "Erin Abbot");
    expect(body).toContain("978 US Rt 52, Lewis Twp, OH, 45121");
    expect(body).toContain("$425,000");
    expect(body).toContain("3 beds");
    expect(body).toContain("1,904 sq ft");
    expect(body).not.toMatch(/neighborhood|amenit|spacious|modern|opportunity/i);
  });

  it("keeps platform bodies meaningfully different", () => {
    const bodies = ["INSTAGRAM", "FACEBOOK", "LINKEDIN"].map((channel) => buildVerifiedPropertyFallback(item, channel, "Erin Abbot"));
    expect(new Set(bodies).size).toBe(3);
    expect(bodies[0]).toContain("🏡");
    expect(bodies[0]).toContain("#JustListed");
  });
});
