#!/usr/bin/env node
import { evaluateBetaLaunchGate } from "./gate.js";

const json = process.argv.includes("--json");
const report = evaluateBetaLaunchGate();
if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Squadpitch Beta Launch Gate\n");
  for (const item of report.results) {
    console.log(`${item.status.padEnd(4)} ${item.id} — ${item.message}`);
  }
  console.log(
    `\nPASS ${report.summary.pass} | WARN ${report.summary.warn} | FAIL ${report.summary.fail}`,
  );
  console.log(`Overall: ${report.summary.status}`);
}
if (report.summary.fail) process.exitCode = 1;
