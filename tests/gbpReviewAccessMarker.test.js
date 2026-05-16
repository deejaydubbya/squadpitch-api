// Access-denied marker semantics + per-call-site wiring.
//
// Per spinstr414:
//   - reviews.list 403/PERMISSION_DENIED maps to a stable marker
//     stored on ChannelConnection.lastError
//   - the resolver does NOT mark REPLY_REVIEW available while
//     the marker is set, even when location + scope are present
//   - successful account/location API calls don't imply review
//     API readiness — only a successful reviews.list clears the
//     marker
//
// The marker constants + detector are a tiny module so the
// poller, the outbound reply service, and the resolver all
// agree on the same wording.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isReviewApiAccessDenied,
  isAccessDeniedMarker,
  buildAccessDeniedMarker,
  ACCESS_DENIED_RESOLVER_REASON,
  REVIEW_API_ACCESS_DENIED_PREFIX,
} from "../domains/inbox/gbpReviewAccessMarker.js";

describe("isReviewApiAccessDenied", () => {
  it("matches Google's 403 PERMISSION_DENIED phrasing on reviews endpoints", () => {
    const err = new Error("Permission denied on resource project squadpitch");
    err.status = 403;
    expect(isReviewApiAccessDenied(err)).toBe(true);
  });

  it("matches Google's 'API has not been used in project' phrasing", () => {
    const err = new Error(
      "Google My Business API has not been used in project 822617393173 before or it is disabled.",
    );
    err.status = 403;
    expect(isReviewApiAccessDenied(err)).toBe(true);
  });

  it("matches the AUTH_PERMISSION_DENIED reason string (gcloud-style)", () => {
    const err = new Error("AUTH_PERMISSION_DENIED: enable failed");
    expect(isReviewApiAccessDenied(err)).toBe(true);
  });

  it("does NOT match a generic 403 that lacks the denial phrasing", () => {
    const err = new Error("Forbidden");
    err.status = 403;
    expect(isReviewApiAccessDenied(err)).toBe(false);
  });

  it("does NOT match transient 5xx errors", () => {
    const err = new Error("Service unavailable");
    err.status = 503;
    expect(isReviewApiAccessDenied(err)).toBe(false);
  });

  it("does NOT match a missing-scope 401", () => {
    const err = new Error("Invalid credentials");
    err.status = 401;
    expect(isReviewApiAccessDenied(err)).toBe(false);
  });

  it("handles null / undefined safely", () => {
    expect(isReviewApiAccessDenied(null)).toBe(false);
    expect(isReviewApiAccessDenied(undefined)).toBe(false);
  });
});

describe("buildAccessDeniedMarker + isAccessDeniedMarker", () => {
  it("builds a marker with the stable prefix + trimmed provider message", () => {
    const marker = buildAccessDeniedMarker("Permission denied");
    expect(marker.startsWith(REVIEW_API_ACCESS_DENIED_PREFIX)).toBe(true);
    expect(marker).toContain("Permission denied");
  });

  it("isAccessDeniedMarker is true for built markers, false for null/other strings", () => {
    expect(isAccessDeniedMarker(buildAccessDeniedMarker("x"))).toBe(true);
    expect(isAccessDeniedMarker(null)).toBe(false);
    expect(isAccessDeniedMarker("Some other error message")).toBe(false);
    expect(isAccessDeniedMarker("PERMISSION_DENIED")).toBe(false);
  });

  it("truncates pathologically long provider messages so the marker fits on the row", () => {
    const huge = "x".repeat(5000);
    const marker = buildAccessDeniedMarker(huge);
    // prefix + space + up to 240 chars of message
    expect(marker.length).toBeLessThan(300);
  });
});

// ── Poller wiring ──────────────────────────────────────────────────────
//
// pollGbpReviewsForConnection must:
//   - call listReviews and, on a denial error, persist the marker
//   - clear any prior marker on a successful listReviews call

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

const { pollGbpReviewsForConnection } = await import(
  "../domains/inbox/gbpReviewPoller.service.js"
);

beforeEach(() => {
  prismaMock = {
    channelConnection: {
      update: vi.fn(async () => ({})),
      findMany: vi.fn(),
    },
  };
  oauthMock.listReviews.mockReset();
  oauthMock.refreshAccessToken.mockReset();
  ingestMock.mockReset();
});

describe("pollGbpReviewsForConnection — access-denied marker", () => {
  it("persists the marker when listReviews throws Google's allowlist denial", async () => {
    const denialErr = Object.assign(
      new Error("Google My Business API has not been used in project 822617393173"),
      { status: 403 },
    );
    oauthMock.listReviews.mockRejectedValue(denialErr);
    const summary = await pollGbpReviewsForConnection({
      id: "conn-1",
      clientId: "client-1",
      externalAccountId: "accounts/100/locations/A1",
      accessToken: "enc",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      lastError: null,
    });
    expect(summary.error).toBe("REVIEW_API_ACCESS_DENIED");
    expect(summary.fetched).toBe(0);
    expect(prismaMock.channelConnection.update).toHaveBeenCalledTimes(1);
    const written = prismaMock.channelConnection.update.mock.calls[0][0].data
      .lastError;
    expect(isAccessDeniedMarker(written)).toBe(true);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("does NOT re-write the same marker on the next failed tick (idempotent persistence)", async () => {
    const existingMarker = buildAccessDeniedMarker(
      "Google My Business API has not been used in project 822617393173",
    );
    oauthMock.listReviews.mockRejectedValue(
      Object.assign(
        new Error("Google My Business API has not been used in project 822617393173"),
        { status: 403 },
      ),
    );
    await pollGbpReviewsForConnection({
      id: "conn-1",
      clientId: "client-1",
      externalAccountId: "accounts/100/locations/A1",
      accessToken: "enc",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      lastError: existingMarker,
    });
    expect(prismaMock.channelConnection.update).not.toHaveBeenCalled();
  });

  it("clears the marker when listReviews succeeds after a prior denial", async () => {
    oauthMock.listReviews.mockResolvedValue([]);
    await pollGbpReviewsForConnection({
      id: "conn-1",
      clientId: "client-1",
      externalAccountId: "accounts/100/locations/A1",
      accessToken: "enc",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      lastError: buildAccessDeniedMarker("prior denial"),
    });
    // First update: clear the lastError. Second update: bump lastValidatedAt.
    const calls = prismaMock.channelConnection.update.mock.calls;
    const clearedLastError = calls.some((c) => c[0].data.lastError === null);
    expect(clearedLastError).toBe(true);
  });

  it("does NOT write to the connection on a clean successful tick with no prior marker", async () => {
    oauthMock.listReviews.mockResolvedValue([]);
    await pollGbpReviewsForConnection({
      id: "conn-1",
      clientId: "client-1",
      externalAccountId: "accounts/100/locations/A1",
      accessToken: "enc",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      lastError: null,
    });
    // Only the lastValidatedAt bump should write — exactly one
    // update call total, and NOT one that touches lastError.
    expect(prismaMock.channelConnection.update).toHaveBeenCalledTimes(1);
    const writtenData = prismaMock.channelConnection.update.mock.calls[0][0].data;
    expect(writtenData.lastError).toBeUndefined();
    expect(writtenData.lastValidatedAt).toBeInstanceOf(Date);
  });
});
