// Channel limits + generator-side enforcement tests.
//
// Two surfaces under test:
//   1. getMaxCharsForChannel — prefers a user override on the
//      ChannelSettings row; falls back to the platform default.
//   2. promptBuilder.buildUserPrompt — must always inject a
//      `Max characters: N` line in the prompt so the AI produces
//      content that fits the target platform, even when no
//      ChannelSettings row exists for that channel.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_CHARS_BY_CHANNEL,
  getMaxCharsForChannel,
} from "../domains/studio/channelLimits.js";
import { buildUserPrompt } from "../domains/studio/generation/promptBuilder.js";

describe("DEFAULT_MAX_CHARS_BY_CHANNEL", () => {
  it("covers every backend-supported channel with sensible platform limits", () => {
    expect(DEFAULT_MAX_CHARS_BY_CHANNEL.INSTAGRAM).toBe(2200);
    expect(DEFAULT_MAX_CHARS_BY_CHANNEL.TIKTOK).toBe(2200);
    expect(DEFAULT_MAX_CHARS_BY_CHANNEL.X).toBe(280);
    expect(DEFAULT_MAX_CHARS_BY_CHANNEL.LINKEDIN).toBe(3000);
    expect(DEFAULT_MAX_CHARS_BY_CHANNEL.LINKEDIN_ORGANIZATION_PAGE).toBe(3000);
    expect(DEFAULT_MAX_CHARS_BY_CHANNEL.FACEBOOK).toBe(63206);
    expect(DEFAULT_MAX_CHARS_BY_CHANNEL.YOUTUBE).toBe(5000);
    expect(DEFAULT_MAX_CHARS_BY_CHANNEL.PINTEREST).toBe(500);
    expect(DEFAULT_MAX_CHARS_BY_CHANNEL.THREADS).toBe(500);
  });
});

describe("getMaxCharsForChannel", () => {
  it("returns the user override when set", () => {
    expect(
      getMaxCharsForChannel("X", { maxChars: 200 })
    ).toBe(200);
  });

  it("falls back to the platform default when override is null", () => {
    expect(getMaxCharsForChannel("X", { maxChars: null })).toBe(280);
  });

  it("falls back to the platform default when no row exists", () => {
    expect(getMaxCharsForChannel("THREADS", null)).toBe(500);
    expect(getMaxCharsForChannel("THREADS", undefined)).toBe(500);
  });

  it("ignores zero / negative overrides (treats as unset)", () => {
    expect(getMaxCharsForChannel("INSTAGRAM", { maxChars: 0 })).toBe(2200);
    expect(getMaxCharsForChannel("INSTAGRAM", { maxChars: -5 })).toBe(2200);
  });

  it("returns null for unknown channels with no override", () => {
    expect(getMaxCharsForChannel("UNKNOWN", null)).toBeNull();
  });
});

describe("buildUserPrompt — channel max-chars instruction", () => {
  // Minimal ctx that the prompt builder is happy with. Fields outside
  // of channelSettings don't affect the assertion we care about.
  const baseCtx = { contentBuckets: [], channelSettings: [] };
  const baseArgs = {
    kind: "POST",
    channel: "THREADS",
    bucketKey: null,
    guidance: null,
    templateType: null,
    dataItem: null,
    blueprint: null,
    realEstateAssets: null,
    contentAngle: null,
  };

  it("always injects the platform default for THREADS even without a settings row", () => {
    const prompt = buildUserPrompt(baseCtx, baseArgs);
    expect(prompt).toContain("Max characters: 500");
  });

  it("injects 280 for X when no override is configured", () => {
    const prompt = buildUserPrompt(baseCtx, { ...baseArgs, channel: "X" });
    expect(prompt).toContain("Max characters: 280");
  });

  it("respects a user override over the default", () => {
    const ctx = {
      contentBuckets: [],
      channelSettings: [
        { channel: "INSTAGRAM", maxChars: 800, allowEmoji: true, trailingHashtags: [] },
      ],
    };
    const prompt = buildUserPrompt(ctx, { ...baseArgs, channel: "INSTAGRAM" });
    expect(prompt).toContain("Max characters: 800");
    expect(prompt).not.toContain("Max characters: 2200");
  });

  it("falls back to default when row exists but maxChars is null", () => {
    const ctx = {
      contentBuckets: [],
      channelSettings: [
        { channel: "PINTEREST", maxChars: null, allowEmoji: true, trailingHashtags: [] },
      ],
    };
    const prompt = buildUserPrompt(ctx, { ...baseArgs, channel: "PINTEREST" });
    expect(prompt).toContain("Max characters: 500");
  });

  it("includes the body+hashtags combined-limit clarification", () => {
    const prompt = buildUserPrompt(baseCtx, baseArgs);
    expect(prompt).toContain("body text AND all hashtags combined");
  });
});
