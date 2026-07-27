import { describe, expect, it, vi } from "vitest";

import {
  CAMPAIGN_OPS_AGENT_ERROR_CODES,
  campaignOpsPlanResponseSchema,
  generateCampaignOpsAgentPreview,
} from "../domains/aiPlatform/campaignOpsAgent.service.js";

function validPythonPlan(overrides = {}) {
  return {
    schemaVersion: "campaign-ops-plan.v1",
    planId: "plan-1",
    objective: "Create a seven-day campaign plan.",
    strategy: "Grounded seven-day plan.",
    proposedPosts: [
      {
        day: 1,
        channel: "INSTAGRAM",
        suggestedTime: "2026-07-23T10:00:00Z",
        contentBrief: "Use the approved property facts.",
        requiredFacts: [
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
        mediaRecommendations: ["Use exterior hero"],
        risks: [],
        approvalRequirements: [
          "Human approval required before creating drafts.",
        ],
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
    mediaRecommendations: ["Use exterior hero"],
    risks: [],
    validationStatus: {
      valid: true,
      warnings: [],
      missingFacts: [],
      calendarConflicts: [],
    },
    approvalRequirements: ["Human approval required before creating drafts."],
    modelMetadata: {
      implementation: "python",
      model: "deterministic-read-only-planner",
      promptVersion: "campaign-ops-read-only.v1",
    },
    traceId: "trace-1",
    expiresAt: "2026-07-23T10:00:00Z",
    proposalOnly: true,
    provenance: {
      operation: "campaign_ops_plan",
      source: "squadpitch-ai",
      fallbackUsed: false,
      implementation: "campaign_ops_v1",
    },
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    actor: { auth0Sub: "auth0|owner", id: "auth0|owner" },
    workspaceId: "workspace-a",
    objective: "Create a seven-day campaign plan.",
    featureEnabled: true,
    serviceAuthSecret: "secret",
    authorizationService: vi.fn(async () => ({ allowed: true })),
    featureFlagEvaluator: vi.fn(async () => true),
    subscriptionFetcher: vi.fn(async () => ({
      stripeSubscriptionId: "sub_123",
      status: "ACTIVE",
      tier: "PRO",
    })),
    effectiveTierResolver: vi.fn(() => "PRO"),
    snapshotBuilder: vi.fn(async () => ({
      workspaceId: "workspace-a",
      objective: "Create a seven-day campaign plan.",
      items: [],
      media: [],
      calendar: [],
      approvalPolicy: { requiresHumanApproval: true },
      allowedChannels: ["INSTAGRAM"],
    })),
    pythonClient: vi.fn(async () => ({ ok: true, body: validPythonPlan() })),
    ...overrides,
  };
}

describe("read-only campaign ops agent", () => {
  it("denies unauthenticated users before Python call", async () => {
    const pythonClient = vi.fn();

    await expect(
      generateCampaignOpsAgentPreview(baseDeps({ actor: null, pythonClient })),
    ).rejects.toMatchObject({
      code: CAMPAIGN_OPS_AGENT_ERROR_CODES.AUTH_REQUIRED,
    });
    expect(pythonClient).not.toHaveBeenCalled();
  });

  it("denies wrong workspace before Python call", async () => {
    const pythonClient = vi.fn();

    await expect(
      generateCampaignOpsAgentPreview(
        baseDeps({
          pythonClient,
          authorizationService: async () => {
            const err = new Error("denied");
            err.code = "NOT_WORKSPACE_OWNER";
            err.status = 403;
            throw err;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_WORKSPACE_OWNER" });
    expect(pythonClient).not.toHaveBeenCalled();
  });

  it("cannot request write scopes", async () => {
    const pythonClient = vi.fn();

    await expect(
      generateCampaignOpsAgentPreview(
        baseDeps({
          requestedScopes: ["campaign-plan:read", "publish:write"],
          pythonClient,
        }),
      ),
    ).rejects.toMatchObject({
      code: CAMPAIGN_OPS_AGENT_ERROR_CODES.WRITE_SCOPE_DENIED,
    });
    expect(pythonClient).not.toHaveBeenCalled();
  });

  it("is gated by feature flag and paid tier", async () => {
    await expect(
      generateCampaignOpsAgentPreview(
        baseDeps({
          featureEnabled: false,
          featureFlagEvaluator: vi.fn(async () => false),
        }),
      ),
    ).rejects.toMatchObject({
      code: CAMPAIGN_OPS_AGENT_ERROR_CODES.FEATURE_DISABLED,
    });

    await expect(
      generateCampaignOpsAgentPreview(
        baseDeps({ effectiveTierResolver: vi.fn(() => "FREE") }),
      ),
    ).rejects.toMatchObject({
      code: CAMPAIGN_OPS_AGENT_ERROR_CODES.TIER_LIMIT,
    });
  });

  it("returns proposal only and cannot publish", async () => {
    const result = await generateCampaignOpsAgentPreview(baseDeps());

    expect(result.status).toBe("proposal_only");
    expect(result.oldNodePathUnaffected).toBe(true);
    expect(result.proposal.proposalOnly).toBe(true);
    expect(result.provenance).toMatchObject({
      source: "squadpitch-ai",
      operation: "campaign_ops_plan",
      fallbackUsed: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /publishDraft|scheduleDraft|createCampaign/,
    );
  });

  it("validates citations and rejects cross-workspace responses", async () => {
    await expect(
      generateCampaignOpsAgentPreview(
        baseDeps({
          pythonClient: vi.fn(async () => ({
            ok: true,
            body: validPythonPlan({
              citations: [
                {
                  sourceType: "property_listing",
                  sourceId: "property-1",
                  workspaceId: "workspace-b",
                  contentHash: "sha256:test",
                  trust: "authoritative",
                },
              ],
            }),
          })),
        }),
      ),
    ).rejects.toMatchObject({
      code: CAMPAIGN_OPS_AGENT_ERROR_CODES.SCHEMA_INVALID,
    });
  });

  it("maps provider timeout and schema failures safely", async () => {
    await expect(
      generateCampaignOpsAgentPreview(
        baseDeps({
          pythonClient: vi.fn(async () => ({
            ok: false,
            status: "timeout",
            errorCode: "PROVIDER_TIMEOUT",
          })),
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", status: 504 });

    expect(() =>
      campaignOpsPlanResponseSchema.parse({
        ...validPythonPlan(),
        proposalOnly: false,
      }),
    ).toThrow();
  });

  it("signs only the read-only campaign plan scope", async () => {
    const pythonClient = vi.fn(async () => ({
      ok: true,
      body: validPythonPlan(),
    }));

    await generateCampaignOpsAgentPreview(baseDeps({ pythonClient }));

    const envelope = pythonClient.mock.calls[0][0].envelope;
    expect(envelope.scopes).toEqual(["campaign-plan:read"]);
    expect(envelope.payload.proposalOnly).toBe(true);
    expect(envelope.payload.snapshot.workspaceId).toBe("workspace-a");
  });

  it("feeds retrieved context into the real campaign planner consumer", async () => {
    const pythonClient = vi.fn(async () => ({
      ok: true,
      body: validPythonPlan(),
    }));
    const retrievalService = vi.fn(async () => ({
      results: [
        {
          text: "Use the approved professional local-market voice.",
          citation: {
            workspaceId: "workspace-a",
            sourceType: "brand_profile",
            sourceId: "brand-1",
            contentHash: `sha256:${"a".repeat(64)}`,
            chunkId: "brand-1:0",
            trustClassification: "approved",
            language: "en",
          },
          metadata: { sourceTitle: "Brand voice" },
        },
      ],
      provenance: {
        source: "squadpitch-ai",
        operation: "retrieval_query",
        fallbackUsed: false,
      },
    }));

    const result = await generateCampaignOpsAgentPreview(
      baseDeps({ pythonClient, retrievalService }),
    );
    const plannerSnapshot =
      pythonClient.mock.calls[0][0].envelope.payload.snapshot;

    expect(retrievalService).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        purpose: "campaign_context",
      }),
    );
    expect(plannerSnapshot.items).toContainEqual(
      expect.objectContaining({
        sourceId: "brand-1",
        citationId: "brand-1:0",
        retrieved: true,
      }),
    );
    expect(result.retrievalProvenance).toMatchObject({
      source: "squadpitch-ai",
      fallbackUsed: false,
    });
    expect(JSON.stringify(result)).not.toContain("retrievalProvenance");
  });
});
