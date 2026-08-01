#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import { buildAuthUrl } from "../../domains/studio/oauth/pinterest.oauth.js";
import { getRefreshAdapter } from "../../domains/studio/token-refresh/index.js";
import { getAdapterForChannel } from "../../domains/studio/publishing/channelAdapters/index.js";
import { integrationCapabilityMatrix } from "../../domains/integrations/integrationCapabilityMatrix.js";
import evidence from "./evidence.json" with { type: "json" };

const EXPECTED_REDIRECT = "https://app.squadpitch.com/oauth/PINTEREST/callback";
const EXPECTED_SCOPES = [
  "user_accounts:read",
  "boards:read",
  "boards:write",
  "pins:read",
  "pins:write",
];

function check(id, pass, detail) {
  return { id, status: pass ? "PASS" : "FAIL", detail };
}

const routeSource = fs.readFileSync(
  path.resolve("domains/studio/studio.routes.js"),
  "utf8",
);
let generatedScopes = [];
let authUrlValid = false;
try {
  const authUrl = new URL(buildAuthUrl({ state: "readiness-state" }));
  authUrlValid = authUrl.searchParams.get("redirect_uri") === EXPECTED_REDIRECT;
  generatedScopes = (authUrl.searchParams.get("scope") ?? "").split(",");
} catch {
  // Missing configuration is reported below without revealing values.
}

const requiredNames = [
  "PINTEREST_CLIENT_ID",
  "PINTEREST_CLIENT_SECRET",
  "PINTEREST_REDIRECT_URI",
  "TOKEN_ENCRYPTION_KEY",
];
const canary = evidence.imagePinPublishing ?? {};
const requiredCanaryAssertions = [
  "oauthCompleted",
  "minimumScopesConfirmed",
  "boardListingConfirmed",
  "syntheticBoardConfirmed",
  "singleImagePinPublished",
  "correctBoardConfirmed",
  "squadpitchPublishedStateConfirmed",
  "providerPinIdStored",
  "refreshCreatedNoDuplicate",
].every((key) => canary[key] === true);
const checks = [
  ...requiredNames.map((name) =>
    check(`config.${name}`, Boolean(env[name]), `${name} is ${env[name] ? "configured" : "missing"}`),
  ),
  check("config.redirect", env.PINTEREST_REDIRECT_URI === EXPECTED_REDIRECT && authUrlValid, "redirect URI is exact"),
  check("config.production_host", env.PINTEREST_USE_SANDBOX !== true, "Pinterest production API host selected"),
  check("oauth.scopes", JSON.stringify(generatedScopes) === JSON.stringify(EXPECTED_SCOPES), "requested scopes match the approved minimum set"),
  check("oauth.start_route", routeSource.includes("connections/:channel/oauth/start"), "OAuth start route registered"),
  check("oauth.complete_route", routeSource.includes("/oauth/complete"), "OAuth completion route registered"),
  check("refresh.adapter", Boolean(getRefreshAdapter("PINTEREST")), "Pinterest refresh adapter registered"),
  check("publish.adapter", getAdapterForChannel("PINTEREST")?.channel === "PINTEREST", "Pinterest publishing adapter registered"),
  check("capability.refresh", integrationCapabilityMatrix.PINTEREST.tokenRefresh === "AVAILABLE", "Pinterest token refresh advertised as available"),
  check(
    "evidence.image_pin_canary",
    evidence.environment === "production" &&
      canary.classification === "AVAILABLE" &&
      requiredCanaryAssertions &&
      canary.customerDataUsed === false,
    "controlled production OAuth and single image Pin canary is durably recorded",
  ),
  check(
    "capability.image_publish",
    integrationCapabilityMatrix.PINTEREST.mediaPublish === "AVAILABLE",
    "Pinterest image Pin publishing is classified as AVAILABLE",
  ),
  check(
    "capability.unsupported",
    integrationCapabilityMatrix.PINTEREST.videoPublish === "UNAVAILABLE" &&
      integrationCapabilityMatrix.PINTEREST.commentsInbox === "UNAVAILABLE" &&
      integrationCapabilityMatrix.PINTEREST.analytics === "UNAVAILABLE",
    "video Pins, comments inbox and analytics remain unavailable",
  ),
];
const failed = checks.filter((item) => item.status === "FAIL");
const report = {
  schemaVersion: "pinterest-readiness.v1",
  generatedAt: new Date().toISOString(),
  result: failed.length ? "FAIL" : "PASS",
  checks,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Pinterest production readiness: ${report.result}`);
  for (const item of checks) console.log(`${item.status} ${item.id}: ${item.detail}`);
}
process.exitCode = failed.length ? 1 : 0;
