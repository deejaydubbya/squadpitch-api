// Show all IG connections updated in the last hour.

import { prisma } from "../prisma.js";

const oneHourAgo = new Date(Date.now() - 60 * 60_000);
const conns = await prisma.channelConnection.findMany({
  where: { channel: "INSTAGRAM", updatedAt: { gte: oneHourAgo } },
  select: {
    id: true,
    clientId: true,
    status: true,
    externalAccountId: true,
    scopes: true,
    updatedAt: true,
  },
  orderBy: { updatedAt: "desc" },
});
console.log("=== INSTAGRAM connections updated in last hour ===");
console.log("count:", conns.length);
console.log(JSON.stringify(conns, null, 2));

// Also fetch all clients to map IDs to names
const clientIds = [...new Set(conns.map((c) => c.clientId))];
if (clientIds.length > 0) {
  const clients = await prisma.client.findMany({
    where: { id: { in: clientIds } },
    select: { id: true, name: true },
  });
  console.log("\n=== Clients ===");
  console.log(JSON.stringify(clients, null, 2));
}

await prisma.$disconnect();
