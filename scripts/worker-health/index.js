import "dotenv/config";
import { verifyProductionCanary } from "../production-canary/runner.js";

const json = process.argv.includes("--json");
const report = await verifyProductionCanary({
  baseUrl: process.env.SQUADPITCH_CANARY_BASE_URL,
  workspaceId: process.env.SQUADPITCH_CANARY_WORKSPACE_ID,
  token: process.env.SQUADPITCH_CANARY_TOKEN,
  cookie: process.env.SQUADPITCH_CANARY_COOKIE,
  runId: `worker-health-${Date.now()}`,
});
const results = report.results.filter((item) => item.id.startsWith("worker."));
const output = {
  schemaVersion: "worker-health-verification.v1",
  generatedAt: report.generatedAt,
  runId: report.runId,
  status: results.some((item) => item.status === "FAIL")
    ? "FAIL"
    : results.some((item) => item.status === "WARN")
      ? "WARN"
      : "PASS",
  results,
};
if (json) console.log(JSON.stringify(output, null, 2));
else {
  console.log(`Worker health: ${output.status}`);
  for (const item of results)
    console.log(`${item.status} ${item.id}: ${item.message}`);
}
if (output.status === "FAIL") process.exitCode = 1;
