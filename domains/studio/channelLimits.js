// Per-channel default character limits.
//
// These are the *platform hard limits* — the longest a single post body
// (caption / description / tweet text) can be on each network. They feed
// two surfaces:
//
//  1. The generator (domains/studio/generation/promptBuilder.js) injects
//     the value into the model prompt as `Max characters: N (this limit
//     includes the body text AND all hashtags combined)`. The model
//     respects it, and downstream the publishing adapter rejects posts
//     that overflow anyway as a backstop.
//
//  2. The frontend ChannelSettings table shows them as placeholders so
//     users understand what's being enforced, and can tighten the cap
//     for a given workspace (e.g. a brand that prefers short FB posts).
//
// A user-saved ChannelSettings.maxChars override takes precedence; the
// values here are only used when no row exists or the row has maxChars
// set to null. Frontend mirror in squadpitch-web/src/lib/
// channelLimits.ts — keep them in sync.

export const DEFAULT_MAX_CHARS_BY_CHANNEL = {
  // Instagram caption — 2,200 chars is the documented limit.
  INSTAGRAM: 2200,
  // TikTok caption — 2,200 chars (was 300 historically; raised in 2022).
  TIKTOK: 2200,
  // X (Twitter) — 280 for standard accounts. Premium goes to 25,000 but
  // most posts target the original limit and engagement drops above it.
  X: 280,
  // LinkedIn UGC post body cap.
  LINKEDIN: 3000,
  LINKEDIN_ORGANIZATION_PAGE: 3000,
  // Facebook post body — official platform max. Practical engagement
  // tops out far below this; users can override per-workspace.
  FACEBOOK: 63206,
  // YouTube video description — 5,000 chars.
  YOUTUBE: 5000,
  // Pinterest pin description.
  PINTEREST: 500,
  // Threads post body — 500 chars hard cap.
  THREADS: 500,
};

/**
 * Returns the effective max-chars limit for a channel, preferring an
 * explicit user override on the ChannelSettings row, falling back to
 * the platform default. Returns null only if the channel is unknown.
 */
export function getMaxCharsForChannel(channel, channelCfg) {
  if (channelCfg && typeof channelCfg.maxChars === "number" && channelCfg.maxChars > 0) {
    return channelCfg.maxChars;
  }
  return DEFAULT_MAX_CHARS_BY_CHANNEL[channel] ?? null;
}
