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

const CLIENT_ID = "client-1";
const CONN_ID = "conn-gbp-1";

function setupConnection({
  status = "CONNECTED",
  externalAccountId = "accounts/100",
  displayName = "Acme Co",
} = {}) {
  prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
    id: CONN_ID,
    clientId: CLIENT_ID,
    channel: "GOOGLE_BUSINESS_PROFILE",
    accessToken: "enc-token",
    status,
    externalAccountId,
    displayName,
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
  it("returns a flat array with canonical accounts/.../locations/... names", async () => {
    setupConnection();
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

    const locations = await svc.listLocations({ connectionId: CONN_ID });
    expect(locations).toHaveLength(3);
    expect(locations[0]).toMatchObject({
      name: "accounts/100/locations/A1",
      title: "Acme Downtown",
      accountId: "accounts/100",
      accountName: "Acme Co",
    });
    expect(locations[0].address).toMatch(/1 Main/);
    expect(locations[2].name).toBe("accounts/200/locations/B1");
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
    });
    await expect(svc.listLocations({ connectionId: CONN_ID })).rejects.toMatchObject({
      code: "WRONG_CHANNEL",
    });
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
