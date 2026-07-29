#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { verifyProductionCanary } from "./runner.js";

const json = process.argv.includes("--json");
const cookie = process.env.SQUADPITCH_CANARY_COOKIE;
const baseUrl =
  process.env.SQUADPITCH_CANARY_BASE_URL ??
  (cookie ? "https://app.squadpitch.com" : "https://squadpitch-api.fly.dev");
const runId = process.env.SQUADPITCH_CANARY_RUN_ID ?? randomUUID();

try {
  const report = await verifyProductionCanary({
    baseUrl,
    workspaceId: process.env.SQUADPITCH_CANARY_WORKSPACE_ID,
    token: process.env.SQUADPITCH_CANARY_TOKEN,
    cookie,
    runId,
  });
  console.log(json ? JSON.stringify(report, null, 2) : render(report));
  if (report.summary.fail) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "Canary failed";
  console.error(json ? JSON.stringify({ status: "FAIL", message }) : `Squadpitch Production Canary\n\nFAIL ${message}`);
  process.exitCode = 1;
}

function render(report) {
  const lines = [
    "Squadpitch Production Canary",
    `Run: ${report.runId}`,
    `Workspace: ${report.workspaceId}`,
    "",
  ];
  for (const item of report.results) {
    lines.push(`${item.status.padEnd(4)} ${item.id} — ${item.message}`);
  }
  lines.push(
    "",
    `PASS ${report.summary.pass} | WARN ${report.summary.warn} | FAIL ${report.summary.fail}`,
    `Overall: ${report.summary.status}`,
  );
  return lines.join("\n");
}
