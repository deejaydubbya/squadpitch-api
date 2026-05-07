// Tenant-isolation regression tests for the new draft + asset ownership
// middlewares. We test the middlewares directly (no routes mounted) so
// the test loads in milliseconds rather than booting the whole studio
// module graph.

import { describe, it, expect, vi, beforeEach } from "vitest";

const userA = "auth0|alice";
const userB = "auth0|bob";

const fixtures = {
  clients: {
    "client-a": { id: "client-a", createdBy: userA },
    "client-b": { id: "client-b", createdBy: userB },
  },
  drafts: {
    "draft-a": { id: "draft-a", clientId: "client-a" },
    "draft-b": { id: "draft-b", clientId: "client-b" },
  },
  assets: {
    "asset-a": { id: "asset-a", clientId: "client-a" },
    "asset-b": { id: "asset-b", clientId: "client-b" },
  },
  folders: {
    "folder-a": { id: "folder-a", clientId: "client-a" },
    "folder-b": { id: "folder-b", clientId: "client-b" },
  },
  dataItems: {
    "item-a": { id: "item-a", clientId: "client-a" },
    "item-b": { id: "item-b", clientId: "client-b" },
  },
};

const prismaMock = {
  client: {
    findUnique: vi.fn(async ({ where }) => fixtures.clients[where.id] ?? null),
  },
  draft: {
    findUnique: vi.fn(async ({ where, select }) => {
      const d = fixtures.drafts[where.id];
      if (!d) return null;
      if (select?.client) {
        return { ...d, client: { createdBy: fixtures.clients[d.clientId]?.createdBy ?? null } };
      }
      return d;
    }),
  },
  mediaAsset: {
    findUnique: vi.fn(async ({ where, select }) => {
      const a = fixtures.assets[where.id];
      if (!a) return null;
      if (select?.client) {
        return { ...a, client: { createdBy: fixtures.clients[a.clientId]?.createdBy ?? null } };
      }
      return a;
    }),
  },
  assetFolder: {
    findUnique: vi.fn(async ({ where }) => fixtures.folders[where.id] ?? null),
  },
  workspaceDataItem: {
    findUnique: vi.fn(async ({ where }) => fixtures.dataItems[where.id] ?? null),
  },
};

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../middleware/auth.js", () => ({
  getAuth0Sub: (req) => req.headers["x-test-sub"] ?? null,
}));

const {
  requireDraftOwner,
  requireAssetOwner,
  requireAssetAndDraftSameWorkspace,
  requireBodyClientOwner,
  assertClientOwnedByCurrentUser,
  assertDraftInClient,
  assertFolderInClient,
  assertAssetInClient,
  assertDataItemInClient,
} = await import("../domains/studio/ownership.js");

// Tiny harness — drives a middleware to completion and returns the final
// status + parsed body, plus whether next() was called cleanly.
function runMiddleware(mw, { params = {}, body = {}, sub } = {}) {
  return new Promise((resolve) => {
    const req = {
      params,
      body,
      headers: sub ? { "x-test-sub": sub } : {},
      log: { warn: () => {} },
    };
    let finalStatus = null;
    let finalBody = null;
    const res = {
      status(code) {
        finalStatus = code;
        return this;
      },
      json(b) {
        finalBody = b;
        return this;
      },
    };
    const next = (err) => {
      if (err) resolve({ status: 500, body: { error: "INTERNAL" }, req, allowed: false });
      else resolve({ status: finalStatus ?? 200, body: finalBody, req, allowed: finalStatus === null });
    };
    Promise.resolve(mw(req, res, next)).then(() => {
      if (finalStatus !== null) {
        resolve({ status: finalStatus, body: finalBody, req, allowed: false });
      }
    });
  });
}

beforeEach(() => {
  Object.values(prismaMock).forEach((tbl) =>
    Object.values(tbl).forEach((fn) => fn.mockClear?.())
  );
});

describe("requireDraftOwner — direct draft routes", () => {
  it("user A cannot read user B's draft (404, not 403, to avoid leaking existence)", async () => {
    const r = await runMiddleware(requireDraftOwner, { params: { id: "draft-b" }, sub: userA });
    expect(r.status).toBe(404);
    expect(r.body?.error).toBe("NOT_FOUND");
  });

  it("user A CAN read own draft (middleware passes)", async () => {
    const r = await runMiddleware(requireDraftOwner, { params: { id: "draft-a" }, sub: userA });
    expect(r.allowed).toBe(true);
    expect(r.req.draft).toEqual({ id: "draft-a", clientId: "client-a" });
  });

  it("missing draft → 404", async () => {
    const r = await runMiddleware(requireDraftOwner, { params: { id: "no-such" }, sub: userA });
    expect(r.status).toBe(404);
  });

  it("missing draft id param → 400", async () => {
    const r = await runMiddleware(requireDraftOwner, { params: {}, sub: userA });
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("MISSING_DRAFT_ID");
  });

  it("anonymous (no sub header) sees 404 on every draft", async () => {
    const r = await runMiddleware(requireDraftOwner, { params: { id: "draft-a" } });
    expect(r.status).toBe(404);
  });
});

describe("requireAssetOwner — direct asset routes", () => {
  it("user A cannot read user B's asset", async () => {
    const r = await runMiddleware(requireAssetOwner, { params: { assetId: "asset-b" }, sub: userA });
    expect(r.status).toBe(404);
  });

  it("user A CAN read own asset", async () => {
    const r = await runMiddleware(requireAssetOwner, { params: { assetId: "asset-a" }, sub: userA });
    expect(r.allowed).toBe(true);
    expect(r.req.asset).toEqual({ id: "asset-a", clientId: "client-a" });
  });

  it("missing asset → 404", async () => {
    const r = await runMiddleware(requireAssetOwner, { params: { assetId: "no-such" }, sub: userA });
    expect(r.status).toBe(404);
  });
});

describe("requireAssetAndDraftSameWorkspace — cross-workspace guard", () => {
  it("blocks attaching an asset from one workspace to a draft in another (cross-workspace)", async () => {
    // In production requireAssetOwner would set req.asset before this
    // middleware runs. Simulate the case where the user owns both
    // workspaces but is trying to bridge them.
    const r = await runMiddleware(
      async (req, res, next) => {
        // Pretend req.asset was set by requireAssetOwner with a
        // different clientId than the draft.
        req.asset = { id: "asset-b", clientId: "client-b" };
        // But change the asset's client to userA so the asset-owner
        // check would have passed; we're testing the cross-workspace
        // arm in isolation.
        fixtures.clients["client-b"].createdBy = userA;
        try {
          return await requireAssetAndDraftSameWorkspace(req, res, next);
        } finally {
          fixtures.clients["client-b"].createdBy = userB; // restore
        }
      },
      { params: { draftId: "draft-a" }, sub: userA }
    );
    expect(r.status).toBe(403);
    expect(r.body?.error).toBe("CROSS_WORKSPACE_FORBIDDEN");
  });

  it("blocks linking own asset to user B's draft (draft owner check fails)", async () => {
    const r = await runMiddleware(
      async (req, res, next) => {
        req.asset = { id: "asset-a", clientId: "client-a" };
        return requireAssetAndDraftSameWorkspace(req, res, next);
      },
      { params: { draftId: "draft-b" }, sub: userA }
    );
    expect(r.status).toBe(404);
  });

  it("allows linking own asset to own draft in the same workspace", async () => {
    const r = await runMiddleware(
      async (req, res, next) => {
        req.asset = { id: "asset-a", clientId: "client-a" };
        return requireAssetAndDraftSameWorkspace(req, res, next);
      },
      { params: { draftId: "draft-a" }, sub: userA }
    );
    expect(r.allowed).toBe(true);
  });
});

describe("requireBodyClientOwner — body-clientId guard", () => {
  it("blocks user A from generating in user B's workspace", async () => {
    const mw = requireBodyClientOwner("clientId");
    const r = await runMiddleware(mw, { body: { clientId: "client-b" }, sub: userA });
    expect(r.status).toBe(404);
    expect(r.body?.error).toBe("NOT_FOUND");
  });

  it("allows user A to generate in own workspace, attaches req.bodyClient", async () => {
    const mw = requireBodyClientOwner("clientId");
    const r = await runMiddleware(mw, { body: { clientId: "client-a" }, sub: userA });
    expect(r.allowed).toBe(true);
    expect(r.req.bodyClient).toEqual({ id: "client-a", createdBy: userA });
  });

  it("missing clientId in body → 400", async () => {
    const mw = requireBodyClientOwner("clientId");
    const r = await runMiddleware(mw, { body: {}, sub: userA });
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("MISSING_CLIENT_ID");
  });
});

describe("assertClientOwnedByCurrentUser — inline body guard", () => {
  it("returns 404-shaped object on cross-workspace attempt", async () => {
    const req = { headers: { "x-test-sub": userA }, log: { warn: () => {} } };
    const result = await assertClientOwnedByCurrentUser("client-b", req);
    expect(result).toEqual({ status: 404, code: "NOT_FOUND", message: "Client not found" });
  });

  it("returns null on success", async () => {
    const req = { headers: { "x-test-sub": userA } };
    expect(await assertClientOwnedByCurrentUser("client-a", req)).toBeNull();
  });

  it("400 on empty/non-string clientId", async () => {
    const req = { headers: { "x-test-sub": userA } };
    const r = await assertClientOwnedByCurrentUser("", req);
    expect(r?.code).toBe("MISSING_CLIENT_ID");
  });
});

describe("assertDraftInClient / assertFolderInClient / assertAssetInClient / assertDataItemInClient", () => {
  it("returns null when id is absent (optional input)", async () => {
    expect(await assertDraftInClient(null, "client-a")).toBeNull();
    expect(await assertFolderInClient(undefined, "client-a")).toBeNull();
    expect(await assertAssetInClient(null, "client-a")).toBeNull();
    expect(await assertDataItemInClient(null, "client-a")).toBeNull();
  });

  it("throws DRAFT_NOT_FOUND when draft belongs to another client", async () => {
    await expect(assertDraftInClient("draft-b", "client-a")).rejects.toMatchObject({
      status: 404,
      code: "DRAFT_NOT_FOUND",
    });
  });

  it("throws FOLDER_NOT_FOUND when folder is in another workspace", async () => {
    await expect(assertFolderInClient("folder-b", "client-a")).rejects.toMatchObject({
      status: 404,
      code: "FOLDER_NOT_FOUND",
    });
  });

  it("throws ASSET_NOT_FOUND when asset is in another workspace", async () => {
    await expect(assertAssetInClient("asset-b", "client-a")).rejects.toMatchObject({
      status: 404,
      code: "ASSET_NOT_FOUND",
    });
  });

  it("throws DATA_ITEM_NOT_FOUND when item is in another workspace", async () => {
    await expect(assertDataItemInClient("item-b", "client-a")).rejects.toMatchObject({
      status: 404,
      code: "DATA_ITEM_NOT_FOUND",
    });
  });

  it("returns the matching record on same-workspace match", async () => {
    expect(await assertDraftInClient("draft-a", "client-a")).toMatchObject({ id: "draft-a" });
    expect(await assertFolderInClient("folder-a", "client-a")).toMatchObject({ id: "folder-a" });
    expect(await assertAssetInClient("asset-a", "client-a")).toMatchObject({ id: "asset-a" });
    expect(await assertDataItemInClient("item-a", "client-a")).toMatchObject({ id: "item-a" });
  });

  it("throws if the id does not exist at all (treated like cross-workspace, not 200)", async () => {
    await expect(assertDraftInClient("ghost", "client-a")).rejects.toMatchObject({
      code: "DRAFT_NOT_FOUND",
    });
  });
});
