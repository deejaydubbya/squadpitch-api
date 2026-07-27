#!/usr/bin/env node
import { renderConsoleReport } from "./reporters/console.js";
import { verifyAiProduction } from "./runner.js";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const strict = args.has("--strict");
const startedAt = new Date().toISOString();
const baseUrl =
  process.env.SQUADPITCH_VERIFY_BASE_URL ?? "https://squadpitch-api.fly.dev";

try {
  const report = await verifyAiProduction({
    baseUrl,
    token: process.env.SQUADPITCH_VERIFY_TOKEN,
    workspaceId: process.env.SQUADPITCH_VERIFY_WORKSPACE_ID,
    strict,
  });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      renderConsoleReport(report, {
        apiUrl: baseUrl,
        startedAt,
        skipped: report.skipped,
      }),
    );
  }
  process.exitCode = report.exitCode;
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Production verification failed";
  if (json) {
    console.log(
      JSON.stringify(
        {
          status: "FAILED",
          pass: 0,
          warn: 0,
          fail: 1,
          results: [],
          message,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`Squadpitch AI Production Verification\n\nFAIL: ${message}`);
  }
  process.exitCode = 1;
}
