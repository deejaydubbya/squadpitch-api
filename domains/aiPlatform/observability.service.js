import crypto from "node:crypto";
import { z } from "zod";

import { prisma } from "../../prisma.js";

export const AI_OBSERVABILITY_ERROR_CODES = Object.freeze({
  PROVIDER_NOT_CONFIGURED: { category: "Provider/config", severity: "blocker" },
  PROVIDER_UNAVAILABLE: { category: "Provider/runtime", severity: "high" },
  PROVIDER_TIMEOUT: { category: "Provider/runtime", severity: "high" },
  PROVIDER_EMPTY_BODY: { category: "Provider/contract", severity: "high" },
  PROVIDER_INVALID_JSON: { category: "Provider/contract", severity: "high" },
  SCHEMA_INVALID: { category: "Contract", severity: "blocker" },
  ENUM_INVALID: { category: "Contract", severity: "high" },
  NORMALIZATION_LOSS: { category: "Contract", severity: "medium" },
  UNSUPPORTED_CLAIM: { category: "Grounding", severity: "high" },
  FABRICATED_CRITICAL_FACT: { category: "Grounding", severity: "blocker" },
  SOURCE_OMISSION: { category: "Grounding", severity: "medium" },
  CHANNEL_NONCOMPLIANT: { category: "Channel", severity: "medium" },
  BRAND_VOICE_MISMATCH: { category: "Quality", severity: "medium" },
  DUPLICATIVE_OUTPUT: { category: "Quality", severity: "medium" },
  LOW_ACTIONABILITY: { category: "Quality", severity: "medium" },
  PROMPT_INJECTION_FOLLOWED: { category: "Safety/security", severity: "blocker" },
  TENANT_LEAKAGE: { category: "Safety/security", severity: "blocker" },
  RAW_SECRET_OR_PII_OUTPUT: { category: "Safety/security", severity: "blocker" },
  UNSAFE_POLICY_CONTENT: { category: "Safety/policy", severity: "blocker" },
  UNINTENDED_SIDE_EFFECT: { category: "Workflow", severity: "blocker" },
  MISSING_USAGE_LOG: { category: "Observability", severity: "medium" },
  MISCLASSIFIED_USAGE: { category: "Observability", severity: "low" },
  TRACE_MISSING: { category: "Observability", severity: "low" },
  HUMAN_REJECTED: { category: "Acceptance", severity: "medium" },
  HIGH_EDIT_DISTANCE: { category: "Acceptance", severity: "medium" },
});

export const AI_RELEASE_GATE_STAGES = Object.freeze([
  "OFFLINE",
  "SHADOW",
  "BETA",
  "GENERAL_RELEASE",
]);

const TRACE_RETENTION_DAYS = 30;
const REDACTION_VERSION = "ai-trace-redaction.v1";
const SECRET_KEYS = /(?:secret|token|password|api[_-]?key|authorization|cookie|signature|credential)/i;
const RAW_CONTENT_KEYS = /(?:prompt|raw|output|completion|body|text|content|transcript)/i;
const SAFE_TELEMETRY_KEYS = new Set([
  "promptVersion",
  "promptTokens",
  "completionTokens",
  "rawContentCaptured",
  "redactionVersion",
  "contentHash",
]);
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

export const aiTraceInputSchema = z
  .object({
    requestId: z.string().min(1),
    traceId: z.string().min(1),
    workspaceId: z.string().min(1).nullable().optional(),
    actorUserId: z.string().min(1).nullable().optional(),
    taskType: z.string().min(1),
    featureFlags: z.record(z.boolean()).optional(),
    provider: z.string().min(1).nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    promptVersion: z.string().min(1).nullable().optional(),
    schemaVersion: z.string().min(1).nullable().optional(),
    retrievalRunId: z.string().min(1).nullable().optional(),
    retrievedSources: z.array(z.object({
      sourceId: z.string().min(1),
      score: z.number().finite().optional(),
      contentHash: z.string().optional(),
    })).optional(),
    steps: z.array(z.record(z.unknown())).optional(),
    validationResults: z.record(z.unknown()).optional(),
    retryCount: z.number().int().min(0).default(0),
    promptTokens: z.number().int().min(0).default(0),
    completionTokens: z.number().int().min(0).default(0),
    estimatedCostCents: z.number().min(0).default(0),
    latencyMs: z.number().int().min(0).nullable().optional(),
    status: z.enum(["STARTED", "SUCCEEDED", "FAILED", "BLOCKED", "REJECTED"]),
    errorCode: z.string().nullable().optional(),
    humanOutcome: z.string().nullable().optional(),
    downstreamCampaignIds: z.array(z.string()).default([]),
    downstreamDraftIds: z.array(z.string()).default([]),
    outcomePointers: z.record(z.unknown()).optional(),
    releaseGateStage: z.enum(AI_RELEASE_GATE_STAGES).default("OFFLINE"),
    retentionUntil: z.date().optional(),
    rawContentCaptured: z.literal(false).default(false),
  })
  .strict();

export function redactAiTraceValue(value, { allowRawContent = false } = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => redactAiTraceValue(item, { allowRawContent }));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, raw]) => {
        if (SAFE_TELEMETRY_KEYS.has(key)) return [key, redactAiTraceValue(raw, { allowRawContent })];
        if (SECRET_KEYS.test(key)) return [key, "[REDACTED_SECRET]"];
        if (!allowRawContent && RAW_CONTENT_KEYS.test(key)) return [key, summarizeRawValue(raw)];
        return [key, redactAiTraceValue(raw, { allowRawContent })];
      }),
    );
  }
  if (typeof value === "string") {
    return value.replace(EMAIL_RE, "[REDACTED_EMAIL]").replace(PHONE_RE, "[REDACTED_PHONE]");
  }
  return value;
}

export function hasSecretLeak(value) {
  return JSON.stringify(value).match(/sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|password=/i) != null;
}

export function buildTraceEnvelope(input, { now = new Date() } = {}) {
  const parsed = aiTraceInputSchema.parse(input);
  const taxonomy = parsed.errorCode ? AI_OBSERVABILITY_ERROR_CODES[parsed.errorCode] : null;
  const sanitized = redactAiTraceValue(parsed);
  if (hasSecretLeak(sanitized)) {
    throw Object.assign(new Error("Trace contains a secret after redaction"), {
      code: "RAW_SECRET_OR_PII_OUTPUT",
      status: 422,
    });
  }
  return {
    ...sanitized,
    clientId: parsed.workspaceId ?? null,
    workspaceId: undefined,
    errorSeverity: taxonomy?.severity ?? null,
    retentionUntil:
      parsed.retentionUntil ?? new Date(now.getTime() + TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    debugAccessLevel: "admin_only",
    rawContentCaptured: false,
    redactionVersion: REDACTION_VERSION,
  };
}

export async function recordAiRunTrace({ trace, prismaClient = prisma, now = new Date() }) {
  const envelope = buildTraceEnvelope(trace, { now });
  return prismaClient.aiRunTrace.create({
    data: {
      requestId: envelope.requestId,
      traceId: envelope.traceId,
      clientId: envelope.clientId,
      actorUserId: envelope.actorUserId ?? null,
      taskType: envelope.taskType,
      featureFlags: envelope.featureFlags ?? {},
      provider: envelope.provider ?? null,
      model: envelope.model ?? null,
      promptVersion: envelope.promptVersion ?? null,
      schemaVersion: envelope.schemaVersion ?? null,
      retrievalRunId: envelope.retrievalRunId ?? null,
      retrievedSources: envelope.retrievedSources ?? [],
      steps: envelope.steps ?? [],
      validationResults: envelope.validationResults ?? {},
      retryCount: envelope.retryCount,
      promptTokens: envelope.promptTokens,
      completionTokens: envelope.completionTokens,
      estimatedCostCents: envelope.estimatedCostCents,
      latencyMs: envelope.latencyMs ?? null,
      status: envelope.status,
      errorCode: envelope.errorCode ?? null,
      errorSeverity: envelope.errorSeverity,
      humanOutcome: envelope.humanOutcome ?? null,
      downstreamCampaignIds: envelope.downstreamCampaignIds,
      downstreamDraftIds: envelope.downstreamDraftIds,
      outcomePointers: envelope.outcomePointers ?? {},
      releaseGateStage: envelope.releaseGateStage,
      retentionUntil: envelope.retentionUntil,
      debugAccessLevel: envelope.debugAccessLevel,
      rawContentCaptured: false,
      redactionVersion: REDACTION_VERSION,
    },
  });
}

export async function getAiOperationsCenter({
  prismaClient = prisma,
  workspaceId,
  taskType,
  provider,
  model,
  promptVersion,
  releaseGateStage,
  since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
} = {}) {
  const where = {
    createdAt: { gte: since },
    ...(workspaceId ? { clientId: workspaceId } : {}),
    ...(taskType ? { taskType } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(promptVersion ? { promptVersion } : {}),
    ...(releaseGateStage ? { releaseGateStage } : {}),
  };
  const traces = await prismaClient.aiRunTrace.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return summarizeOperations(traces);
}

export async function getAiTraceDrilldown({
  traceId,
  workspaceId,
  actorRoles = [],
  prismaClient = prisma,
}) {
  if (!actorRoles.includes("admin")) {
    throw Object.assign(new Error("Admin role required for AI trace drill-down"), {
      code: "FORBIDDEN",
      status: 403,
    });
  }
  const trace = await prismaClient.aiRunTrace.findFirst({ where: { traceId } });
  if (!trace) return null;
  if (workspaceId && trace.clientId && trace.clientId !== workspaceId) {
    throw Object.assign(new Error("Trace belongs to another workspace"), {
      code: "TENANT_LEAKAGE",
      status: 403,
    });
  }
  return redactAiTraceValue(trace);
}

export async function cleanupExpiredAiRunTraces({ prismaClient = prisma, now = new Date() } = {}) {
  return prismaClient.aiRunTrace.deleteMany({ where: { retentionUntil: { lt: now } } });
}

function summarizeOperations(traces) {
  const total = traces.length;
  const successCount = traces.filter((trace) => trace.status === "SUCCEEDED").length;
  const latencies = traces.map((trace) => trace.latencyMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const byErrorCode = groupCount(traces, (trace) => trace.errorCode || "NONE");
  return {
    generatedAt: new Date().toISOString(),
    taxonomyVersion: "AI_ERROR_TAXONOMY.md",
    releaseGateSpec: "RELEASE_GATE_SPEC.md",
    summary: {
      totalRuns: total,
      successRate: total === 0 ? 0 : successCount / total,
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
      estimatedCostCents: sum(traces, "estimatedCostCents"),
    },
    panels: {
      costByTaskProviderModelWorkspace: groupSum(traces, (trace) => [
        trace.taskType,
        trace.provider,
        trace.model,
        trace.clientId,
      ].join("|"), "estimatedCostCents"),
      providerFailures: groupCount(traces.filter((trace) => trace.errorCode?.startsWith("PROVIDER_")), (trace) => [
        trace.provider,
        trace.model,
        trace.errorCode,
      ].join("|")),
      retrievalFailures: groupCount(traces.filter((trace) => ["SOURCE_OMISSION", "TRACE_MISSING"].includes(trace.errorCode)), (trace) => trace.taskType),
      validationFailures: groupCount(traces.filter((trace) => ["SCHEMA_INVALID", "ENUM_INVALID", "FABRICATED_CRITICAL_FACT", "UNSUPPORTED_CLAIM", "PROMPT_INJECTION_FOLLOWED"].includes(trace.errorCode)), (trace) => trace.errorCode),
      promptModelComparison: groupAverage(traces, (trace) => [trace.taskType, trace.model, trace.promptVersion].join("|"), "latencyMs"),
      evalReleaseGates: groupCount(traces, (trace) => [trace.taskType, trace.releaseGateStage].join("|")),
      approvalAndEditRates: groupCount(traces.filter((trace) => trace.humanOutcome), (trace) => trace.humanOutcome),
      errorCodeByTask: groupCount(traces, (trace) => [trace.taskType, trace.errorCode || "NONE"].join("|")),
      errorSeverityByProviderModelPrompt: groupCount(traces, (trace) => [
        trace.provider,
        trace.model,
        trace.promptVersion,
        trace.errorSeverity || "none",
      ].join("|")),
      releaseGateStatusByTask: groupLatestStage(traces),
      taxonomyFocus: Object.fromEntries([
        "MISSING_USAGE_LOG",
        "MISCLASSIFIED_USAGE",
        "TRACE_MISSING",
        "UNSUPPORTED_CLAIM",
        "FABRICATED_CRITICAL_FACT",
        "PROMPT_INJECTION_FOLLOWED",
        "HUMAN_REJECTED",
        "HIGH_EDIT_DISTANCE",
      ].map((code) => [code, byErrorCode[code] || 0])),
    },
    tracePointers: traces.slice(0, 50).map((trace) => {
      const provenance = Array.isArray(trace.steps)
        ? trace.steps.find((step) => step?.type === "execution_provenance")
        : null;
      return {
        traceId: trace.traceId,
        requestId: trace.requestId,
        workspaceId: trace.clientId,
        taskType: trace.taskType,
        status: trace.status,
        errorCode: trace.errorCode,
        provider: trace.provider,
        model: trace.model,
        promptVersion: trace.promptVersion,
        releaseGateStage: trace.releaseGateStage,
        createdAt: trace.createdAt,
        provenance: provenance ? redactAiTraceValue(provenance) : null,
      };
    }),
    rollbackControls: {
      aiActionProposals: "Disable ai_action_proposals_enabled and AI_ACTION_PROPOSALS_ENABLED",
      campaignOpsAgent: "Disable ai_campaign_ops_agent_enabled and AI_CAMPAIGN_OPS_AGENT_ENABLED",
      retrieval: "Disable ai_retrieval_enabled and AI_RETRIEVAL_ENABLED",
    },
  };
}

function summarizeRawValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return {
    redacted: true,
    length: text.length,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

function percentile(values, pct) {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.ceil((pct / 100) * values.length) - 1);
  return values[index];
}

function sum(items, key) {
  return items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
}

function groupCount(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function groupSum(items, keyFn, field) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + (Number(item[field]) || 0);
    return acc;
  }, {});
}

function groupAverage(items, keyFn, field) {
  const buckets = {};
  for (const item of items) {
    const value = Number(item[field]);
    if (!Number.isFinite(value)) continue;
    const key = keyFn(item);
    buckets[key] ??= { total: 0, count: 0 };
    buckets[key].total += value;
    buckets[key].count += 1;
  }
  return Object.fromEntries(
    Object.entries(buckets).map(([key, value]) => [key, value.count ? value.total / value.count : null]),
  );
}

function groupLatestStage(traces) {
  const stages = {};
  for (const trace of traces) {
    stages[trace.taskType] ??= trace.releaseGateStage;
  }
  return stages;
}
