import { beforeEach, describe, expect, it, vi } from "vitest";

let prismaMock;
let flagEnabled = false;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

vi.mock("../domains/internal/config.service.js", () => ({
  evaluateFlag: vi.fn(async () => flagEnabled),
}));

const { getDashboardActions } = await import("../domains/studio/dashboard.service.js");

function makePrisma() {
  return {
    draft: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
    },
    channelSettings: {
      findMany: vi.fn(async () => [{ channel: "INSTAGRAM", isEnabled: true }]),
    },
    workspaceDataItem: {
      count: vi.fn(async () => 1),
    },
  };
}

describe("dashboard campaign ops preview surface", () => {
  beforeEach(() => {
    flagEnabled = false;
    prismaMock = makePrisma();
  });

  it("hides the campaign ops preview action by default", async () => {
    const { actions } = await getDashboardActions("workspace-a");

    expect(actions.some((action) => action.id === "campaign_ops_agent_preview")).toBe(false);
  });

  it("shows a gated proposal preview action when enabled", async () => {
    flagEnabled = true;

    const { actions } = await getDashboardActions("workspace-a");
    const preview = actions.find((action) => action.id === "campaign_ops_agent_preview");

    expect(preview).toMatchObject({
      type: "ai_preview",
      actionRoute: "dashboard?preview=campaign_ops_agent",
    });
  });
});
