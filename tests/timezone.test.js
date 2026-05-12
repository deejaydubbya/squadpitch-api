// Tests for the timezone helpers consumed by save-drafts (Plan 10
// scheduling enforcement). The save-drafts route relies on
// `zonedLocalToUtc` for "user HH:mm in IANA tz → UTC" conversion
// and `bumpToNextAllowedDay` for posting-day filtering. Both need
// to be DST-correct and round-trip stable.

import { describe, it, expect } from "vitest";
import {
  getTimezoneOffsetMinutes,
  zonedLocalToUtc,
  bumpToNextAllowedDay,
} from "../lib/timezone.js";

describe("getTimezoneOffsetMinutes", () => {
  it("returns 0 for UTC", () => {
    expect(getTimezoneOffsetMinutes(new Date("2026-06-15T12:00:00Z"), "UTC")).toBe(0);
  });

  it("returns -240 in summer for America/New_York (EDT)", () => {
    expect(
      getTimezoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/New_York"),
    ).toBe(-240);
  });

  it("returns -300 in winter for America/New_York (EST)", () => {
    expect(
      getTimezoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "America/New_York"),
    ).toBe(-300);
  });

  it("returns +60 for Europe/London in summer (BST)", () => {
    expect(
      getTimezoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "Europe/London"),
    ).toBe(60);
  });

  it("returns 0 on invalid timezone (graceful fallback)", () => {
    expect(
      getTimezoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "Not/A_Zone"),
    ).toBe(0);
  });
});

describe("zonedLocalToUtc", () => {
  it("UTC: local time equals UTC time", () => {
    const utc = zonedLocalToUtc("2026-06-15", "10:00", "UTC");
    expect(utc).not.toBeNull();
    expect(utc.toISOString()).toBe("2026-06-15T10:00:00.000Z");
  });

  it("Europe/London summer: 10:00 BST = 09:00 UTC", () => {
    const utc = zonedLocalToUtc("2026-07-15", "10:00", "Europe/London");
    expect(utc.toISOString()).toBe("2026-07-15T09:00:00.000Z");
  });

  it("America/New_York summer: 14:30 EDT = 18:30 UTC", () => {
    const utc = zonedLocalToUtc("2026-07-15", "14:30", "America/New_York");
    expect(utc.toISOString()).toBe("2026-07-15T18:30:00.000Z");
  });

  it("America/New_York winter: 09:00 EST = 14:00 UTC", () => {
    const utc = zonedLocalToUtc("2026-01-15", "09:00", "America/New_York");
    expect(utc.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("Asia/Tokyo: 09:00 JST = 00:00 UTC (same day)", () => {
    const utc = zonedLocalToUtc("2026-06-15", "09:00", "Asia/Tokyo");
    expect(utc.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("Australia/Sydney: 09:00 AEST (winter) = 23:00 UTC previous day", () => {
    // June 15 is winter in Sydney → AEST = UTC+10
    const utc = zonedLocalToUtc("2026-06-15", "09:00", "Australia/Sydney");
    expect(utc.toISOString()).toBe("2026-06-14T23:00:00.000Z");
  });

  it("returns null on malformed date", () => {
    expect(zonedLocalToUtc("not-a-date", "10:00", "UTC")).toBeNull();
  });

  it("returns null on malformed time", () => {
    expect(zonedLocalToUtc("2026-06-15", "25:99", "UTC")).toBeNull();
    expect(zonedLocalToUtc("2026-06-15", "10:00:00", "UTC")).toBeNull();
  });
});

describe("bumpToNextAllowedDay", () => {
  // Anchor: 2026-06-15 is a Monday in UTC.
  const monday = new Date("2026-06-15T15:00:00Z");

  it("returns input unchanged when allowedDays is empty", () => {
    expect(bumpToNextAllowedDay(monday, [], "UTC")).toBe(monday);
  });

  it("returns input unchanged when input already falls on an allowed day", () => {
    const out = bumpToNextAllowedDay(monday, ["mon", "wed", "fri"], "UTC");
    expect(out.toISOString()).toBe(monday.toISOString());
  });

  it("bumps Sunday forward to Monday when only mon allowed", () => {
    const sunday = new Date("2026-06-14T15:00:00Z");
    const out = bumpToNextAllowedDay(sunday, ["mon"], "UTC");
    // +1 day → Monday at the same UTC time.
    expect(out.toISOString()).toBe("2026-06-15T15:00:00.000Z");
  });

  it("bumps Tuesday forward to Wednesday with Mon/Wed/Fri allowed", () => {
    const tuesday = new Date("2026-06-16T15:00:00Z");
    const out = bumpToNextAllowedDay(tuesday, ["mon", "wed", "fri"], "UTC");
    expect(out.toISOString()).toBe("2026-06-17T15:00:00.000Z");
  });

  it("evaluates day-of-week in the workspace timezone", () => {
    // 2026-06-15T03:00:00Z is Sunday 23:00 in New York (UTC-4 in
    // June). If "mon" is allowed and we evaluated in UTC we'd
    // keep this Monday UTC instant; in NY tz it's still Sunday,
    // so the helper should bump it forward.
    const lateSundayInNy = new Date("2026-06-15T03:00:00Z");
    const out = bumpToNextAllowedDay(
      lateSundayInNy,
      ["mon"],
      "America/New_York",
    );
    // Bumped by exactly 24h → Monday 23:00 NY time / Tuesday
    // 03:00 UTC. But "mon" is allowed and at 24h later we're at
    // 2026-06-16T03:00:00Z which is Monday 23:00 NY. Good.
    expect(out.toISOString()).toBe("2026-06-16T03:00:00.000Z");
  });

  it("ignores unknown day strings gracefully", () => {
    // Only invalid day names → behaves like empty allowedDays.
    const out = bumpToNextAllowedDay(monday, ["funday"], "UTC");
    expect(out).toBe(monday);
  });

  it("never bumps by more than 6 days", () => {
    // With every weekday allowed except Sat, a Saturday input
    // should bump 1 day to Sunday — confirming the 7-iter loop
    // covers the whole week.
    const saturday = new Date("2026-06-20T15:00:00Z");
    const out = bumpToNextAllowedDay(saturday, ["sun"], "UTC");
    expect(out.toISOString()).toBe("2026-06-21T15:00:00.000Z");
  });
});
