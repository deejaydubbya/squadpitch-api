import { pathToFileURL } from "node:url";

const DEFAULT_CHECKS = Object.freeze([
  ["web", "https://app.squadpitch.com", [200]],
  ["api-readiness", "https://api.squadpitch.com/ready", [200]],
  ["ai-readiness", "https://squadpitch-ai.fly.dev/ready", [200]],
]);

export async function verifyExternalReadiness({
  checks = DEFAULT_CHECKS,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const results = [];
  for (const [id, url, expectedStatuses] of checks) {
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "squadpitch-uptime-verifier/1.0" },
      });
      results.push({
        id,
        status: expectedStatuses.includes(response.status) ? "PASS" : "FAIL",
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt,
      });
    } catch {
      results.push({
        id,
        status: "FAIL",
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
      });
    }
  }
  return {
    schemaVersion: "external-readiness.v1",
    status: results.every((item) => item.status === "PASS") ? "PASS" : "FAIL",
    checkedAt: new Date().toISOString(),
    results,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await verifyExternalReadiness();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
}
