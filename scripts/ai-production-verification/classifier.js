export const AI_VERIFICATION_STATUS = Object.freeze({
  PASS: "PASS",
  WARN_PYTHON: "WARN_PYTHON",
  WARN_NODE: "WARN_NODE",
  FAIL: "FAIL",
});

export function classifyAiVerification({
  operation,
  name,
  usableResult,
  provenance,
  latencyMs,
  message,
  diagnostics,
}) {
  const source = provenance?.source ?? null;
  const fallbackUsed = provenance?.fallbackUsed === true;
  const fallbackLayer = provenance?.fallbackLayer ?? null;
  let status;

  if (!usableResult) {
    status = AI_VERIFICATION_STATUS.FAIL;
  } else if (
    source === "squadpitch-ai" &&
    fallbackUsed &&
    fallbackLayer === "python"
  ) {
    status = AI_VERIFICATION_STATUS.WARN_PYTHON;
  } else if (source === "squadpitch-ai" && !fallbackUsed) {
    status = AI_VERIFICATION_STATUS.PASS;
  } else {
    status = AI_VERIFICATION_STATUS.WARN_NODE;
  }

  return {
    operation,
    name: name ?? operation,
    status,
    source,
    fallbackUsed,
    fallbackLayer:
      fallbackLayer ??
      (status === AI_VERIFICATION_STATUS.WARN_NODE ? "node" : null),
    fallbackReason:
      provenance?.fallbackReason ??
      (status === AI_VERIFICATION_STATUS.WARN_NODE
        ? (provenance?.executionMode ?? "local_execution")
        : null),
    implementation: provenance?.implementation ?? null,
    serviceVersion: provenance?.serviceVersion ?? null,
    model: provenance?.model ?? null,
    modelVersion: provenance?.modelVersion ?? null,
    traceId: provenance?.traceId ?? null,
    latencyMs: provenance?.totalLatencyMs ?? latencyMs ?? null,
    usableResult: usableResult === true,
    diagnostics: sanitizeDiagnostics(diagnostics),
    message: sanitizeMessage(message),
  };
}

export function summarizeVerification(results, { strict = false } = {}) {
  const pass = results.filter((result) => result.status === "PASS").length;
  const warnPython = results.filter(
    (result) => result.status === "WARN_PYTHON",
  ).length;
  const warnNode = results.filter(
    (result) => result.status === "WARN_NODE",
  ).length;
  const fail = results.filter((result) => result.status === "FAIL").length;
  const warn = warnPython + warnNode;
  const status =
    fail > 0 ? "FAILED" : warn > 0 ? "HEALTHY_WITH_WARNINGS" : "HEALTHY";
  return {
    status,
    pass,
    warn,
    warnPython,
    warnNode,
    fail,
    exitCode: fail > 0 || (strict && warn > 0) ? 1 : 0,
    results,
  };
}

function sanitizeMessage(message) {
  if (typeof message !== "string") return null;
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password)=\S+/gi, "$1=[REDACTED]")
    .slice(0, 240);
}

function sanitizeDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    workspaceId:
      typeof value.workspaceId === "string" ? value.workspaceId : null,
    proposalType:
      typeof value.proposalType === "string" ? value.proposalType : null,
    schemaVersion:
      typeof value.schemaVersion === "string" ? value.schemaVersion : null,
    dryRun: value.dryRun === true,
    persistence: value.persistence === true,
  };
}
