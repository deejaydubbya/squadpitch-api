// One-shot ops script to soft-disconnect a user's google_drive +
// dropbox integrations (matches the /disconnect endpoint: sets
// isActive=false but keeps the row so we can audit).
//
// Run inside the API container:
//   fly ssh console -a squadpitch-api -C 'node scripts/disconnect-integrations.js veldkampbart@gmail.com'

import { PrismaClient } from "@prisma/client";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/disconnect-integrations.js <email>");
  process.exit(1);
}

const prisma = new PrismaClient();

const user = await prisma.user.findUnique({
  where: { email },
  select: { id: true, email: true, auth0Sub: true },
});
if (!user) {
  console.error(`No user with email ${email}`);
  await prisma.$disconnect();
  process.exit(1);
}

const before = await prisma.integration.findMany({
  where: { userId: user.id, type: { in: ["google_drive", "dropbox"] } },
  select: { id: true, type: true, name: true, isActive: true, createdAt: true },
});
console.log(`User ${user.email} (${user.id}) before:`);
console.log(JSON.stringify(before, null, 2));

const result = await prisma.integration.updateMany({
  where: { userId: user.id, type: { in: ["google_drive", "dropbox"] } },
  data: { isActive: false },
});
console.log(`updateMany matched ${result.count} integration row(s)`);

const after = await prisma.integration.findMany({
  where: { userId: user.id, type: { in: ["google_drive", "dropbox"] } },
  select: { id: true, type: true, name: true, isActive: true },
});
console.log("after:");
console.log(JSON.stringify(after, null, 2));

await prisma.$disconnect();
