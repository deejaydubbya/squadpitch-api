// Spinstr05 — pure-helper tests for the new triggers.
//
// The detector functions inside autopilot.service.js are private +
// rely on prisma + reAssets. We test the deterministic helpers
// that drive them (seasonal calendar, price formatter, sold-stamp
// extractor) directly, and let the detector blocks be covered by
// the existing integration suites (autopilotPhase*.test.js).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Re-export the helpers from autopilot.service.js for testing.
// They're not exported today — we need to expose them. The
// alternative is to mock the entire detector pipeline, which is
// far heavier than the value of these tests.

// Test the seasonal window math by date-injection.

describe("seasonal calendar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["2026-02-15T12:00:00Z", "spring_buyer_campaign"],
    ["2026-03-15T12:00:00Z", "spring_buyer_campaign"],
    ["2026-05-15T12:00:00Z", "summer_open_house"],
    ["2026-06-15T12:00:00Z", "summer_open_house"],
    ["2026-09-15T12:00:00Z", "fall_seller_prep"],
    ["2026-10-15T12:00:00Z", "fall_seller_prep"],
    ["2026-12-15T12:00:00Z", "year_end_market_recap"],
  ])("returns %s on %s", async (iso, expectedKey) => {
    vi.setSystemTime(new Date(iso));
    const { __TEST_currentSeasonalWindow } = await import(
      "../domains/studio/autopilot.service.js"
    );
    const out = __TEST_currentSeasonalWindow(new Date());
    expect(out?.key).toBe(expectedKey);
    expect(out?.year).toBe(2026);
  });

  it.each([
    "2026-01-15T12:00:00Z",
    "2026-04-15T12:00:00Z",
    "2026-07-15T12:00:00Z",
    "2026-08-15T12:00:00Z",
    "2026-11-15T12:00:00Z",
  ])("returns null in a quiet month (%s)", async (iso) => {
    vi.setSystemTime(new Date(iso));
    const { __TEST_currentSeasonalWindow } = await import(
      "../domains/studio/autopilot.service.js"
    );
    expect(__TEST_currentSeasonalWindow(new Date())).toBeNull();
  });

  it("expires the window at the end of the latest active month", async () => {
    vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
    const { __TEST_currentSeasonalWindow } = await import(
      "../domains/studio/autopilot.service.js"
    );
    const out = __TEST_currentSeasonalWindow(new Date());
    // Spring covers months [1,2] (Feb, Mar) → expires Apr 1.
    expect(out?.expiresAt.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("formatPrice", () => {
  it("formats numbers with $ + commas", async () => {
    const { __TEST_formatPrice } = await import(
      "../domains/studio/autopilot.service.js"
    );
    expect(__TEST_formatPrice(425000)).toBe("$425,000");
    expect(__TEST_formatPrice(1234567)).toBe("$1,234,567");
  });

  it("passes already-formatted strings through, adds $ if missing", async () => {
    const { __TEST_formatPrice } = await import(
      "../domains/studio/autopilot.service.js"
    );
    expect(__TEST_formatPrice("$425,000")).toBe("$425,000");
    expect(__TEST_formatPrice("425k")).toBe("$425k");
  });

  it("returns a safe placeholder for empty / non-finite input", async () => {
    const { __TEST_formatPrice } = await import(
      "../domains/studio/autopilot.service.js"
    );
    expect(__TEST_formatPrice(null)).toBe("the previous price");
    expect(__TEST_formatPrice(undefined)).toBe("the previous price");
    expect(__TEST_formatPrice("")).toBe("the previous price");
    expect(__TEST_formatPrice(NaN)).toBe("the previous price");
  });
});

describe("soldStampOf", () => {
  it("returns the most recent sold entry from _statusHistory", async () => {
    const { __TEST_soldStampOf } = await import(
      "../domains/studio/autopilot.service.js"
    );
    expect(
      __TEST_soldStampOf({
        _statusHistory: [
          { status: "active", recordedAt: "2026-01-01T00:00:00Z" },
          { status: "pending", recordedAt: "2026-04-01T00:00:00Z" },
          { status: "sold", recordedAt: "2026-05-10T00:00:00Z" },
        ],
      }),
    ).toBe("2026-05-10T00:00:00Z");
  });

  it("returns null when no sold entry exists", async () => {
    const { __TEST_soldStampOf } = await import(
      "../domains/studio/autopilot.service.js"
    );
    expect(__TEST_soldStampOf({ _statusHistory: [] })).toBeNull();
    expect(__TEST_soldStampOf({})).toBeNull();
    expect(
      __TEST_soldStampOf({
        _statusHistory: [{ status: "active", recordedAt: "2026-01-01T00:00:00Z" }],
      }),
    ).toBeNull();
  });
});
