#!/usr/bin/env node
import { runProductionReadinessChecks } from "./checks.js";
import { summarizeReadiness } from "./classifier.js";
import { renderReadinessReport } from "./reporters.js";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const network = !args.has("--no-network");

const checks = await runProductionReadinessChecks({ network });
const summary = summarizeReadiness(checks);
const report = {
  schemaVersion: "production-readiness.v1",
  generatedAt: new Date().toISOString(),
  networkEnabled: network,
  summary,
  checks,
};

console.log(
  json ? JSON.stringify(report, null, 2) : renderReadinessReport(report),
);
process.exitCode = summary.exitCode;
