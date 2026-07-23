import { describe, expect, it, vi } from "vitest";

import {
  canAccessWorkspaceResource,
  canActorPerformWorkspaceScope,
  WORKSPACE_AUTH_REASON,
} from "../domains/authorization/workspaceAuthorization.service.js";
import {
  createAuthorizedAiServiceEnvelope,
  verifyAiServiceEnvelopeSignature,
} from "../domains/aiPlatform/serviceEnvelope.js";

const OWNER = "auth0|owner";
const OTHER = "auth0|other";

function makePrisma() {
  const clients = new Map([
    ["workspace-a", { id: "workspace-a", createdBy: OWNER }],
    ["workspace-b", { id: "workspace-b", createdBy: OTHER }],
  ]);
  return {
    client: {
      findUnique: vi.fn(async ({ where }) => clients.get(where.id) ?? null),
    },
    draft: {
      findUnique: vi.fn(async ({ where }) =>
        where.id === "draft-a"
          ? { id: "draft-a", clientId: "workspace-a" }
          : { id: "draft-b", clientId: "workspace-b" },
      ),
    },
    mediaAsset: {
      findUnique: vi.fn(async ({ where }) =>
        where.id === "asset-a"
          ? { id: "asset-a", clientId: "workspace-a" }
          : { id: "asset-b", clientId: "workspace-b" },
      ),
    },
    workspaceDataItem: {
      findUnique: vi.fn(async ({ where }) =>
        where.id === "property-a"
          ? { id: "property-a", clientId: "workspace-a", type: "PROPERTY" }
          : { id: "property-b", clientId: "workspace-b", type: "PROPERTY" },
      ),
    },
  };
}

describe("workspace authorization boundary", () => {
  it("allows the workspace owner", async () => {
    const decision = await canActorPerformWorkspaceScope({
      actor: { auth0Sub: OWNER },
      workspaceId: "workspace-a",
      scope: "eval:run",
      prismaClient: makePrisma(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe(WORKSPACE_AUTH_REASON.ALLOWED_OWNER);
  });

  it("denies the wrong user", async () => {
    const decision = await canActorPerformWorkspaceScope({
      actor: { auth0Sub: OTHER },
      workspaceId: "workspace-a",
      scope: "eval:run",
      prismaClient: makePrisma(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(WORKSPACE_AUTH_REASON.NOT_WORKSPACE_OWNER);
  });

  it("allows admin only where explicitly requested", async () => {
    const prismaClient = makePrisma();

    await expect(
      canActorPerformWorkspaceScope({
        actor: { auth0Sub: OTHER, roles: ["admin"] },
        workspaceId: "workspace-a",
        scope: "eval:run",
        prismaClient,
      }),
    ).resolves.toMatchObject({ allowed: false });

    await expect(
      canActorPerformWorkspaceScope({
        actor: { auth0Sub: OTHER, roles: ["admin"] },
        workspaceId: "workspace-a",
        scope: "eval:run",
        allowAdmin: true,
        prismaClient,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: WORKSPACE_AUTH_REASON.ALLOWED_ADMIN,
    });
  });

  it("denies cross-workspace property, draft, and media access", async () => {
    const prismaClient = makePrisma();

    await expect(
      canAccessWorkspaceResource({
        workspaceId: "workspace-a",
        resourceType: "property",
        resourceId: "property-b",
        prismaClient,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: WORKSPACE_AUTH_REASON.RESOURCE_WORKSPACE_MISMATCH,
    });
    await expect(
      canAccessWorkspaceResource({
        workspaceId: "workspace-a",
        resourceType: "draft",
        resourceId: "draft-b",
        prismaClient,
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      canAccessWorkspaceResource({
        workspaceId: "workspace-a",
        resourceType: "mediaAsset",
        resourceId: "asset-b",
        prismaClient,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("AI signer cannot sign an unauthorized scope", async () => {
    await expect(
      createAuthorizedAiServiceEnvelope({
        actor: { auth0Sub: OTHER },
        workspaceId: "workspace-a",
        scopes: ["eval:run"],
        payload: { workspaceId: "workspace-a" },
        secret: "secret",
        authorizationService: async () => {
          const err = new Error("denied");
          err.code = WORKSPACE_AUTH_REASON.NOT_WORKSPACE_OWNER;
          throw err;
        },
      }),
    ).rejects.toMatchObject({ code: WORKSPACE_AUTH_REASON.NOT_WORKSPACE_OWNER });
  });

  it("signed envelope workspace must match the authorized workspace", async () => {
    await expect(
      createAuthorizedAiServiceEnvelope({
        actor: { auth0Sub: OWNER },
        workspaceId: "workspace-a",
        scopes: ["eval:run"],
        payload: { workspaceId: "workspace-b" },
        secret: "secret",
        authorizationService: vi.fn(async () => ({ allowed: true })),
      }),
    ).rejects.toMatchObject({ code: "CONTRACT_WORKSPACE_MISMATCH" });
  });

  it("feature flags cannot bypass authorization", async () => {
    const decision = await canActorPerformWorkspaceScope({
      actor: { auth0Sub: OTHER },
      workspaceId: "workspace-a",
      scope: "eval:run",
      featureFlags: { ai_platform_enabled: true },
      prismaClient: makePrisma(),
    });

    expect(decision.allowed).toBe(false);
  });

  it("keeps future role compatibility behind the scope interface", async () => {
    const decision = await canActorPerformWorkspaceScope({
      actor: { auth0Sub: OTHER },
      workspaceId: "workspace-a",
      scope: "retrieval:query",
      allowAdmin: true,
      prismaClient: makePrisma(),
      roleResolver: vi.fn(async () => ["admin"]),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.scope).toBe("retrieval:query");
  });

  it("signs after authorization succeeds", async () => {
    const envelope = await createAuthorizedAiServiceEnvelope({
      actor: { auth0Sub: OWNER },
      workspaceId: "workspace-a",
      scopes: ["eval:run"],
      payload: { workspaceId: "workspace-a" },
      secret: "secret",
      keyId: "test",
      authorizationService: vi.fn(async () => ({ allowed: true })),
    });

    expect(envelope.actorUserId).toBe(OWNER);
    expect(verifyAiServiceEnvelopeSignature(envelope, "secret")).toBe(true);
  });
});
