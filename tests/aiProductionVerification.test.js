import { describe, expect, it, vi } from "vitest";

import {
  classifyAiVerification,
  summarizeVerification,
} from "../scripts/ai-production-verification/classifier.js";
import { parseAiProvenanceHeaders } from "../scripts/ai-production-verification/provenance.js";
import { verifyAiProduction } from "../scripts/ai-production-verification/runner.js";
import { runProductionAiVerification } from "../domains/aiPlatform/productionVerification.service.js";

function result(overrides = {}) {
  return {
    operation: "campaign_ops",
    name: "Campaign Ops",
    usableResult: true,
    provenance: {
      source: "squadpitch-ai",
      fallbackUsed: false,
      fallbackLayer: null,
      implementation: "campaign_ops_v1",
      traceId: "trace-safe",
      totalLatencyMs: 42,
    },
    ...overrides,
  };
}

describe("AI production verification classification", () => {
  it("classifies hosted success as PASS", () => {
    expect(classifyAiVerification(result())).toMatchObject({
      status: "PASS",
      source: "squadpitch-ai",
      fallbackUsed: false,
    });
  });

  it("classifies Python internal fallback as WARN_PYTHON", () => {
    expect(
      classifyAiVerification(
        result({
          provenance: {
            source: "squadpitch-ai",
            fallbackUsed: true,
            fallbackLayer: "python",
            fallbackReason: "model_unavailable",
          },
        }),
      ),
    ).toMatchObject({
      status: "WARN_PYTHON",
      fallbackLayer: "python",
    });
  });

  it.each(["timeout", "invalid_response", "auth_failure"])(
    "classifies usable Node fallback (%s) as WARN_NODE",
    (fallbackReason) => {
      expect(
        classifyAiVerification(
          result({
            provenance: {
              source: "node_fallback",
              fallbackUsed: true,
              fallbackLayer: "node",
              fallbackReason,
            },
          }),
        ),
      ).toMatchObject({
        status: "WARN_NODE",
        fallbackLayer: "node",
        fallbackReason,
      });
    },
  );

  it("does not lie about intentional local execution", () => {
    expect(
      classifyAiVerification(
        result({
          provenance: {
            source: "node",
            executionMode: "local",
            fallbackUsed: false,
          },
        }),
      ),
    ).toMatchObject({
      status: "WARN_NODE",
      source: "node",
      fallbackReason: "local",
    });
  });

  it.each([
    ["hosted and fallback both fail", null],
    ["empty result is unusable", { source: "squadpitch-ai" }],
  ])("classifies %s as FAIL", (_name, provenance) => {
    expect(
      classifyAiVerification(result({ usableResult: false, provenance }))
        .status,
    ).toBe("FAIL");
  });

  it("preserves only the common provenance fields through classification", () => {
    const classified = classifyAiVerification(
      result({
        provenance: {
          source: "squadpitch-ai",
          fallbackUsed: false,
          implementation: "campaign_ops_v1",
          serviceVersion: "abc123",
          model: "planner",
          modelVersion: "v1",
          traceId: "trace-1",
          totalLatencyMs: 99,
          rawPrompt: "must not leak",
          authorization: "Bearer secret",
        },
      }),
    );
    expect(classified).toMatchObject({
      implementation: "campaign_ops_v1",
      serviceVersion: "abc123",
      model: "planner",
      modelVersion: "v1",
      traceId: "trace-1",
      latencyMs: 99,
    });
    expect(classified).not.toHaveProperty("rawPrompt");
    expect(classified).not.toHaveProperty("authorization");
  });

  it("redacts secrets from diagnostic messages", () => {
    const classified = classifyAiVerification(
      result({
        usableResult: false,
        message: "Bearer real-token token=abc secret=def password=ghi",
      }),
    );
    expect(classified.message).not.toContain("real-token");
    expect(classified.message).not.toContain("abc");
    expect(classified.message).not.toContain("def");
    expect(classified.message).not.toContain("ghi");
  });

  it("keeps warnings at exit zero by default", () => {
    const summary = summarizeVerification([
      classifyAiVerification(result()),
      classifyAiVerification(
        result({
          provenance: {
            source: "squadpitch-ai",
            fallbackUsed: true,
            fallbackLayer: "python",
          },
        }),
      ),
      classifyAiVerification(
        result({
          provenance: {
            source: "node_fallback",
            fallbackUsed: true,
            fallbackLayer: "node",
          },
        }),
      ),
    ]);
    expect(summary).toMatchObject({
      status: "HEALTHY_WITH_WARNINGS",
      pass: 1,
      warn: 2,
      fail: 0,
      exitCode: 0,
    });
  });

  it("makes FAIL non-zero and supports optional strict warnings", () => {
    const failed = summarizeVerification([
      classifyAiVerification(result()),
      classifyAiVerification(result({ usableResult: false })),
    ]);
    expect(failed).toMatchObject({
      status: "FAILED",
      fail: 1,
      exitCode: 1,
    });

    const warning = classifyAiVerification(
      result({
        provenance: {
          source: "node_fallback",
          fallbackUsed: true,
          fallbackLayer: "node",
        },
      }),
    );
    expect(summarizeVerification([warning], { strict: true }).exitCode).toBe(1);
  });
});

describe("AI production verification orchestration", () => {
  it("isolates operation failures and preserves successful provenance", async () => {
    const output = await runProductionAiVerification({
      workspaceId: "workspace-a",
      requestTraceId: "request-1",
      operations: [
        {
          key: "good",
          name: "Good",
          execute: vi.fn(async () => ({
            usableResult: true,
            provenance: result().provenance,
          })),
        },
        {
          key: "bad",
          name: "Bad",
          execute: vi.fn(async () => {
            const error = new Error("Bearer secret must not leak");
            error.code = "PROVIDER_UNAVAILABLE";
            throw error;
          }),
        },
      ],
    });
    expect(output.results[0]).toMatchObject({
      operation: "good",
      usableResult: true,
      provenance: { source: "squadpitch-ai" },
    });
    expect(output.results[1]).toMatchObject({
      operation: "bad",
      usableResult: false,
      message: "Operation failed (PROVIDER_UNAVAILABLE)",
    });
    expect(JSON.stringify(output)).not.toContain("Bearer secret");
  });

  it("parses the existing response-header provenance contract", () => {
    const headers = new Headers({
      "X-Squadpitch-AI-Source": "squadpitch-ai",
      "X-Squadpitch-AI-Operation": "campaign_ops_plan",
      "X-Squadpitch-AI-Fallback": "false",
      "X-Squadpitch-AI-Trace-ID": "trace-1",
      Authorization: "Bearer hidden",
    });
    expect(parseAiProvenanceHeaders(headers)).toEqual({
      source: "squadpitch-ai",
      operation: "campaign_ops_plan",
      fallbackUsed: false,
      traceId: "trace-1",
    });
  });

  it("calls the authenticated Node endpoint and never prints its token", async () => {
    const fetchImpl = vi.fn(async (_url, options) => ({
      ok: true,
      json: async () => ({
        environment: "production",
        results: [result()],
        skipped: [],
      }),
      requestOptions: options,
    }));
    const report = await verifyAiProduction({
      baseUrl: "https://api.example.test/",
      token: "private-token",
      workspaceId: "workspace-a",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/internal/ai/production-verification",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer private-token",
        }),
      }),
    );
    expect(JSON.stringify(report)).not.toContain("private-token");
    expect(report.exitCode).toBe(0);
  });

  it("can authenticate through the production web proxy with a session cookie", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        environment: "production",
        results: [result()],
        skipped: [],
      }),
    }));
    const report = await verifyAiProduction({
      baseUrl: "https://app.example.test",
      cookie: "appSession=private-cookie",
      workspaceId: "workspace-a",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.example.test/api/proxy/internal/ai/production-verification",
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: "appSession=private-cookie",
        }),
      }),
    );
    expect(JSON.stringify(report)).not.toContain("private-cookie");
  });
});
