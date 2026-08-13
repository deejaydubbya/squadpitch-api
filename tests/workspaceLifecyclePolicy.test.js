import { describe, expect, it, vi } from "vitest";

const prismaMock = { client: { findUnique: vi.fn() } };
vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
const policy = await import("../lib/workspaceLifecyclePolicy.js");

describe("workspace lifecycle side-effect policy", () => {
  it.each(["social publishing", "social scheduling", "OAuth connection", "email sending", "SMS sending", "billing action", "autopilot external action", "mutating integration"])("rejects PROSPECT %s", (operation) => {
    expect(() => policy.assertWorkspaceAllowsExternalSideEffects({ lifecycle: "PROSPECT" }, operation)).toThrow(expect.objectContaining({ code: "PROSPECT_SIDE_EFFECT_BLOCKED" }));
  });
  it("does not change CUSTOMER capability behavior", () => {
    expect(policy.assertWorkspaceAllowsExternalSideEffects({ lifecycle: "CUSTOMER" }, "publishing")).toEqual({ lifecycle: "CUSTOMER" });
  });
});
