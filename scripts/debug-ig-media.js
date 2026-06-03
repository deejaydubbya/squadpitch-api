// One-shot diagnostic — find the active INSTAGRAM connection for
// the user's workspace, then for each of its recent media items
// show what Meta reports as comments_count vs what /comments returns.
// Delete after.

import { prisma } from "../prisma.js";
import { decryptToken } from "../lib/tokenCrypto.js";

const CLIENT_ID = process.argv[2] ?? "cmpheg00n0005rchptxt132kb";

const c = await prisma.channelConnection.findUnique({
  where: { clientId_channel: { clientId: CLIENT_ID, channel: "INSTAGRAM" } },
  select: {
    id: true,
    status: true,
    externalAccountId: true,
    scopes: true,
    accessToken: true,
    tokenExpiresAt: true,
    updatedAt: true,
  },
});
if (!c) {
  console.error("no INSTAGRAM connection for clientId:", CLIENT_ID);
  process.exit(1);
}
console.log("connection:", {
  id: c.id,
  status: c.status,
  externalAccountId: c.externalAccountId,
  scopes: c.scopes,
  tokenExpiresAt: c.tokenExpiresAt,
  updatedAt: c.updatedAt,
});

const tok = decryptToken(c.accessToken);

// Get the IG account's recent media + comments_count
const mediaRes = await fetch(
  `https://graph.instagram.com/${c.externalAccountId}/media?fields=id,timestamp,caption,comments_count,media_type&limit=10&access_token=${encodeURIComponent(tok)}`,
);
const mediaBody = await mediaRes.json();
console.log("\n=== /me/media (with comments_count) ===");
console.log(JSON.stringify(mediaBody, null, 2).slice(0, 3000));

console.log("\n=== Per-media /comments fetches ===");
for (const m of (mediaBody?.data ?? []).slice(0, 5)) {
  const cRes = await fetch(
    `https://graph.instagram.com/${m.id}/comments?fields=id,text,username,timestamp,from&access_token=${encodeURIComponent(tok)}`,
  );
  const cBody = await cRes.json();
  console.log(`\n--- media ${m.id} (count=${m.comments_count}, ts=${m.timestamp}) ---`);
  console.log("status:", cRes.status);
  console.log("body:", JSON.stringify(cBody, null, 2).slice(0, 1500));
}

await prisma.$disconnect();
