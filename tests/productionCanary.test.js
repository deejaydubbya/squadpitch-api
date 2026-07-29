import { describe, expect, it, vi } from "vitest";
import {
  SYNTHETIC_WORKSPACE_PREFIX,
  summarizeCanaryResults,
  validateCanaryInvocation,
} from "../domains/canary/canaryPolicy.js";
import { verifyProductionCanary } from "../scripts/production-canary/runner.js";

describe("production canary policy", () => {
  const valid = {
    configuredWorkspaceId: "workspace-canary",
    requestedWorkspaceId: "workspace-canary",
    workspaceName: `${SYNTHETIC_WORKSPACE_PREFIX} Launch Monitor`,
    synthetic: true,
    runId: "run-12345678",
  };

  it("requires exact allowlist, marker, acknowledgement, and safe run id", () => {
    expect(validateCanaryInvocation(valid)).toEqual([]);
    expect(
      validateCanaryInvocation({
        ...valid,
        requestedWorkspaceId: "customer-workspace",
        workspaceName: "Real Customer",
        synthetic: false,
        runId: "bad run",
      }),
    ).toHaveLength(4);
  });

  it("summarizes PASS/WARN/FAIL without hiding failures", () => {
    expect(
      summarizeCanaryResults([
        { status: "PASS" },
        { status: "WARN" },
        { status: "FAIL" },
      ]),
    ).toEqual({ status: "FAIL", pass: 1, warn: 1, fail: 1 });
  });
});

describe("production canary client", () => {
  it("uses normal bearer authorization and synthetic acknowledgement", async () => {
    const fetchImpl = vi.fn(async (_url, init) => ({
      status: 200,
      json: async () => ({
        runId: "run-12345678",
        workspaceId: "workspace-canary",
        summary: { status: "PASS", pass: 1, warn: 0, fail: 0 },
        results: [{ id: "auth", status: "PASS" }],
      }),
    }));
    const report = await verifyProductionCanary({
      baseUrl: "https://api.example.test",
      workspaceId: "workspace-canary",
      token: "not-returned",
      runId: "run-12345678",
      fetchImpl,
    });
    expect(report.summary.status).toBe("PASS");
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer not-returned");
    expect(JSON.parse(init.body)).toEqual({
      synthetic: true,
      runId: "run-12345678",
    });
    expect(JSON.stringify(report)).not.toContain("not-returned");
  });
});
