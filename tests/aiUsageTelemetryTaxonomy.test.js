import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let prismaMock;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const {
  AI_USAGE_ACTIONS,
  billingActionForTask,
  buildAiUsageMetadata,
  getUsageForPeriod,
  isValidAiUsageAction,
  mapProviderErrorToTaxonomyCode,
  trackAiUsage,
} = await import("../domains/billing/aiUsageTracking.service.js");

describe("AI telemetry taxonomy", () => {
  beforeEach(() => {
    prismaMock = {
      aiUsageLog: {
        create: vi.fn().mockResolvedValue({ id: "usage-1" }),
        groupBy: vi.fn().mockResolvedValue([]),
      },
    };
    delete process.env.AI_BASELINE_METADATA_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AI_BASELINE_METADATA_ENABLED;
  });

  it("accepts every persisted AiActionType, including the remediated actions", () => {
    expect(AI_USAGE_ACTIONS).toEqual([
      "GENERATE_POST",
      "REGENERATE",
      "REMIX_CONTENT",
      "GENERATE_CAMPAIGN",
      "REGENERATE_POST",
      "PARSE",
      "EXTRACT_IMAGE",
      "IMAGE",
      "VIDEO",
      "IDEAS",
      "ONBOARDING",
    ]);
    expect(isValidAiUsageAction("REMIX_CONTENT")).toBe(true);
    expect(isValidAiUsageAction("GENERATE_CAMPAIGN")).toBe(true);
    expect(isValidAiUsageAction("REGENERATE_POST")).toBe(true);
    expect(isValidAiUsageAction("EXTRACT_IMAGE")).toBe(true);
    expect(isValidAiUsageAction("UNKNOWN_ACTION")).toBe(false);
  });

  it("maps task taxonomy to stable billing actions for inline, vision, and autopilot paths", () => {
    expect(billingActionForTask("inline_rewrite")).toBe("REGENERATE");
    expect(billingActionForTask("inline_variations")).toBe("REGENERATE");
    expect(billingActionForTask("vision_auto_tag")).toBe("EXTRACT_IMAGE");
    expect(billingActionForTask("image_extraction")).toBe("EXTRACT_IMAGE");
    expect(billingActionForTask("autopilot_draft_generation")).toBe("GENERATE_POST");
  });

  it("blocks invalid enum values before Prisma writes", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    trackAiUsage({
      userId: "user-1",
      actionType: "REMIX",
      model: "gpt-4o-mini",
    });

    expect(prismaMock.aiUsageLog.create).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[AI_USAGE_TRACKING] Invalid action type:", "REMIX");
  });

  it("writes safe task metadata while the baseline metadata flag is off", () => {
    trackAiUsage({
      userId: "user-1",
      clientId: "client-1",
      actionType: "GENERATE_POST",
      model: "gpt-4o-mini",
      promptTokens: 12,
      completionTokens: 8,
      taskName: "autopilot_draft_generation",
      provider: "openai",
      source: "autopilot_draft",
      systemInitiated: true,
      latencyMs: 321,
      artifactIds: { draftId: "draft-1" },
      metadata: { promptPreview: "must not be copied" },
    });

    expect(prismaMock.aiUsageLog.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.aiUsageLog.create.mock.calls[0][0].data;
    expect(data.actionType).toBe("GENERATE_POST");
    expect(data.metadata).toMatchObject({
      taskName: "autopilot_draft_generation",
      provider: "openai",
      model: "gpt-4o-mini",
      source: "autopilot_draft",
      systemInitiated: true,
    });
    expect(data.metadata).not.toHaveProperty("latencyMs");
    expect(data.metadata).not.toHaveProperty("artifactIds");
    expect(data.metadata).not.toHaveProperty("promptPreview");
  });

  it("adds trace metadata only when AI_BASELINE_METADATA_ENABLED is enabled", () => {
    process.env.AI_BASELINE_METADATA_ENABLED = "true";

    const metadata = buildAiUsageMetadata({
      actionType: "EXTRACT_IMAGE",
      model: "gpt-4o-mini",
      taskName: "vision_auto_tag",
      schemaName: "asset_auto_tag",
      provider: "openai",
      requestId: "req-1",
      latencyMs: 42,
      taxonomyCode: "PROVIDER_TIMEOUT",
      artifactIds: { assetId: "asset-1" },
    });

    expect(metadata).toMatchObject({
      taskName: "vision_auto_tag",
      schemaName: "asset_auto_tag",
      provider: "openai",
      requestId: "req-1",
      traceId: "req-1",
      latencyMs: 42,
      providerStatus: "success",
      taxonomyCode: "PROVIDER_TIMEOUT",
      artifactIds: { assetId: "asset-1" },
    });
  });

  it("classifies known provider failures without logging prompts or outputs", () => {
    expect(mapProviderErrorToTaxonomyCode("OPENAI_TIMEOUT")).toBe("PROVIDER_TIMEOUT");
    expect(mapProviderErrorToTaxonomyCode("OPENAI_INVALID_JSON")).toBe("PROVIDER_INVALID_JSON");
    expect(mapProviderErrorToTaxonomyCode("OPENAI_UNKNOWN")).toBeNull();
  });

  it("keeps historical usage aggregation grouped by persisted actionType", async () => {
    prismaMock.aiUsageLog.groupBy.mockResolvedValue([
      {
        actionType: "REGENERATE_POST",
        _count: 2,
        _sum: { promptTokens: 10, completionTokens: 6, estimatedCostCents: 4 },
      },
    ]);

    await expect(
      getUsageForPeriod("user-1", new Date("2026-07-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z")),
    ).resolves.toEqual([
      {
        actionType: "REGENERATE_POST",
        count: 2,
        totalPromptTokens: 10,
        totalCompletionTokens: 6,
        totalCostCents: 4,
      },
    ]);
  });
});
