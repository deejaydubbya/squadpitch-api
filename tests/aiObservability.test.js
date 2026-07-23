import { describe, expect, it, vi } from "vitest";

import {
  AI_OBSERVABILITY_ERROR_CODES,
  buildTraceEnvelope,
  cleanupExpiredAiRunTraces,
  getAiOperationsCenter,
  getAiTraceDrilldown,
  hasSecretLeak,
  recordAiRunTrace,
  redactAiTraceValue,
} from "../domains/aiPlatform/observability.service.js";

function baseTrace(overrides = {}) {
  return {
    requestId: "req-1",
    traceId: "trace-1",
    workspaceId: "workspace-a",
    actorUserId: "auth0|owner",
    taskType: "draft_content",
    featureFlags: { ai_action_proposals_enabled: true },
    provider: "openai",
    model: "gpt-4o-mini",
    promptVersion: "draft.v1",
    schemaVersion: "draft-content-proposal.v1",
    retrievalRunId: "retrieval-1",
    retrievedSources: [{ sourceId: "property-1", score: 0.91, contentHash: "sha256:test" }],
    steps: [{ name: "provider_call", latencyMs: 120, prompt: "secret customer prompt" }],
    validationResults: { valid: true, output: "raw generated copy" },
    retryCount: 1,
    promptTokens: 100,
    completionTokens: 50,
    estimatedCostCents: 3.5,
    latencyMs: 250,
    status: "SUCCEEDED",
    humanOutcome: "approved",
    downstreamCampaignIds: ["campaign-1"],
    downstreamDraftIds: ["draft-1"],
    outcomePointers: { proposalId: "proposal-1" },
    releaseGateStage: "SHADOW",
    rawContentCaptured: false,
    ...overrides,
  };
}

describe("AI observability operations center", () => {
  it("builds complete cross-service trace envelopes with raw capture disabled", () => {
    const envelope = buildTraceEnvelope(baseTrace());

    expect(envelope).toMatchObject({
      requestId: "req-1",
      traceId: "trace-1",
      clientId: "workspace-a",
      taskType: "draft_content",
      provider: "openai",
      model: "gpt-4o-mini",
      promptVersion: "draft.v1",
      schemaVersion: "draft-content-proposal.v1",
      retrievalRunId: "retrieval-1",
      retryCount: 1,
      promptTokens: 100,
      completionTokens: 50,
      estimatedCostCents: 3.5,
      status: "SUCCEEDED",
      humanOutcome: "approved",
      releaseGateStage: "SHADOW",
      rawContentCaptured: false,
      redactionVersion: "ai-trace-redaction.v1",
    });
    expect(envelope.retentionUntil).toBeInstanceOf(Date);
  });

  it("rejects missing trace dependencies", () => {
    expect(() => buildTraceEnvelope({ ...baseTrace(), traceId: undefined })).toThrow();
    expect(() => buildTraceEnvelope({ ...baseTrace(), requestId: undefined })).toThrow();
  });

  it("redacts raw prompt/output fields and detects leaked secrets", () => {
    const redacted = redactAiTraceValue({
      prompt: "Write about jane@example.com",
      nested: { authorization: "Bearer abcdefghijklmnop", phone: "Call 919-555-1212" },
      safeId: "property-1",
    });

    expect(redacted.prompt).toMatchObject({ redacted: true, length: expect.any(Number) });
    expect(redacted.nested.authorization).toBe("[REDACTED_SECRET]");
    expect(redacted.nested.phone).toBe("Call [REDACTED_PHONE]");
    expect(redacted.safeId).toBe("property-1");
    expect(hasSecretLeak(redacted)).toBe(false);

    expect(() =>
      buildTraceEnvelope(baseTrace({ steps: [{ name: "bad", note: "sk-thisisnotallowed12345" }] })),
    ).toThrow(/secret/);
  });

  it("records sanitized traces without raw prompts or outputs", async () => {
    const create = vi.fn(async ({ data }) => ({ id: "trace-row-1", ...data }));

    const record = await recordAiRunTrace({
      trace: baseTrace(),
      prismaClient: { aiRunTrace: { create } },
      now: new Date("2026-07-22T12:00:00.000Z"),
    });

    expect(record.rawContentCaptured).toBe(false);
    expect(JSON.stringify(record)).not.toContain("secret customer prompt");
    expect(JSON.stringify(record)).not.toContain("raw generated copy");
    expect(record.steps[0].prompt.redacted).toBe(true);
  });

  it("requires admin drill-down and denies cross-workspace trace access", async () => {
    const prismaClient = {
      aiRunTrace: {
        findFirst: vi.fn(async () => ({ traceId: "trace-1", clientId: "workspace-b" })),
      },
    };

    await expect(
      getAiTraceDrilldown({ traceId: "trace-1", actorRoles: ["developer"], prismaClient }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      getAiTraceDrilldown({
        traceId: "trace-1",
        workspaceId: "workspace-a",
        actorRoles: ["admin"],
        prismaClient,
      }),
    ).rejects.toMatchObject({ code: "TENANT_LEAKAGE" });
  });

  it("cleans up traces past retention", async () => {
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const result = await cleanupExpiredAiRunTraces({
      prismaClient: { aiRunTrace: { deleteMany } },
      now: new Date("2026-07-22T12:00:00.000Z"),
    });

    expect(result.count).toBe(2);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { retentionUntil: { lt: new Date("2026-07-22T12:00:00.000Z") } },
    });
  });

  it("surfaces provider failures and taxonomy release gate panels", async () => {
    const traces = [
      storedTrace(baseTrace()),
      storedTrace(baseTrace({ traceId: "trace-2", status: "FAILED", errorCode: "PROVIDER_TIMEOUT" })),
      storedTrace(baseTrace({ traceId: "trace-3", status: "FAILED", errorCode: "MISSING_USAGE_LOG" })),
      storedTrace(baseTrace({ traceId: "trace-4", status: "REJECTED", errorCode: "HUMAN_REJECTED", humanOutcome: "rejected" })),
    ];

    const center = await getAiOperationsCenter({
      prismaClient: { aiRunTrace: { findMany: vi.fn(async () => traces) } },
      since: new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(center.summary.totalRuns).toBe(4);
    expect(center.panels.providerFailures["openai|gpt-4o-mini|PROVIDER_TIMEOUT"]).toBe(1);
    expect(center.panels.taxonomyFocus.MISSING_USAGE_LOG).toBe(1);
    expect(center.panels.taxonomyFocus.HUMAN_REJECTED).toBe(1);
    expect(center.panels.errorCodeByTask["draft_content|PROVIDER_TIMEOUT"]).toBe(1);
    expect(center.rollbackControls.aiActionProposals).toContain("ai_action_proposals_enabled");
    expect(AI_OBSERVABILITY_ERROR_CODES.TRACE_MISSING.severity).toBe("low");
  });
});

function storedTrace(trace) {
  const envelope = buildTraceEnvelope(trace);
  return {
    ...envelope,
    workspaceId: undefined,
    createdAt: new Date("2026-07-22T12:00:00.000Z"),
  };
}
