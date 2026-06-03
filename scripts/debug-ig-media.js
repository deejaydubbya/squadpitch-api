// Verify the user's new IG connection + probe Meta for comments.

import { prisma } from "../prisma.js";
import { decryptToken } from "../lib/tokenCrypto.js";

const CLIENT_ID = "cmpheg00n0005rchptxt132kb";

const c = await prisma.channelConnection.findUnique({
  where: { clientId_channel: { clientId: CLIENT_ID, channel: "INSTAGRAM" } },
  select: {
    id: true,
    status: true,
    externalAccountId: true,
    scopes: true,
    tokenExpiresAt: true,
    updatedAt: true,
    accessToken: true,
  },
});
if (!c) {
  console.error("no INSTAGRAM connection for", CLIENT_ID);
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
const mediaRes = await fetch(
  `https://graph.instagram.com/${c.externalAccountId}/media?fields=id,timestamp,caption,comments_count,media_type&limit=5&access_token=${encodeURIComponent(tok)}`,
);
const mediaBody = await mediaRes.json();
console.log("\n=== /me/media ===");
console.log(JSON.stringify(mediaBody, null, 2).slice(0, 2000));

console.log("\n=== Per-media /comments ===");
for (const m of (mediaBody?.data ?? []).slice(0, 5)) {
  const cRes = await fetch(
    `https://graph.instagram.com/${m.id}/comments?fields=id,text,username,timestamp,from&access_token=${encodeURIComponent(tok)}`,
  );
  const cBody = await cRes.json();
  console.log(`--- media ${m.id} (count=${m.comments_count}) ---`);
  console.log("status:", cRes.status, "body:", JSON.stringify(cBody).slice(0, 800));
}

await prisma.$disconnect();
