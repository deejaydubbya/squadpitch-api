import { beforeEach, describe, expect, it, vi } from "vitest";

let prismaMock;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { seedFlags } = await import("../domains/internal/config.service.js");

describe("AI platform feature flag seed", () => {
  beforeEach(() => {
    prismaMock = {
      featureFlag: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(1),
      },
    };
  });

  it("seeds ai_platform_enabled disabled by default", async () => {
    await seedFlags();

    expect(prismaMock.featureFlag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "ai_platform_enabled",
        enabled: false,
        scope: "global",
        category: "ops",
      }),
    });
  });

  it("seeds ai_retrieval_enabled disabled by default", async () => {
    await seedFlags();

    expect(prismaMock.featureFlag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "ai_retrieval_enabled",
        enabled: false,
        scope: "global",
        category: "ops",
      }),
    });
  });

  it("seeds ai_campaign_ops_agent_enabled disabled by default", async () => {
    await seedFlags();

    expect(prismaMock.featureFlag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "ai_campaign_ops_agent_enabled",
        enabled: false,
        scope: "global",
        category: "ops",
      }),
    });
  });

  it("seeds ai_action_proposals_enabled disabled by default", async () => {
    await seedFlags();

    expect(prismaMock.featureFlag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "ai_action_proposals_enabled",
        enabled: false,
        scope: "global",
        category: "ops",
      }),
    });
  });

  it("seeds ai_operations_center_enabled disabled by default", async () => {
    await seedFlags();

    expect(prismaMock.featureFlag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "ai_operations_center_enabled",
        enabled: false,
        scope: "global",
        category: "ops",
      }),
    });
  });

  it("seeds ai_autopilot_ml_ranking_enabled disabled by default", async () => {
    await seedFlags();

    expect(prismaMock.featureFlag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "ai_autopilot_ml_ranking_enabled",
        enabled: false,
        scope: "global",
        category: "ops",
      }),
    });
  });

  it("seeds ai_brand_quality_model_enabled disabled by default", async () => {
    await seedFlags();

    expect(prismaMock.featureFlag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "ai_brand_quality_model_enabled",
        enabled: false,
        scope: "global",
        category: "ops",
      }),
    });
  });

  it("seeds ai_experimentation_enabled disabled by default", async () => {
    await seedFlags();

    expect(prismaMock.featureFlag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "ai_experimentation_enabled",
        enabled: false,
        scope: "global",
        category: "ops",
      }),
    });
  });
});
