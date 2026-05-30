// Google Business Profile location picker — list + select.
//
// Pins spinstr413 task F.3 ("Location picker requires explicit
// selection") + tenant-isolation behavior. listLocations() walks
// all GBP accounts the connection's token can see; selectLocation
// validates the canonical resource-name shape before updating
// externalAccountId.

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
  listAccounts: vi.fn(),
  listLocationsForAccount: vi.fn(),
};
vi.mock("../domains/studio/oauth/googleBusinessProfile.oauth.js", () => oauthMock);

const svc = await import("../domains/studio/gbpLocations.service.js");
const { buildAccessDeniedMarker } = await import(
  "../domains/inbox/gbpReviewAccessMarker.js"
);

const CLIENT_ID = "client-1";
const CONN_ID = "conn-gbp-1";

function setupConnection({
  status = "CONNECTED",
  externalAccountId = "accounts/100",
  displayName = "Acme Co",
  lastError = null,
  connId = CONN_ID,
} = {}) {
  prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
    id: connId,
    clientId: CLIENT_ID,
    channel: "GOOGLE_BUSINESS_PROFILE",
    accessToken: "enc-token",
    status,
    externalAccountId,
    displayName,
    lastError,
  });
}

beforeEach(() => {
  prismaMock = {
    channelConnection: {
      findUnique: vi.fn(),
      update: vi.fn(async ({ data }) => ({ id: CONN_ID, ...data })),
    },
  };
  oauthMock.listAccounts.mockReset();
  oauthMock.listLocationsForAccount.mockReset();
});

// ── listLocations ──────────────────────────────────────────────────────

describe("listLocations", () => {
  it("returns ok status + canonical accounts/.../locations/... names", async () => {
    setupConnection({ connId: "conn-list-1" });
    oauthMock.listAccounts.mockResolvedValue([
      { name: "accounts/100", accountName: "Acme Co" },
      { name: "accounts/200", accountName: "Beta LLC" },
    ]);
    oauthMock.listLocationsForAccount.mockImplementation(async ({ accountName }) => {
      if (accountName === "accounts/100") {
        return [
          { name: "accounts/100/locations/A1", title: "Acme Downtown", storefrontAddress: { addressLines: ["1 Main"], locality: "Cary", administrativeArea: "NC", postalCode: "27513" } },
          { name: "accounts/100/locations/A2", title: "Acme North", storefrontAddress: null },
        ];
      }
      if (accountName === "accounts/200") {
        return [
          { name: "accounts/200/locations/B1", title: "Beta HQ" },
        ];
      }
      return [];
    });

    const result = await svc.listLocations({ connectionId: "conn-list-1" });
    expect(result.status).toBe("ok");
    expect(result.locations).toHaveLength(3);
    expect(result.locations[0]).toMatchObject({
      name: "accounts/100/locations/A1",
      title: "Acme Downtown",
      accountId: "accounts/100",
      accountName: "Acme Co",
    });
    expect(result.locations[0].address).toMatch(/1 Main/);
    expect(result.locations[2].name).toBe("accounts/200/locations/B1");
  });

  it("throws NOT_FOUND when the connection doesn't exist", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce(null);
    await expect(svc.listLocations({ connectionId: "bad" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("throws WRONG_CHANNEL when the connection is for a different channel", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
      id: CONN_ID,
      clientId: CLIENT_ID,
      channel: "PINTEREST",
      accessToken: "x",
      status: "CONNECTED",
      externalAccountId: "user",
      displayName: "user",
      lastError: null,
    });
    await expect(svc.listLocations({ connectionId: CONN_ID })).rejects.toMatchObject({
      code: "WRONG_CHANNEL",
    });
  });

  // Quota-gate hardening. The v1 GBP APIs return a 429
  // RESOURCE_EXHAUSTED for unapproved projects on every call —
  // we treat that as the same access-denied state as the v4
  // PERMISSION_DENIED on reviews. One marker, one UI state,
  // one Google approval clears all of them.
  it("short-circuits without calling Google when lastError is already the access-denied marker", async () => {
    setupConnection({
      connId: "conn-cached-marker",
      lastError: buildAccessDeniedMarker("prior denial"),
    });
    const result = await svc.listLocations({ connectionId: "conn-cached-marker" });
    expect(result.status).toBe("access_denied");
    expect(result.locations).toEqual([]);
    expect(oauthMock.listAccounts).not.toHaveBeenCalled();
    expect(oauthMock.listLocationsForAccount).not.toHaveBeenCalled();
  });

  it("persists the marker + returns access_denied when listAccounts throws 429 RESOURCE_EXHAUSTED", async () => {
    setupConnection({ connId: "conn-429" });
    const quotaErr = Object.assign(
      new Error(
        "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com'",
      ),
      { status: 429 },
    );
    oauthMock.listAccounts.mockRejectedValueOnce(quotaErr);

    const result = await svc.listLocations({ connectionId: "conn-429" });
    expect(result.status).toBe("access_denied");
    expect(result.locations).toEqual([]);
    expect(result.providerMessage).toMatch(/Quota exceeded/);
    expect(prismaMock.channelConnection.update).toHaveBeenCalledTimes(1);
    const written = prismaMock.channelConnection.update.mock.calls[0][0].data
      .lastError;
    expect(written).toMatch(/^REVIEW_API_ACCESS_DENIED:/);
  });

  it("persists the marker when listLocationsForAccount throws RESOURCE_EXHAUSTED (sub-API gate)", async () => {
    setupConnection({ connId: "conn-sub-429" });
    oauthMock.listAccounts.mockResolvedValueOnce([
      { name: "accounts/100", accountName: "Acme Co" },
    ]);
    const quotaErr = Object.assign(
      new Error("RESOURCE_EXHAUSTED: quota exceeded for mybusinessbusinessinformation"),
      { status: 429 },
    );
    oauthMock.listLocationsForAccount.mockRejectedValueOnce(quotaErr);

    const result = await svc.listLocations({ connectionId: "conn-sub-429" });
    expect(result.status).toBe("access_denied");
    expect(result.locations).toEqual([]);
    expect(prismaMock.channelConnection.update).toHaveBeenCalledTimes(1);
  });

  it("re-throws non-quota errors from listAccounts (transient 5xx must bubble, not poison the marker)", async () => {
    setupConnection({ connId: "conn-5xx" });
    const transientErr = Object.assign(new Error("Service unavailable"), {
      status: 503,
    });
    oauthMock.listAccounts.mockRejectedValueOnce(transientErr);

    await expect(
      svc.listLocations({ connectionId: "conn-5xx" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(prismaMock.channelConnection.update).not.toHaveBeenCalled();
  });

  // Cache behavior. The picker is the most quota-burning surface
  // because users tab back and forth between pages — re-opening
  // it should replay the prior fetch, not call Google again.
  it("caches a successful fetch and replays it on the next call within the TTL", async () => {
    setupConnection({ connId: "conn-cache" });
    oauthMock.listAccounts.mockResolvedValueOnce([
      { name: "accounts/100", accountName: "Acme Co" },
    ]);
    oauthMock.listLocationsForAccount.mockResolvedValueOnce([
      { name: "accounts/100/locations/A1", title: "Acme Downtown" },
    ]);

    const first = await svc.listLocations({ connectionId: "conn-cache" });
    expect(first.status).toBe("ok");
    expect(first.locations).toHaveLength(1);

    // Second call — connection still findable (re-prime findUnique
    // because the service loads the connection on every call), but
    // listAccounts is NOT mocked again so the cache hit is what
    // keeps it from throwing.
    setupConnection({ connId: "conn-cache" });
    const second = await svc.listLocations({ connectionId: "conn-cache" });
    expect(second.status).toBe("ok");
    expect(second.locations).toHaveLength(1);
    expect(oauthMock.listAccounts).toHaveBeenCalledTimes(1);
    expect(oauthMock.listLocationsForAccount).toHaveBeenCalledTimes(1);
  });
});

// ── saveSelectedLocation ───────────────────────────────────────────────

describe("saveSelectedLocation", () => {
  it("updates externalAccountId to the canonical resource name + composes displayName", async () => {
    setupConnection();
    const updated = await svc.saveSelectedLocation({
      connectionId: CONN_ID,
      locationName: "accounts/100/locations/A1",
      locationTitle: "Acme Downtown",
    });
    expect(prismaMock.channelConnection.update).toHaveBeenCalledTimes(1);
    const call = prismaMock.channelConnection.update.mock.calls[0][0];
    expect(call.data.externalAccountId).toBe("accounts/100/locations/A1");
    expect(call.data.displayName).toBe("Acme Co · Acme Downtown");
    expect(call.data.lastValidatedAt).toBeInstanceOf(Date);
    expect(updated.externalAccountId).toBe("accounts/100/locations/A1");
  });

  it("rejects malformed location names (must look like accounts/.../locations/...)", async () => {
    await expect(
      svc.saveSelectedLocation({
        connectionId: CONN_ID,
        locationName: "accounts/100",
        locationTitle: "x",
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_LOCATION_NAME" });

    await expect(
      svc.saveSelectedLocation({
        connectionId: CONN_ID,
        locationName: "locations/A1",
        locationTitle: "x",
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_LOCATION_NAME" });
  });

  it("requires locationName (no silent default — picker must explicit-select)", async () => {
    await expect(
      svc.saveSelectedLocation({ connectionId: CONN_ID, locationTitle: "x" }),
    ).rejects.toMatchObject({ code: "MISSING_LOCATION_NAME" });
  });
});
