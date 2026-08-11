import { beforeEach, describe, expect, it, vi } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { requestAccountLifecycle } =
  await import("../domains/account/accountLifecycle.service.js");

function makePrisma({ existing = null, workspaces = [] } = {}) {
  const calls = {
    clientUpdates: [],
    draftUpdates: [],
    siteUpdates: [],
    connectionDeletes: [],
    techDeletes: [],
    userIntegrationDeletes: [],
    workspaceQueries: [],
  };
  const tx = {
    accountLifecycleRequest: {
      create: vi.fn(async ({ data }) => ({
        id: "request-1",
        status: "PENDING",
        requestedAt: new Date("2026-07-29T12:00:00Z"),
        ...data,
      })),
    },
    client: {
      findMany: vi.fn(async (args) => {
        calls.workspaceQueries.push(args);
        return workspaces.map((id) => ({ id, status: "ACTIVE", site: null, drafts: [] }));
      }),
      updateMany: vi.fn(async (args) => {
        calls.clientUpdates.push(args);
        return { count: workspaces.length };
      }),
    },
    draft: {
      updateMany: vi.fn(async (args) => {
        calls.draftUpdates.push(args);
        return { count: 1 };
      }),
    },
    site: {
      updateMany: vi.fn(async (args) => {
        calls.siteUpdates.push(args);
        return { count: 1 };
      }),
    },
    channelConnection: {
      deleteMany: vi.fn(async (args) => {
        calls.connectionDeletes.push(args);
        return { count: 1 };
      }),
    },
    workspaceTechStackConnection: {
      deleteMany: vi.fn(async (args) => {
        calls.techDeletes.push(args);
        return { count: 1 };
      }),
    },
    integration: { deleteMany: vi.fn(async args => { calls.userIntegrationDeletes.push(args); return { count: 0 }; }) },
    slackConnection: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    outboundWebhook: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  };
  return {
    calls,
    accountLifecycleRequest: {
      findFirst: vi.fn(async () => existing),
    },
    $transaction: vi.fn(async (callback) => callback(tx)),
  };
}

const user = {
  id: "user-1",
  auth0Sub: "auth0|owner-a",
  email: "owner@example.test",
};

describe("account lifecycle requests", () => {
  beforeEach(() => {
    prismaMock = makePrisma();
  });

  it("is idempotent for an already-open deletion request", async () => {
    const existing = {
      id: "existing",
      type: "DELETE_ACCOUNT",
      status: "PENDING",
    };
    prismaMock = makePrisma({ existing });
    const result = await requestAccountLifecycle({
      user,
      auth0Sub: user.auth0Sub,
      type: "DELETE_ACCOUNT",
    });
    expect(result).toEqual({ request: existing, created: false });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("archives only the actor's selected workspace IDs and disables automation", async () => {
    prismaMock = makePrisma({ workspaces: ["workspace-a"] });
    const result = await requestAccountLifecycle({
      user,
      auth0Sub: user.auth0Sub,
      type: "DELETE_ACCOUNT",
    });
    expect(result.created).toBe(true);
    expect(result.request.status).toBe("GRACE_PERIOD");
    expect(result.request.graceEndsAt).toBeInstanceOf(Date);
    expect(prismaMock.calls.workspaceQueries[0].where).toEqual({
      createdBy: "auth0|owner-a",
      status: { not: "ARCHIVED" },
    });
    expect(prismaMock.calls.clientUpdates[0].where).toEqual({
      id: { in: ["workspace-a"] },
      createdBy: "auth0|owner-a",
    });
    expect(prismaMock.calls.draftUpdates[0]).toMatchObject({
      where: {
        clientId: { in: ["workspace-a"] },
        status: "SCHEDULED",
      },
      data: { status: "FAILED" },
    });
    expect(prismaMock.calls.connectionDeletes[0].where).toEqual({
      clientId: { in: ["workspace-a"] },
    });
  });

  it("sets a seven-day grace period and snapshots only owned workspaces", async () => {
    prismaMock = makePrisma({ workspaces: ["workspace-a"] });
    const now = new Date("2026-08-11T00:00:00Z");
    const result = await requestAccountLifecycle({ user, auth0Sub: user.auth0Sub, type: "DELETE_ACCOUNT", now });
    expect(result.request.graceEndsAt.toISOString()).toBe("2026-08-18T00:00:00.000Z");
    expect(result.request.workspaceSnapshot).toEqual([{ id: "workspace-a", status: "ACTIVE", siteStatus: null, scheduledDraftIds: [] }]);
    expect(prismaMock.calls.userIntegrationDeletes[0].where).toEqual({ userId: user.id });
  });

  it("does not archive workspaces or remove connections for export requests", async () => {
    prismaMock = makePrisma({ workspaces: ["workspace-a"] });
    await requestAccountLifecycle({
      user,
      auth0Sub: user.auth0Sub,
      type: "EXPORT_ACCOUNT",
    });
    expect(prismaMock.calls.clientUpdates).toHaveLength(0);
    expect(prismaMock.calls.connectionDeletes).toHaveLength(0);
  });
});
