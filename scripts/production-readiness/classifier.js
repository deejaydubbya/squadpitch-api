export const READINESS_STATUS = Object.freeze({
  PASS: "PASS",
  WARN: "WARN",
  BLOCKED: "BLOCKED",
  FAIL: "FAIL",
});

export function readinessExitCode(checks) {
  return checks.some(
    (check) =>
      check.status === READINESS_STATUS.FAIL && check.priority === "P0",
  )
    ? 1
    : 0;
}

export function summarizeReadiness(checks) {
  const counts = Object.fromEntries(
    Object.values(READINESS_STATUS).map((status) => [
      status.toLowerCase(),
      checks.filter((check) => check.status === status).length,
    ]),
  );
  return {
    status:
      counts.fail > 0
        ? "NOT_READY"
        : counts.warn > 0 || counts.blocked > 0
          ? "READY_WITH_WARNINGS"
          : "READY",
    ...counts,
    exitCode: readinessExitCode(checks),
  };
}

export function configCheck({
  id,
  group,
  variables,
  required = true,
  remediation,
  env = process.env,
}) {
  const missing = variables.filter((name) => !hasValue(env[name]));
  const configured = variables.length - missing.length;
  if (missing.length === 0) {
    return check(
      id,
      group,
      "configuration",
      "PASS",
      "P0",
      "Configured",
      remediation,
    );
  }
  const partial = configured > 0;
  return check(
    id,
    group,
    "configuration",
    required ? "FAIL" : "WARN",
    required ? "P0" : "P2",
    `${partial ? "Partially configured; missing" : "Not configured; missing"}: ${missing.join(", ")}`,
    remediation,
  );
}

export function check(
  id,
  group,
  kind,
  status,
  priority,
  message,
  remediation,
  metadata,
) {
  return {
    id,
    group,
    kind,
    status,
    priority,
    message,
    remediation,
    ...(metadata ? { metadata } : {}),
  };
}

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}
