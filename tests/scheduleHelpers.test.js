// Timezone-aware auto-schedule helper tests.
//
// These prove that 9 / 12 / 15 / 18 are interpreted as LOCAL time in the
// workspace's IANA zone, not as UTC, and that no slot ever lands in the
// past.

import { describe, it, expect } from "vitest";
import {
  zonedDateToUtc,
  computeAutoScheduleSlots,
  resolveClientTimezone,
  isValidTimeZone,
} from "../lib/scheduleHelpers.js";

function getZonedHour(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  return Number(fmt.format(date));
}

describe("isValidTimeZone", () => {
  it("accepts known IANA zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects garbage and non-strings", () => {
    expect(isValidTimeZone("Bogus/Zone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});

describe("resolveClientTimezone", () => {
  it("returns the supplied zone when valid", () => {
    expect(resolveClientTimezone("America/Chicago")).toEqual({
      timezone: "America/Chicago",
      fellBack: false,
    });
  });

  it("falls back when null/empty/invalid", () => {
    const out = resolveClientTimezone(null);
    expect(out.fellBack).toBe(true);
    expect(out.timezone).toBe("America/New_York");
  });
});

describe("zonedDateToUtc", () => {
  it("America/New_York 9am locally → 13:00 or 14:00 UTC depending on DST", () => {
    const utc = zonedDateToUtc(2026, 6, 1, 9, 0, "America/New_York"); // EDT (UTC-4)
    expect(getZonedHour(utc, "America/New_York")).toBe(9);
    expect(utc.getUTCHours()).toBe(13);
  });

  it("America/Los_Angeles 9am locally → 16:00 or 17:00 UTC", () => {
    const utc = zonedDateToUtc(2026, 6, 1, 9, 0, "America/Los_Angeles"); // PDT (UTC-7)
    expect(getZonedHour(utc, "America/Los_Angeles")).toBe(9);
    expect(utc.getUTCHours()).toBe(16);
  });

  it("Asia/Tokyo 9am locally → 00:00 UTC", () => {
    const utc = zonedDateToUtc(2026, 6, 1, 9, 0, "Asia/Tokyo"); // JST (UTC+9)
    expect(getZonedHour(utc, "Asia/Tokyo")).toBe(9);
    expect(utc.getUTCHours()).toBe(0);
  });
});

describe("computeAutoScheduleSlots", () => {
  it("renders 9 / 12 / 15 / 18 local in the requested zone", () => {
    const tz = "America/Los_Angeles";
    const from = new Date("2026-06-01T00:00:00Z"); // mid-day previous day in LA
    const slots = computeAutoScheduleSlots({ count: 4, timeZone: tz, from });
    const hours = slots.map((d) => getZonedHour(d, tz));
    // Across the four optimal hours within the day(s).
    expect(hours).toEqual([9, 12, 15, 18]);
  });

  it("renders local hours for America/New_York too", () => {
    const tz = "America/New_York";
    const from = new Date("2026-06-01T00:00:00Z");
    const slots = computeAutoScheduleSlots({ count: 4, timeZone: tz, from });
    const hours = slots.map((d) => getZonedHour(d, tz));
    expect(hours).toEqual([9, 12, 15, 18]);
  });

  it("never returns a slot in the past", () => {
    const tz = "America/Los_Angeles";
    const now = new Date();
    const slots = computeAutoScheduleSlots({ count: 8, timeZone: tz, from: now });
    for (const s of slots) {
      expect(s.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("falls back to a safe default when timeZone is invalid", () => {
    const slots = computeAutoScheduleSlots({ count: 1, timeZone: "Bogus/Zone" });
    // 1 slot, valid Date, in the future.
    expect(slots).toHaveLength(1);
    expect(slots[0]).toBeInstanceOf(Date);
    expect(slots[0].getTime()).toBeGreaterThan(Date.now());
  });
});
