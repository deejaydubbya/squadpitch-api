// One-shot diagnostic — list the IG account's recent media + comment counts.
// Delete after the App Review polling investigation closes.

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
const url =
  `https://graph.instagram.com/${c.externalAccountId}/media` +
  `?fields=id,caption,timestamp,media_type,comments_count,like_count` +
  `&limit=10&access_token=${encodeURIComponent(tok)}`;

const res = await fetch(url);
const body = await res.json();
console.log("status:", res.status);
console.log("count:", body?.data?.length ?? null);
console.log(
  "items:",
  JSON.stringify(
    (body?.data ?? []).map((m) => ({
      id: m.id,
      type: m.media_type,
      ts: m.timestamp,
      caption: (m.caption || "").slice(0, 60),
      comments_count: m.comments_count,
      like_count: m.like_count,
    })),
    null,
    2,
  ),
);
if (body?.error) console.log("error:", JSON.stringify(body.error, null, 2));

await prisma.$disconnect();
