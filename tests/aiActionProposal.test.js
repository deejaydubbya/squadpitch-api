import { describe, expect, it, vi } from "vitest";

import {
  AI_ACTION_PROPOSAL_ERROR_CODES,
  approveAiActionProposal,
  contentHashForProposalPayload,
  createDraftContentProposal,
  rejectAiActionProposal,
  validateDraftContentProposal,
} from "../domains/aiPlatform/aiActionProposal.service.js";

const actor = { auth0Sub: "auth0|owner", id: "auth0|owner" };
const now = new Date("2026-07-22T12:00:00.000Z");

function validProposal(overrides = {}) {
  return {
    schemaVersion: "draft-content-proposal.v1",
    proposalType: "draft_content",
    proposalVersion: "draft-proposal.v1",
    workspaceId: "workspace-a",
    objective: "Create listing drafts.",
    proposedDrafts: [
      {
        channel: "INSTAGRAM",
        body: "New listing at 123 Cedar Ave with approved property details.",
        cta: "Book a showing",
        hashtags: ["#realestate"],
        scheduledFor: null,
        mediaAssetIds: ["asset-1"],
        dataItemIds: ["property-1"],
        requiredFacts: [
          { name: "address", status: "available", sourceId: "property-1" },
          { name: "price", status: "available", sourceId: "property-1" },
        ],
        citations: [
          {
            sourceType: "property_listing",
            sourceId: "property-1",
            workspaceId: "workspace-a",
            contentHash: "sha256:test",
            trust: "authoritative",
          },
        ],
        validationHints: [],
      },
    ],
    citations: [
      {
        sourceType: "property_listing",
        sourceId: "property-1",
        workspaceId: "workspace-a",
        contentHash: "sha256:test",
        trust: "authoritative",
      },
    ],
    validationStatus: {
      valid: true,
      warnings: [],
      missingFacts: [],
      calendarConflicts: [],
    },
    modelMetadata: {
      implementation: "python",
      model: "deterministic-draft-proposer",
      promptVersion: "validated-draft-proposal.v1",
    },
    traceId: "trace-1",
    expiresAt: "2026-07-23T12:00:00.000Z",
    contentHash: "sha256:" + "a".repeat(64),
    proposalOnly: true,
    ...overrides,
  };
}

function storedProposal(overrides = {}) {
  const proposalPayload = validProposal();
  return {
    id: "proposal-1",
    clientId: "workspace-a",
    actorUserId: "auth0|owner",
    status: "PROPOSED",
    proposalPayload,
    contentHash: contentHashForProposalPayload(proposalPayload),
    sourceModelVersion: "deterministic-draft-proposer",
    auditMetadata: { events: [{ type: "created" }], rawPromptStored: false },
    expiresAt: new Date("2026-07-23T12:00:00.000Z"),
    ...overrides,
  };
}

function prismaForValidation(overrides = {}) {
  return {
    mediaAsset: { count: vi.fn(async () => 1) },
    workspaceDataItem: { count: vi.fn(async () => 1) },
    draft: { findFirst: vi.fn(async () => null) },
    ...overrides,
  };
}

function baseCreateDeps(overrides = {}) {
  return {
    actor,
    workspaceId: "workspace-a",
    objective: "Create listing drafts.",
    requestedChannels: ["INSTAGRAM"],
    idempotencyKey: "idem-1",
    featureEnabled: true,
    serviceAuthSecret: "secret",
    authorizationService: vi.fn(async () => ({ allowed: true })),
    featureFlagEvaluator: vi.fn(async () => true),
    subscriptionFetcher: vi.fn(async () => ({ tier: "PRO", status: "ACTIVE" })),
    effectiveTierResolver: vi.fn(() => "PRO"),
    snapshotBuilder: vi.fn(async () => ({
      workspaceId: "workspace-a",
      objective: "Create listing drafts.",
      items: [],
      media: [],
      calendar: [],
      approvalPolicy: { requiresHumanApproval: true },
      allowedChannels: ["INSTAGRAM"],
    })),
    pythonClient: vi.fn(async () => ({ ok: true, body: validProposal() })),
    prismaClient: {
      aiActionProposal: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }) => ({ id: "proposal-1", ...data })),
      },
      mediaAsset: { count: vi.fn(async () => 1) },
      workspaceDataItem: { count: vi.fn(async () => 1) },
      draft: { findFirst: vi.fn(async () => null) },
    },
    ...overrides,
  };
}

describe("AI action proposals", () => {
  it("rejects duplicate idempotency keys before Python call", async () => {
    const pythonClient = vi.fn();
    await expect(
      createDraftContentProposal(
        baseCreateDeps({
          pythonClient,
          prismaClient: {
            aiActionProposal: {
              findUnique: vi.fn(async () => ({ id: "existing-proposal" })),
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: AI_ACTION_PROPOSAL_ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY });
    expect(pythonClient).not.toHaveBeenCalled();
  });

  it("keeps the existing generation fallback when disabled", async () => {
    const pythonClient = vi.fn();
    await expect(
      createDraftContentProposal(
        baseCreateDeps({ featureEnabled: false, featureFlagEvaluator: vi.fn(async () => false), pythonClient }),
      ),
    ).rejects.toMatchObject({
      code: AI_ACTION_PROPOSAL_ERROR_CODES.FEATURE_DISABLED,
      fallback: "aiGenerationService.js",
    });
    expect(pythonClient).not.toHaveBeenCalled();
  });

  it("validates unsupported channel, cross-workspace references, invalid facts, and policy copy", async () => {
    await expect(
      validateDraftContentProposal({
        proposal: validProposal({ proposedDrafts: [{ ...validProposal().proposedDrafts[0], channel: "FAX" }] }),
        workspaceId: "workspace-a",
        prismaClient: prismaForValidation(),
        now,
      }),
    ).rejects.toMatchObject({ code: AI_ACTION_PROPOSAL_ERROR_CODES.UNSUPPORTED_CHANNEL });

    await expect(
      validateDraftContentProposal({
        proposal: validProposal({ citations: [{ ...validProposal().citations[0], workspaceId: "workspace-b" }] }),
        workspaceId: "workspace-a",
        prismaClient: prismaForValidation(),
        now,
      }),
    ).rejects.toMatchObject({ code: AI_ACTION_PROPOSAL_ERROR_CODES.CROSS_WORKSPACE_REFERENCE });

    await expect(
      validateDraftContentProposal({
        proposal: validProposal({
          proposedDrafts: [
            {
              ...validProposal().proposedDrafts[0],
              requiredFacts: [{ name: "price", status: "missing", sourceId: null }],
            },
          ],
        }),
        workspaceId: "workspace-a",
        prismaClient: prismaForValidation(),
        now,
      }),
    ).rejects.toMatchObject({ code: AI_ACTION_PROPOSAL_ERROR_CODES.INVALID_FACT });

    await expect(
      validateDraftContentProposal({
        proposal: validProposal({
          proposedDrafts: [{ ...validProposal().proposedDrafts[0], body: "Perfect for families near downtown." }],
        }),
        workspaceId: "workspace-a",
        prismaClient: prismaForValidation(),
        now,
      }),
    ).rejects.toMatchObject({ code: AI_ACTION_PROPOSAL_ERROR_CODES.FAIR_HOUSING_POLICY });
  });

  it("rejects cross-workspace media and property references", async () => {
    await expect(
      validateDraftContentProposal({
        proposal: validProposal(),
        workspaceId: "workspace-a",
        prismaClient: prismaForValidation({ mediaAsset: { count: vi.fn(async () => 0) } }),
        now,
      }),
    ).rejects.toMatchObject({ code: AI_ACTION_PROPOSAL_ERROR_CODES.CROSS_WORKSPACE_REFERENCE });

    await expect(
      validateDraftContentProposal({
        proposal: validProposal(),
        workspaceId: "workspace-a",
        prismaClient: prismaForValidation({ workspaceDataItem: { count: vi.fn(async () => 0) } }),
        now,
      }),
    ).rejects.toMatchObject({ code: AI_ACTION_PROPOSAL_ERROR_CODES.CROSS_WORKSPACE_REFERENCE });
  });

  it("rejects replayed approval, expired proposals, and modified payloads", async () => {
    await expect(
      approveAiActionProposal({
        actor,
        workspaceId: "workspace-a",
        proposalId: "proposal-1",
        authorizationService: vi.fn(async () => ({ allowed: true })),
        prismaClient: txPrisma(storedProposal({ status: "APPROVED" })),
        now,
      }),
    ).rejects.toMatchObject({ code: AI_ACTION_PROPOSAL_ERROR_CODES.REPLAYED_APPROVAL });

    await expect(
      approveAiActionProposal({
        actor,
        workspaceId: "workspace-a",
        proposalId: "proposal-1",
        authorizationService: vi.fn(async () => ({ allowed: true })),
        prismaClient: txPrisma(storedProposal({ expiresAt: new Date("2026-07-21T12:00:00.000Z") })),
        now,
      }),
    ).rejects.toMatchObject({ code: AI_ACTION_PROPOSAL_ERROR_CODES.EXPIRED_PROPOSAL });

    await expect(
      approveAiActionProposal({
        actor,
        workspaceId: "workspace-a",
        proposalId: "proposal-1",
        authorizationService: vi.fn(async () => ({ allowed: true })),
        prismaClient: txPrisma(storedProposal({ contentHash: "sha256:" + "b".repeat(64) })),
        now,
      }),
    ).rejects.toMatchObject({ code: AI_ACTION_PROPOSAL_ERROR_CODES.CONTENT_HASH_MISMATCH });
  });

  it("records rejection flow and approval audit without publishing", async () => {
    const rejected = await rejectAiActionProposal({
      actor,
      workspaceId: "workspace-a",
      proposalId: "proposal-1",
      rejectionReason: "Needs broker edits",
      authorizationService: vi.fn(async () => ({ allowed: true })),
      prismaClient: {
        aiActionProposal: {
          findFirst: vi.fn(async () => storedProposal()),
          update: vi.fn(async ({ data }) => ({ id: "proposal-1", ...data })),
        },
      },
      now,
    });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.auditMetadata.events.at(-1)).toMatchObject({ type: "rejected" });

    const publishDraft = vi.fn();
    const approved = await approveAiActionProposal({
      actor,
      workspaceId: "workspace-a",
      proposalId: "proposal-1",
      authorizationService: vi.fn(async () => ({ allowed: true })),
      prismaClient: txPrisma(storedProposal()),
      now,
      draftCreator: vi.fn(async () => ({ id: "draft-1" })),
      publishDraft,
    });
    expect(approved.status).toBe("approved");
    expect(approved.published).toBe(false);
    expect(approved.draftIds).toEqual(["draft-1"]);
    expect(publishDraft).not.toHaveBeenCalled();
  });

  it("rolls back approval transaction when draft creation fails", async () => {
    const update = vi.fn(async ({ data }) => ({ id: "proposal-1", ...data }));
    await expect(
      approveAiActionProposal({
        actor,
        workspaceId: "workspace-a",
        proposalId: "proposal-1",
        authorizationService: vi.fn(async () => ({ allowed: true })),
        prismaClient: txPrisma(storedProposal(), { update }),
        now,
        draftCreator: vi.fn(async () => {
          throw new Error("draft create failed");
        }),
      }),
    ).rejects.toThrow("draft create failed");
    expect(update).not.toHaveBeenCalled();
  });
});

function txPrisma(proposal, overrides = {}) {
  const tx = {
    aiActionProposal: {
      findFirst: vi.fn(async () => proposal),
      update: overrides.update ?? vi.fn(async ({ data }) => ({ id: proposal.id, ...data })),
    },
    mediaAsset: { count: vi.fn(async () => 1) },
    workspaceDataItem: { count: vi.fn(async () => 1) },
    draft: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: "draft-1" })) },
  };
  return {
    $transaction: vi.fn(async (fn) => fn(tx)),
  };
}
