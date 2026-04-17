// Post Timing Intelligence.
//
// Channel-specific optimal posting times based on general best practices.
// Used by planner suggestions to recommend scheduling times.
//
// Phase 1: Static best practices per channel.
// Phase 2 (future): Adapt based on performance data + audience activity.

// ── Optimal Time Windows ─────────────────────────────────────────────────

/**
 * Best posting times by channel (UTC offsets — caller adjusts for timezone).
 * Each entry: { hour, label, score } where score 0–100 indicates relative strength.
 */
export const CHANNEL_OPTIMAL_TIMES = {
  INSTAGRAM: [
    { hour: 7, label: "Early morning", score: 65 },
    { hour: 9, label: "Mid-morning", score: 80 },
    { hour: 12, label: "Lunch break", score: 90 },
    { hour: 17, label: "Evening commute", score: 85 },
    { hour: 19, label: "Evening wind-down", score: 75 },
  ],
  FACEBOOK: [
    { hour: 9, label: "Morning", score: 75 },
    { hour: 12, label: "Lunch break", score: 85 },
    { hour: 15, label: "Afternoon", score: 80 },
    { hour: 19, label: "Evening", score: 70 },
  ],
  TIKTOK: [
    { hour: 7, label: "Early morning", score: 70 },
    { hour: 10, label: "Late morning", score: 75 },
    { hour: 12, label: "Lunch break", score: 80 },
    { hour: 19, label: "Prime time", score: 95 },
    { hour: 21, label: "Late evening", score: 85 },
  ],
  LINKEDIN: [
    { hour: 8, label: "Pre-work", score: 85 },
    { hour: 10, label: "Mid-morning", score: 90 },
    { hour: 12, label: "Lunch", score: 80 },
    { hour: 17, label: "End of day", score: 70 },
  ],
  X: [
    { hour: 8, label: "Morning", score: 75 },
    { hour: 12, label: "Midday", score: 85 },
    { hour: 17, label: "Evening", score: 80 },
    { hour: 21, label: "Late night", score: 70 },
  ],
  YOUTUBE: [
    { hour: 12, label: "Lunch", score: 75 },
    { hour: 15, label: "Afternoon", score: 85 },
    { hour: 18, label: "Evening", score: 80 },
  ],
};

// ── Best Days ────────────────────────────────────────────────────────────

/**
 * Best posting days by channel (0 = Sunday, 1 = Monday, ..., 6 = Saturday).
 */
export const CHANNEL_BEST_DAYS = {
  INSTAGRAM: [1, 2, 3, 4], // Mon-Thu
  FACEBOOK: [2, 3, 4, 5], // Tue-Fri
  TIKTOK: [1, 2, 3, 4, 5], // Mon-Fri
  LINKEDIN: [1, 2, 3], // Mon-Wed
  X: [1, 2, 3, 4], // Mon-Thu
  YOUTUBE: [4, 5, 6], // Thu-Sat
};

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Get the best posting time for a given channel.
 *
 * @param {string} channel — INSTAGRAM, FACEBOOK, etc.
 * @returns {{ hour: number, label: string, score: number }}
 */
export function getBestTimeForChannel(channel) {
  const times = CHANNEL_OPTIMAL_TIMES[channel] ?? CHANNEL_OPTIMAL_TIMES.INSTAGRAM;
  return times.reduce((best, t) => (t.score > best.score ? t : best), times[0]);
}

/**
 * Get optimal hours sorted by score for a channel.
 *
 * @param {string} channel
 * @param {number} [limit] — max results
 * @returns {number[]} — array of hours
 */
export function getOptimalHours(channel, limit = 4) {
  const times = CHANNEL_OPTIMAL_TIMES[channel] ?? CHANNEL_OPTIMAL_TIMES.INSTAGRAM;
  return times
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((t) => t.hour);
}

/**
 * Get a timing suggestion object for frontend display.
 *
 * @param {string} channel
 * @returns {{ bestTime: string, bestDays: string, tip: string }}
 */
export function getTimingSuggestion(channel) {
  const best = getBestTimeForChannel(channel);
  const days = CHANNEL_BEST_DAYS[channel] ?? [1, 2, 3, 4, 5];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayLabels = days.map((d) => dayNames[d]).join(", ");

  const tips = {
    INSTAGRAM: "Instagram's algorithm favors consistent posting. Aim for 4-5 posts per week at peak times.",
    FACEBOOK: "Facebook rewards conversation starters. Post when your audience is most likely to comment.",
    TIKTOK: "TikTok's For You page is time-sensitive. Evening posts often get the most initial traction.",
    LINKEDIN: "LinkedIn engagement peaks during business hours. Professional content performs best mid-week.",
    X: "X moves fast — post when your audience is actively scrolling for maximum visibility.",
    YOUTUBE: "YouTube's algorithm favors weekend uploads when viewers have more time to watch.",
  };

  return {
    bestTime: `${best.hour}:00`,
    bestTimeLabel: best.label,
    bestDays: dayLabels,
    tip: tips[channel] ?? tips.INSTAGRAM,
  };
}

/**
 * Get all channel timing suggestions for frontend display.
 *
 * @returns {Record<string, object>}
 */
export function getAllTimingSuggestions() {
  const channels = Object.keys(CHANNEL_OPTIMAL_TIMES);
  const result = {};
  for (const ch of channels) {
    result[ch] = getTimingSuggestion(ch);
  }
  return result;
}
