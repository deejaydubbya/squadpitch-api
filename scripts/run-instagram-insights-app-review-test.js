// Admin one-shot — triggers a real Instagram insights API call
// against the connected Instagram Business Login account so that
// Meta's App Review "instagram_business_manage_insights — 0 of 1
// API call(s) required" counter ticks up.
//
// Safe to re-run. Token never logged. Tries account-level insights
// first; if Meta rejects the chosen metric for the account, falls
// back to media-level insights on the most recent SquadPitch-
// published media.
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
console.log(`Scope ${REQUIRED_SCOPE} granted: yes`);

async function probe(label, url) {
  // Redact the token in any log line
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

// Try account-level insights first. Meta's current default supported
// metric for IG Business is `reach`; some accounts also accept `views`
// (newer naming, post-2024 changes).
const accountMetrics = "reach";
const accountUrl =
  `${INSTAGRAM_GRAPH_BASE}/${encodeURIComponent(igUserId)}/insights` +
  `?metric=${encodeURIComponent(accountMetrics)}` +
  `&period=day` +
  `&metric_type=total_value` +
  `&access_token=${encodeURIComponent(token)}`;

const accountResult = await probe("Account insights (reach, day)", accountUrl);

let mediaResult = null;
if (!accountResult.ok || accountResult.body?.error) {
  // Account-level rejected — fall back to media-level on the most
  // recent SquadPitch-published media. Uses the same metric set the
  // production poller (instagram.metrics.js) uses.
  console.log(
    "\nAccount-level call did not succeed; trying media-level fallback on most recent published media…",
  );
  const recentDraft = await prisma.draft.findFirst({
    where: {
      clientId: CLIENT_ID,
      channel: "INSTAGRAM",
      externalPostId: { not: null },
    },
    orderBy: { publishedAt: "desc" },
    select: { externalPostId: true, publishedAt: true },
  });
  if (!recentDraft) {
    console.error("no SquadPitch-published IG media found to fall back to");
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(
    `using mediaId ${recentDraft.externalPostId} (publishedAt ${recentDraft.publishedAt?.toISOString()})`,
  );
  // Mirror what the existing instagram.metrics.js adapter requests so
  // we're guaranteed at least one supported metric.
  const mediaMetrics = "impressions,reach,saved,shares";
  const mediaUrl =
    `${INSTAGRAM_GRAPH_BASE}/${encodeURIComponent(recentDraft.externalPostId)}/insights` +
    `?metric=${encodeURIComponent(mediaMetrics)}` +
    `&access_token=${encodeURIComponent(token)}`;
  mediaResult = await probe("Media insights (impressions/reach/saved/shares)", mediaUrl);
}

console.log("\n=== Summary ===");
console.log(
  `account-level call: ${accountResult.ok ? "OK" : "FAILED"} (status ${accountResult.status})`,
);
if (mediaResult) {
  console.log(
    `media-level call: ${mediaResult.ok ? "OK" : "FAILED"} (status ${mediaResult.status})`,
  );
}
console.log(
  "\nReminder: Meta App Review may take up to 24 hours to show this test call as completed.",
);

await prisma.$disconnect();
