// One-shot diagnostic — for each of the IG media items we polled,
// show what Meta reports as comments_count vs what /comments returns.
// Delete after.

import { prisma } from "../prisma.js";
import { decryptToken } from "../lib/tokenCrypto.js";

const CONN_ID = process.argv[2] ?? "cmpv09qpw000vsohp155nud62";

const c = await prisma.channelConnection.findUnique({
  where: { id: CONN_ID },
  select: { accessToken: true, externalAccountId: true },
});
if (!c) {
  console.error("connection not found:", CONN_ID);
  process.exit(1);
}

const tok = decryptToken(c.accessToken);

// Get the IG account's recent media + comments_count
const mediaRes = await fetch(
  `https://graph.instagram.com/${c.externalAccountId}/media?fields=id,timestamp,caption,comments_count,media_type&limit=10&access_token=${encodeURIComponent(tok)}`,
);
const mediaBody = await mediaRes.json();
console.log("=== /me/media (with comments_count) ===");
console.log(JSON.stringify(mediaBody, null, 2).slice(0, 2500));

// For each media with comments_count > 0, also fetch /{id}/comments
console.log("\n=== Per-media /comments fetches for posts with comments_count > 0 ===");
for (const m of (mediaBody?.data ?? []).filter((x) => x.comments_count > 0)) {
  const cRes = await fetch(
    `https://graph.instagram.com/${m.id}/comments?fields=id,text,username,timestamp,from&access_token=${encodeURIComponent(tok)}`,
  );
  const cBody = await cRes.json();
  console.log(`\n--- media ${m.id} (count=${m.comments_count}, ts=${m.timestamp}) ---`);
  console.log("status:", cRes.status);
  console.log("body:", JSON.stringify(cBody, null, 2).slice(0, 1500));
}

await prisma.$disconnect();
