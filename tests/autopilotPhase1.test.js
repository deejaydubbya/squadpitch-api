// Autopilot Phase 1 — truthful mode enum contract.
//
// docs/AUTOPILOT_PRODUCT_AUDIT.md spec'd shrinking the supported
// modes to ["off", "draft_only"] until the persistence + scheduler
// phases land. These tests pin three things:
//   1. Schema rejects the legacy modes.
//   2. Schema accepts the two supported modes.
//   3. getAutopilotSettings normalizes a row stored with a legacy
//      mode back to draft_only on read.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { AutopilotSettingsSchema } from "../domains/studio/studio.schemas.js";

describe("AutopilotSettingsSchema — mode enum", () => {
  it("accepts off", () => {
    expect(
      AutopilotSettingsSchema.safeParse({ mode: "off" }).success,
    ).toBe(true);
  });

  it("accepts draft_only", () => {
    expect(
      AutopilotSettingsSchema.safeParse({ mode: "draft_only" }).success,
    ).toBe(true);
  });

  it("rejects auto_publish (never implemented; pulled in Phase 1)", () => {
    const r = AutopilotSettingsSchema.safeParse({ mode: "auto_publish" });
    expect(r.success).toBe(false);
  });

  it("rejects schedule_approved (never implemented; pulled in Phase 1)", () => {
    const r = AutopilotSettingsSchema.safeParse({ mode: "schedule_approved" });
    expect(r.success).toBe(false);
  });

  it("rejects a typo / unknown mode", () => {
    expect(
      AutopilotSettingsSchema.safeParse({ mode: "all_in" }).success,
    ).toBe(false);
  });
});

// ── getAutopilotSettings normalization ────────────────────────────────

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

// Other modules the service imports — we only exercise the
// settings reader, so stubs are enough.
vi.mock("../domains/studio/contentAngles.js", () => ({
  pickAngleForSource: vi.fn(),
}));
vi.mock("../domains/studio/gbpSync.service.js", () => ({
  getGBPSignals: vi.fn(),
}));

const { getAutopilotSettings } = await import(
  "../domains/studio/autopilot.service.js"
);

beforeEach(() => {
  prismaMock = {
    workspaceTechStackConnection: {
      findUnique: vi.fn(),
    },
  };
});

describe("getAutopilotSettings — legacy mode normalization", () => {
  it("returns draft_only when the stored row has mode=schedule_approved", async () => {
    prismaMock.workspaceTechStackConnection.findUnique.mockResolvedValueOnce({
      metadataJson: { mode: "schedule_approved", enabled: true },
    });
    const s = await getAutopilotSettings("client-1");
    expect(s.mode).toBe("draft_only");
  });

  it("returns draft_only when the stored row has mode=auto_publish", async () => {
    prismaMock.workspaceTechStackConnection.findUnique.mockResolvedValueOnce({
      metadataJson: { mode: "auto_publish", enabled: true },
    });
    const s = await getAutopilotSettings("client-1");
    expect(s.mode).toBe("draft_only");
  });

  it("returns draft_only when the stored row has mode=draft_assist (older legacy)", async () => {
    prismaMock.workspaceTechStackConnection.findUnique.mockResolvedValueOnce({
      metadataJson: { mode: "draft_assist", enabled: true },
    });
    const s = await getAutopilotSettings("client-1");
    expect(s.mode).toBe("draft_only");
  });

  it("passes off through unchanged", async () => {
    prismaMock.workspaceTechStackConnection.findUnique.mockResolvedValueOnce({
      metadataJson: { mode: "off", enabled: false },
    });
    const s = await getAutopilotSettings("client-1");
    expect(s.mode).toBe("off");
  });

  it("falls back to default off when no row exists", async () => {
    prismaMock.workspaceTechStackConnection.findUnique.mockResolvedValueOnce(null);
    const s = await getAutopilotSettings("client-1");
    expect(s.mode).toBe("off");
    expect(s.enabled).toBe(false);
  });
});
