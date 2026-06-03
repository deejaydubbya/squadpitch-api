// One-shot diagnostic — dump the FB connection's status + scopes
// so we can tell why REPLY_PUBLIC_COMMENT is gated off. Delete after.

import { prisma } from "../prisma.js";

const CONN_ID = process.argv[2] ?? "cmpya8e6r0071rchquyzlk27b";

const c = await prisma.channelConnection.findUnique({
  where: { id: CONN_ID },
  select: {
    id: true,
    clientId: true,
    channel: true,
    status: true,
    externalAccountId: true,
    scopes: true,
    lastError: true,
    tokenExpiresAt: true,
    updatedAt: true,
  },
});
console.log(JSON.stringify(c, null, 2));
await prisma.$disconnect();
