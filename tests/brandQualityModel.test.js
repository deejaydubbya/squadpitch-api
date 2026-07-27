import { describe, expect, it, vi } from "vitest";

import {
  BRAND_QUALITY_ERROR_CODES,
  deterministicBrandQualityFallback,
  scoreBrandContentQuality,
} from "../domains/aiPlatform/brandQualityModel.service.js";

const actor = { auth0Sub: "auth0|owner", id: "auth0|owner" };

function pythonScore(overrides = {}) {
  return {
    schemaVersion: "brand-content-quality.v1",
    workspaceId: "workspace-a",
    contentId: "content-1",
    modelVersion: "brand-quality-neural-shadow.v1",
    modelFamily: "deterministic_shadow",
    scores: [
      {
        label: "needs_human_review",
        score: 0.8,
        risk: "high",
        explanation: "Maximum policy/quality risk.",
      },
    ],
    needsHumanReview: true,
    categories: ["needs_human_review"],
    calibration: { expectedCalibrationError: 0, trainedArtifactAvailable: 0 },
    explanations: ["Maximum policy/quality risk."],
    traceId: "trace-quality",
    proposalOnly: true,
    provenance: {
      operation: "brand_quality_score",
      source: "squadpitch-ai",
      fallbackUsed: false,
      implementation: "deterministic_brand_quality_v1",
    },
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    actor,
    workspaceId: "workspace-a",
    contentId: "content-1",
    sanitizedText:
      "A calm professional listing update with local market context.",
    channel: "INSTAGRAM",
    industry: "real_estate",
    brandConstraints: ["professional", "local"],
    bannedPhrases: ["guaranteed profit"],
    language: "en",
    featureEnabled: true,
    serviceAuthSecret: "secret",
    authorizationService: vi.fn(async () => ({ allowed: true })),
    featureFlagEvaluator: vi.fn(async () => true),
    pythonClient: vi.fn(async () => ({ ok: true, body: pythonScore() })),
    ...overrides,
  };
}

describe("brand content quality model wrapper", () => {
  it("uses deterministic fallback when disabled without calling Python", async () => {
    const pythonClient = vi.fn();
    const result = await scoreBrandContentQuality(
      baseDeps({
        featureEnabled: false,
        featureFlagEvaluator: vi.fn(async () => false),
        pythonClient,
      }),
    );

    expect(result.mode).toBe("deterministic_fallback");
    expect(result.reason).toBe(BRAND_QUALITY_ERROR_CODES.FEATURE_DISABLED);
    expect(result.qualityScore.proposalOnly).toBe(true);
    expect(result.provenance).toMatchObject({
      source: "node",
      executionMode: "local",
      fallbackUsed: false,
    });
    expect(pythonClient).not.toHaveBeenCalled();
  });

  it("rejects model mismatch and unsanitized text before Python call", async () => {
    const pythonClient = vi.fn();
    await expect(
      scoreBrandContentQuality(
        baseDeps({ modelVersion: "future-model", pythonClient }),
      ),
    ).rejects.toMatchObject({
      code: BRAND_QUALITY_ERROR_CODES.MODEL_VERSION_MISMATCH,
    });
    await expect(
      scoreBrandContentQuality(
        baseDeps({ sanitizedText: "Email lead@example.com", pythonClient }),
      ),
    ).rejects.toMatchObject({
      code: BRAND_QUALITY_ERROR_CODES.RAW_TEXT_REJECTED,
    });
    expect(pythonClient).not.toHaveBeenCalled();
  });

  it("falls back when Python provider fails", async () => {
    const result = await scoreBrandContentQuality(
      baseDeps({
        pythonClient: vi.fn(async () => ({
          ok: false,
          errorCode: "PROVIDER_TIMEOUT",
        })),
      }),
    );

    expect(result.mode).toBe("deterministic_fallback");
    expect(result.reason).toBe("PROVIDER_TIMEOUT");
    expect(result.oldNodePathUnaffected).toBe(true);
    expect(result.provenance).toMatchObject({
      source: "node_fallback",
      fallbackLayer: "node",
      fallbackReason: "timeout",
    });
  });

  it("falls back with schema_mismatch when Python returns an invalid response", async () => {
    const result = await scoreBrandContentQuality(
      baseDeps({
        pythonClient: vi.fn(async () => ({ ok: true, body: { nope: true } })),
      }),
    );

    expect(result.mode).toBe("deterministic_fallback");
    expect(result.provenance.fallbackReason).toBe("schema_mismatch");
  });

  it("signs content-score read scope and returns model output only in shadow mode", async () => {
    const pythonClient = vi.fn(async () => ({ ok: true, body: pythonScore() }));
    const result = await scoreBrandContentQuality(baseDeps({ pythonClient }));

    const envelope = pythonClient.mock.calls[0][0].envelope;
    expect(envelope.scopes).toEqual(["content-score:read"]);
    expect(envelope.payload.proposalOnly).toBe(true);
    expect(result.mode).toBe("shadow");
    expect(result.modelScore.proposalOnly).toBe(true);
    expect(result).not.toHaveProperty("draft");
    expect(result).not.toHaveProperty("publish");
    expect(result.provenance).toMatchObject({
      source: "node",
      executionMode: "shadow",
      hostedAttempted: true,
    });
  });

  it("rejects cross-workspace provider responses", async () => {
    await expect(
      scoreBrandContentQuality(
        baseDeps({
          pythonClient: vi.fn(async () => ({
            ok: true,
            body: pythonScore({ workspaceId: "workspace-b" }),
          })),
        }),
      ),
    ).rejects.toMatchObject({
      code: BRAND_QUALITY_ERROR_CODES.CROSS_WORKSPACE_REFERENCE,
    });
  });

  it("flags prohibited phrases and unsupported language locally", () => {
    const result = deterministicBrandQualityFallback({
      workspaceId: "workspace-a",
      contentId: "content-1",
      sanitizedText: "This exclusive offer has guaranteed profit.",
      channel: "X",
      brandConstraints: ["local"],
      bannedPhrases: ["guaranteed profit"],
      language: "fr",
    });

    expect(result.needsHumanReview).toBe(true);
    expect(result.categories).toEqual(
      expect.arrayContaining([
        "prohibited_phrase",
        "unsupported_language_risk",
        "needs_human_review",
      ]),
    );
  });
});
