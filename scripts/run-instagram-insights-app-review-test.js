// Admin one-shot — triggers real Instagram insights API calls
// against the connected Instagram Business Login account so Meta's
// App Review "instagram_business_manage_insights — N of 1 API
// call(s) required" counter ticks up. Run as often as needed; the
// scope is the same every time.
//
// Makes BOTH calls each run (account-level + media-level) so we
// exercise both shapes the App Review reviewer might require:
//   1. Account: GET /{ig-user-id}/insights?metric=views&period=day
//   2. Media:   GET /{ig-media-id}/insights?metric=<existing set>
//
// Safe to re-run. Token never logged. No legacy or DM scopes
// requested.
//
// Usage:
//   node scripts/run-instagram-insights-app-review-test.js [clientId]
// Default clientId: cmpheg00n0005rchptxt132kb (David Browning).

import { prisma } from "../prisma.js";
import { decryptToken } from "../lib/tokenCrypto.js";
import { INSTAGRAM_GRAPH_BASE } from "../domains/studio/meta.constants.js";

const REQUIRED_SCOPE = "instagram_business_manage_insights";
const CLIENT_ID = process.argv[2] ?? "cmpheg00n0005rchptxt132kb";

const conn = await prisma.channelConnection.findUnique({
  where: { clientId_channel: { clientId: CLIENT_ID, channel: "INSTAGRAM" } },
  select: {
    id: true,
    status: true,
    externalAccountId: true,
    scopes: true,
    accessToken: true,
    displayName: true,
  },
});
if (!conn) {
  console.error(`no INSTAGRAM connection for clientId ${CLIENT_ID}`);
  process.exit(1);
}
if (conn.status !== "CONNECTED") {
  console.error(`connection status is ${conn.status}, must be CONNECTED`);
  process.exit(1);
}
if (!Array.isArray(conn.scopes) || !conn.scopes.includes(REQUIRED_SCOPE)) {
  console.error(`connection missing required scope: ${REQUIRED_SCOPE}`);
  console.error(`current scopes: ${JSON.stringify(conn.scopes)}`);
  process.exit(1);
}

const token = decryptToken(conn.accessToken);
const igUserId = conn.externalAccountId;
console.log(`Connected IG user id: ${igUserId}`);
if (conn.displayName) console.log(`Connected IG display name: ${conn.displayName}`);
console.log(`Scope ${REQUIRED_SCOPE} granted: yes`);

async function probe(label, url) {
  const safeUrl = url.replace(/access_token=[^&]+/, "access_token=REDACTED");
  console.log(`\n--- ${label} ---`);
  console.log(`endpoint: ${safeUrl.split("?")[0]}`);
  console.log(`query: ${safeUrl.split("?")[1] ?? ""}`);
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  console.log(`status: ${res.status}`);
  if (Array.isArray(body?.data)) {
    const metrics = body.data.map((d) => d.name).filter(Boolean);
    console.log(`metrics returned: ${JSON.stringify(metrics)}`);
    console.log(`raw data items: ${body.data.length}`);
  } else if (body && typeof body === "object" && !body.error) {
    console.log(`response keys: ${JSON.stringify(Object.keys(body))}`);
  }
  if (body?.error) {
    console.log(
      `error: ${JSON.stringify(
        {
          code: body.error.code,
          subcode: body.error.error_subcode,
          message: body.error.message,
          type: body.error.type,
        },
        null,
        2,
      )}`,
    );
  }
  return { ok: res.ok, status: res.status, body };
}

// ── 1. Account-level insights ───────────────────────────────────────
// Newer IG Business Login API uses `views` as the canonical account-
// level reach metric (post-2024 Meta naming changes). Period=day per
// Meta's App Review docs.
const accountUrl =
  `${INSTAGRAM_GRAPH_BASE}/${encodeURIComponent(igUserId)}/insights` +
  `?metric=views` +
  `&period=day` +
  `&metric_type=total_value` +
  `&access_token=${encodeURIComponent(token)}`;
const accountResult = await probe("Account insights (views, day)", accountUrl);

// ── 2. Media-level insights ────────────────────────────────────────
// Mirror the production poller's metric set so we exercise the exact
// same Graph shape as instagram.metrics.js.
let mediaResult = null;
const recentDraft = await prisma.draft.findFirst({
  where: {
    clientId: CLIENT_ID,
    channel: "INSTAGRAM",
    externalPostId: { not: null },
  },
  orderBy: { publishedAt: "desc" },
  select: { externalPostId: true, publishedAt: true },
});
if (recentDraft) {
  console.log(
    `\nmost recent SquadPitch-published IG media: ${recentDraft.externalPostId} (publishedAt ${recentDraft.publishedAt?.toISOString()})`,
  );
  const mediaMetrics = "impressions,reach,saved,shares";
  const mediaUrl =
    `${INSTAGRAM_GRAPH_BASE}/${encodeURIComponent(recentDraft.externalPostId)}/insights` +
    `?metric=${encodeURIComponent(mediaMetrics)}` +
    `&access_token=${encodeURIComponent(token)}`;
  mediaResult = await probe("Media insights (impressions/reach/saved/shares)", mediaUrl);
} else {
  console.log(
    "\nNo SquadPitch-published IG media found — skipping media-level call.",
  );
}

console.log("\n=== Summary ===");
console.log(
  `account-level call: ${accountResult.ok ? "OK" : "FAILED"} (status ${accountResult.status})`,
);
if (mediaResult) {
  console.log(
    `media-level call:   ${mediaResult.ok ? "OK" : "FAILED"} (status ${mediaResult.status})`,
  );
}
console.log(
  "\nReminder: Meta App Review may take up to 24 hours to show this test call as completed.",
);

await prisma.$disconnect();
