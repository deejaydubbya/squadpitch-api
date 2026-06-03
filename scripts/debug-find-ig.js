import { prisma } from "../prisma.js";
const conns = await prisma.channelConnection.findMany({
  where: { channel: "INSTAGRAM" },
  select: { id: true, clientId: true, status: true, externalAccountId: true, updatedAt: true, scopes: true },
  orderBy: { updatedAt: "desc" },
});
console.log(JSON.stringify(conns, null, 2));
await prisma.$disconnect();
