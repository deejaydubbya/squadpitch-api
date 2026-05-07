// Tenant-isolation tests for the media-import service.
//
// Two routes were unsafe before this round:
//
//   POST /api/v1/integrations/media-import/:integrationId/import
//     — accepted clientId from req.body without verifying ownership.
//   POST /api/v1/integrations/media-import/:integrationId/export
//     — looked up MediaAsset by id with no workspace scoping, so any
//       authenticated user could export any asset to their own Drive.
//
// We test the service-layer fix (exportFile) here. The route-layer
// fix for /import is exercised by the existing tenantIsolation tests
// for assertClientOwnedByCurrentUser.

import { describe, it, expect, vi, beforeEach } from "vitest";

const userA = { id: "user-a-pk", auth0Sub: "auth0|alice" };
const userB = { id: "user-b-pk", auth0Sub: "auth0|bob" };

const fixtures = {
  users: {
    [userA.id]: userA,
    [userB.id]: userB,
  },
  integrations: {
    "int-a": { id: "int-a", userId: userA.id, type: "google_drive", isActive: true, config: {} },
  },
  // MediaAsset owned by user B (via clientId -> client.createdBy = userB.auth0Sub).
  // mediaAsset.findFirst is the call under test.
  assets: {
    "asset-b": { id: "asset-b", clientId: "client-b", url: "https://cdn/foo.png", filename: "foo.png" },
  },
  clients: {
    "client-b": { id: "client-b", createdBy: userB.auth0Sub },
  },
};

const prismaMock = {
  user: {
    findUnique: vi.fn(async ({ where }) => fixtures.users[where.id] ?? null),
  },
  integration: {
    findFirst: vi.fn(async ({ where }) => {
      const i = fixtures.integrations[where.id];
      if (!i) return null;
      if (where.userId && i.userId !== where.userId) return null;
      return i;
    }),
  },
  // findFirst is what the v8 fix uses. The where clause includes a
  // relation: client.createdBy = <auth0sub>. We honor that here.
  mediaAsset: {
    findFirst: vi.fn(async ({ where }) => {
      const a = fixtures.assets[where.id];
      if (!a) return null;
      const requiredCreatedBy = where.client?.createdBy;
      if (requiredCreatedBy) {
        const c = fixtures.clients[a.clientId];
        if (!c || c.createdBy !== requiredCreatedBy) return null;
      }
      return a;
    }),
  },
};

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
// Disable real Cloudinary / providers — exportFile will throw before
// calling them in the unauthorized case, so we never actually need them
// to fire. Stubs prevent module resolution issues in CI.
vi.mock("../services/storage/imageStorage.js", () => ({
  getImageStorageService: () => ({ upload: vi.fn() }),
  getVideoStorageService: () => ({ upload: vi.fn() }),
}));
vi.mock("../domains/integrations/providers/driveProvider.js", () => ({
  uploadFile: vi.fn(),
  listFiles: vi.fn(),
  downloadFile: vi.fn(),
}));
vi.mock("../domains/integrations/providers/dropboxProvider.js", () => ({
  uploadFile: vi.fn(),
  listFiles: vi.fn(),
  downloadFile: vi.fn(),
}));
vi.mock("../domains/billing/billing.service.js", () => ({
  enforceUsageLimit: vi.fn().mockResolvedValue(null),
  incrementUsage: vi.fn(),
  checkStorageLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("../lib/mimeDetect.js", () => ({
  sniffImageMime: vi.fn(() => "image/png"),
  sniffVideoMime: vi.fn(() => null),
}));

const { exportFile } = await import("../domains/integrations/mediaImport.service.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mediaImport.service.exportFile — tenant isolation", () => {
  it("user A cannot export user B's asset (404, not 200)", async () => {
    // user A owns int-a and the integration lookup will succeed, but
    // asset-b is NOT in any workspace owned by user A.
    await expect(exportFile(userA.id, "int-a", "asset-b", null)).rejects.toMatchObject({
      message: "Asset not found",
      status: 404,
    });
  });

  it("missing requester user → 404, never reaches the asset query", async () => {
    await expect(exportFile("ghost", "int-a", "asset-b", null)).rejects.toMatchObject({
      status: 404,
    });
    // The mediaAsset.findFirst call should never have happened: the
    // user lookup short-circuits, which prevents enumeration of asset
    // ids via timing or error differences.
    expect(prismaMock.mediaAsset.findFirst).not.toHaveBeenCalled();
  });

  it("calls findFirst with a relation-scoped where clause (not findUnique)", async () => {
    // The fix swapped findUnique to findFirst with a client.createdBy
    // filter. If a future refactor accidentally drops the filter, this
    // test catches it before the cross-workspace leak ships.
    await exportFile(userA.id, "int-a", "asset-b", null).catch(() => {});
    expect(prismaMock.mediaAsset.findFirst).toHaveBeenCalled();
    const call = prismaMock.mediaAsset.findFirst.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: "asset-b" });
    expect(call.where.client).toMatchObject({ createdBy: userA.auth0Sub });
  });
});
