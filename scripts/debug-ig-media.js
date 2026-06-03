// List all INSTAGRAM connections + the user's clients.

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
    updatedAt: true,
  },
  orderBy: { updatedAt: "desc" },
});
console.log("=== All INSTAGRAM connections ===");
console.log(JSON.stringify(conns, null, 2));

await prisma.$disconnect();
