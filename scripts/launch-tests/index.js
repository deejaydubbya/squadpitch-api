#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchTestJourneys, evaluateLiveLaunchSafety } from "./manifest.js";

const json = process.argv.includes("--json");
const results = [];
const vitestCli = fileURLToPath(
  new URL("../../node_modules/vitest/vitest.mjs", import.meta.url),
);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

for (const journey of launchTestJourneys) {
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    [vitestCli, "run", ...journey.tests, "--reporter=dot"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  results.push({
    id: journey.id,
    status: run.status === 0 ? "PASS" : "FAIL",
    durationMs: Date.now() - started,
    tests: journey.tests,
    ...(run.status === 0
      ? {}
      : { detail: tail(`${run.stdout ?? ""}\n${run.stderr ?? ""}`, 20) }),
  });
}

results.push(...evaluateLiveLaunchSafety());
const counts = Object.fromEntries(
  ["PASS", "WARN", "FAIL"].map((status) => [
    status.toLowerCase(),
    results.filter((result) => result.status === status).length,
  ]),
);
const report = {
  schemaVersion: "launch-test-report.v1",
  generatedAt: new Date().toISOString(),
  mode: "ci-local-safe",
  summary: {
    status: counts.fail ? "FAIL" : counts.warn ? "WARN" : "PASS",
    ...counts,
  },
  results,
};

console.log(json ? JSON.stringify(report, null, 2) : render(report));
if (counts.fail) process.exitCode = 1;

function tail(value, lines) {
  return value.trim().split(/\r?\n/).slice(-lines).join("\n");
}

function render(report) {
  const lines = ["Squadpitch Launch Test Report", ""];
  for (const result of report.results) {
    lines.push(`${result.status.padEnd(4)} ${result.id} — ${result.message ?? `${result.tests.length} test file(s), ${result.durationMs}ms`}`);
    if (result.detail) lines.push(result.detail);
  }
  lines.push(
    "",
    `PASS ${report.summary.pass} | WARN ${report.summary.warn} | FAIL ${report.summary.fail}`,
    `Overall: ${report.summary.status}`,
  );
  return lines.join("\n");
}
