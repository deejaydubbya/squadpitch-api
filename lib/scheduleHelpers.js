// Helpers for timezone-aware scheduling. Auto-schedule treats
// "9 / 12 / 15 / 18" as local hours in the workspace's timezone, not as
// UTC. Without this helper the server's TZ (Fly.io = UTC) would put posts
// out at 1am / 4am / 7am / 10am for a US-Pacific user.
//
// We avoid pulling in `luxon` or `date-fns-tz` for one helper. The core
// trick is: format a candidate UTC instant in the target zone via
// `Intl.DateTimeFormat`, read back the wall-clock parts, and compute the
// offset from there.

const DEFAULT_FALLBACK_TIMEZONE = "America/New_York";

/** Validate that a string is a real IANA timezone name. */
export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the workspace's effective timezone, falling back safely.
 * Returns `{ timezone, fellBack: boolean }` so callers can log the fallback.
 */
export function resolveClientTimezone(rawTimezone) {
  if (isValidTimeZone(rawTimezone)) {
    return { timezone: rawTimezone, fellBack: false };
  }
  return { timezone: DEFAULT_FALLBACK_TIMEZONE, fellBack: true };
}

/**
 * Build a UTC Date whose local representation in `timeZone` is the given
 * year-month-day hour:minute. Single-pass offset reconstruction; accurate
 * within a few hours of a DST transition (auto-schedule never targets
 * those moments).
 *
 * @example zonedDateToUtc(2026, 5, 6, 9, 0, "America/Los_Angeles") returns
 *   the Date for 2026-05-06T16:00:00Z (= 9am PDT).
 */
export function zonedDateToUtc(year, month, day, hour, minute, timeZone) {
  // Step 1: assume the given numbers are UTC and compute that instant.
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Step 2: ask Intl what the wall clock in `timeZone` would be at that instant.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(naiveUtc)).map((p) => [p.type, p.value])
  );
  const localY = Number(parts.year);
  const localM = Number(parts.month);
  const localD = Number(parts.day);
  // Some locales return "24" for midnight — normalise to 0.
  const localH = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const localMin = Number(parts.minute);

  // Step 3: offset in ms = naiveUtc - localAsUtc.
  const localAsUtc = Date.UTC(localY, localM - 1, localD, localH, localMin, 0);
  const offsetMs = naiveUtc - localAsUtc;

  // Step 4: shift the naive UTC instant by that offset to land on the
  // moment whose local-in-zone reading is exactly (year, month, day, hour, minute).
  return new Date(naiveUtc + offsetMs);
}

/**
 * Compute auto-schedule slots starting from `from` (defaulting to "now").
 * Each slot is rendered as a `Date` (UTC) whose representation in
 * `timeZone` lands on one of the `optimalHours` (default
 * 9 / 12 / 15 / 18 local). Slots are spread across days at
 * `slotsPerDay` posts/day starting `startDayOffset` days after `from`.
 *
 * Skips slots that resolve to a moment in the past — auto-schedule must
 * never produce backdated `scheduledFor` values.
 *
 * @param {object} args
 * @param {number} args.count
 * @param {string} args.timeZone
 * @param {Date}   [args.from=new Date()]
 * @param {number[]} [args.optimalHours=[9,12,15,18]]
 * @param {number} [args.slotsPerDay=2]
 * @param {number} [args.startDayOffset=1]
 * @returns {Date[]} length-`count` array of UTC Date objects (in slot order).
 */
export function computeAutoScheduleSlots({
  count,
  timeZone,
  from = new Date(),
  optimalHours = [9, 12, 15, 18],
  slotsPerDay = 2,
  startDayOffset = 1,
}) {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_FALLBACK_TIMEZONE;

  // Anchor date = "today" in the target zone.
  const fromParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(from)
      .map((p) => [p.type, p.value])
  );
  const baseY = Number(fromParts.year);
  const baseM = Number(fromParts.month);
  const baseD = Number(fromParts.day);

  const slots = [];
  for (let i = 0; i < count; i++) {
    const dayOffset = Math.floor(i / slotsPerDay) + startDayOffset;
    const hour = optimalHours[i % optimalHours.length];

    // Build the local target via Date.UTC math, then map to a real
    // moment in `tz`.
    const baseUtc = Date.UTC(baseY, baseM - 1, baseD + dayOffset, 0, 0, 0);
    const targetD = new Date(baseUtc);
    const slot = zonedDateToUtc(
      targetD.getUTCFullYear(),
      targetD.getUTCMonth() + 1,
      targetD.getUTCDate(),
      hour,
      0,
      tz
    );

    // Defensive: never return a past slot.
    if (slot.getTime() <= from.getTime()) {
      // Push to the next slot day until we're in the future.
      let extraDays = 1;
      let safe = slot;
      while (safe.getTime() <= from.getTime() && extraDays < 30) {
        safe = zonedDateToUtc(
          targetD.getUTCFullYear(),
          targetD.getUTCMonth() + 1,
          targetD.getUTCDate() + extraDays,
          hour,
          0,
          tz
        );
        extraDays++;
      }
      slots.push(safe);
    } else {
      slots.push(slot);
    }
  }
  return slots;
}
