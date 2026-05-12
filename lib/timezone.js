// Timezone-aware date helpers for analytics.
//
// Uses Intl.DateTimeFormat (built into Node.js, no dependencies).
// All functions accept an IANA timezone string (e.g. "America/New_York")
// and fall back to UTC on invalid input.

import { prisma } from '../prisma.js';

/**
 * Get the local hour (0-23) for a Date in the given timezone.
 */
export function getLocalHour(date, timezone = 'UTC') {
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(date);
    return parseInt(hour, 10);
  } catch {
    return date.getUTCHours();
  }
}

/**
 * Get the local date string (YYYY-MM-DD) for a Date in the given timezone.
 * Uses en-CA locale which outputs YYYY-MM-DD natively.
 */
export function getLocalDateString(date, timezone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Get midnight of "today" in the given timezone, returned as a UTC Date.
 * Used for snapshot date keys — stores the local date as midnight UTC.
 */
export function getLocalMidnight(timezone = 'UTC') {
  const localDate = getLocalDateString(new Date(), timezone);
  return new Date(localDate + 'T00:00:00Z');
}

/**
 * Get the start-of-week date key (YYYY-MM-DD) for a Date in the given timezone.
 * Week starts on Sunday (day 0). Returns the local date of the preceding Sunday.
 */
export function getLocalWeekKey(date, timezone = 'UTC') {
  try {
    // Get local year/month/day parts
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).formatToParts(date);

    const year = parseInt(parts.find((p) => p.type === 'year').value, 10);
    const month = parseInt(parts.find((p) => p.type === 'month').value, 10);
    const day = parseInt(parts.find((p) => p.type === 'day').value, 10);

    // Get day-of-week (0=Sun..6=Sat) from the local date
    const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      parts.find((p) => p.type === 'weekday').value
    );

    // Subtract dayOfWeek to get Sunday
    const localDate = new Date(year, month - 1, day - dayOfWeek);
    const y = localDate.getFullYear();
    const m = String(localDate.getMonth() + 1).padStart(2, '0');
    const d = String(localDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  } catch {
    // Fallback to UTC
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Fetch the timezone for a client. Returns 'UTC' if not set.
 */
export async function getClientTimezone(clientId) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { timezone: true },
  });
  return client?.timezone || 'UTC';
}

/**
 * Compute the timezone offset (in minutes east of UTC) for a given
 * UTC instant in an IANA timezone. Handles DST correctly because
 * the offset is resolved against the actual UTC instant, not the
 * wall-clock interpretation.
 *
 * Example: getTimezoneOffsetMinutes(new Date('2026-07-04T15:00:00Z'),
 * 'America/New_York') → -240 (EDT, July).
 *           getTimezoneOffsetMinutes(new Date('2026-01-04T15:00:00Z'),
 * 'America/New_York') → -300 (EST, January).
 */
export function getTimezoneOffsetMinutes(utcDate, timezone = 'UTC') {
  if (timezone === 'UTC') return 0;
  try {
    // Format the UTC instant in the target timezone, extracting the
    // wall-clock parts. Reconstructing those parts as UTC and
    // subtracting from the original instant gives the offset.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(utcDate);

    const lookup = (type) =>
      parseInt(parts.find((p) => p.type === type).value, 10);
    const year = lookup('year');
    const month = lookup('month');
    const day = lookup('day');
    // Intl emits "24" for midnight in some locales; Date.UTC handles
    // that fine but normalize defensively.
    const rawHour = lookup('hour');
    const hour = rawHour === 24 ? 0 : rawHour;
    const minute = lookup('minute');
    const second = lookup('second');

    const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    return Math.round((wallAsUtc - utcDate.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * Given a calendar date (YYYY-MM-DD) and time-of-day (HH:mm) in a
 * specific timezone, return the corresponding UTC Date. DST-safe.
 *
 * `localDate` — "YYYY-MM-DD" (matches the format the assistant
 *               session stores).
 * `localTime` — "HH:mm" (24-hour).
 * `timezone` — IANA timezone (e.g. "America/New_York"). Defaults to
 *              UTC, so legacy callers without a timezone get the
 *              same result they got before.
 *
 * Returns `null` if the inputs are malformed — callers should fall
 * back to their own default so a bad value doesn't schedule posts
 * into the wrong day.
 *
 * DST note: in the "spring forward" gap (e.g. 02:30 on a DST
 * morning that doesn't exist) we still return a Date; it will land
 * one hour ahead in UTC. In the "fall back" overlap (02:30 happens
 * twice), we return the first occurrence. Both are acceptable for
 * social-post scheduling.
 */
export function zonedLocalToUtc(localDate, localTime, timezone = 'UTC') {
  if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    return null;
  }
  if (typeof localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    return null;
  }
  const [y, m, d] = localDate.split('-').map(Number);
  const [hh, mm] = localTime.split(':').map(Number);

  if (timezone === 'UTC') {
    return new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  }

  // First pass: pretend the local wall-clock is UTC.
  const wallAsUtc = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  // The timezone offset *at that instant* tells us how to adjust.
  const offsetMin = getTimezoneOffsetMinutes(wallAsUtc, timezone);
  // realUtc = wallAsUtc - offset (offset is east-of-UTC, so EST
  // -300 means UTC = local + 300 minutes).
  return new Date(wallAsUtc.getTime() - offsetMin * 60000);
}

const POSTING_DAY_TO_NUMBER = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Bump a UTC date forward to the next allowed day-of-week according
 * to `allowedDays` (subset of ["mon"…"sun"]). The day-of-week check
 * is performed in `timezone` so a Monday-only schedule actually
 * lands on Monday in the user's local calendar, not Sunday or
 * Tuesday somewhere in the world.
 *
 * If `allowedDays` is empty or invalid, returns `utcDate` unchanged
 * (preserves legacy behavior). The maximum bump is 6 days — beyond
 * that the input was already on an allowed day (no-op).
 */
export function bumpToNextAllowedDay(utcDate, allowedDays, timezone = 'UTC') {
  if (!Array.isArray(allowedDays) || allowedDays.length === 0) return utcDate;
  const allowedNums = new Set(
    allowedDays
      .map((d) => POSTING_DAY_TO_NUMBER[String(d).toLowerCase()])
      .filter((n) => typeof n === 'number'),
  );
  if (allowedNums.size === 0) return utcDate;

  for (let i = 0; i < 7; i += 1) {
    const candidate = new Date(utcDate.getTime() + i * 24 * 60 * 60 * 1000);
    // Day-of-week 0-6 in the user's timezone.
    let dow;
    try {
      const weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
      }).format(candidate);
      dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
    } catch {
      dow = candidate.getUTCDay();
    }
    if (allowedNums.has(dow)) return candidate;
  }
  // Shouldn't reach here — the loop covers every weekday. Fall back
  // to the input.
  return utcDate;
}
