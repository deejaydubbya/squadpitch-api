-- Drop old tables if they exist (from previous implementation)
DROP TABLE IF EXISTS "notification_logs";
DROP TABLE IF EXISTS "notification_preferences";

-- CreateTable: notification_preferences
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
);

-- CreateTable: notification_logs
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
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_key" ON "notification_preferences"("userId");

-- CreateIndex
CREATE INDEX "notification_logs_userId_createdAt_idx" ON "notification_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_logs_userId_eventType_idx" ON "notification_logs"("userId", "eventType");

-- CreateIndex (deduplication lookups)
CREATE INDEX "notification_logs_userId_eventType_resourceId_idx" ON "notification_logs"("userId", "eventType", "resourceId");
