import { describe, expect, it, vi } from "vitest";

import {
  EXPERIMENT_ERROR_CODES,
  assignExperimentVariant,
  attributeOutcomes,
  buildExperimentReportInterface,
  createExposure,
  getExperimentReport,
  rollbackExperiment,
} from "../domains/aiPlatform/experimentation.service.js";

const actor = { auth0Sub: "auth0|admin", id: "auth0|admin" };
const now = new Date("2026-07-22T12:00:00.000Z");

function definition(overrides = {}) {
  return {
    experimentId: "exp-hook-v1",
    workspaceId: "workspace-a",
    name: "Hook experiment",
    hypothesis: "Local proof hooks improve approval rate.",
    primaryMetric: "approved",
    metricType: "proportion",
    guardrailMetrics: ["provider_failure_rate"],
    eligibilityRules: { channels: ["INSTAGRAM"] },
    variants: [
      { key: "control", label: "Current", allocation: 0.5, isControl: true },
      {
        key: "treatment",
        label: "Local proof",
        allocation: 0.5,
        isControl: false,
      },
    ],
    attributionWindowHours: 24,
    sampleSizeGuidance: { minimumPerVariant: 30, power: 0.8 },
    stoppingRules: ["Do not stop early unless guardrail fails."],
    analysisPlan: "Compare approval proportions with confidence intervals.",
    segments: ["channel"],
    status: "running",
    ...overrides,
  };
}

function exposure(overrides = {}) {
  return {
    exposureId: "exposure-1",
    experimentId: "exp-hook-v1",
    workspaceId: "workspace-a",
    subjectId: "subject-1",
    variantKey: "control",
    exposedAt: "2026-07-22T12:00:00.000Z",
    entityType: "draft",
    entityId: "draft-1",
    segments: { channel: "INSTAGRAM" },
    ...overrides,
  };
}

function outcome(overrides = {}) {
  return {
    outcomeId: "outcome-1",
    experimentId: "exp-hook-v1",
    workspaceId: "workspace-a",
    entityType: "draft",
    entityId: "draft-1",
    metric: "approved",
    value: 1,
    observedAt: "2026-07-22T13:00:00.000Z",
    ...overrides,
  };
}

describe("AI experimentation service", () => {
  it("assigns variants deterministically", () => {
    const first = assignExperimentVariant({
      definition: definition(),
      subjectId: "subject-1",
    });
    const second = assignExperimentVariant({
      definition: definition(),
      subjectId: "subject-1",
    });

    expect(first).toEqual(second);
    expect(["control", "treatment"]).toContain(first.key);
  });

  it("dedupes exposures and rejects rolled back experiments", () => {
    const created = createExposure({
      definition: definition(),
      subjectId: "subject-1",
      entityType: "draft",
      entityId: "draft-1",
      now,
    });

    expect(() =>
      createExposure({
        definition: definition(),
        subjectId: "subject-1",
        entityType: "draft",
        entityId: "draft-1",
        now,
        existingExposures: [created],
      }),
    ).toThrow(
      expect.objectContaining({
        code: EXPERIMENT_ERROR_CODES.DUPLICATE_EXPOSURE,
      }),
    );
    expect(() =>
      assignExperimentVariant({
        definition: rollbackExperiment(definition(), "guardrail failed"),
        subjectId: "s",
      }),
    ).toThrow(
      expect.objectContaining({
        code: EXPERIMENT_ERROR_CODES.EXPERIMENT_ROLLED_BACK,
      }),
    );
  });

  it("attributes outcomes inside the window only and rejects tenant leakage", () => {
    const attributed = attributeOutcomes({
      definition: definition(),
      exposures: [exposure()],
      outcomes: [
        outcome(),
        outcome({ outcomeId: "late", observedAt: "2026-07-23T13:01:00.000Z" }),
      ],
    });

    expect(attributed[0].outcomes.map((item) => item.outcomeId)).toEqual([
      "outcome-1",
    ]);
    expect(() =>
      attributeOutcomes({
        definition: definition(),
        exposures: [exposure({ workspaceId: "workspace-b" })],
        outcomes: [],
      }),
    ).toThrow(
      expect.objectContaining({ code: EXPERIMENT_ERROR_CODES.TENANT_LEAKAGE }),
    );
  });

  it("builds a gated admin report surface without implying causation", () => {
    const report = buildExperimentReportInterface({
      definition: definition(),
      exposures: [exposure()],
      outcomes: [outcome()],
      enabled: true,
    });

    expect(report.summary.attributedOutcomes).toBe(1);
    expect(report.cautions.join(" ")).toContain("Do not infer causation");
  });

  it("calls Python analysis with eval:run scope and falls back on timeout", async () => {
    const pythonClient = vi.fn(async () => ({
      ok: true,
      body: { schemaVersion: "experiment-analysis.v1" },
    }));
    const result = await getExperimentReport({
      actor,
      definition: definition(),
      exposures: [exposure()],
      outcomes: [outcome()],
      featureEnabled: true,
      serviceAuthSecret: "secret",
      authorizationService: vi.fn(async () => ({ allowed: true })),
      pythonClient,
    });

    expect(result.status).toBe("ok");
    expect(pythonClient.mock.calls[0][0].envelope.scopes).toEqual(["eval:run"]);

    const failed = await getExperimentReport({
      actor,
      definition: definition(),
      exposures: [exposure()],
      outcomes: [outcome()],
      featureEnabled: true,
      serviceAuthSecret: "secret",
      authorizationService: vi.fn(async () => ({ allowed: true })),
      pythonClient: vi.fn(async () => ({
        ok: false,
        errorCode: "PROVIDER_TIMEOUT",
      })),
    });
    expect(failed.status).toBe("analysis_unavailable");
    expect(failed.reason).toBe("PROVIDER_TIMEOUT");
  });
});
