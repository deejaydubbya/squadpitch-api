import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Running notification tables migration...");

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "notification_preferences" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
      "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
      "phone" TEXT,
      "preferences" JSONB NOT NULL DEFAULT '{"POST_PUBLISHED":true,"POST_FAILED":true,"USAGE_LIMIT_NEARING":true,"CONNECTION_EXPIRED":true,"BATCH_COMPLETE":true,"WEEKLY_SUMMARY":true,"POST_NEEDS_APPROVAL":true}',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
    )
  `);
  console.log("Created notification_preferences table");

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "notification_logs" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "eventType" TEXT NOT NULL,
      "channel" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'SENT',
      "payload" JSONB,
      "error" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
    )
  `);
  console.log("Created notification_logs table");

  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_userId_key" ON "notification_preferences"("userId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "notification_logs_userId_createdAt_idx" ON "notification_logs"("userId", "createdAt")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "notification_logs_userId_eventType_idx" ON "notification_logs"("userId", "eventType")`);
  console.log("Created indexes");

  await prisma.$disconnect();
  console.log("Migration complete!");
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
