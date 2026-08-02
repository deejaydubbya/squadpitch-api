import { describe, expect, it, vi } from "vitest";
import {
  SYNTHETIC_WORKSPACE_PREFIX,
  summarizeCanaryResults,
  validateCanaryInvocation,
} from "../domains/canary/canaryPolicy.js";
import {
  exchangeCanaryRefreshToken,
  verifyProductionCanary,
} from "../scripts/production-canary/runner.js";
import { summarizeAiCanaryResults } from "../domains/canary/canary.service.js";

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

describe("production canary AI evidence", () => {
  it("requires hosted source, provenance, and correlated traces", () => {
    const requestId = "production-canary:run-12345678";
    const results = summarizeAiCanaryResults(
      [
        {
          usableResult: true,
          provenance: {
            source: "squadpitch-ai",
            fallbackUsed: false,
            traceId: `${requestId}:campaign_ops`,
          },
        },
      ],
      requestId,
    );
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ai.provenance-present",
          status: "PASS",
        }),
        expect.objectContaining({ id: "ai.hosted-provenance", status: "PASS" }),
        expect.objectContaining({ id: "ai.trace-correlation", status: "PASS" }),
      ]),
    );
  });

  it("rejects usable local fallback as hosted AI", () => {
    const results = summarizeAiCanaryResults(
      [
        {
          usableResult: true,
          provenance: {
            source: "squadpitch-api",
            fallbackUsed: true,
            traceId: "unrelated",
          },
        },
      ],
      "production-canary:run-12345678",
    );
    expect(
      results.find((item) => item.id === "ai.hosted-provenance"),
    ).toMatchObject({ status: "FAIL" });
    expect(
      results.find((item) => item.id === "ai.trace-correlation"),
    ).toMatchObject({ status: "FAIL" });
    expect(
      results.find((item) => item.id === "ai.fallback-status"),
    ).toMatchObject({ status: "WARN" });
  });

  it("accepts hosted delivery while preserving an explicitly labeled shadow result", () => {
    const requestId = "production-canary:run-12345678";
    const results = summarizeAiCanaryResults(
      [
        {
          usableResult: true,
          provenance: {
            source: "squadpitch-ai",
            fallbackUsed: false,
            traceId: `${requestId}:retrieval`,
          },
        },
        {
          usableResult: true,
          provenance: {
            source: "node",
            executionMode: "shadow",
            fallbackUsed: false,
            traceId: `${requestId}:brand_quality`,
          },
        },
      ],
      requestId,
    );
    expect(
      results.find((item) => item.id === "ai.hosted-provenance"),
    ).toMatchObject({ status: "PASS" });
    expect(
      results.find((item) => item.id === "ai.trace-correlation"),
    ).toMatchObject({ status: "PASS" });
  });
});

describe("production canary client", () => {
  it("exchanges a rotating Auth0 refresh token without returning it", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "short-lived-access-token" }),
    }));
    const token = await exchangeCanaryRefreshToken({
      auth0Domain: "tenant.example.test",
      clientId: "native-canary",
      refreshToken: "never-log-refresh-token",
      audience: "https://api.example.test",
      fetchImpl,
    });
    expect(token).toBe("short-lived-access-token");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://tenant.example.test/oauth/token");
    expect(JSON.parse(init.body)).toMatchObject({
      grant_type: "refresh_token",
      client_id: "native-canary",
      refresh_token: "never-log-refresh-token",
    });
  });

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
