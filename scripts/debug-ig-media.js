// One-shot diagnostic — probe IG comment-read via three different
// Graph API surfaces to definitively prove whether the Live-mode
// gate applies to all paths or only /{media-id}/comments.
// Delete after the App Review polling investigation closes.

import { prisma } from "../prisma.js";
import { decryptToken } from "../lib/tokenCrypto.js";

const CONN_ID = process.argv[2] ?? "cmpv09qpw000vsohp155nud62";
const TARGET_MEDIA = "17942011083039275"; // the post with comments_count=7

const c = await prisma.channelConnection.findUnique({
  where: { id: CONN_ID },
  select: { accessToken: true, externalAccountId: true },
});
if (!c) {
  console.error("connection not found:", CONN_ID);
  process.exit(1);
}

const tok = decryptToken(c.accessToken);

async function probe(label, url) {
  const res = await fetch(url);
  const body = await res.json();
  console.log(`\n--- ${label} ---`);
  console.log("status:", res.status);
  console.log("body:", JSON.stringify(body, null, 2).slice(0, 2000));
}

// Path 1: dedicated /comments endpoint (what the poller uses today)
await probe(
  "PATH 1: /{media-id}/comments",
  `https://graph.instagram.com/${TARGET_MEDIA}/comments?fields=id,text,username,timestamp,from&limit=100&access_token=${encodeURIComponent(tok)}`,
);

// Path 2: nested field expansion on the media itself
await probe(
  "PATH 2: /{media-id}?fields=comments{...}",
  `https://graph.instagram.com/${TARGET_MEDIA}?fields=id,comments_count,comments{id,text,username,timestamp,from}&access_token=${encodeURIComponent(tok)}`,
);

// Path 3: nested via /me/media with comments field
await probe(
  "PATH 3: /me/media?fields=...,comments{...}",
  `https://graph.instagram.com/${c.externalAccountId}/media?fields=id,comments_count,comments{id,text,username,timestamp,from}&limit=5&access_token=${encodeURIComponent(tok)}`,
);

await prisma.$disconnect();
