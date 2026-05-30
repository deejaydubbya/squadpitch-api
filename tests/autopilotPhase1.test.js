// Autopilot mode-enum contract.
//
// Spinstr01 expanded to the full ladder:
//   off / recommend_only / draft_on_click /
//   auto_generate_drafts / schedule_after_approval
// + draft_only (legacy alias, accepted on wire, normalized
//   on read to draft_on_click).
// auto_publish_guarded is REJECTED on save (UI shows it as
// Coming Soon).

import { describe, it, expect, vi, beforeEach } from "vitest";

import { AutopilotSettingsSchema } from "../domains/studio/studio.schemas.js";

describe("AutopilotSettingsSchema — mode enum", () => {
  it.each([
    "off",
    "recommend_only",
    "draft_on_click",
    "auto_generate_drafts",
    "schedule_after_approval",
    // legacy alias still accepted on the wire
    "draft_only",
  ])("accepts %s", (mode) => {
    expect(AutopilotSettingsSchema.safeParse({ mode }).success).toBe(true);
  });

  it("rejects auto_publish (never implemented)", () => {
    expect(
      AutopilotSettingsSchema.safeParse({ mode: "auto_publish" }).success,
    ).toBe(false);
  });

  it("rejects schedule_approved (never implemented)", () => {
    expect(
      AutopilotSettingsSchema.safeParse({ mode: "schedule_approved" }).success,
    ).toBe(false);
  });

  it("rejects auto_publish_guarded — locked behind safety controls", () => {
    expect(
      AutopilotSettingsSchema.safeParse({ mode: "auto_publish_guarded" }).success,
    ).toBe(false);
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
    // industry-01 — autopilot service now asserts the workspace's
    // Client.industryKey is `real_estate` before any read/write.
    // The setting-reader tests don't care about industry per se;
    // we just need the gate to pass.
    client: {
      findUnique: vi.fn(async () => ({ industryKey: "real_estate" })),
    },
  };
});

describe("getAutopilotSettings — legacy mode normalization", () => {
  it.each([
    ["draft_only", "draft_on_click"],
    ["draft_assist", "draft_on_click"],
    ["schedule_approved", "draft_on_click"],
    ["auto_publish", "draft_on_click"],
    // Defensive: a hand-edited row carrying the locked mode
    // normalizes back to the safest live mode rather than
    // pretending it's enabled.
    ["auto_publish_guarded", "draft_on_click"],
  ])("normalizes stored mode=%s to %s on read", async (stored, expected) => {
    prismaMock.workspaceTechStackConnection.findUnique.mockResolvedValueOnce({
      metadataJson: { mode: stored, enabled: true },
    });
    const s = await getAutopilotSettings("client-1");
    expect(s.mode).toBe(expected);
  });

  it.each([
    "off",
    "recommend_only",
    "draft_on_click",
    "auto_generate_drafts",
    "schedule_after_approval",
  ])("passes %s through unchanged", async (mode) => {
    prismaMock.workspaceTechStackConnection.findUnique.mockResolvedValueOnce({
      metadataJson: { mode, enabled: mode !== "off" },
    });
    const s = await getAutopilotSettings("client-1");
    expect(s.mode).toBe(mode);
  });

  it("falls back to default off when no row exists", async () => {
    prismaMock.workspaceTechStackConnection.findUnique.mockResolvedValueOnce(null);
    const s = await getAutopilotSettings("client-1");
    expect(s.mode).toBe("off");
    expect(s.enabled).toBe(false);
  });
});
