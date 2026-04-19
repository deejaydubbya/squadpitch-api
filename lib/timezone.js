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
