import { describe, expect, it } from "vitest";

import { env } from "../config/env.js";
import {
  hostedProvenance,
  localProvenance,
  setAiProvenanceHeaders,
  shadowProvenance,
} from "../domains/aiPlatform/executionProvenance.js";

const envelope = { traceId: "trace-node-1" };

describe("AI execution provenance", () => {
  it("reports hosted Python only when its result is accepted", () => {
    const provenance = hostedProvenance({
      operation: "campaign_ops_plan",
      envelope,
      startedAt: Date.now(),
      pythonResult: {
        body: {
          traceId: "trace-python-1",
          provenance: {
            implementation: "campaign_ops_v1",
            serviceVersion: "sha-ai",
            inferenceMode: "deterministic",
            latencyMs: 14,
          },
        },
      },
    });

    expect(provenance).toMatchObject({
      source: "squadpitch-ai",
      executionMode: "hosted",
      fallbackUsed: false,
      implementation: "campaign_ops_v1",
      serviceVersion: "sha-ai",
      traceId: "trace-node-1",
      pythonTraceId: "trace-python-1",
      serviceLatencyMs: 14,
    });
  });

  it("normalizes Node timeout and invalid-response fallbacks", () => {
    expect(localProvenance({
      operation: "brand_quality_score",
      envelope,
      startedAt: Date.now(),
      implementation: "deterministic_brand_quality_v1",
      attemptedHosted: true,
      reason: "PROVIDER_TIMEOUT",
    })).toMatchObject({
      source: "node_fallback",
      fallbackUsed: true,
      fallbackLayer: "node",
      fallbackReason: "timeout",
    });

    expect(localProvenance({
      operation: "brand_quality_score",
      envelope,
      startedAt: Date.now(),
      implementation: "deterministic_brand_quality_v1",
      attemptedHosted: true,
      reason: "SCHEMA_INVALID",
    }).fallbackReason).toBe("schema_mismatch");
  });

  it("distinguishes a Python internal fallback and a shadow result", () => {
    const pythonFallback = hostedProvenance({
      operation: "brand_quality_score",
      envelope,
      startedAt: Date.now(),
      pythonResult: {
        body: {
          provenance: {
            implementation: "deterministic_brand_quality_v1",
            fallbackUsed: true,
            fallbackReason: "model_unavailable",
          },
        },
      },
    });
    expect(pythonFallback).toMatchObject({
      source: "squadpitch-ai",
      fallbackUsed: true,
      fallbackLayer: "python",
      fallbackReason: "model_unavailable",
    });

    const shadow = shadowProvenance({
      operation: "autopilot_rank",
      envelope,
      startedAt: Date.now(),
      pythonResult: { body: { provenance: { implementation: "python_ranker" } } },
      implementation: "heuristic_autopilot_ranker_v1",
    });
    expect(shadow).toMatchObject({
      source: "node",
      executionMode: "shadow",
      hostedAttempted: true,
      shadowImplementation: "python_ranker",
    });
  });

  it("emits only safe, meaningful response headers when enabled", () => {
    const original = env.AI_PROVENANCE_RESPONSE_HEADERS_ENABLED;
    env.AI_PROVENANCE_RESPONSE_HEADERS_ENABLED = true;
    const headers = new Map();
    setAiProvenanceHeaders(
      { setHeader: (name, value) => headers.set(name, value) },
      {
        operation: "campaign_ops_plan",
        source: "squadpitch-ai",
        fallbackUsed: false,
        implementation: "campaign_ops_v1",
        traceId: "trace-safe",
        serviceVersion: null,
      },
    );
    env.AI_PROVENANCE_RESPONSE_HEADERS_ENABLED = original;

    expect(headers.get("X-Squadpitch-AI-Source")).toBe("squadpitch-ai");
    expect(headers.get("X-Squadpitch-AI-Fallback")).toBe("false");
    expect(headers.has("X-Squadpitch-AI-Service-Version")).toBe(false);
    expect(JSON.stringify([...headers])).not.toMatch(/secret|authorization|signature/i);
  });

  it("does not emit response headers when disabled", () => {
    const original = env.AI_PROVENANCE_RESPONSE_HEADERS_ENABLED;
    env.AI_PROVENANCE_RESPONSE_HEADERS_ENABLED = false;
    const setHeader = () => {
      throw new Error("must not be called");
    };
    setAiProvenanceHeaders({ setHeader }, { source: "squadpitch-ai" });
    env.AI_PROVENANCE_RESPONSE_HEADERS_ENABLED = original;
  });
});
