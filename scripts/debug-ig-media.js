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

console.log("\n=== All clients owned by user cmnth9od40000ojhm8lgb2xzj ===");
const clients = await prisma.client.findMany({
  where: { ownerUserId: "cmnth9od40000ojhm8lgb2xzj" },
  select: { id: true, name: true, updatedAt: true },
  orderBy: { updatedAt: "desc" },
});
console.log(JSON.stringify(clients, null, 2));

await prisma.$disconnect();
