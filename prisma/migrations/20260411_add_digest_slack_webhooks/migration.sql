-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN "digestEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "slack_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "webhookUrl" TEXT NOT NULL,
    "channelName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "subscribedEvents" JSONB NOT NULL DEFAULT '["POST_FAILED","POST_PUBLISHED","BATCH_COMPLETE","CONNECTION_EXPIRED"]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_connections_userId_key" ON "slack_connections"("userId");

-- CreateTable
CREATE TABLE "outbound_webhooks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "subscribedEvents" JSONB NOT NULL DEFAULT '["POST_PUBLISHED","POST_FAILED","BATCH_COMPLETE","CONNECTION_EXPIRED"]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbound_webhooks_userId_idx" ON "outbound_webhooks"("userId");

-- CreateTable
CREATE TABLE "webhook_delivery_logs" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "requestBody" JSONB NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_delivery_logs_webhookId_createdAt_idx" ON "webhook_delivery_logs"("webhookId", "createdAt");

-- AddForeignKey
ALTER TABLE "webhook_delivery_logs" ADD CONSTRAINT "webhook_delivery_logs_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "outbound_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
