// Per-channel normalization tests.
//
// Each test feeds a raw metrics payload that mirrors what the
// corresponding adapter returns from the live API, then asserts the
// normalized output. The adapter shapes are documented at the top of
// each metricsSync/<channel>.metrics.js file.
//
// These tests run as pure logic — no DB, no Prisma, no network — so
// they import the normalizer directly. The downstream `computeAndSave-
// Insight` path that depends on Prisma is exercised in
// publishingService.test.js.

import { describe, it, expect, vi } from "vitest";

// classification.service.js + Prisma transitively pulled in by
// normalization.service.js — stub them so this test stays pure.
vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("../domains/studio/classification.service.js", () => ({
  classifyContent: () => ({}),
}));
vi.mock("../lib/timezone.js", () => ({
  getClientTimezone: async () => "UTC",
}));

const { normalizeRawMetrics } = await import(
  "../domains/studio/normalization.service.js"
);

describe("normalizeRawMetrics — INSTAGRAM", () => {
  it("sums likes + comments + saves + shares into engagements", () => {
    const r = normalizeRawMetrics("INSTAGRAM", {
      impressions: 1000,
      reach: 800,
      likes: 50,
      comments: 10,
      saves: 5,
      shares: 3,
    });
    expect(r.engagements).toBe(68);
    expect(r.impressions).toBe(1000);
    expect(r.reach).toBe(800);
    // engagementRate = engagements / impressions
    expect(r.engagementRate).toBeCloseTo(68 / 1000, 5);
  });

  it("falls back to reach when impressions missing (Meta IG-API 2024 deprecation)", () => {
    const r = normalizeRawMetrics("INSTAGRAM", {
      reach: 500,
      likes: 25,
      comments: 5,
      saves: 0,
      shares: 0,
    });
    expect(r.engagementRate).toBeCloseTo(30 / 500, 5);
  });

  it("treats missing fields as zero, never NaN", () => {
    const r = normalizeRawMetrics("INSTAGRAM", { impressions: 100 });
    expect(r.engagements).toBe(0);
    expect(r.engagementRate).toBe(0);
  });
});

describe("normalizeRawMetrics — LINKEDIN", () => {
  it("counts likes + comments + shares (the names the adapter actually returns)", () => {
    // This is the bug from spinstr359: prior normalizer expected
    // `reactions`/`reposts` but adapter sends `likes`/`shares` —
    // produced 0 engagement on every LinkedIn post.
    const r = normalizeRawMetrics("LINKEDIN", {
      impressions: 2000,
      clicks: 12,
      likes: 40,
      comments: 8,
      shares: 6,
    });
    expect(r.engagements).toBe(54);
    expect(r.engagementRate).toBeCloseTo(54 / 2000, 5);
  });

  it("also accepts the legacy reactions/reposts naming (forward compat)", () => {
    const r = normalizeRawMetrics("LINKEDIN", {
      impressions: 1000,
      reactions: 30,
      comments: 5,
      reposts: 5,
    });
    expect(r.engagements).toBe(40);
  });
});

describe("normalizeRawMetrics — X", () => {
  it("includes bookmarks in engagement (X's save signal)", () => {
    const r = normalizeRawMetrics("X", {
      impressions: 5000,
      likes: 100,
      retweets: 20,
      replies: 5,
      bookmarks: 30,
    });
    // 100 + 20 + 5 + 30 = 155
    expect(r.engagements).toBe(155);
    expect(r.engagementRate).toBeCloseTo(155 / 5000, 5);
  });

  it("accepts public_metrics raw shape (impression_count, like_count, …)", () => {
    const r = normalizeRawMetrics("X", {
      impression_count: 1000,
      like_count: 10,
      retweet_count: 2,
      reply_count: 1,
      bookmark_count: 4,
    });
    expect(r.impressions).toBe(1000);
    expect(r.engagements).toBe(17);
  });
});

describe("normalizeRawMetrics — YOUTUBE", () => {
  it("uses views as impressions and computes engagement rate from views", () => {
    const r = normalizeRawMetrics("YOUTUBE", {
      views: 10000,
      likes: 200,
      comments: 50,
    });
    expect(r.impressions).toBe(10000);
    expect(r.engagements).toBe(250);
    expect(r.engagementRate).toBeCloseTo(250 / 10000, 5);
  });

  it("accepts raw statistics camelCase (viewCount, likeCount, commentCount)", () => {
    const r = normalizeRawMetrics("YOUTUBE", {
      viewCount: 5000,
      likeCount: 100,
      commentCount: 20,
    });
    expect(r.impressions).toBe(5000);
    expect(r.engagements).toBe(120);
  });
});

describe("normalizeRawMetrics — TIKTOK", () => {
  it("matches adapter's likes/comments/shares/views naming", () => {
    const r = normalizeRawMetrics("TIKTOK", {
      views: 8000,
      likes: 400,
      comments: 30,
      shares: 50,
    });
    expect(r.impressions).toBe(8000);
    expect(r.engagements).toBe(480);
    expect(r.engagementRate).toBeCloseTo(480 / 8000, 5);
  });

  it("zero views returns null engagementRate (avoids divide-by-zero)", () => {
    const r = normalizeRawMetrics("TIKTOK", { views: 0, likes: 0, comments: 0, shares: 0 });
    expect(r.engagementRate).toBeNull();
    expect(r.impressions).toBeNull();
  });
});

describe("normalizeRawMetrics — FACEBOOK", () => {
  it("counts reactions + comments + shares", () => {
    const r = normalizeRawMetrics("FACEBOOK", {
      impressions: 3000,
      reach: 2500,
      reactions: 100,
      comments: 15,
      shares: 10,
      clicks: 25,
    });
    expect(r.engagements).toBe(125);
    expect(r.engagementRate).toBeCloseTo(125 / 3000, 5);
  });
});

describe("normalizeRawMetrics — unsupported channel", () => {
  it("returns nulls (not an exception) for an unknown channel", () => {
    const r = normalizeRawMetrics("MYSPACE", { likes: 100 });
    expect(r).toEqual({
      impressions: null,
      reach: null,
      engagements: null,
      clicks: null,
      engagementRate: null,
    });
  });

  it("handles undefined raw payload defensively", () => {
    expect(() => normalizeRawMetrics("INSTAGRAM", {})).not.toThrow();
    const r = normalizeRawMetrics("INSTAGRAM", {});
    expect(r.engagements).toBe(0);
  });
});
