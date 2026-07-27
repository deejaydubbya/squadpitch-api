import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { logEvent } from "../../lib/logger.js";
import { recordAiRunTrace } from "./observability.service.js";

export const AI_FALLBACK_REASONS = Object.freeze({
  AI_PLATFORM_DISABLED: "feature_disabled",
  FEATURE_DISABLED: "feature_disabled",
  PROVIDER_TIMEOUT: "timeout",
  PROVIDER_UNAVAILABLE: "service_unavailable",
  PROVIDER_NOT_CONFIGURED: "service_unavailable",
  PROVIDER_INVALID_JSON: "invalid_response",
  PROVIDER_EMPTY_BODY: "invalid_response",
  SCHEMA_INVALID: "schema_mismatch",
  AUTH_SIGNATURE_INVALID: "auth_failure",
  AUTH_SIGNATURE_MISSING: "auth_failure",
});

export function normalizeFallbackReason(code, status) {
  return AI_FALLBACK_REASONS[code] ??
    (status === "timeout" ? "timeout" :
      status === "invalid_response" ? "invalid_response" :
        "internal_error");
}

export function hostedProvenance({
  operation,
  envelope,
  pythonResult,
  startedAt,
  serviceLatencyMs,
  featureFlag,
}) {
  const internal = pythonResult?.body?.provenance ?? {};
  return compact({
    operation,
    source: "squadpitch-ai",
    executionMode: "hosted",
    fallbackUsed: internal.fallbackUsed === true,
    fallbackLayer: internal.fallbackUsed === true ? "python" : null,
    fallbackReason: internal.fallbackReason ?? null,
    implementation: internal.implementation ?? "unknown_python_implementation",
    serviceVersion: internal.serviceVersion ?? null,
    model: internal.model ?? null,
    modelVersion: internal.modelVersion ?? null,
    inferenceMode: internal.inferenceMode ?? null,
    traceId: envelope?.traceId ?? randomUUID(),
    pythonTraceId: internal.traceId ?? pythonResult?.body?.traceId ?? null,
    totalLatencyMs: elapsed(startedAt),
    serviceLatencyMs: internal.latencyMs ?? serviceLatencyMs ?? null,
    featureFlag: featureFlag ?? null,
    nodeServiceVersion: env.APP_BUILD_SHA ?? null,
  });
}

export function localProvenance({
  operation,
  envelope,
  startedAt,
  implementation,
  inferenceMode = "deterministic",
  reason,
  attemptedHosted = false,
  serviceLatencyMs,
  featureFlag,
}) {
  return compact({
    operation,
    source: attemptedHosted ? "node_fallback" : "node",
    executionMode: attemptedHosted ? "fallback" : "local",
    fallbackUsed: attemptedHosted,
    fallbackLayer: attemptedHosted ? "node" : null,
    fallbackReason: attemptedHosted ? normalizeFallbackReason(reason) : null,
    implementation,
    serviceVersion: null,
    model: null,
    modelVersion: null,
    inferenceMode,
    traceId: envelope?.traceId ?? randomUUID(),
    pythonTraceId: null,
    totalLatencyMs: elapsed(startedAt),
    serviceLatencyMs: attemptedHosted ? serviceLatencyMs ?? null : null,
    featureFlag: featureFlag ?? null,
    nodeServiceVersion: env.APP_BUILD_SHA ?? null,
  });
}

export function shadowProvenance({
  operation,
  envelope,
  pythonResult,
  startedAt,
  serviceLatencyMs,
  implementation,
  featureFlag,
}) {
  const internal = pythonResult?.body?.provenance ?? {};
  return compact({
    operation,
    source: "node",
    executionMode: "shadow",
    fallbackUsed: false,
    fallbackLayer: null,
    fallbackReason: null,
    implementation,
    serviceVersion: null,
    model: null,
    modelVersion: null,
    inferenceMode: "deterministic",
    traceId: envelope?.traceId ?? null,
    pythonTraceId: internal.traceId ?? pythonResult?.body?.traceId ?? null,
    totalLatencyMs: elapsed(startedAt),
    serviceLatencyMs: internal.latencyMs ?? serviceLatencyMs ?? null,
    featureFlag: featureFlag ?? null,
    hostedAttempted: true,
    shadowImplementation: internal.implementation ?? null,
    shadowServiceVersion: internal.serviceVersion ?? null,
    shadowModel: internal.model ?? null,
    shadowModelVersion: internal.modelVersion ?? null,
    nodeServiceVersion: env.APP_BUILD_SHA ?? null,
  });
}

export function emitAiExecution(provenance, {
  workspaceId,
  actorUserId,
  status = "SUCCEEDED",
} = {}) {
  logEvent("ai.execution.completed", {
    ...provenance,
    workspaceId,
    actorUserId,
    success: status === "SUCCEEDED",
  });
  if (!provenance?.traceId) return;
  void recordAiRunTrace({
    trace: {
      requestId: provenance.traceId,
      traceId: provenance.traceId,
      workspaceId,
      actorUserId,
      taskType: provenance.operation,
      featureFlags: provenance.featureFlag == null
        ? {}
        : { [provenance.operation]: provenance.featureFlag },
      provider: provenance.source,
      model: provenance.model ?? null,
      schemaVersion: "ai-execution-provenance.v1",
      steps: [{ type: "execution_provenance", ...provenance }],
      latencyMs: provenance.totalLatencyMs,
      status,
      errorCode: status === "SUCCEEDED" ? null : provenance.fallbackReason,
      releaseGateStage: "GENERAL_RELEASE",
    },
  }).catch((error) => {
    logEvent("ai.execution.trace_write_failed", {
      operation: provenance.operation,
      traceId: provenance.traceId,
      errorCode: error?.code ?? "TRACE_WRITE_FAILED",
    });
  });
}

export function setAiProvenanceHeaders(res, provenance) {
  if (!env.AI_PROVENANCE_RESPONSE_HEADERS_ENABLED || !res || !provenance) return;
  const headers = {
    "X-Squadpitch-AI-Source": provenance.source,
    "X-Squadpitch-AI-Operation": provenance.operation,
    "X-Squadpitch-AI-Fallback": String(provenance.fallbackUsed),
    "X-Squadpitch-AI-Fallback-Layer": provenance.fallbackLayer,
    "X-Squadpitch-AI-Fallback-Reason": provenance.fallbackReason,
    "X-Squadpitch-AI-Implementation": provenance.implementation,
    "X-Squadpitch-AI-Service-Version": provenance.serviceVersion,
    "X-Squadpitch-AI-Model": provenance.model,
    "X-Squadpitch-AI-Model-Version": provenance.modelVersion,
    "X-Squadpitch-AI-Trace-ID": provenance.traceId,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== null && value !== undefined && value !== "") {
      res.setHeader(name, String(value));
    }
  }
}

function elapsed(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
