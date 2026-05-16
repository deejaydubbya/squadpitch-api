// Manual "Check review API access" probe (spinstr415).
//
// Pins the contract:
//   - reviews.list 200 → status='ok', stale marker cleared
//   - reviews.list denial → status='access_denied', marker set
//   - no /locations/ in externalAccountId → status='no_location'
//   - missing connection / not CONNECTED → throws (handled by route)
//
// No fake ingestion — the probe always calls the real listReviews;
// it just uses pageSize=1 so the call is as cheap as possible.

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

const { checkGbpReviewAccess } = await import(
  "../domains/studio/gbpReviewAccessCheck.service.js"
);
const { buildAccessDeniedMarker, isAccessDeniedMarker } = await import(
  "../domains/inbox/gbpReviewAccessMarker.js"
);

const CLIENT_ID = "client-1";

function baseConnection(overrides = {}) {
  return {
    id: "conn-1",
    clientId: CLIENT_ID,
    channel: "GOOGLE_BUSINESS_PROFILE",
    status: "CONNECTED",
    externalAccountId: "accounts/100/locations/A1",
    accessToken: "enc-A",
    refreshToken: "enc-RT",
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  prismaMock = {
    channelConnection: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
    },
  };
  oauthMock.listReviews.mockReset();
  oauthMock.refreshAccessToken.mockReset();
});

// ── 200 OK ─────────────────────────────────────────────────────────────

describe("checkGbpReviewAccess — success path", () => {
  it("returns status=ok when reviews.list returns 200", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(baseConnection());
    oauthMock.listReviews.mockResolvedValueOnce([]);
    const result = await checkGbpReviewAccess({ clientId: CLIENT_ID });
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/approved review access/i);
  });

  it("clears a prior REVIEW_API_ACCESS_DENIED marker on success", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(
      baseConnection({ lastError: buildAccessDeniedMarker("prior denial") }),
    );
    oauthMock.listReviews.mockResolvedValueOnce([]);
    await checkGbpReviewAccess({ clientId: CLIENT_ID });
    expect(prismaMock.channelConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastError: null }),
      }),
    );
  });

  it("does NOT write to the DB when listReviews succeeds AND no prior marker existed", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(baseConnection());
    oauthMock.listReviews.mockResolvedValueOnce([]);
    await checkGbpReviewAccess({ clientId: CLIENT_ID });
    expect(prismaMock.channelConnection.update).not.toHaveBeenCalled();
  });

  it("uses pageSize=1 so the probe call is as cheap as possible", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(baseConnection());
    oauthMock.listReviews.mockResolvedValueOnce([]);
    await checkGbpReviewAccess({ clientId: CLIENT_ID });
    expect(oauthMock.listReviews).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 1 }),
    );
  });
});

// ── Access denied ──────────────────────────────────────────────────────

describe("checkGbpReviewAccess — access denied path", () => {
  it("returns status=access_denied + persists marker when Google rejects", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(baseConnection());
    const denial = Object.assign(
      new Error("Google My Business API has not been used in project 822617393173"),
      { status: 403 },
    );
    oauthMock.listReviews.mockRejectedValueOnce(denial);
    const result = await checkGbpReviewAccess({ clientId: CLIENT_ID });
    expect(result.status).toBe("access_denied");
    expect(result.message).toMatch(/not approved this project/i);
    expect(prismaMock.channelConnection.update).toHaveBeenCalledTimes(1);
    const writtenMarker = prismaMock.channelConnection.update.mock.calls[0][0]
      .data.lastError;
    expect(isAccessDeniedMarker(writtenMarker)).toBe(true);
  });

  it("does not re-write an identical marker if one was already present", async () => {
    const existing = buildAccessDeniedMarker(
      "Google My Business API has not been used in project 822617393173",
    );
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(
      baseConnection({ lastError: existing }),
    );
    oauthMock.listReviews.mockRejectedValueOnce(
      Object.assign(
        new Error("Google My Business API has not been used in project 822617393173"),
        { status: 403 },
      ),
    );
    await checkGbpReviewAccess({ clientId: CLIENT_ID });
    expect(prismaMock.channelConnection.update).not.toHaveBeenCalled();
  });
});

// ── Refuse cases ───────────────────────────────────────────────────────

describe("checkGbpReviewAccess — refuse cases", () => {
  it("returns status=no_location when the connection still holds the pre-picker sentinel", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(
      baseConnection({ externalAccountId: "accounts/100" /* no /locations/ */ }),
    );
    const result = await checkGbpReviewAccess({ clientId: CLIENT_ID });
    expect(result.status).toBe("no_location");
    expect(oauthMock.listReviews).not.toHaveBeenCalled();
    expect(prismaMock.channelConnection.update).not.toHaveBeenCalled();
  });

  it("throws NO_CONNECTION when no GBP connection exists in the workspace", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(null);
    await expect(
      checkGbpReviewAccess({ clientId: CLIENT_ID }),
    ).rejects.toMatchObject({ code: "NO_CONNECTION", status: 404 });
  });

  it("throws CONNECTION_NOT_ACTIVE when the connection is in a non-CONNECTED state", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(
      baseConnection({ status: "NEEDS_RECONNECT" }),
    );
    await expect(
      checkGbpReviewAccess({ clientId: CLIENT_ID }),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_ACTIVE", status: 412 });
  });
});

// ── Non-denial errors ──────────────────────────────────────────────────

describe("checkGbpReviewAccess — other errors", () => {
  it("returns status=error on transient 5xx without touching the marker", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(baseConnection());
    const transient = Object.assign(new Error("Backend error"), { status: 503 });
    oauthMock.listReviews.mockRejectedValueOnce(transient);
    const result = await checkGbpReviewAccess({ clientId: CLIENT_ID });
    expect(result.status).toBe("error");
    expect(result.providerMessage).toMatch(/Backend error/);
    // Marker untouched — could be a blip; next tick decides.
    expect(prismaMock.channelConnection.update).not.toHaveBeenCalled();
  });

  it("returns status=error when token refresh fails (without trying reviews.list)", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(
      baseConnection({ tokenExpiresAt: new Date(Date.now() + 30_000) }),
    );
    oauthMock.refreshAccessToken.mockRejectedValueOnce(new Error("Refresh denied"));
    const result = await checkGbpReviewAccess({ clientId: CLIENT_ID });
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/refresh the Google Business Profile access token/i);
    expect(oauthMock.listReviews).not.toHaveBeenCalled();
  });
});
