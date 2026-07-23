import { describe, expect, it, vi } from "vitest";

import {
  AUTOPILOT_ML_RANKING_ERROR_CODES,
  heuristicRankCandidates,
  rankAutopilotOpportunities,
} from "../domains/aiPlatform/autopilotMlRanking.service.js";

const actor = { auth0Sub: "auth0|owner", id: "auth0|owner" };

function candidate(candidateId, overrides = {}) {
  return {
    candidateId,
    workspaceId: "workspace-a",
    triggerType: "NEW_LISTING",
    industry: "real_estate",
    channel: "INSTAGRAM",
    heuristicScore: 0.5,
    listingAgeDays: 4,
    priceChangePercent: 0,
    daysSinceLastPost: 8,
    mediaAvailable: true,
    historicalApprovalRate: 0.7,
    historicalEngagementRate: 0.03,
    hourOfDay: 10,
    dayOfWeek: 2,
    contentType: "listing",
    recentAudienceEngagement: 0.04,
    detectedAt: "2026-07-22T10:00:00.000Z",
    ...overrides,
  };
}

function pythonRanking(overrides = {}) {
  return {
    schemaVersion: "autopilot-opportunity-ranking.v1",
    workspaceId: "workspace-a",
    rankedCandidates: [
      {
        candidateId: "c2",
        workspaceId: "workspace-a",
        baselineRank: 2,
        mlRank: 1,
        heuristicScore: 0.2,
        predictedUsefulness: 0.9,
        missingFeatures: [],
        modelVersion: "autopilot-logistic-ranker.v1",
      },
      {
        candidateId: "c1",
        workspaceId: "workspace-a",
        baselineRank: 1,
        mlRank: 2,
        heuristicScore: 0.8,
        predictedUsefulness: 0.7,
        missingFeatures: [],
        modelVersion: "autopilot-logistic-ranker.v1",
      },
    ],
    modelMetadata: { modelVersion: "autopilot-logistic-ranker.v1" },
    traceId: "trace-rank",
    shadowMode: true,
    proposalOnly: true,
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    actor,
    workspaceId: "workspace-a",
    candidates: [
      candidate("c1", { heuristicScore: 0.8 }),
      candidate("c2", { heuristicScore: 0.2 }),
    ],
    featureEnabled: true,
    serviceAuthSecret: "secret",
    authorizationService: vi.fn(async () => ({ allowed: true })),
    featureFlagEvaluator: vi.fn(async () => true),
    pythonClient: vi.fn(async () => ({ ok: true, body: pythonRanking() })),
    ...overrides,
  };
}

describe("Autopilot ML ranking wrapper", () => {
  it("keeps heuristic baseline deterministic", () => {
    const ranked = heuristicRankCandidates([
      candidate("old", { heuristicScore: 0.5, detectedAt: "2026-07-22T11:00:00.000Z" }),
      candidate("high", { heuristicScore: 0.9 }),
      candidate("new", { heuristicScore: 0.5, detectedAt: "2026-07-22T12:00:00.000Z" }),
    ]);

    expect(ranked.map((item) => item.candidateId)).toEqual(["high", "old", "new"]);
  });

  it("falls back to heuristic when disabled or provider fails", async () => {
    const disabled = await rankAutopilotOpportunities(
      baseDeps({ featureEnabled: false, featureFlagEvaluator: vi.fn(async () => false) }),
    );
    expect(disabled.mode).toBe("heuristic_fallback");
    expect(disabled.rankedCandidates.map((item) => item.candidateId)).toEqual(["c1", "c2"]);

    const failed = await rankAutopilotOpportunities(
      baseDeps({ pythonClient: vi.fn(async () => ({ ok: false, errorCode: "PROVIDER_TIMEOUT" })) }),
    );
    expect(failed.mode).toBe("heuristic_fallback");
    expect(failed.reason).toBe("PROVIDER_TIMEOUT");
  });

  it("does not alter authoritative order in shadow mode", async () => {
    const result = await rankAutopilotOpportunities(baseDeps({ shadowMode: true }));

    expect(result.mode).toBe("shadow");
    expect(result.oldNodePathUnaffected).toBe(true);
    expect(result.rankedCandidates.map((item) => item.candidateId)).toEqual(["c1", "c2"]);
    expect(result.mlRankings.rankedCandidates[0].candidateId).toBe("c2");
  });

  it("uses ML order only when explicitly not shadowing", async () => {
    const result = await rankAutopilotOpportunities(
      baseDeps({ shadowMode: false, pythonClient: vi.fn(async () => ({ ok: true, body: pythonRanking({ shadowMode: false }) })) }),
    );

    expect(result.mode).toBe("ml_ranked");
    expect(result.rankedCandidates.map((item) => item.candidateId)).toEqual(["c2", "c1"]);
  });

  it("rejects model version mismatch and cross-workspace candidates before Python call", async () => {
    const pythonClient = vi.fn();
    await expect(
      rankAutopilotOpportunities(baseDeps({ modelVersion: "future-model", pythonClient })),
    ).rejects.toMatchObject({ code: AUTOPILOT_ML_RANKING_ERROR_CODES.MODEL_VERSION_MISMATCH });
    expect(pythonClient).not.toHaveBeenCalled();

    await expect(
      rankAutopilotOpportunities(
        baseDeps({ candidates: [candidate("bad", { workspaceId: "workspace-b" })], pythonClient }),
      ),
    ).rejects.toMatchObject({ code: AUTOPILOT_ML_RANKING_ERROR_CODES.CROSS_WORKSPACE_REFERENCE });
    expect(pythonClient).not.toHaveBeenCalled();
  });

  it("signs only the read-only autopilot rank scope", async () => {
    const pythonClient = vi.fn(async () => ({ ok: true, body: pythonRanking() }));

    await rankAutopilotOpportunities(baseDeps({ pythonClient }));

    const envelope = pythonClient.mock.calls[0][0].envelope;
    expect(envelope.scopes).toEqual(["autopilot-rank:read"]);
    expect(envelope.payload.candidates).toHaveLength(2);
  });
});
