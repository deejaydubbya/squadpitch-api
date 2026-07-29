export const SYNTHETIC_WORKSPACE_PREFIX = "[SYNTHETIC CANARY]";

export function validateCanaryInvocation({
  configuredWorkspaceId,
  requestedWorkspaceId,
  workspaceName,
  synthetic,
  runId,
}) {
  const errors = [];
  if (!configuredWorkspaceId) errors.push("Production canary is not configured");
  if (configuredWorkspaceId !== requestedWorkspaceId) {
    errors.push("Workspace is not the configured production canary");
  }
  if (!workspaceName?.startsWith(SYNTHETIC_WORKSPACE_PREFIX)) {
    errors.push(`Workspace name must start with ${SYNTHETIC_WORKSPACE_PREFIX}`);
  }
  if (synthetic !== true) errors.push("synthetic=true acknowledgement is required");
  if (
    typeof runId !== "string" ||
    runId.length < 8 ||
    runId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(runId)
  ) {
    errors.push("runId must be 8-128 safe identifier characters");
  }
  return errors;
}

export function summarizeCanaryResults(results) {
  const counts = Object.fromEntries(
    ["PASS", "WARN", "FAIL"].map((status) => [
      status.toLowerCase(),
      results.filter((item) => item.status === status).length,
    ]),
  );
  return {
    status: counts.fail ? "FAIL" : counts.warn ? "WARN" : "PASS",
    ...counts,
  };
}
