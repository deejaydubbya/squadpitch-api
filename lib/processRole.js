const VALID_ROLES = new Set(["api", "worker", "cli", "test"]);

export function getProcessRole(environment = process.env) {
  const fallback = environment.NODE_ENV === "test" ? "test" : "api";
  return String(environment.PROCESS_ROLE || fallback).trim().toLowerCase();
}

export function assertProcessRole(expected, environment = process.env) {
  const actual = getProcessRole(environment);
  if (!VALID_ROLES.has(actual)) {
    throw new Error(`Invalid PROCESS_ROLE=${actual}`);
  }
  if (actual !== expected) {
    throw new Error(
      `Process role ${actual} cannot initialize ${expected}-only components`,
    );
  }
  return actual;
}

export function runtimeIdentity(environment = process.env) {
  return {
    service: environment.FLY_APP_NAME || "squadpitch-api",
    processRole: getProcessRole(environment),
    instanceId:
      environment.FLY_MACHINE_ID || environment.HOSTNAME || "local-process",
    environment: environment.NODE_ENV || "development",
  };
}
