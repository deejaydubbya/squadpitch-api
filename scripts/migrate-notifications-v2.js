// Migration script: Rebuild notification tables with new schema.
// Run via: node scripts/migrate-notifications-v2.js

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Dropping old notification tables...");
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "notification_logs"`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "notification_preferences"`);

  console.log("Creating notification_preferences...");
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "notification_preferences" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
      "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
      "phoneNumber" TEXT,
      "preferencesJson" JSONB NOT NULL DEFAULT '{"POST_PUBLISHED":true,"POST_FAILED":true,"USAGE_LIMIT_NEARING":true,"CONNECTION_EXPIRED":true,"BATCH_COMPLETE":true}',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
    )
  `);

  console.log("Creating notification_logs...");
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "notification_logs" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "eventType" TEXT NOT NULL,
      "channel" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'queued',
      "provider" TEXT,
      "providerMessageId" TEXT,
      "resourceType" TEXT,
      "resourceId" TEXT,
      "errorMessage" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
    )
  `);

  console.log("Creating indexes...");
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "notification_preferences_userId_key" ON "notification_preferences"("userId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX "notification_logs_userId_createdAt_idx" ON "notification_logs"("userId", "createdAt")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX "notification_logs_userId_eventType_idx" ON "notification_logs"("userId", "eventType")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX "notification_logs_userId_eventType_resourceId_idx" ON "notification_logs"("userId", "eventType", "resourceId")`);

  console.log("Migration complete!");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
