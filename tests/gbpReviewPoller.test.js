// GBP review poller — normalization + tick orchestration.
//
// Pins spinstr413 tasks F.4 (polling normalizes + calls
// ingestGbpReview) and F.10 (cross-workspace isolation — poller
// only touches CONNECTED locations belonging to the right
// workspace, never crosses).

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const cryptoMock = {
  decryptToken: vi.fn((t) => `plain:${t}`),
  encryptToken: vi.fn((t) => `enc:${t}`),
};
vi.mock("../lib/tokenCrypto.js", () => cryptoMock);

const oauthMock = {
  listReviews: vi.fn(),
  refreshAccessToken: vi.fn(),
};
vi.mock("../domains/studio/oauth/googleBusinessProfile.oauth.js", () => oauthMock);

const ingestMock = vi.fn();
vi.mock("../domains/inbox/inbox.gbp.ingestion.service.js", () => ({
  ingestGbpReview: (...args) => ingestMock(...args),
}));

const svc = await import("../domains/inbox/gbpReviewPoller.service.js");

beforeEach(() => {
  prismaMock = {
    channelConnection: {
      findMany: vi.fn(),
      update: vi.fn(async () => ({})),
    },
  };
  oauthMock.listReviews.mockReset();
  oauthMock.refreshAccessToken.mockReset();
  ingestMock.mockReset();
});

// ── normalizeGbpReview ─────────────────────────────────────────────────

describe("normalizeGbpReview", () => {
  it("converts the v4 review shape into the ingestion contract", () => {
    const raw = {
      name: "accounts/100/locations/A1/reviews/r1",
      starRating: "FOUR",
      comment: "Pretty good",
      reviewer: { displayName: "Alice", profilePhotoUrl: "https://lh3/...abc", isAnonymous: false },
      createTime: "2026-05-16T10:00:00Z",
      updateTime: "2026-05-16T10:00:00Z",
      reviewReply: null,
    };
    const norm = svc.normalizeGbpReview({ raw, locationName: "accounts/100/locations/A1" });
    expect(norm.reviewId).toBe("accounts/100/locations/A1/reviews/r1");
    expect(norm.locationName).toBe("accounts/100/locations/A1");
    expect(norm.starRating).toBe(4);
    expect(norm.comment).toBe("Pretty good");
    expect(norm.reviewer.displayName).toBe("Alice");
    expect(norm.reviewer.isAnonymous).toBe(false);
  });

  it("handles anonymous reviewers + null comments", () => {
    const norm = svc.normalizeGbpReview({
      raw: {
        name: "accounts/100/locations/A1/reviews/r2",
        starRating: "ONE",
        reviewer: { isAnonymous: true, displayName: "A Google User" },
        createTime: "2026-05-16T10:00:00Z",
      },
      locationName: "accounts/100/locations/A1",
    });
    expect(norm.starRating).toBe(1);
    expect(norm.comment).toBeNull();
    expect(norm.reviewer.isAnonymous).toBe(true);
    expect(norm.reviewer.googleId).toMatch(/^anon:/);
  });

  it("returns null for malformed payloads", () => {
    expect(svc.normalizeGbpReview({ raw: null, locationName: "x" })).toBeNull();
    expect(svc.normalizeGbpReview({ raw: {}, locationName: "x" })).toBeNull();
  });
});

// ── pollGbpReviewsForConnection ────────────────────────────────────────

describe("pollGbpReviewsForConnection", () => {
  it("skips connections that haven't completed the location picker", async () => {
    const summary = await svc.pollGbpReviewsForConnection({
      id: "conn-1",
      clientId: "client-1",
      externalAccountId: "accounts/100", // sentinel — no /locations/
      accessToken: "x",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    expect(summary.error).toBe("NO_LOCATION");
    expect(summary.fetched).toBe(0);
    expect(oauthMock.listReviews).not.toHaveBeenCalled();
  });

  it("lists reviews, normalizes each, and dispatches to ingestGbpReview", async () => {
    oauthMock.listReviews.mockResolvedValue([
      {
        name: "accounts/100/locations/A1/reviews/r1",
        starRating: "FIVE",
        comment: "Loved it",
        reviewer: { displayName: "Alice", isAnonymous: false },
        createTime: "2026-05-16T10:00:00Z",
      },
      {
        name: "accounts/100/locations/A1/reviews/r2",
        starRating: "ONE",
        reviewer: { isAnonymous: true, displayName: "A Google User" },
        createTime: "2026-05-16T11:00:00Z",
      },
    ]);
    ingestMock
      .mockResolvedValueOnce({ status: "created", conversationId: "c1", messageId: "m1" })
      .mockResolvedValueOnce({ status: "duplicate", conversationId: "c2", messageId: "m2" });

    const summary = await svc.pollGbpReviewsForConnection({
      id: "conn-1",
      clientId: "client-1",
      externalAccountId: "accounts/100/locations/A1",
      accessToken: "enc-token",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });

    expect(oauthMock.listReviews).toHaveBeenCalledWith(
      expect.objectContaining({
        locationName: "accounts/100/locations/A1",
        accessToken: "plain:enc-token",
      }),
    );
    expect(ingestMock).toHaveBeenCalledTimes(2);
    expect(summary.fetched).toBe(2);
    expect(summary.created).toBe(1);
    expect(summary.duplicate).toBe(1);
    expect(summary.error).toBeNull();
  });

  it("refreshes a near-expired token before listing reviews", async () => {
    oauthMock.refreshAccessToken.mockResolvedValue({
      accessToken: "AT-FRESH",
      expiresIn: 3600,
    });
    oauthMock.listReviews.mockResolvedValue([]);

    await svc.pollGbpReviewsForConnection({
      id: "conn-1",
      clientId: "client-1",
      externalAccountId: "accounts/100/locations/A1",
      accessToken: "enc-old-access",
      refreshToken: "enc-old-refresh",
      // expires in 30 seconds → inside the skew window
      tokenExpiresAt: new Date(Date.now() + 30_000),
    });

    expect(oauthMock.refreshAccessToken).toHaveBeenCalledTimes(1);
    // listReviews must use the NEW access token, not the stored one.
    expect(oauthMock.listReviews).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "AT-FRESH" }),
    );
  });

  it("returns a safe error summary when listReviews throws (no partial writes)", async () => {
    oauthMock.listReviews.mockRejectedValue(new Error("Quota exceeded"));
    const summary = await svc.pollGbpReviewsForConnection({
      id: "conn-1",
      clientId: "client-1",
      externalAccountId: "accounts/100/locations/A1",
      accessToken: "enc-token",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    expect(summary.fetched).toBe(0);
    expect(summary.error).toMatch(/Quota/);
    expect(ingestMock).not.toHaveBeenCalled();
  });
});

// ── runGbpReviewPollTick — cross-workspace isolation ───────────────────

describe("runGbpReviewPollTick", () => {
  it("only fetches reviews for the connections returned by the workspace-scoped query", async () => {
    // Two workspaces, each with their own location. The poller's
    // findMany() must return both — they're independent rows.
    // The tick must call listReviews once PER connection, never
    // mixing tokens or locations across workspaces.
    prismaMock.channelConnection.findMany.mockResolvedValueOnce([
      {
        id: "conn-A",
        clientId: "wsA",
        accessToken: "enc-A",
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        externalAccountId: "accounts/100/locations/A1",
        status: "CONNECTED",
      },
      {
        id: "conn-B",
        clientId: "wsB",
        accessToken: "enc-B",
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        externalAccountId: "accounts/200/locations/B1",
        status: "CONNECTED",
      },
    ]);
    oauthMock.listReviews.mockResolvedValue([]);

    await svc.runGbpReviewPollTick();
    expect(oauthMock.listReviews).toHaveBeenCalledTimes(2);
    const calls = oauthMock.listReviews.mock.calls.map((c) => c[0]);
    // Workspace A's token MUST be used for workspace A's location.
    const aCall = calls.find((c) => c.locationName === "accounts/100/locations/A1");
    const bCall = calls.find((c) => c.locationName === "accounts/200/locations/B1");
    expect(aCall.accessToken).toBe("plain:enc-A");
    expect(bCall.accessToken).toBe("plain:enc-B");
  });

  it("only queries connections in CONNECTED state with completed location picker", async () => {
    prismaMock.channelConnection.findMany.mockResolvedValueOnce([]);
    await svc.runGbpReviewPollTick();
    const where = prismaMock.channelConnection.findMany.mock.calls[0][0].where;
    expect(where.channel).toBe("GOOGLE_BUSINESS_PROFILE");
    expect(where.status).toBe("CONNECTED");
    expect(where.externalAccountId).toEqual({ contains: "/locations/" });
  });
});
