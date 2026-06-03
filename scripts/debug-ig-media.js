// List ALL INSTAGRAM connections regardless of status + look up
// the user's clients.

import { prisma } from "../prisma.js";

const conns = await prisma.channelConnection.findMany({
  where: { channel: "INSTAGRAM" },
  select: {
    id: true,
    clientId: true,
    status: true,
    externalAccountId: true,
    scopes: true,
    tokenExpiresAt: true,
    lastError: true,
    updatedAt: true,
    createdAt: true,
  },
  orderBy: { updatedAt: "desc" },
});
console.log("=== All INSTAGRAM connections (any status) ===");
console.log("count:", conns.length);
console.log(JSON.stringify(conns, null, 2));

const USER_CLIENT = "cmpheg00n0005rchptxt132kb";
console.log(`\n=== Connections on ${USER_CLIENT} (the primary workspace) ===`);
const ours = conns.filter((c) => c.clientId === USER_CLIENT);
console.log(JSON.stringify(ours, null, 2));

// Look up the user's primary client
const client = await prisma.client.findUnique({
  where: { id: USER_CLIENT },
  select: { id: true, name: true, updatedAt: true, createdBy: true },
});
console.log("\n=== Primary client ===", JSON.stringify(client, null, 2));

await prisma.$disconnect();
